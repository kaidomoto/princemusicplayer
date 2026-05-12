const express = require('express');
const partyMgr = require('./party-manager');
const sessionMgr = require("./session-manager");
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const cheerio = require('cheerio');
const axios = require('axios');

const app = express();

// === Global bridge operation locks (shared between Reconnect and BridgeWatchdog) ===
var _bridgeOpInProgress = false;
var _bridgeLastRestartTime = 0;
app.disable('x-powered-by');
const upload = multer({ dest: '/tmp/' });
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==================== Socket.IO Session Room Routing ====================

// ==================== Voice Slots (migrated from production socket.js) ====================
const SLOT_TEMPLATES = [
    { id: 0, duration: 60, label: '1分钟' },
    { id: 1, duration: 180, label: '3分钟' },
    { id: 2, duration: 300, label: '5分钟' },
    { id: 3, duration: 420, label: '7分钟' },
    { id: 4, duration: 600, label: '10分钟' },
    { id: 5, duration: 1800, label: '半小时' },
];
const voiceUserSessions = new Map(); // userId -> [{ slotId, endTime, stage, duration, socketId, label, header }]
let globalVoiceEnabled = false; // Shared voice chat toggle state

// Tick every second to manage voice slot transitions (active -> silence -> remove)
setInterval(() => {
    const now = Date.now();
    let globalChanged = false;

    for (const [userId, sessions] of voiceUserSessions.entries()) {
        const initialCount = sessions.length;
        let userChanged = false;

        sessions.forEach(session => {
            if (now >= session.endTime && session.stage === 'active') {
                session.stage = 'silence';
                session.endTime = now + (session.duration * 1000);
                userChanged = true;
                globalChanged = true;
            }
        });

        const filtered = sessions.filter(s => s.stage === 'active' || now < s.endTime);
        if (filtered.length !== initialCount) {
            voiceUserSessions.set(userId, filtered);
            userChanged = true;
            globalChanged = true;
        }

        if (userChanged) {
            const userSockets = Array.from(io.sockets.sockets.values()).filter(
                s => (s.handshake.auth?.userId || s.id) === userId
            );
            userSockets.forEach(s => s.emit('my_slot_update', voiceUserSessions.get(userId) || []));
        }
    }

    if (globalChanged) {
        io.emit('slots_update', Array.from(voiceUserSessions.values()).flat());
    }
}, 1000);

io.on('connection', (socket) => {
    const sessionId = socket.handshake.auth?.sessionId || 'default';
    const userId = socket.handshake.auth?.userId || 'unknown';
    const clientIp = socket.handshake.headers['x-real-ip'] || socket.handshake.address;
    
    // Join session-specific room for command isolation
    const room = 'session:' + sessionId;
    socket.join(room);
    console.log(`User connected: ${socket.id} session: ${sessionId} (${clientIp})`);

    // Voice Slots: send templates and restore sessions on connect
    const vsUserId = socket.handshake.auth?.userId || socket.id;
    socket.emit('slot_templates', SLOT_TEMPLATES);
    if (voiceUserSessions.has(vsUserId)) {
        const vsSessions = voiceUserSessions.get(vsUserId);
        vsSessions.forEach(s => s.socketId = socket.id);
        socket.emit('my_slot_update', vsSessions);
    }
    socket.emit('slots_update', Array.from(voiceUserSessions.values()).flat());
    socket.emit('voice_enabled', globalVoiceEnabled);


    // Remote → Server → Player: relay player_action within session
    socket.on('player_action', (data) => {
        const roomSockets = io.sockets.adapter.rooms.get(room);
        const count = roomSockets ? roomSockets.size : 0;
        console.log(`[player_action] ${data?.type || '?'} from ${socket.id} → room ${room} (${count} sockets)`);

        // Party mode: block load/next/prev/loop from non-queue sources
        const ps = partyMgr.getState();
        if (ps.enabled && ps.queue.filter(q => q.status === 'waiting').length > 0) {
            if (data.type === 'load' || data.type === 'next' || data.type === 'prev' || data.type === 'loop') {
                console.log(`🎉 [Party] Blocked ${data.type} - use party queue`);
                socket.emit('party_error', '🎉 Party 模式中，请通过队列点歌');
                return;
            }
        }
        // (Chrome removed — server-driven playback)

        // Don't relay next/prev to Chrome (headless Chrome has empty songs list)
        // Server handles them via skipTrack which emits the result to all clients
        if (data.type !== 'next' && data.type !== 'prev') {
            socket.to(room).emit('player_action', data);
        }
        // Trigger CDP audio play for headless Chrome
        if (sessionId && sessionId !== 'default') {
            if (data.type === 'load' && data.payload?.url) {
                sessionMgr.playTrack(sessionId, data.payload.url).catch(() => {});
                // Track current song for next/prev (just update current track)
                sessionMgr.updateTracks(sessionId, null, data.payload);
                // Store track info so ioBroadcastCallback can restore it for reconnected clients
                sessionMgr.setCurrentTrackInfo(sessionId, {
                    id: data.payload.id || data.payload.url,
                    title: data.payload.title,
                    url: data.payload.url
                });

            } else if (data.type === 'pause') {
                sessionMgr.pauseTrack(sessionId);
            } else if (data.type === 'play') {
                sessionMgr.resumeTrack(sessionId);
            } else if (data.type === 'stop') {
                sessionMgr.stopTrack(sessionId);
            } else if (data.type === 'volume' && data.payload !== undefined) {
                sessionMgr.setVolume(sessionId, data.payload).catch(() => {});
            } else if (data.type === 'seek' && data.payload !== undefined) {
                sessionMgr.seekTrack(sessionId, data.payload).catch(() => {});
            } else if (data.type === 'loop' && data.payload) {
                // Set shuffle mode on the server when Remote toggles it
                sessionMgr.setShuffleMode(sessionId, data.payload === 'shuffle');
                console.log(`[Audio] Loop mode: ${data.payload} (shuffle=${data.payload === 'shuffle'})`);
            } else if (data.type === 'next' || data.type === 'prev') {
                // Handled by socket.js's onTrackSelected hook → triggers ffplay
                console.log(`[Audio] next/prev delegated to socket.js for ${sessionId?.slice(0,8)}`);
            }
        }

    });

    // Also relay state_update with logging
    socket.on('state_update', (data) => {
        const roomSockets = io.sockets.adapter.rooms.get(room);
        const count = roomSockets ? roomSockets.size : 0;
        const keys = Object.keys(data || {}).join(',');
        if (data?.currentTrack) {
            console.log(`[state_update] ⚡ currentTrack="${data.currentTrack.title?.slice(0,30)}" from ${socket.id} → room ${room} (${count} sockets)`);
        } else {
            console.log(`[state_update] keys=[${keys}] from ${socket.id} → room ${room} (${count} sockets)`);
        }
        // Strip currentTrack from client-relayed state_updates
        // Only server's skipTrack can push currentTrack (prevents Chrome overwrite)
        const relayData = { ...data };
        if (relayData.currentTrack) {
            delete relayData.currentTrack;
            delete relayData.currentIndex;
        }
        if (Object.keys(relayData).length > 0) {
            socket.to(room).emit('state_update', relayData);
        }
        // Capture song list for server-side next/prev
        if (sessionId && sessionId !== 'default' && data) {
            try {
                if (data.songs) sessionMgr.updateTracks(sessionId, data.songs, data.currentTrack);
                else if (data.currentTrack) sessionMgr.updateTracks(sessionId, null, data.currentTrack);
                if (data.loopMode !== undefined) sessionMgr.setShuffleMode(sessionId, data.loopMode === 'shuffle');
            } catch(e) {}
        }
    });

    // Player status feedback: headless Chrome Player → Remote
    socket.on('player_status', (data) => {
        socket.to(room).emit('player_status', data);
    });

    // Delete song/playlist: set hidden=true (preserves mp3 files)
    socket.on('delete_song', (songId) => {
        try {
            const dataPath = path.join(__dirname, 'data', 'songs.json');
            const songs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
            const song = songs.find(s => String(s.id) === String(songId));
            if (song) {
                song.hidden = true;
                fs.writeFileSync(dataPath, JSON.stringify(songs, null, 2));
                console.log(`🗑️ Song hidden: ${song.title?.slice(0,40)} (id: ${songId})`);
                // Notify all clients in room to refresh
                io.to(room).emit('data_updated', { type: 'song_deleted', songId });
            }
        } catch (e) { console.error('delete_song error:', e.message); }
    });


    // === Party Mode Socket Events ===
    socket.on('party_join', (data, ack) => {
        const { userId, nickname, photoUrl } = data || {};
        if (!userId || !nickname) return ack?.({ error: '缺少用户信息' });
        // Force-cleanup stale socket claims before registering
        const uid = String(userId);
        const existingSocketId = partyMgr.getClaimedSocket?.(uid);
        if (existingSocketId && existingSocketId !== socket.id) {
            const existingSocket = io.sockets.sockets.get(existingSocketId);
            if (!existingSocket || !existingSocket.connected) {
                console.log(`🧹 [Party] Cleaning stale socket ${existingSocketId} for ${nickname}`);
                partyMgr.unregisterUser(existingSocketId);
            }
        }
        const result = partyMgr.registerUser(socket.id, uid, nickname, photoUrl || '');
        if (result.error) return ack?.({ error: result.error });
        ack?.({ success: true });
        // Send current party state
        socket.emit('party_update', partyMgr.getState());
    });

    socket.on('party_add', (data, ack) => {
        const user = partyMgr.getUserBySocket(socket.id);
        if (!user) return ack?.({ error: '请先选择身份' });
        const { song } = data || {};
        if (!song || !song.id) return ack?.({ error: '无效歌曲' });
        const result = partyMgr.addToQueue(song, user.userId, user.nickname, user.photoUrl);
        if (result.error) return ack?.({ error: result.error });
        // Broadcast updated queue to all clients
        io.emit('party_update', partyMgr.getState());
        ack?.({ success: true, item: result.item });
    });

    socket.on('party_remove', (data, ack) => {
        const user = partyMgr.getUserBySocket(socket.id);
        if (!user) return ack?.({ error: '请先选择身份' });
        const { queueId } = data || {};
        const result = partyMgr.removeFromQueue(queueId, user.userId);
        if (result.error) return ack?.({ error: result.error });
        
        // If removed song was playing, auto-play next from queue
        if (result.wasPlaying) {
            const next = partyMgr.onTrackEnd();
            if (next && sessionId && sessionId !== 'default') {
                console.log(`🎉 [Party] Auto-next after remove: ${next.song.title?.slice(0, 30)}`);
                sessionMgr.playTrack(sessionId, next.song.url).catch(() => {});
                sessionMgr.updateTracks(sessionId, null, next.song);
                io.to(room).emit('state_update', {
                    currentTrack: { id: next.song.id || next.song.url, title: next.song.title, url: next.song.url }
                });
            } else if (!next) {
                // Queue empty, stop playback
                if (sessionId && sessionId !== 'default') {
                    sessionMgr.stopTrack(sessionId);
                }
                io.to(room).emit('state_update', { currentTrack: null, playing: false });
            }
        }
        
        io.emit('party_update', partyMgr.getState());
        ack?.({ success: true });
    });

    // Party: play next from queue
    socket.on('party_play', (data, ack) => {
        const ps = partyMgr.getState();
        if (!ps.enabled) return ack?.({ error: 'Party 模式未开启' });
        
        const waiting = ps.queue.filter(q => q.status === 'waiting');
        if (waiting.length === 0) return ack?.({ error: '队列为空' });
        
        const lastUserId = ps.currentItem?.userId;
        const next = partyMgr.onTrackEnd(); // Gets next via round-robin
        if (!next) return ack?.({ error: '无可播放歌曲' });
        
        console.log(`🎉 [Party] Playing: ${next.song.title?.slice(0, 30)} by ${next.nickname}`);
        
        // Load the song via the normal player path
        if (sessionId && sessionId !== 'default') {
            sessionMgr.playTrack(sessionId, next.song.url).catch(() => {});
            sessionMgr.updateTracks(sessionId, null, next.song);
        }
        // Broadcast to all clients
        io.to(room).emit('player_action', { type: 'load', payload: next.song });
        io.to(room).emit('state_update', {
            currentTrack: { id: next.song.id || next.song.url, title: next.song.title, url: next.song.url }
        });
        io.emit('party_update', partyMgr.getState());
        ack?.({ success: true, item: next });
    });

    // Send party state on connect
    socket.emit('party_update', partyMgr.getState());

    // Explicit request for party state (in case initial emit was missed)
    socket.on('get_party_state', () => {
        socket.emit('party_update', partyMgr.getState());
    });

    socket.on('delete_playlist', (playlistId) => {
        try {
            const plPath = path.join(__dirname, 'data', 'playlists.json');
            const playlists = JSON.parse(fs.readFileSync(plPath, 'utf8'));
            const pl = playlists.find(p => String(p.id) === String(playlistId));
            if (pl) {
                pl.hidden = true;
                fs.writeFileSync(plPath, JSON.stringify(playlists, null, 2));
                console.log(`🗑️ Playlist hidden: ${pl.name} (id: ${playlistId})`);
                // Also hide all songs in this playlist
                const songsPath = path.join(__dirname, 'data', 'songs.json');
                const songs = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
                let count = 0;
                songs.forEach(s => { if (String(s.playlistId) === String(playlistId)) { s.hidden = true; count++; } });
                fs.writeFileSync(songsPath, JSON.stringify(songs, null, 2));
                console.log(`🗑️ Hidden ${count} songs in playlist ${pl.name}`);
                io.to(room).emit('data_updated', { type: 'playlist_deleted', playlistId });
            }
        } catch (e) { console.error('delete_playlist error:', e.message); }
    });


    // Voice Slots: activate, voice_data relay, reset
    socket.on('activate_slot', ({ slotId }) => {
        const vsUid = socket.handshake.auth?.userId || socket.id;
        const sessions = voiceUserSessions.get(vsUid) || [];

        if (sessions.some(s => s.stage === 'active')) return;
        if (sessions.some(s => s.slotId === slotId && s.stage === 'silence')) return;

        const template = SLOT_TEMPLATES.find(t => t.id === slotId);
        if (!template) return;

        const newSession = {
            slotId,
            endTime: Date.now() + template.duration * 1000,
            label: template.label,
            socketId: socket.id,
            stage: 'active',
            duration: template.duration
        };

        sessions.push(newSession);
        voiceUserSessions.set(vsUid, sessions);
        socket.emit('my_slot_update', sessions);
        io.to(room).emit('slots_update', Array.from(voiceUserSessions.values()).flat());
        console.log(`🎙️ [VoiceSlot] ${vsUid} activated slot ${slotId} (${template.label})`);
    });

    socket.on('set_voice_enabled', (enabled) => {
        globalVoiceEnabled = !!enabled;
        io.emit('voice_enabled', globalVoiceEnabled);
        console.log(`🎙️ [Voice] Enabled: ${globalVoiceEnabled}`);
    });

    // Voice-to-PulseAudio: per-user ffmpeg process
    const voiceFfmpegProcs = new Map();  // userId -> ffmpeg process

    socket.on('voice_data', (data) => {
        const vsUid = socket.handshake.auth?.userId || socket.id;
        data.userId = vsUid;
        const sessions = voiceUserSessions.get(vsUid) || [];
        const activeSession = sessions.find(s => s.stage === 'active');

        if (activeSession) {
            if (data.isHeader) activeSession.header = data.buffer;
            if (activeSession.header) data.header = activeSession.header;
            const roomSockets = io.sockets.adapter.rooms.get(room);
            const cnt = roomSockets ? roomSockets.size : 0;
            if (data.isHeader || !data._logged) {
                console.log(`🎙️ [voice_data] from ${vsUid} → room ${room} (${cnt} sockets), header=${!!data.isHeader}, bytes=${data.buffer?.length || data.data?.length || '?'}`);
                data._logged = true;
            }
            socket.to(room).emit('voice_data', data);

            // Pipe to PulseAudio via ffmpeg (server-side voice output)
            const sessId = socket.handshake.auth?.sessionId || 'default';
            const sess = sessionMgr.getSession(sessId);
            if (sess && sess.sinkName && data.buffer) {
                let ff = voiceFfmpegProcs.get(vsUid);
                if (!ff || ff.killed || ff.exitCode !== null) {
                    // Determine input format from data.type
                    const isMP4 = (data.type || '').includes('mp4');
                    const inputFmt = isMP4 ? 'mp4' : 'webm';
                    try {
                        ff = require('child_process').spawn('sudo', [
                            '-u', 'studio', 'env',
                            'XDG_RUNTIME_DIR=/tmp/runtime-studio',
                            'PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native',
                            `PULSE_SINK=${sess.sinkName}`,
                            'ffmpeg', '-f', inputFmt, '-i', 'pipe:0',
                            '-f', 'pulse', '-ac', '2', '-ar', '48000',
                            '-'
                        ], { stdio: ['pipe', 'ignore', 'pipe'] });
                        ff.stderr.on('data', (d) => {
                            const msg = d.toString().trim();
                            if (msg && !msg.includes('size=') && !msg.includes('bitrate='))
                                console.log(`🎙️ [ffmpeg voice] ${vsUid}: ${msg.substring(0, 100)}`);
                        });
                        ff.on('exit', (code) => {
                            console.log(`🎙️ [ffmpeg voice] ${vsUid} exited (code ${code})`);
                            voiceFfmpegProcs.delete(vsUid);
                            // Unduck: restore ffplay volume if no other voice active
                            if (voiceFfmpegProcs.size === 0 && sess._duckedSinkInput) {
                                try {
                                    const { execSync } = require('child_process');
                                    execSync(`sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl set-sink-input-volume ${sess._duckedSinkInput} 100% 2>/dev/null`);
                                    console.log(`🔊 [Duck] Restored sink-input ${sess._duckedSinkInput} to 100%`);
                                    delete sess._duckedSinkInput;
                                } catch(e) {}
                            }
                        });
                        voiceFfmpegProcs.set(vsUid, ff);
                        console.log(`🎙️ [ffmpeg voice] Started for ${vsUid} → ${sess.sinkName} (${inputFmt})`);
                        // Duck music: lower ffplay volume
                        if (sess.ffplayProc && sess.ffplayProc.pid) {
                            const { execSync } = require('child_process');
                            try {
                                // Find ffplay's sink-input index and lower to 30%
                                const out = execSync(`sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl list short sink-inputs 2>/dev/null`).toString();
                                const lines = out.trim().split('\n');
                                for (const line of lines) {
                                    const parts = line.split('\t');
                                    if (parts[1] === String(sess.sinkIndex || '')) continue; // skip bridge
                                    // Find sink-input on our session sink
                                    const sinkId = parts[1];
                                    // Check if this is ffplay by matching sink
                                    if (line.includes('protocol-native')) {
                                        execSync(`sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl set-sink-input-volume ${parts[0]} 30% 2>/dev/null`);
                                        sess._duckedSinkInput = parts[0];
                                        console.log(`🔉 [Duck] Lowered sink-input ${parts[0]} to 30%`);
                                        break;
                                    }
                                }
                            } catch(e) {}
                        }
                    } catch (e) {
                        console.log(`🎙️ [ffmpeg voice] Spawn error: ${e.message}`);
                    }
                }
                // Write voice data to ffmpeg stdin
                if (ff && ff.stdin && !ff.stdin.destroyed) {
                    try {
                        ff.stdin.write(Buffer.from(data.buffer));
                    } catch (e) {}
                }
            }
        } else {
            console.log(`🎙️ [voice_data] from ${vsUid} - NO active session, skipped`);
        }
    });

    // Cleanup ffmpeg on disconnect
    socket.on('disconnect', () => {
        voiceFfmpegProcs.forEach((ff, uid) => {
            try { ff.stdin.end(); ff.kill(); } catch (_) {}
        });
    });

    socket.on('reset_slots', (pwd) => {
        // Verify using slots password hash (same as production)
        const slotsHashFile = require('path').join(__dirname, '.auth', 'slots.hash');
        try {
            const stored = require('fs').readFileSync(slotsHashFile, 'utf8').trim();
            const hash = require('crypto').createHash('sha256').update(pwd, 'utf8').digest('hex');
            if (require('crypto').timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored, 'hex'))) {
                voiceUserSessions.clear();
                io.emit('my_slot_update', []);
                io.emit('slots_update', []);
                io.emit('force_reset');
                console.log('🎙️ [VoiceSlot] All slots reset');
            }
        } catch (_) {}
    });

    socket.on('disconnect', () => {
        partyMgr.unregisterUser(socket.id);
        console.log(`User disconnected: ${socket.id} session: ${sessionId}`);
    });
});


const PORT = 3096;

// ==================== Auth System (SHA256 + Token) ====================
const AUTH_DIR = path.join(__dirname, '.auth');
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { mode: 0o700 });

// Persist SESSION_SECRET across restarts so existing tokens remain valid
const SECRET_FILE = path.join(AUTH_DIR, 'session_secret');
let SESSION_SECRET;
try {
    SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch (_) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 }); } catch (_) {}
}

function getPasswordHash(type) {
    const file = path.join(AUTH_DIR, `${type}.hash`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8').trim();
}

function hashPassword(plain) {
    return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

function verifyPassword(type, plain) {
    const stored = getPasswordHash(type);
    if (!stored) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(hashPassword(plain), 'hex'),
            Buffer.from(stored, 'hex')
        );
    } catch { return false; }
}

function createToken(type) {
    const payload = `${type}:${Date.now()}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

function verifyToken(token, requiredType) {
    if (!token) return false;
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx < 0) return false;
    const payload = token.substring(0, dotIdx);
    const sig = token.substring(dotIdx + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    } catch { return false; }
    const [type, ts] = payload.split(':');
    if (requiredType && type !== requiredType) return false;
    return (Date.now() - parseInt(ts, 10)) < SESSION_TTL;
}

// Auth middleware
function requireAuth(type) {
    return (req, res, next) => {
        const token = req.headers['x-auth-token'];
        if (verifyToken(token, type)) return next();
        return res.status(401).json({ error: '请先验证密码' });
    };
}

// ==================== Standard Setup ====================
app.use(cors({ origin: 'https://clubhouses.party' }));
app.use(express.json());

// === Party Mode API (must be after express.json) ===
app.get('/api/party', (req, res) => {
    res.json(partyMgr.getState());
});

app.get('/api/party/room-users', (req, res) => {
    const data = partyMgr.getRoomUsers();
    res.json(data);
});

app.post('/api/party/toggle', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (!token || !verifyToken(token, 'player')) {
        return res.status(401).json({ error: '需要管理员权限' });
    }
    const { enabled } = req.body;
    const result = partyMgr.toggle(!!enabled);
    io.emit('party_update', partyMgr.getState());
    res.json(result);
});

app.use(express.static(path.join(__dirname, 'client/dist')));
app.use('/storage', express.static(path.join(__dirname, 'storage'), {
    setHeaders: (res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));

// Ensure directories
['storage', 'storage/lyrics', 'data'].forEach(d => {
    const p = path.join(__dirname, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ==================== Auth Routes ====================
// Rate limit: max 5 login attempts per IP per minute
const loginAttempts = new Map();
setInterval(() => loginAttempts.clear(), 60 * 1000);

app.post('/api/auth/login', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const attempts = loginAttempts.get(ip) || 0;
    if (attempts >= 5) {
        console.log(`🚫 Rate limit: ${ip} (${attempts} attempts)`);
        return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
    }
    loginAttempts.set(ip, attempts + 1);

    const { password, type } = req.body;
    if (!password || !type) return res.status(400).json({ error: '缺少密码或类型' });
    if (!verifyPassword(type, password)) return res.status(401).json({ error: '密码错误' });
    loginAttempts.delete(ip); // Reset on success
    res.json({ token: createToken(type) });
});

app.get('/api/auth/verify', (req, res) => {
    const token = req.headers['x-auth-token'];
    const type = req.query.type;
    res.json({ valid: verifyToken(token, type) });
});

// Change Password (requires player token — only accessible from Player view)
app.post('/api/auth/change-password', requireAuth('player'), (req, res) => {
    const { type, oldPassword, newPassword } = req.body;
    if (!type || !oldPassword || !newPassword) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    if (!['player', 'lyrics', 'slots', 'sleep'].includes(type)) {
        return res.status(400).json({ error: '只能修改 player、lyrics、slots 或 sleep 密码' });
    }
    if (newPassword.length < 1) {
        return res.status(400).json({ error: '新密码不能为空' });
    }
    if (!verifyPassword(type, oldPassword)) {
        return res.status(401).json({ error: '旧密码错误' });
    }
    // Write new hash
    const newHash = hashPassword(newPassword);
    fs.writeFileSync(path.join(AUTH_DIR, `${type}.hash`), newHash, { mode: 0o600 });
    console.log(`🔑 ${type} 密码已修改`);
    res.json({ status: 'ok' });
});

// ==================== Cookie Management ====================
const saveCookies = (content) => {
    fs.writeFileSync(path.join(__dirname, 'cookies.txt'), content);
};

app.post('/api/cookies', requireAuth('player'), (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).send('No content');
    saveCookies(content);
    res.json({ status: 'ok' });
});

// ==================== Download & Parse ====================
const { loadData, saveData } = require('./db');

app.post('/api/download', async (req, res) => {
    const { url, type, playlistId } = req.body;
    console.log('Download request:', url, type, playlistId);
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    const storagePath = path.join(__dirname, 'storage');
    const cookiePath = path.join(__dirname, 'cookies.txt');
    let cookieArg = [];
    if (fs.existsSync(cookiePath)) cookieArg = ['--cookies', cookiePath];

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    if (type === 'parse') {
        const args = [
            ...cookieArg,
            '--js-runtimes', 'node',
            '--user-agent', userAgent,
            '--force-ipv4', '--no-check-certificates',
            '-J', '--flat-playlist', url
        ];
        console.log(`[Parse] Executing: yt-dlp ${args.join(' ')}`);
        const child = spawn('yt-dlp', args);
        child.on('error', (e) => { console.error('[yt-dlp] spawn error:', e.message); });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`[Parse] Failed: ${stderr}`);
                fs.appendFileSync(path.join(__dirname, 'yt_errors.log'),
                    `[${new Date().toISOString()}] [Parse Error] Code ${code}, URL: ${url}, Stderr: ${stderr}\n`);
                return res.status(500).json({ error: `yt-dlp failed with code ${code}`, stderr });
            }
            try {
                const data = JSON.parse(stdout);
                const entries = data.entries || [data];
                const normalizedEntries = entries.map(e => {
                    if (!e.url && e.webpage_url) e.url = e.webpage_url;
                    if (!e.url && e.id) e.url = `https://www.youtube.com/watch?v=${e.id}`;
                    return e;
                });
                return res.json({ ...data, entries: normalizedEntries });
            } catch (e) {
                console.error(`[Parse] JSON Error: ${e.message}`);
                return res.status(500).json({ error: 'Failed to parse yt-dlp output', stderr });
            }
        });
        return;
    }

    // Download Logic
    const downloadId = Date.now().toString();
    const outputTemplate = path.join(storagePath, `${downloadId}.%(ext)s`);
    io.emit('download_progress', { url, progress: 0 });

    const downloadArgs = [
        ...cookieArg,
        '--js-runtimes', 'node',
        '--user-agent', userAgent,
        '--force-ipv4', '--no-check-certificates',
        '--no-playlist',
        '-x', '--audio-format', 'mp3',
        '-o', outputTemplate,
        url
    ];
    console.log(`[Download] Executing: yt-dlp ${downloadArgs.join(' ')}`);
    const child = spawn('yt-dlp', downloadArgs);
        child.on('error', (e) => { console.error('[yt-dlp] spawn error:', e.message); });
    let lastError = '';

    child.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+\.?\d*)%/);
        if (match) io.emit('download_progress', { url, progress: parseFloat(match[1]) });
    });
    child.stderr.on('data', (data) => {
        lastError += data.toString();
        console.error(`[Download stderr] ${data.toString().trim()}`);
    });
    child.on('close', (code) => {
        if (code === 0) {
            console.log(`[Download] Success: ${url}`);
            io.emit('download_complete', { url });
            if (playlistId) {
                const filename = `${downloadId}.mp3`;
                if (req.body.title) {
                    processMetadata(req.body.title, filename);
                } else {
                    const titleArgs = [...cookieArg, '--js-runtimes', 'node', '--user-agent', userAgent,
                        '--get-title', url];
                    const titleProcess = spawn('yt-dlp', titleArgs);
        titleProcess.on('error', (e) => { console.error('[yt-dlp] spawn error:', e.message); });
                    let titleOut = '';
                    titleProcess.stdout.on('data', d => titleOut += d.toString());
                    titleProcess.on('close', (tCode) => {
                        const title = (tCode === 0 && titleOut.trim()) ? titleOut.trim() : `Song ${downloadId}`;
                        processMetadata(title, filename);
                    });
                }
                function processMetadata(title, filename) {
                    const { playlists, songs } = loadData();
                    songs.push({
                        id: downloadId, title, url: `/storage/${filename}`,
                        playlistId, hidden: false
                    });
                    saveData(null, songs);
                    io.emit('data_update', { playlists, songs });
                }
            }
        } else {
            console.error(`[Download] Failed: ${lastError}`);
            fs.appendFileSync(path.join(__dirname, 'yt_errors.log'),
                `[${new Date().toISOString()}] [Download Error] Code ${code}, URL: ${url}\n`);
            io.emit('download_error', { url, error: lastError });
        }
    });
    res.json({ status: 'started' });
});

// ==================== Lyrics (Protected) ====================
app.post('/api/lyrics/upload', requireAuth('lyrics'), upload.single('lyric'), (req, res) => {
    const { songId } = req.body;
    if (!req.file || !songId) return res.status(400).send('Missing file or songId');
    const dest = path.join(__dirname, 'storage/lyrics', `${songId}.lrc`);
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    res.json({ status: 'ok' });
});

app.post('/api/lyrics/sync-url', requireAuth('lyrics'), async (req, res) => {
    const { url, songId } = req.body;
    if (!url || !songId) return res.status(400).send('Missing url or songId');
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://xiaojiangclub.com/' },
            timeout: 10000
        });
        const $ = cheerio.load(response.data);
        let downloadUrl = null;
        $('a').each((i, el) => {
            const text = $(el).text().trim();
            if (text.includes('立即下载LRC歌词') || text.includes('下载LRC歌词')) downloadUrl = $(el).attr('href');
        });
        if (!downloadUrl) {
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && (href.includes('.lrc') || href.includes('download/lyric'))) downloadUrl = href;
            });
        }
        if (!downloadUrl) throw new Error('Could not find download button');
        if (downloadUrl.startsWith('/')) downloadUrl = new URL(url).origin + downloadUrl;
        const lyricRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url } });
        fs.writeFileSync(path.join(__dirname, 'storage/lyrics', `${songId}.lrc`), lyricRes.data);
        res.json({ status: 'ok' });
    } catch (e) {
        console.error(`[LyricSync] Error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/lyrics/save', requireAuth('lyrics'), (req, res) => {
    const { songId, text } = req.body;
    if (!songId || text === undefined) return res.status(400).send('Missing songId or text');
    try {
        fs.writeFileSync(path.join(__dirname, 'storage/lyrics', `${songId}.lrc`), text);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== Auto Lyrics (LRCLIB) ====================

// Smart title parser: extract artist and song from YouTube-style titles
function parseTitle(raw) {
    let title = raw
        // Remove file extensions
        .replace(/\.(wmv|mp4|avi|mkv|flv|mp3|wav|flac|m4a)$/i, '')
        // Remove YouTube noise: (Official MV), [Lyric Video], 【完整版】, etc.
        .replace(/\s*[\(\[\【].*?(official|mv|lyric|video|audio|hd|hq|4k|karaoke|subtitle|without|動畫|歌詞|版|官方|完整|高清).*?[\)\]\】]/gi, '')
        .trim();

    // Try to split "Artist - Song" or "Artist-Song"
    // Prefer " - " (with spaces), fallback to "-" (without)
    let artist = '', song = '';
    const dashMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
        const left = dashMatch[1].trim();
        const right = dashMatch[2].trim();
        // Heuristic: if left contains CJK or known artist patterns, left=artist
        // Most YouTube titles are "Artist - Song"
        artist = left;
        song = right;
    } else {
        song = title;
    }

    return { artist, song, full: title };
}

// Search LRCLIB with multiple strategies
async function searchLRCLIB(artist, song, fullTitle) {
    const UA = { 'User-Agent': 'PrinceMusic/1.0 (https://clubhouses.party)' };
    const timeout = 8000;

    // Strategy 1: Precise search with track_name + artist_name
    if (artist && song) {
        try {
            const res = await axios.get('https://lrclib.net/api/search', {
                params: { track_name: song, artist_name: artist },
                headers: UA, timeout
            });
            if (res.data?.length > 0) {
                console.log(`[AutoLyrics] Strategy 1 hit: track="${song}" artist="${artist}"`);
                return res.data;
            }
        } catch { }
    }

    // Strategy 2: Search with just track_name (more flexible)
    if (song) {
        try {
            const res = await axios.get('https://lrclib.net/api/search', {
                params: { track_name: song },
                headers: UA, timeout
            });
            if (res.data?.length > 0) {
                // Filter by artist name if we have one (fuzzy match)
                if (artist) {
                    const artistLower = artist.toLowerCase();
                    const filtered = res.data.filter(r =>
                        artistLower.includes(r.artistName?.toLowerCase()) ||
                        r.artistName?.toLowerCase().includes(artistLower.split(/\s+/)[0])
                    );
                    if (filtered.length > 0) {
                        console.log(`[AutoLyrics] Strategy 2+filter hit: track="${song}" filtered by "${artist}"`);
                        return filtered;
                    }
                }
                console.log(`[AutoLyrics] Strategy 2 hit: track="${song}"`);
                return res.data;
            }
        } catch { }
    }

    // Strategy 3: Fuzzy q= search with full cleaned title
    try {
        const q = artist && song ? `${artist} ${song}` : fullTitle;
        const res = await axios.get('https://lrclib.net/api/search', {
            params: { q },
            headers: UA, timeout
        });
        if (res.data?.length > 0) {
            console.log(`[AutoLyrics] Strategy 3 hit: q="${q}"`);
            return res.data;
        }
    } catch { }

    return [];
}

app.get('/api/lyrics/auto', async (req, res) => {
    const { songId, title } = req.query;
    if (!songId || !title) return res.status(400).json({ error: 'Missing songId or title' });

    // Check if lyrics already exist locally
    const lrcPath = path.join(__dirname, 'storage/lyrics', `${songId}.lrc`);
    if (fs.existsSync(lrcPath)) {
        const text = fs.readFileSync(lrcPath, 'utf8');
        return res.json({ found: true, type: 'synced', lrc: text, source: 'local' });
    }

    const parsed = parseTitle(title);
    console.log(`[AutoLyrics] Parsed: artist="${parsed.artist}" song="${parsed.song}" (raw: "${title}")`);

    try {
        const results = await searchLRCLIB(parsed.artist, parsed.song, parsed.full);
        if (results.length === 0) {
            console.log(`[AutoLyrics] No results`);
            return res.json({ found: false });
        }

        // Priority: pick first result with syncedLyrics
        const synced = results.find(r => r.syncedLyrics);
        if (synced) {
            console.log(`[AutoLyrics] ✅ Synced: "${synced.trackName}" by ${synced.artistName}`);
            fs.mkdirSync(path.dirname(lrcPath), { recursive: true });
            fs.writeFileSync(lrcPath, synced.syncedLyrics);
            return res.json({
                found: true, type: 'synced', lrc: synced.syncedLyrics,
                source: 'lrclib', artist: synced.artistName, track: synced.trackName
            });
        }

        // Fallback: plain lyrics
        const plain = results.find(r => r.plainLyrics);
        if (plain) {
            console.log(`[AutoLyrics] 📝 Plain: "${plain.trackName}" by ${plain.artistName}`);
            return res.json({
                found: true, type: 'plain', text: plain.plainLyrics,
                source: 'lrclib', artist: plain.artistName, track: plain.trackName
            });
        }

        return res.json({ found: false });
    } catch (e) {
        console.error(`[AutoLyrics] Error:`, e.message);
        return res.json({ found: false, error: e.message });
    }
});

// Delete auto-saved lyrics (for "replace lyrics" feature)
app.delete('/api/lyrics/auto', requirePlayerAuth, (req, res) => {
    const { songId } = req.query;
    if (!songId) return res.status(400).json({ error: 'Missing songId' });
    const lrcPath = path.join(__dirname, 'storage/lyrics', `${songId}.lrc`);
    try {
        if (fs.existsSync(lrcPath)) fs.unlinkSync(lrcPath);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== Socket.IO ====================
const sessionManager = require('./socket')(io);

// Wire up socket.js track selection → ffplay for broadcast sessions
sessionManager.setOnTrackSelected((sessionId, track) => {
    if (sessionId && sessionId !== 'default' && track && track.url) {
        sessionMgr.playTrack(sessionId, track.url).catch(() => {});
        sessionMgr.updateTracks(sessionId, null, track);
    }
});

// Client-side routing fallback


// Auth middleware for session management
function requirePlayerAuth(req, res, next) {
    // Internal requests from server itself (auto-keepalive, etc.) bypass auth
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    const token = req.headers['x-auth-token'];
    if (!token) {
        console.log(`🔒 [Auth] REJECTED ${req.method} ${req.path} from ${ip} - no token`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // Verify the token
    if (!verifyToken(token, 'player')) {
        console.log(`🔒 [Auth] REJECTED ${req.method} ${req.path} from ${ip} - invalid token`);
        return res.status(401).json({ error: 'Invalid token' });
    }
    next();
}


// Sync playlists from production
app.post('/api/sync-playlists', requirePlayerAuth, (req, res) => {
    try {
        const prodDir = '/root/prince-music/data';
        const stagingDir = path.join(__dirname, 'data');
        if (!fs.existsSync(stagingDir)) fs.mkdirSync(stagingDir, { recursive: true });

        // Merge playlists AND songs: prod base + staging-only additions
        const prodPlaylists = JSON.parse(fs.readFileSync(path.join(prodDir, 'playlists.json'), 'utf8'));
        const prodSongs = JSON.parse(fs.readFileSync(path.join(prodDir, 'songs.json'), 'utf8'));
        let stagingPlaylists = [];
        let stagingSongs = [];
        try { stagingPlaylists = JSON.parse(fs.readFileSync(path.join(stagingDir, 'playlists.json'), 'utf8')); } catch(_) {}
        try { stagingSongs = JSON.parse(fs.readFileSync(path.join(stagingDir, 'songs.json'), 'utf8')); } catch(_) {}

        // Merge playlists: prod + staging-only playlists (FIX: was overwriting before)
        const prodPlIds = new Set(prodPlaylists.map(p => String(p.id)));
        const stagingOnlyPlaylists = stagingPlaylists.filter(p => !prodPlIds.has(String(p.id)));
        const mergedPlaylists = [...prodPlaylists, ...stagingOnlyPlaylists];

        // Merge songs: prod + staging-only songs
        const prodIds = new Set(prodSongs.map(s => String(s.id)));
        const stagingOnlySongs = stagingSongs.filter(s => !prodIds.has(String(s.id)));
        const mergedSongs = [...prodSongs, ...stagingOnlySongs];

        fs.writeFileSync(path.join(stagingDir, 'playlists.json'), JSON.stringify(mergedPlaylists, null, 2));
        fs.writeFileSync(path.join(stagingDir, 'songs.json'), JSON.stringify(mergedSongs, null, 2));

        console.log(`🔄 Sync: ${prodPlaylists.length} prod playlists + ${stagingOnlyPlaylists.length} staging-only = ${mergedPlaylists.length} total`);
        console.log(`🔄 Sync: ${prodSongs.length} prod songs + ${stagingOnlySongs.length} staging-only = ${mergedSongs.length} total`);
        res.json({
            success: true,
            playlists: mergedPlaylists.length,
            songs: mergedSongs.length,
            stagingOnlyPlaylists: stagingOnlyPlaylists.length,
            stagingOnlySongs: stagingOnlySongs.length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === Session Management API ===
app.get('/api/sessions', (req, res) => {
    res.json(sessionMgr.listSessions());
});

app.post('/api/sessions/create', requirePlayerAuth, async (req, res) => {
    try {
        const result = await sessionMgr.createSession();
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/delete', requirePlayerAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    try {
        const result = await sessionMgr.deleteSession(sessionId);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});






// chweb auto-login page — serves HTML that injects JWT into localStorage
app.get('/chweb-login-page', async (req, res) => {
    try {
        const jwtFile = '/root/chweb-jwt.json';
        if (!require('fs').existsSync(jwtFile)) {
            return res.send('<html><body>JWT not found</body></html>');
        }
        const { jwt: chwebJwt } = JSON.parse(require('fs').readFileSync(jwtFile, 'utf8'));
        const resp = await axios.get('http://127.0.0.1:8080/api/user_info', {
            headers: { 'Authorization': 'Bearer ' + chwebJwt }
        });
        const userData = { ...resp.data, token: chwebJwt };
        const userJson = JSON.stringify(userData);
        res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>chweb login</title></head>
<body><p>Logging in to chweb...</p>
<script>
localStorage.setItem('user', ${JSON.stringify(userJson)});
window.location.href = '/chweb/#/channels';
</script></body></html>`);
    } catch (e) {
        res.send('<html><body>Error: ' + e.message + '</body></html>');
    }
});

// ==================== Chweb JWT (pre-auth token injection) ====================
// fs already required at top


// GET /api/chweb-autologin — return JS snippet for chweb localStorage injection
app.get('/api/chweb-autologin', requirePlayerAuth, async (req, res) => {
    try {
        // fs already required at top
        const jwtFile = '/root/chweb-jwt.json';
        if (!fs.existsSync(jwtFile)) {
            return res.status(404).json({ error: 'JWT not found' });
        }
        const { jwt: chwebJwt } = JSON.parse(fs.readFileSync(jwtFile, 'utf8'));
        // Call chweb user_info exactly as AuthService.ts does
        const resp = await axios.get('http://127.0.0.1:8080/api/user_info', {
            headers: { 'Authorization': 'Bearer ' + chwebJwt }
        });
        const userData = { ...resp.data, token: chwebJwt };
        // Build the JS snippet that sets localStorage and reloads
        const jsSnippet = `localStorage.setItem('user', ${JSON.stringify(JSON.stringify(userData))}); location.reload();`;
        res.json({ script: jsSnippet, userId: userData.user_id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/chweb-jwt — returns the forged JWT for browser localStorage injection
app.get('/api/chweb-jwt', requirePlayerAuth, (req, res) => {
    try {
        const jwtFile = '/root/chweb-jwt.json';
        if (fs.existsSync(jwtFile)) {
            const data = JSON.parse(fs.readFileSync(jwtFile, 'utf8'));
            res.json({ jwt: data.jwt, created: data.created });
        } else {
            res.status(404).json({ error: 'JWT not found. Run /tmp/fix_jwt_roles.py on VPS.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/chweb/join — join a Clubhouse room via chweb API using JWT auth
app.post('/api/chweb/join', requirePlayerAuth, async (req, res) => {
    const { channel } = req.body;
    if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
    try {
        // Load JWT
        const jwtFile = '/root/chweb-jwt.json';
        if (!fs.existsSync(jwtFile)) {
            return res.json({ success: false, error_message: 'chweb JWT not found' });
        }
        const { jwt: chwebJwt } = JSON.parse(fs.readFileSync(jwtFile, 'utf8'));
        const { data } = await axios.post('http://127.0.0.1:8080/api/join_channel',
            { channel },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${chwebJwt}`
                },
                timeout: 15000
            }
        );
        console.log(`🎙️ chweb join result: success=${data.success}, err=${data.error_message}`);
        res.json(data);
    } catch (e) {
        const errData = e.response?.data || { error_message: e.message };
        console.error('[chweb/join] Error:', errData.error_message || e.message);
        res.json({ success: false, error_message: errData.error_message || e.message });
    }
});

// ==================== Unified Broadcast API ====================

// Extract channel slug from Clubhouse URL
async function resolveChannelSlugFromPage(url, sourceLabel) {
    try {
        let fetchUrl = url.trim();
        if (!fetchUrl.match(/^https?:\/\//i)) fetchUrl = 'https://' + fetchUrl;
        const resp = await fetch(fetchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
            redirect: 'follow'
        });
        if (!resp.ok) {
            console.log(`  ⚠️ extractChannelSlug: ${sourceLabel} page returned HTTP ${resp.status}`);
            return null;
        }
        const html = await resp.text();
        // Primary source: og:image points to share.clubhouse.com/og/room/CHANNEL[:TOKEN].png
        const ogMatch = html.match(/share\.clubhouse\.com\/og\/room\/([^.]+)\.png/);
        if (ogMatch) {
            const slug = decodeURIComponent(ogMatch[1]);
            console.log(`  📋 extractChannelSlug (${sourceLabel}→og:image): "${slug}"`);
            return slug;
        }
        // Fallback: explicit channel:token pattern somewhere in page source
        const ctMatch = html.match(/([A-Za-z0-9]{8,20}:[A-Za-z0-9_-]{20,})/);
        if (ctMatch) {
            console.log(`  📋 extractChannelSlug (${sourceLabel}→pattern): "${ctMatch[1]}"`);
            return ctMatch[1];
        }
        console.log(`  ⚠️ extractChannelSlug: ${sourceLabel} page fetched but no canonical channel slug found`);
        return null;
    } catch (e) {
        console.log(`  ⚠️ extractChannelSlug: Failed to fetch ${sourceLabel} page: ${e.message}`);
        return null;
    }
}

async function extractChannelSlug(url) {
    if (!url) return null;
    // URL decode first to handle %3A (colon), %E6... (unicode) etc
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch(e) {}
    // Handle /room/ links: https://www.clubhouse.com/room/SLUG:TOKEN?...
    const roomMatch = decoded.match(/room\/([^?\s]+)/);
    if (roomMatch) {
        const roomSlug = roomMatch[1];
        console.log(`  📋 extractChannelSlug (room): "${roomSlug}"`);
        // Old canonical format already contains channel:token and can be used directly.
        if (roomSlug.includes(':')) return roomSlug;
        // New short /room/<code> links are not valid join_channel IDs; resolve via page HTML.
        const resolved = await resolveChannelSlugFromPage(url, 'room');
        if (resolved) return resolved;
        console.log(`  ⚠️ extractChannelSlug: /room/ short code "${roomSlug}" could not be resolved`);
        return null;
    }
    // Handle new /i/ links: https://www.clubhouse.com/i/房间名/shortCode
    const inviteMatch = decoded.match(/clubhouse\.com\/i\/([^/]+)\/([^?\s]+)/);
    if (inviteMatch) {
        console.log(`  📋 extractChannelSlug: New /i/ format detected: room="${inviteMatch[1]}", code="${inviteMatch[2]}"`);
        return await resolveChannelSlugFromPage(url, 'invite');
    }
    // Handle /house/ links - these are Club links, not room links
    const houseMatch = decoded.match(/house\/([^?\s]+)/);
    if (houseMatch) {
        console.log(`  ⚠️ extractChannelSlug: Got a /house/ (Club) link, not a /room/ link`);
        return null; // Will trigger "Missing roomUrl" error
    }
    // Treat as raw channel ID
    const slug = decoded.trim();
    console.log(`  📋 extractChannelSlug (raw): "${slug}"`);
    return slug;
}

// POST /api/broadcast/start
// body: { mode: "player-only" | "create-room" | "join-room", roomUrl?: string, topic?: string }
app.post('/api/broadcast/start', requirePlayerAuth, async (req, res) => {
    const { mode, roomUrl, topic, accountId } = req.body;
    if (!['player-only', 'create-room', 'join-room'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode. Use: player-only, create-room, join-room' });
    }

    try {
        let requestedChannel = null;
        if (mode === 'join-room') {
            requestedChannel = await extractChannelSlug(roomUrl);
            if (!requestedChannel) {
                return res.status(400).json({ error: '无法从房间链接解析真实房间 ID。请粘贴有效的 Clubhouse 房间分享链接。' });
            }
        }

        // 0. Auto-replace: stop existing session for same account to prevent duplicates
        try {
            const _raw = sessionMgr.listSessions();
            const existingSessions = _raw && _raw.sessions ? _raw.sessions : (Array.isArray(_raw) ? _raw : []);
            for (let _i = 0; _i < existingSessions.length; _i++) {
                const existing = existingSessions[_i];
                const existingAccount = existing.accountId || null;
                if (existingAccount === (accountId || null)) {
                    console.log('  ♻️ Replacing existing session ' + existing.shortId + ' (same account: ' + (accountId || 'default') + ')');
                    await sessionMgr.deleteSession(existing.sessionId);
                }
            }
        } catch (replaceErr) {
            console.log('  ⚠️ Auto-replace check failed: ' + replaceErr.message);
        }

        // 1. Create session (Chrome + PulseAudio + agora-bridge)
        console.log(`🚀 Broadcast start: mode=${mode}, account=${accountId || 'default'}`);
        const session = await sessionMgr.createSession(mode !== 'player-only');
        if (session.error) return res.status(400).json(session);
        // Store accountId for this session
        if (accountId) sessionMgr.setSessionMeta(session.sessionId, 'accountId', accountId);

        let roomInfo = null;

        if (mode === 'create-room') {
            // 2a. Create Clubhouse room
            try {
                const roomTopic = topic || '🎵 Music Studio';
                const data = await clubhousePost('create_channel', {
                    topic: roomTopic,
                    privacy_level: 'public',
                    is_social_mode: false,
                    is_replay_enabled: false,
                }, accountId);
                if (data.success !== false) {
                    const createAccount = getAccount(accountId);
                    roomInfo = {
                        channel: data.channel,
                        channelId: data.channel_id,
                        topic: roomTopic,
                        token: data.token,
                        agoraInfo: data.agora_info,
                        url: data.url || `https://www.clubhouse.com/room/${data.channel}`,
                        botUserId: createAccount ? createAccount.userId : CH_BOT_USER_ID,
                    };
                    console.log(`  📡 Room created: ${data.channel}`);
                    // Phase 3: Disable replay and hide from profile
                    try {
                        await clubhousePost('disable_replay', { channel: data.channel, channel_id: data.channel_id }, accountId);
                        console.log('  🔇 Replay disabled');
                    } catch (replayErr) {
                        console.log('  ⚠️ disable_replay failed:', replayErr.message);
                    }
                    try {
                        await clubhousePost('hide_channel_from_replay_profile', { channel: data.channel, channel_id: data.channel_id }, accountId);
                        console.log('  🙈 Replay hidden from profile');
                    } catch (hideErr) {
                        console.log('  ⚠️ hide_replay_from_profile failed:', hideErr.message);
                    }
                } else {
                    console.error('  ❌ Create room failed:', data.error_message);
                }
            } catch (e) {
                console.error('  ❌ Create room error:', e.response?.data || e.message);
            }
        } else if (mode === 'join-room') {
            // 2b. Join existing room
            const channel = requestedChannel;
            try {
                // First try chweb API (only for main account — chweb JWT belongs to main)
                let data;
                if (!accountId || accountId === 'main') {
                    try {
                        const jwtFile = '/root/chweb-jwt.json';
                        if (require('fs').existsSync(jwtFile)) {
                            const { jwt: chwebJwt } = JSON.parse(require('fs').readFileSync(jwtFile, 'utf8'));
                            const r = await axios.post('http://127.0.0.1:8080/api/join_channel',
                                { channel, attribution_source: 'feed', attribution_details: 'eyJpc19leHBsb3JlIjpmYWxzZSwiY2hhbm5lbF90b3BpYyI6bnVsbH0=' },
                                { headers: { 'Authorization': `Bearer ${chwebJwt}`, 'Content-Type': 'application/json' }, timeout: 15000 }
                            );
                            data = r.data;
                            console.log('  🌐 join via chweb:', data.success, data.error_message);
                        }
                    } catch (e) { console.log('  ⚠️ chweb join failed, falling back to direct API:', e.response?.data || e.message); }
                } else {
                    console.log(`  ℹ️ Skipping chweb join for non-main account (${accountId})`);
                }
                // Fallback to direct Clubhouse API
                if (!data) data = await clubhousePost('join_channel', { channel, attribution_source: 'feed', attribution_details: 'eyJpc19leHBsb3JlIjpmYWxzZSwiY2hhbm5lbF90b3BpYyI6bnVsbH0=' }, accountId);
                if (data.success !== false) {
                    const joinAccount = getAccount(accountId);
                    roomInfo = {
                        channel: data.channel || channel,
                        channelId: data.channel_id,
                        token: data.token,
                        agoraInfo: data.agora_info,
                        url: data.url || `https://www.clubhouse.com/room/${data.channel || channel}`,
                        users: data.users?.length || 0,
                        botUserId: joinAccount ? joinAccount.userId : CH_BOT_USER_ID,
                    };
                    console.log(`  🎙️ Joined room: slug=${channel}, api_channel=${data.channel}, roomInfo.channel=${roomInfo.channel}`);
                    // Auto become speaker immediately after joining
                    try {
                        const joinChannel = roomInfo.channel || channel;
                        const bsData = await clubhousePost('become_speaker', { channel: joinChannel }, accountId);
                        if (bsData && (bsData.token || bsData.success !== false)) {
                            console.log(`  🎤 Auto become_speaker succeeded!`);
                            // CRITICAL: Replace audience token with speaker token
                            if (bsData.token) {
                                roomInfo.token = bsData.token;
                                console.log(`  🔑 roomInfo.token updated to speaker token`);
                            }
                            // Also update agora_info if available
                            if (bsData.agora_info) {
                                roomInfo.agoraInfo = bsData.agora_info;
                            }
                            // Unmute via API
                            try {
                                await clubhousePost('update_channel_user_status', { channel: joinChannel, is_muted: false }, accountId);
                                console.log(`  🔊 Auto-unmuted after join`);
                            } catch (ue) { /* ignore */ }
                        }
                    } catch (bsErr) {
                        console.log(`  ⚠️ Auto become_speaker after join: ${bsErr.message}`);
                    }
                    // Store channel + roomInfo in session for auto-leave and Broadcast UI
                    if (session && session.sessionId) {
                        sessionMgr.setSessionChannel(session.sessionId, roomInfo.channel || channel);
                        sessionMgr.setSessionMeta(session.sessionId, 'roomInfo', roomInfo);
                    }
                    // Auto-start server-side keepalive for joined room
                    const kaChannel = roomInfo.channel || channel;
                    (async () => {
                        try {
                            // Reuse the same keepalive start logic from /api/clubhouse/start_keepalive
                            console.log(`  💓 Auto-keepalive starting: channel=${kaChannel}, accountId=${accountId || 'default'}`);
                            const kaRes = await fetch(`http://127.0.0.1:${PORT}/api/clubhouse/start_keepalive`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ channel: kaChannel, accountId })
                            });
                            const kaData = await kaRes.json();
                            console.log('  💓 Auto-keepalive:', kaData.success ? `started (bot: ${kaData.botUserId})` : kaData.error_message);
                        } catch (ke) {
                            console.log('  ⚠️ Auto-keepalive request failed:', ke.message);
                        }
                    })();
                } else {
                    console.error('  ❌ Join room failed:', data.error_message);
                    roomInfo = { error: data.error_message, channel };
                }
            } catch (e) {
                console.error('  ❌ Join room error:', e.response?.data || e.message);
                roomInfo = { error: e.response?.data?.error_message || e.message, channel };
            }
        }

        if (mode !== 'player-only' && (!roomInfo || roomInfo.error || !roomInfo.channel || !roomInfo.token)) {
            const failureReason = roomInfo?.error || (mode === 'join-room' ? '加入房间失败' : '创建房间失败');
            try {
                await sessionMgr.deleteSession(session.sessionId);
            } catch (cleanupErr) {
                console.log(`  ⚠️ Cleanup after ${mode} failure failed: ${cleanupErr.message}`);
            }
            return res.status(400).json({ error: failureReason });
        }

        // === Server-side Bridge Join: connect bridge to Agora (fire-and-forget) ===
        // Bridge keeps Agora connection alive even after WS closes, so we just need
        // to send join+unmute once and then disconnect. No persistent WS needed!
        if (roomInfo && roomInfo.channel && roomInfo.token && session.bridgePort && !roomInfo.error && mode !== 'player-only') {
            const _bp = session.bridgePort;
            const _tk = roomInfo.token;
            const _ch = roomInfo.channel;
            const _uid = roomInfo.botUserId || 450417781;
            const _aid = roomInfo.agoraInfo?.app_id || '938de3e8055e42b281bb8c6f69c21f78';
            const _sid = session.sessionId;
            const _sm = require('./session-manager');
            const _waitForBridgeReady = async (port, maxWaitMs = 150000, intervalMs = 2000) => {
                const start = Date.now();
                let logged = false;
                while (Date.now() - start < maxWaitMs) {
                    try {
                        const check = require('child_process').execSync(
                            `curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:${port}/ 2>/dev/null || echo 000`,
                            { encoding: 'utf8', timeout: 2000 }
                        ).trim();
                        if (check === '426') {
                            console.log(`[Bridge] Ready on port ${port} after ${Math.round((Date.now() - start) / 1000)}s`);
                            return port;
                        }
                        if (!logged) {
                            console.log(`[Bridge] Waiting for port ${port} to become ready (HTTP ${check})...`);
                            logged = true;
                        }
                    } catch (_) {}
                    await new Promise(r => setTimeout(r, intervalMs));
                }
                return null;
            };

            function sendBridgeCommand(port) {
                // Check session still alive
                try {
                    const sessions = _sm.listSessions ? _sm.listSessions() : [];
                    if (!sessions.some(s => s.sessionId === _sid)) {
                        console.log('[Bridge] Session ' + _sid.slice(0,8) + ' ended, aborting');
                        _bridgeOpInProgress = false;
                        return;
                    }
                } catch(_) {}

                const WebSocket = require('ws');
                const ws = new WebSocket('ws://127.0.0.1:' + port);

                ws.on('open', () => {
                    // Send leave first (clean up any existing Agora session)
                    ws.send(JSON.stringify({ action: 'leave' }));

                    // Then send join after short delay
                    setTimeout(() => {
                        if (ws.readyState !== 1) return;
                        ws.send(JSON.stringify({
                            id: 1, action: 'join', token: _tk,
                            channel_name: _ch, user_id: _uid,
                            speaker: true, app_id: _aid
                        }));
                        console.log('[Bridge] Agora join sent: ch=' + _ch);
                    }, 300);

                    // Send unmute after 2s, then close WS
                    // Bridge will keep Agora connection alive after WS closes!
                    setTimeout(() => {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({ action: 'unmute' }));
                            console.log('[Bridge] Unmute sent, closing WS (bridge keeps Agora alive)');
                        }
                        // Close WS cleanly - bridge stays in Agora channel
                        setTimeout(() => {
                            try { ws.close(); } catch(_) {}
                        }, 500);
                    }, 2000);
                });

                ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.ok !== undefined) {
                            console.log('[Bridge] Agora result: ok=' + msg.ok + (Number(msg.ok) === 0 ? ' (success)' : ' (error)'));
                        }
                    } catch (_) {}
                });

                ws.on('error', (e) => {
                    console.log('[Bridge] WS error: ' + (e.message || 'unknown'));
                    _bridgeOpInProgress = false;
                });
                ws.on('close', () => { _bridgeOpInProgress = false; }); // Expected - we close intentionally
            }

            // Suppress watchdog while a new bridge is still cold-starting.
            _bridgeOpInProgress = true;
            _bridgeLastRestartTime = Date.now();
            setTimeout(async () => {
                try {
                    const activePort = await _waitForBridgeReady(_bp);
                    if (!activePort) {
                        console.log(`[Bridge] Port ${_bp} never became ready within startup window`);
                        _bridgeOpInProgress = false;
                        return;
                    }
                    sendBridgeCommand(activePort);
                } catch (e) {
                    console.log('[Bridge] Join bootstrap failed: ' + e.message);
                    _bridgeOpInProgress = false;
                }
            }, 3000);
            setTimeout(() => { _bridgeOpInProgress = false; }, 180000);
        }

        // === Auto Pin Link: add session remote link to room ===
        if (roomInfo && roomInfo.channel && !roomInfo.error && mode !== 'player-only') {
            try {
                const remoteUrl = `https://clubhouses.party/?session=${session.sessionId}`;
                const pinData = await clubhousePost('add_channel_link', {
                    channel: roomInfo.channel,
                    link: remoteUrl,
                }, accountId);
                if (pinData.success !== false && pinData.links) {
                    console.log(`  📌 Pinned link OK: ${remoteUrl} (${pinData.links.length} links total)`);
                    roomInfo.pinnedLinks = pinData.links;
                } else {
                    console.log(`  ⚠️ Pin link response: ${pinData.error_message || 'unknown'}`);
                }
            } catch (pinErr) {
                console.log(`  ⚠️ Pin link failed: ${pinErr.message}`);
            }
        }

        // mode === 'player-only': no room action needed

        res.json({
            success: true,
            mode,
            session: {
                sessionId: session.sessionId,
                shortId: session.shortId,
                bridgePort: session.bridgePort,
                bridgeWsUrl: session.bridgeWsUrl,
                playerUrl: session.playerUrl,
            },
            room: roomInfo,
            count: session.count,
            maxSessions: session.maxSessions,
        });
    } catch (e) {
        console.error('Broadcast start error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/broadcast/mute — toggle mute via server-side bridge WS
app.post('/api/broadcast/mute', requirePlayerAuth, async (req, res) => {
    const { sessionId, muted } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    
    const sessionMgr = require('./session-manager');
    const _rawSessions = sessionMgr.listSessions();
    const sessions = _rawSessions && _rawSessions.sessions ? _rawSessions.sessions : (Array.isArray(_rawSessions) ? _rawSessions : []);
    const session = sessions.find(s => s.sessionId === sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.bridgePort) return res.status(400).json({ error: 'No bridge for this session' });
    
    const action = muted ? 'mute' : 'unmute';
    const roomInfo = session.roomInfo || {};
    // Track manual mute state so poll won't auto-unmute when manually muted
    const sessionChannel = session.channel || roomInfo.channel;
    if (sessionChannel) channelMuteOverride.set(sessionChannel, !!muted);
    
    try {
        const WebSocket = require('ws');
        const result = await new Promise((resolve, reject) => {
            const ws = new WebSocket('ws://127.0.0.1:' + session.bridgePort);
            const timeout = setTimeout(() => { try{ws.close();}catch(_){} reject(new Error('timeout')); }, 5000);
            
            ws.on('open', () => {
                // Must send join first (sets bridge's this.joined=true)
                if (roomInfo.token) {
                    ws.send(JSON.stringify({ action: 'leave' }));
                    setTimeout(() => {
                        ws.send(JSON.stringify({
                            id: 1, action: 'join',
                            token: roomInfo.token,
                            channel_name: roomInfo.channel,
                            user_id: roomInfo.botUserId || 450417781,
                            speaker: true,
                            app_id: roomInfo.agoraInfo?.app_id || '938de3e8055e42b281bb8c6f69c21f78'
                        }));
                        // Send mute/unmute after join
                        setTimeout(() => {
                            ws.send(JSON.stringify({ action }));
                            console.log('[Mute API] ' + action + ' sent for session ' + sessionId.slice(0,8));
                            clearTimeout(timeout);
                            setTimeout(() => { try{ws.close();}catch(_){} }, 300);
                            resolve({ success: true, action });
                        }, 800);
                    }, 300);
                } else {
                    // No token — try unmute directly (may fail if bridge not joined)
                    ws.send(JSON.stringify({ action }));
                    clearTimeout(timeout);
                    setTimeout(() => { try{ws.close();}catch(_){} }, 300);
                    resolve({ success: true, action, warning: 'no token, direct send' });
                }
            });
            ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
        });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/broadcast/stop
// body: { sessionId, channel? }

// Reconnect playback: rebuild Chrome+Bridge without calling Clubhouse API
// Use when session is lost but bot is still in room (keepalive active)
app.post('/api/broadcast/reconnect', requirePlayerAuth, async (req, res) => {
    const { accountId } = req.body;
    try {
        // Find active keepalive for this account
        const kaStatus = JSON.parse(JSON.stringify(
            // Access the keepalive sessions from the route handler at /api/clubhouse/keepalive_status
            (() => {
                const sessions = {};
                // We need to access keepaliveSessions - check if it's accessible
                return sessions;
            })()
        ));
    } catch(e) {}

    // Check if keepalive is running
    let activeChannel = null;
    let activeKA = null;
    try {
        const kaRes = await fetch(`http://127.0.0.1:${PORT}/api/clubhouse/keepalive_status`);
        const kaData = await kaRes.json();
        // Find keepalive for this account
        for (const [key, val] of Object.entries(kaData.sessions || {})) {
            const parts = key.split(':');
            const kaAcct = parts[1] || 'main';
            if (kaAcct === (accountId || 'main')) {
                activeChannel = parts[0];
                activeKA = val;
                break;
            }
        }
    } catch(e) {
        return res.status(500).json({ error: 'Cannot check keepalive status: ' + e.message });
    }

    if (!activeChannel) {
        return res.status(400).json({ error: '没有活跃的 keepalive，请用房间链接重新加入' });
    }

    console.log(`🔄 Reconnect: channel=${activeChannel}, account=${accountId || 'main'}, isSpeaker=${activeKA?.isSpeaker}`);
        // Lock out watchdog during reconnect
        _bridgeOpInProgress = true;
        _bridgeLastRestartTime = Date.now();

    try {
        // Auto-replace existing sessions for same account
        const _raw = sessionMgr.listSessions();
        const existingSessions = _raw && _raw.sessions ? _raw.sessions : [];
        for (let _i = 0; _i < existingSessions.length; _i++) {
            const existing = existingSessions[_i];
            if ((existing.accountId || null) === (accountId || null)) {
                console.log('  ♻️ Replacing existing session ' + existing.shortId);
                await sessionMgr.deleteSession(existing.sessionId);
            }
        }

        // Create new session (Chrome + PulseAudio + bridge)
        const session = await sessionMgr.createSession(true);
        if (session.error) return res.status(400).json(session);
        if (accountId) sessionMgr.setSessionMeta(session.sessionId, 'accountId', accountId);

        // Store channel info
        const roomInfo = {
            channel: activeChannel,
            url: `https://www.clubhouse.com/room/${activeChannel}`,
            botUserId: (() => { const a = getAccount(accountId); return a ? a.userId : null; })(),
            reconnected: true
        };
        sessionMgr.setSessionMeta(session.sessionId, 'roomInfo', roomInfo);
        sessionMgr.setSessionMeta(session.sessionId, 'channel', activeChannel);

        // Get channel info via API (1 call) to obtain agora token for bridge
        const bridgePort = session.bridgePort || 8767;
        // Get API tokens immediately (don't wait for bridge)
        const botAccount = getAccount(accountId);
        const botUserId = botAccount ? botAccount.userId : null;
        let agoraToken = '', agoraAppId = '938de3e8055e42b281bb8c6f69c21f78';
        try {
            const chData = await clubhousePost('join_channel', { 
                channel: activeChannel, 
                attribution_source: 'feed',
                attribution_details: 'eyJpc19leHBsb3JlIjpmYWxzZSwiY2hhbm5lbF90b3BpYyI6bnVsbH0='
            }, accountId);
            agoraToken = chData.token || '';
            agoraAppId = (chData.agora_info || {}).app_id || agoraAppId;
            console.log(`  🔗 Reconnect: join_channel OK, agoraToken=${agoraToken ? 'yes' : 'no'}`);
            // become_speaker
            try {
                const bsData = await clubhousePost('become_speaker', { channel: activeChannel }, accountId);
                if (bsData && bsData.token) { agoraToken = bsData.token; console.log('  🎤 Reconnect: speaker token obtained'); }
                if (bsData && bsData.agora_info) { agoraAppId = bsData.agora_info.app_id || agoraAppId; }
            } catch(bsErr) { console.log('  ⚠️ become_speaker: ' + bsErr.message); }
            // Clear manual mute override — reconnect always resets to unmuted
            channelMuteOverride.delete(activeChannel);
            // API unmute
            try { await clubhousePost('update_channel_user_status', { channel: activeChannel, is_muted: false }, accountId); console.log('  🔊 Reconnect: API unmute sent'); } catch(ue) {}
            // Pin session link in room
            try {
                await clubhousePost('add_channel_link', { channel: activeChannel, link: 'https://clubhouses.party/?session=' + session.sessionId }, accountId);
                console.log('  📌 Reconnect: Pinned link OK');
            } catch(pe) { console.log('  ⚠️ Reconnect: Pin failed: ' + pe.message); }
        } catch(apiErr) { console.log('  ⚠️ Reconnect API error: ' + apiErr.message); }

        // Bridge connection: poll port until it returns 426 (WS-ready), then connect.
        // Wine cold-start can take 80-120s, so we poll up to 150s instead of 12 blind retries.
        const _waitForBridgeReady = async (port, maxWaitMs = 150000, intervalMs = 2000) => {
            const start = Date.now();
            let logged = false;
            while (Date.now() - start < maxWaitMs) {
                try {
                    const check = require('child_process').execSync(
                        `curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:${port}/ 2>/dev/null || echo 000`,
                        { encoding: 'utf8', timeout: 2000 }
                    ).trim();
                    if (check === '426') {
                        console.log(`  ✅ Reconnect: Bridge ready on port ${port} after ${Math.round((Date.now()-start)/1000)}s`);
                        return port;
                    }
                    if (!logged) { console.log(`  ⏳ Reconnect: Waiting for bridge on port ${port} (HTTP ${check})...`); logged = true; }
                } catch (_) {}
                await new Promise(r => setTimeout(r, intervalMs));
            }
            // Fallback: scan other known bridge ports
            for (const tryPort of [8767, 8768, 8769]) {
                if (tryPort === port) continue;
                try {
                    const check = require('child_process').execSync(
                        `curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:${tryPort}/ 2>/dev/null || echo 000`,
                        { encoding: 'utf8', timeout: 2000 }
                    ).trim();
                    if (check === '426') {
                        console.log(`  🔀 Reconnect: Falling back to alive bridge on port ${tryPort}`);
                        return tryPort;
                    }
                } catch (_) {}
            }
            return null;
        };

        const _reconnectBridge = async () => {
            const activePort = await _waitForBridgeReady(bridgePort);
            if (!activePort) {
                console.log(`  ❌ Reconnect: No bridge ready after 150s on any port, giving up`);
                _bridgeOpInProgress = false;
                return;
            }
            const WebSocket = require('ws');
            const ws = new WebSocket('ws://127.0.0.1:' + activePort);
            ws.on('open', () => {
                ws.send(JSON.stringify({ action: 'leave' }));
                setTimeout(() => {
                    if (ws.readyState !== 1) return;
                    ws.send(JSON.stringify({ id: 1, action: 'join', token: agoraToken, channel_name: activeChannel, user_id: botUserId, speaker: true, app_id: agoraAppId }));
                    console.log('[Bridge] Reconnect: Agora join sent: ch=' + activeChannel);
                }, 300);
                // Mute first to ensure clean state reset
                setTimeout(() => {
                    if (ws.readyState === 1) { ws.send(JSON.stringify({ action: 'mute' })); console.log('[Bridge] Reconnect: Mute sent (state reset)'); }
                }, 1200);
                // Then unmute to open mic, then release lock
                setTimeout(() => {
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ action: 'unmute' }));
                        console.log('[Bridge] Reconnect: Unmute sent (mic open)');
                        ws.close();
                        _bridgeOpInProgress = false;
                    }
                }, 2500);
            });
            ws.on('error', (e) => {
                console.log(`  ❌ Reconnect: WS error after bridge was ready: ${e.message}`);
                _bridgeOpInProgress = false;
            });
        };
        _bridgeOpInProgress = true;
        _bridgeLastRestartTime = Date.now();
        // Brief 3s grace for createSession to settle, then start polling
        setTimeout(() => { _reconnectBridge().catch(e => { console.log('Reconnect bridge fatal: ' + e.message); _bridgeOpInProgress = false; }); }, 3000);
        // Safety release: bridge poll max 150s + WS handshake + margin = 180s
        setTimeout(() => { _bridgeOpInProgress = false; }, 180000);

        // Broadcast session-changed event to all connected clients
        // so Remote pages auto-redirect to the new session
        io.emit('session-changed', {
            oldSessionId: null,  // old was already deleted
            newSessionId: session.sessionId,
            newSessionUrl: '/?session=' + session.sessionId,
            reason: 'reconnect'
        });
        console.log('  📢 Reconnect: Broadcast session-changed to all clients');
        // Note: _bridgeOpInProgress stays true until _reconnectBridge succeeds or gives up

        res.json({
            success: true,
            sessionId: session.sessionId,
            channel: activeChannel,
            sessionUrl: 'https://clubhouses.party/?session=' + session.sessionId,
            message: '重连成功！Bridge 正在连接 Agora',
            apiCalls: 3
        });
    } catch (e) {
        console.error('Reconnect error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/broadcast/stop', requirePlayerAuth, async (req, res) => {
    const { sessionId } = req.body;
    let { channel } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    try {
        // Auto-detect channel from session if not provided
        if (!channel) {
            channel = sessionMgr.getSessionChannel(sessionId);
        }
        // Phase 3: Skip leave_channel/mute to protect other sessions' Agora connections
        // Use /api/clubhouse/force_leave for full disconnect
        if (channel) {
            console.log(`  ℹ️ Skipping leave_channel for ${channel} (multi-session protection)`);
        }

        // 1.5. Auto-cleanup keepalive for this channel
        if (channel) {
            for (const [key, sess] of activeSessions) {
                if (key === channel || key.startsWith(channel + ':')) {
                    clearInterval(sess.pingInterval);
                    clearInterval(sess.pollInterval);
                    activeSessions.delete(key);
                    console.log(`🛑 [Broadcast/Stop] Auto-stopped keepalive: ${key} (${sess.pingCount} pings)`);
                }
            }
            saveKeepaliveState();
        }

        // 2. Delete session (kills Chrome, bridge, PulseAudio sink)
        const result = await sessionMgr.deleteSession(sessionId);
        if (result.error) return res.status(400).json(result);

        console.log(`🛑 Broadcast stopped: ${sessionId}`);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/storage')) return res.status(404).send('Not found');
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// ==================== Clubhouse API Proxy ====================
const CH_API_ROOT = process.env.CH_API_PROXY || 'https://www.clubhouseapi.com/api';
const CH_PROXY_SECRET = process.env.CH_PROXY_SECRET || '';
let CH_AUTH_TOKEN = process.env.CH_AUTH_TOKEN || '6116e81dd17634fa44ecdd1ad231728c079d4fb3';
let CH_DEVICE_ID = process.env.CH_DEVICE_ID || '0AEAF080-27F9-45DB-B999-2C492F803CAF';
const CH_UA = 'clubhouse/3375 (iPhone; iOS 17.1.2; Scale/3.00)';
let CH_TOKEN_LAST_VALID = Date.now();

// ==================== Multi-Account Support ====================
const ACCOUNTS_PATH = path.join(__dirname, 'data', 'accounts.json');

function loadAccounts() {
    try {
        const raw = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        // Fallback: return single account from globals
        return {
            accounts: {
                main: { label: 'Main', token: CH_AUTH_TOKEN, userId: CH_BOT_USER_ID, deviceId: CH_DEVICE_ID, userAgent: CH_UA }
            },
            default: 'main'
        };
    }
}

function saveAccounts(data) {
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2));
}

function getAccount(accountId) {
    const data = loadAccounts();
    const id = accountId || data.default || 'main';
    const acct = data.accounts[id];
    if (!acct) return null;
    return { id, ...acct };
}

async function clubhousePost(endpoint, body = {}, accountId = null) {
    const acct = getAccount(accountId);
    const token = acct ? acct.token : CH_AUTH_TOKEN;
    const userId = acct ? acct.userId : CH_BOT_USER_ID;
    const deviceId = acct ? acct.deviceId : CH_DEVICE_ID;
    const ua = acct ? (acct.userAgent || CH_UA) : CH_UA;
    const appBuild = acct?.appBuild || '3375';
    const appVersion = acct?.appVersion || '26.03.01';
    try {
        const { data } = await axios.post(`${CH_API_ROOT}/${endpoint}`, body, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'CH-AppBuild': appBuild,
                'CH-AppVersion': appVersion,
                'User-Agent': ua,
                'CH-DeviceId': deviceId,
                'Authorization': `Token ${token}`,
                'CH-UserID': String(userId),
                ...(CH_PROXY_SECRET ? { 'X-Proxy-Secret': CH_PROXY_SECRET } : {}),
            }
        });
        return data;
    } catch (e) {
        // Track 503/5xx source: CF Worker vs Clubhouse
        if (e.response && e.response.status >= 500) {
            const h = e.response.headers || {};
            const source = h['cf-ray'] ? 'CF-Worker' : (h['server'] || 'unknown');
            const cfCache = h['cf-cache-status'] || '';
            console.log(`🔍 [API ${e.response.status}] ${endpoint} → source: ${source}, server: ${h['server'] || '?'}, cf-ray: ${h['cf-ray'] || 'none'}, body: ${String(e.response.data || '').substring(0, 80)}`);
        }
        throw e; // Re-throw so callers still get the error
    }
}

// === Bridge Diagnostic & Repair API ===
app.get('/api/bridge/diagnose', requirePlayerAuth, async (req, res) => {
    try {
        const checks = {};
        const sessions = sessionMgr.getSessions();
        const activeSess = sessions[0] || null;

        // 1. Session status
        checks.session = {
            exists: !!activeSess,
            sessionId: activeSess?.sessionId || null,
            shortId: activeSess?.shortId || null,
            hasRoomInfo: !!(activeSess?.roomInfo),
            channel: activeSess?.roomInfo?.channel || activeSess?.channel || null,
            accountId: activeSess?.accountId || null,
        };

        // 2. Bridge status (TCP port check)
        const bridgePort = activeSess?.bridgePort || 8767;
        checks.bridge = await new Promise((resolve) => {
            const sock = net.connect(bridgePort, '127.0.0.1', () => {
                sock.destroy();
                resolve({ listening: true, port: bridgePort });
            });
            sock.on('error', () => resolve({ listening: false, port: bridgePort }));
            sock.setTimeout(2000, () => { sock.destroy(); resolve({ listening: false, port: bridgePort, timeout: true }); });
        });

        // 3. PulseAudio status
        const paCheck = await new Promise((resolve) => {
            const { exec } = require('child_process');
            exec('sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl list short source-outputs 2>/dev/null', (err, stdout) => {
                const sourceOutputs = stdout.trim().split('\n').filter(l => l.trim());
                exec('sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl list short sink-inputs 2>/dev/null', (err2, stdout2) => {
                    const sinkInputs = stdout2.trim().split('\n').filter(l => l.trim());
                    exec('sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl list short sinks 2>/dev/null', (err3, stdout3) => {
                        const sinks = stdout3.trim().split('\n').filter(l => l.trim());
                        const sessionSinks = sinks.filter(s => s.includes('session_'));
                        resolve({
                            bridgeRecording: sourceOutputs.length > 0,
                            sourceOutputCount: sourceOutputs.length,
                            ffplayPlaying: sinkInputs.length > 0,
                            sinkInputCount: sinkInputs.length,
                            sessionSinkCount: sessionSinks.length,
                            totalSinkCount: sinks.length,
                        });
                    });
                });
            });
        });
        checks.pulseAudio = paCheck;

        // 4. Keepalive status
        checks.keepalive = { running: false, channel: null, paused: false };
        if (typeof activeSessions !== 'undefined') {
            for (const [key, sess] of activeSessions) {
                checks.keepalive = {
                    running: true,
                    channel: sess.channel,
                    paused: !!sess._pausedUntil,
                    pauseRemaining: sess._pausedUntil ? Math.max(0, Math.round((sess._pausedUntil - Date.now()) / 1000)) : 0,
                    pingCount: sess.pingCount || 0,
                    pingErrorCount: sess.pingErrorCount || 0,
                };
                break;
            }
        }

        // 5. Bot speaker status (from last poll)
        checks.botSpeaker = { isSpeaker: false, info: 'unknown' };
        if (typeof activeSessions !== 'undefined') {
            for (const [key, sess] of activeSessions) {
                if (sess._lastBotPoll) {
                    checks.botSpeaker = sess._lastBotPoll;
                }
                break;
            }
        }

        // 6. Token validity
        const acct = getAccount(activeSess?.accountId || 'main');
        checks.token = {
            hasToken: !!(acct && acct.token),
            tokenLen: acct?.token?.length || 0,
            account: acct?.label || 'unknown',
        };

        // 7. CH API reachability
        checks.chApi = { reachable: false, status: 0 };
        try {
            const testRes = await axios.post(`${CH_API_ROOT}/me`, {}, {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Authorization': `Token ${acct?.token || ''}`,
                    'CH-UserID': String(acct?.userId || ''),
                    'CH-DeviceId': acct?.deviceId || '',
                    'User-Agent': acct?.userAgent || 'clubhouse/3375',
                    ...(CH_PROXY_SECRET ? { 'X-Proxy-Secret': CH_PROXY_SECRET } : {}),
                },
                timeout: 10000,
            });
            checks.chApi = { reachable: true, status: 200, user: testRes.data?.user_profile?.name || '?' };
        } catch (e) {
            checks.chApi = {
                reachable: false,
                status: e.response?.status || 0,
                error: e.response?.status >= 500 ? 'CF Worker/CH API 503' : (e.response?.status === 401 ? 'Token invalid' : e.message),
                source: e.response?.headers?.['cf-ray'] ? 'CF-Worker' : 'direct',
            };
        }

        // Generate summary
        const issues = [];
        if (!checks.session.exists) issues.push('❌ 没有活跃 Session');
        if (checks.session.exists && !checks.session.hasRoomInfo) issues.push('❌ Session 没有 roomInfo（未成功加入房间）');
        if (!checks.bridge.listening) issues.push('❌ Bridge 不在监听（端口 ' + bridgePort + '）');
        if (checks.bridge.listening && !checks.pulseAudio.bridgeRecording) issues.push('⚠️ Bridge 在监听但不在录音（未 join Agora 或 PA source 错误）');
        if (!checks.pulseAudio.ffplayPlaying) issues.push('⚠️ 没有 ffplay 在播放音乐');
        if (!checks.keepalive.running) issues.push('⚠️ Keepalive 未运行');
        if (checks.keepalive.paused) issues.push(`⏸️ Keepalive 暂停中 (${checks.keepalive.pauseRemaining}s 后恢复)`);
        if (!checks.chApi.reachable) issues.push('❌ CH API 不可达: ' + (checks.chApi.error || 'unknown'));
        if (!checks.token.hasToken) issues.push('🔴 Auth Token 为空！');

        if (issues.length === 0) issues.push('✅ 所有系统正常');

        res.json({ checks, issues, timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bridge/repair', requirePlayerAuth, async (req, res) => {
    try {
        const sessions = sessionMgr.getSessions();
        const activeSess = sessions[0] || null;
        const steps = [];

        if (!activeSess) {
            return res.json({ success: false, steps: ['❌ 没有活跃 Session，请先创建 Session'], repaired: false });
        }

        const accountId = activeSess.accountId || 'main';
        const bridgePort = activeSess.bridgePort || 8767;

        // Step 1: Check if roomInfo exists, if not → join_channel
        let roomInfo = activeSess.roomInfo;
        let channel = roomInfo?.channel || activeSess.channel;

        if (!roomInfo || !roomInfo.token) {
            steps.push('🔧 roomInfo 为空，尝试 join_channel...');
            // Need channel slug - try to get from keepalive or stored channel
            let joinChannel = channel;
            if (!joinChannel) {
                // Try to find from keepalive sessions
                if (typeof activeSessions !== 'undefined') {
                    for (const [key, sess] of activeSessions) {
                        joinChannel = sess.channel;
                        break;
                    }
                }
            }
            if (!joinChannel) {
                steps.push('❌ 无法确定 channel，请用链接重新加入房间');
                return res.json({ success: false, steps, repaired: false });
            }

            try {
                const data = await clubhousePost('join_channel', {
                    channel: joinChannel,
                    attribution_source: 'feed',
                    attribution_details: 'eyJpc19leHBsb3JlIjpmYWxzZSwiY2hhbm5lbF90b3BpYyI6bnVsbH0='
                }, accountId);

                if (data && data.token) {
                    roomInfo = {
                        channel: data.channel || joinChannel,
                        channelId: data.channel_id,
                        token: data.token,
                        agoraInfo: data.agora_info,
                        botUserId: getAccount(accountId)?.userId || 0,
                    };
                    sessionMgr.setSessionMeta(activeSess.sessionId, 'roomInfo', roomInfo);
                    sessionMgr.setSessionChannel(activeSess.sessionId, joinChannel);
                    channel = roomInfo.channel;
                    steps.push(`✅ join_channel 成功 (channel=${channel}, ${(data.users||[]).length} users)`);
                } else {
                    steps.push('❌ join_channel 返回无效数据: ' + JSON.stringify(data).substring(0, 100));
                    return res.json({ success: false, steps, repaired: false });
                }
            } catch (e) {
                const status = e.response?.status || 0;
                const source = e.response?.headers?.['cf-ray'] ? 'CF-Worker' : 'CH-API';
                steps.push(`❌ join_channel 失败 [${status}] (${source}): ${e.response?.data?.error_message || e.message}`);
                return res.json({ success: false, steps, repaired: false });
            }
        } else {
            steps.push(`✅ roomInfo 存在 (channel=${channel})`);
        }

        // Step 2: become_speaker + unmute
        try {
            const bsData = await clubhousePost('become_speaker', { channel }, accountId);
            if (bsData && bsData.token) {
                roomInfo.token = bsData.token;
                sessionMgr.setSessionMeta(activeSess.sessionId, 'roomInfo', roomInfo);
                steps.push('✅ become_speaker 成功 (speaker token 已更新)');
            } else {
                steps.push('⚠️ become_speaker 未返回 token');
            }
        } catch (e) { steps.push('⚠️ become_speaker: ' + (e.response?.data?.error_message || e.message)); }

        try {
            await clubhousePost('update_channel_user_status', { channel, is_muted: false }, accountId);
            steps.push('✅ API unmute 成功');
        } catch (e) { steps.push('⚠️ API unmute: ' + e.message); }

        // Step 3: Bridge join
        const portReady = await new Promise((resolve) => {
            const sock = net.connect(bridgePort, '127.0.0.1', () => { sock.destroy(); resolve(true); });
            sock.on('error', () => resolve(false));
            sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
        });

        if (portReady && roomInfo.token && channel) {
            try {
                const WebSocket = require('ws');
                await new Promise((resolve, reject) => {
                    const ws = new WebSocket('ws://127.0.0.1:' + bridgePort);
                    ws.on('open', () => {
                        ws.send(JSON.stringify({ action: 'leave' }));
                        setTimeout(() => {
                            if (ws.readyState !== 1) { reject(new Error('WS closed')); return; }
                            ws.send(JSON.stringify({
                                id: 1, action: 'join',
                                token: roomInfo.token,
                                channel_name: channel,
                                user_id: roomInfo.botUserId || 0,
                                speaker: true,
                                app_id: (roomInfo.agoraInfo || {}).app_id || '938de3e8055e42b281bb8c6f69c21f78',
                            }));
                            steps.push(`✅ Bridge join 已发送 (ch=${channel})`);
                        }, 300);
                        setTimeout(() => {
                            if (ws.readyState === 1) {
                                ws.send(JSON.stringify({ action: 'unmute' }));
                                steps.push('✅ Bridge unmute 已发送');
                                ws.close();
                            }
                            resolve();
                        }, 2500);
                    });
                    ws.on('error', (e) => { steps.push('❌ Bridge WS 错误: ' + e.message); reject(e); });
                    setTimeout(() => resolve(), 5000); // Safety timeout
                });
            } catch (e) {
                steps.push('❌ Bridge join 失败: ' + e.message);
            }
        } else if (!portReady) {
            steps.push('⚠️ Bridge 端口未就绪，watchdog 将在 ~2 分钟内自动重启');
        } else {
            steps.push('⚠️ 缺少 token 或 channel，无法 bridge join');
        }

        // Step 4: Ensure keepalive is running
        if (typeof activeSessions !== 'undefined') {
            let kaRunning = false;
            for (const [key] of activeSessions) { kaRunning = true; break; }
            if (!kaRunning && channel) {
                steps.push('🔧 Keepalive 未运行，尝试启动...');
                try {
                    const kaRes = await fetch(`http://127.0.0.1:${PORT}/api/clubhouse/start_keepalive`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ channel, accountId }),
                    });
                    const kaData = await kaRes.json();
                    steps.push(kaData.success ? '✅ Keepalive 已启动' : '⚠️ Keepalive: ' + kaData.error_message);
                } catch (e) { steps.push('⚠️ Keepalive 启动失败: ' + e.message); }
            } else {
                steps.push('✅ Keepalive 已在运行');
            }
        }

        res.json({ success: true, steps, repaired: true, channel });
    } catch (e) {
        res.status(500).json({ error: e.message, steps: [] });
    }
});

// Create room
app.post('/api/clubhouse/create', requirePlayerAuth, async (req, res) => {
    try {
        const topic = req.body.topic || '🎵 Music Studio';
        const data = await clubhousePost('create_channel', {
            topic,
            privacy_level: 'public',
            is_social_mode: false,
        });
        console.log(`📡 Clubhouse room created: ${data.channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Create failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Join room
app.post('/api/clubhouse/join', requirePlayerAuth, async (req, res) => {
    try {
        const { channel } = req.body;
        if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
        const data = await clubhousePost('join_channel', { channel });
        console.log(`🎙️ Joined Clubhouse room: ${channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Join failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Leave room
app.post('/api/clubhouse/leave', requirePlayerAuth, async (req, res) => {
    try {
        const { channel, accountId } = req.body;
        if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
        const data = await clubhousePost('leave_channel', { channel }, accountId || null);
        console.log(`👋 Left Clubhouse room: ${channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Leave failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Active ping — keep speaker alive (must call every 30s)
app.post('/api/clubhouse/ping', requirePlayerAuth, async (req, res) => {
    try {
        const { channel, accountId } = req.body;
        if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
        const data = await clubhousePost('active_ping', { channel, channel_id: null }, accountId || null);
        if (data.should_leave === true || String(data.should_leave) === 'true') {
            console.log(`⚠️ [FE-Ping] should_leave=true for ${channel} (account: ${accountId || 'default'})`);
        }
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Ping failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Get channel info — refresh user list
app.post('/api/clubhouse/get_channel', requirePlayerAuth, async (req, res) => {
    try {
        const { channel, accountId } = req.body;
        if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
        const data = await clubhousePost('get_channel', { channel });
        res.json(data);
    } catch (e) {
        // Suppress get_channel error spam (may fail for rooms not created by this token)
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

app.get('/api/clubhouse/token', (req, res) => {
    res.json({
        hasToken: !!CH_AUTH_TOKEN,
        tokenPrefix: CH_AUTH_TOKEN ? CH_AUTH_TOKEN.slice(0, 8) + '...' : null,
        deviceId: CH_DEVICE_ID ? CH_DEVICE_ID.slice(0, 8) + '...' : null,
        lastValid: CH_TOKEN_LAST_VALID,
    });
});

// Update token
app.post('/api/clubhouse/token', requirePlayerAuth, (req, res) => {
    const { token, deviceId } = req.body;
    if (token) {
        CH_AUTH_TOKEN = token;
        // Also update 'main' account in accounts.json
        try {
            const data = loadAccounts();
            if (data.accounts.main) { data.accounts.main.token = token; }
            saveAccounts(data);
        } catch(_) {}
        console.log(`🔑 Clubhouse token updated: ${token.slice(0, 8)}...`);
    }
    if (deviceId) {
        CH_DEVICE_ID = deviceId;
        try {
            const data = loadAccounts();
            if (data.accounts.main) { data.accounts.main.deviceId = deviceId; }
            saveAccounts(data);
        } catch(_) {}
        console.log(`📱 Clubhouse device ID updated: ${deviceId.slice(0, 8)}...`);
    }
    CH_TOKEN_LAST_VALID = Date.now();
    res.json({ success: true, tokenPrefix: '***' });
});

// ==================== Account Management ====================
app.get('/api/clubhouse/accounts', (req, res) => {
    const data = loadAccounts();
    const safe = {};
    for (const [id, acct] of Object.entries(data.accounts)) {
        safe[id] = {
            label: acct.label,
            userId: acct.userId,
            tokenPrefix: acct.token ? acct.token.slice(0, 8) + '...' : null,
        };
    }
    res.json({ accounts: safe, default: data.default });
});

app.post('/api/clubhouse/accounts', requirePlayerAuth, (req, res) => {
    const { id, label, token, userId, deviceId, userAgent } = req.body;
    if (!id || !token || !userId) {
        return res.json({ success: false, error_message: 'Missing id, token, or userId' });
    }
    const data = loadAccounts();
    data.accounts[id] = {
        label: label || id,
        token,
        userId: parseInt(userId),
        deviceId: deviceId || '',
        userAgent: userAgent || CH_UA,
    };
    saveAccounts(data);
    console.log(`👤 Account added/updated: ${id} (${label || id})`);
    res.json({ success: true, id });
});

app.delete('/api/clubhouse/accounts/:id', requirePlayerAuth, (req, res) => {
    const { id } = req.params;
    if (id === 'main') return res.json({ success: false, error_message: 'Cannot delete main account' });
    const data = loadAccounts();
    if (!data.accounts[id]) return res.json({ success: false, error_message: 'Account not found' });
    delete data.accounts[id];
    if (data.default === id) data.default = 'main';
    saveAccounts(data);
    console.log(`🗑️ Account deleted: ${id}`);
    res.json({ success: true });
});

// Validate token by calling a simple CH API
app.get('/api/clubhouse/validate', async (req, res) => {
    try {
        const mainAcct = getAccount('main');
        const vToken = mainAcct ? mainAcct.token : CH_AUTH_TOKEN;
        const vDeviceId = mainAcct ? mainAcct.deviceId : CH_DEVICE_ID;
        const vUA = mainAcct ? (mainAcct.userAgent || CH_UA) : CH_UA;
        const vBuild = mainAcct?.appBuild || '3375';
        const vVersion = mainAcct?.appVersion || '24.01.02';
        const { data } = await axios.post(`${CH_API_ROOT}/check_for_update`, { is_testflight: false }, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'CH-AppBuild': vBuild,
                'CH-AppVersion': vVersion,
                'User-Agent': vUA,
                'CH-DeviceId': vDeviceId,
                'Authorization': `Token ${vToken}`,
                ...(CH_PROXY_SECRET ? { 'X-Proxy-Secret': CH_PROXY_SECRET } : {}),
            }
        });
        CH_TOKEN_LAST_VALID = Date.now();
        res.json({ valid: true, data });
    } catch (e) {
        const status = e.response?.status;
        res.json({ valid: status !== 401 && status !== 403, status, error: e.response?.data || e.message });
    }
});

// ==================== Speaker Management ====================

// Accept speaker invitation
app.post('/api/clubhouse/accept_speaker', requirePlayerAuth, async (req, res) => {
    try {
        const { channel, user_id } = req.body;
        if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
        const data = await clubhousePost('accept_speaker_invite', {
            channel,
            user_id: user_id || CH_USER_ID
        });
        console.log(`🎙️ Accepted speaker invite in: ${channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Accept speaker failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Invite user to speak (requires moderator)
app.post('/api/clubhouse/invite_speaker', async (req, res) => {
    try {
        const { channel, user_id } = req.body;
        if (!channel || !user_id) return res.json({ success: false, error_message: 'Missing channel or user_id' });
        const data = await clubhousePost('invite_speaker', { channel, user_id: parseInt(user_id) });
        console.log(`📣 Invited user ${user_id} to speak in: ${channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Invite speaker failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Make user a moderator (requires bot to be moderator)
app.post('/api/clubhouse/make_moderator', async (req, res) => {
    try {
        const { channel, user_id } = req.body;
        if (!channel || !user_id) return res.json({ success: false, error_message: 'Missing channel or user_id' });
        const data = await clubhousePost('make_moderator', { channel, user_id: parseInt(user_id) });
        console.log(`👑 Made user ${user_id} moderator in: ${channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Make moderator failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// Raise hand (request to speak)
app.post('/api/clubhouse/raise_hand', requirePlayerAuth, async (req, res) => {
    try {
        const { channel } = req.body;
        if (!channel) return res.json({ success: false, error_message: 'Missing channel' });
        const data = await clubhousePost('audience_reply', {
            channel,
            raise_hands: true,
            unraise_hands: false
        });
        console.log(`✋ Raised hand in: ${channel}`);
        res.json(data);
    } catch (e) {
        console.error('[Clubhouse] Raise hand failed:', e.response?.data || e.message);
        res.json({ success: false, error_message: e.response?.data?.error_message || e.message });
    }
});

// ==================== Server-Side Keepalive Manager ====================
// Persistence: save/restore active keepalive across restarts
const KEEPALIVE_STATE_FILE = path.join(__dirname, 'data', 'active_keepalive.json');

function saveKeepaliveState() {
    const state = [];
    for (const [key, sess] of activeSessions) {
        const parts = key.split(':');
        state.push({
            channel: parts[0],
            accountId: parts[1] || 'main',
            bridgePort: sess.bridgePort || null,
            sessionId: sess.sessionId || null,
            isSpeaker: sess.isSpeaker || false,
        });
    }
    try {
        fs.writeFileSync(KEEPALIVE_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (_) {}
}

function clearKeepaliveState() {
    try { fs.unlinkSync(KEEPALIVE_STATE_FILE); } catch (_) {}
}

function loadKeepaliveState() {
    try {
        const raw = fs.readFileSync(KEEPALIVE_STATE_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (_) { return []; }
}
// Manages active_ping heartbeat + auto-accept speaker invitations
const activeSessions = new Map(); // Map<channel, { pingInterval, pollInterval, isSpeaker }>
const channelMuteOverride = new Map(); // channel → true means manually muted (skip auto-unmute)

// Speaker whitelist + historical room users
const SPEAKER_WHITELIST_FILE = path.join(__dirname, 'data', 'speaker_whitelist.json');
const ROOM_USERS_HISTORY_FILE = path.join(__dirname, 'data', 'room_users_history.json');

function loadSpeakerWhitelist() {
    try { return JSON.parse(fs.readFileSync(SPEAKER_WHITELIST_FILE, 'utf-8')); }
    catch (_) { return []; }
}
function saveSpeakerWhitelist(list) {
    fs.writeFileSync(SPEAKER_WHITELIST_FILE, JSON.stringify(list, null, 2));
}
const WHITELIST_CONFIG_FILE = path.join(__dirname, 'data', 'whitelist_config.json');
function loadWhitelistConfig() {
    try { return JSON.parse(fs.readFileSync(WHITELIST_CONFIG_FILE, 'utf-8')); }
    catch (_) { return { mode: 'auto' }; } // default: auto-invite on sight
}
function saveWhitelistConfig(config) {
    fs.writeFileSync(WHITELIST_CONFIG_FILE, JSON.stringify(config, null, 2));
}
const AUTOKICK_CONFIG_FILE = path.join(__dirname, 'data', 'autokick_config.json');
function loadAutokickConfig() {
    try { return JSON.parse(fs.readFileSync(AUTOKICK_CONFIG_FILE, 'utf-8')); }
    catch (_) { return { enabled: false, kickWebListeners: true, keywordBlocklist: [], blacklistIds: [], whitelistIds: [] }; }
}
function saveAutokickConfig(cfg) {
    fs.writeFileSync(AUTOKICK_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// GET /api/autokick/config — return current autokick enabled state
app.get('/api/autokick/config', requirePlayerAuth, (req, res) => {
    const cfg = loadAutokickConfig();
    res.json({ enabled: !!cfg.enabled, kickWebListeners: !!cfg.kickWebListeners });
});

// POST /api/autokick/toggle — toggle enabled on/off (or set explicitly via body.enabled)
app.post('/api/autokick/toggle', requirePlayerAuth, (req, res) => {
    const cfg = loadAutokickConfig();
    const newEnabled = (req.body && req.body.enabled !== undefined) ? !!req.body.enabled : !cfg.enabled;
    cfg.enabled = newEnabled;
    saveAutokickConfig(cfg);
    console.log(`🚫 [AutoKick] ${newEnabled ? '✅ 已开启' : '⏸️ 已关闭'} (toggled via API)`);
    res.json({ success: true, enabled: newEnabled });
});

function loadRoomUsersHistory() {
    try { return JSON.parse(fs.readFileSync(ROOM_USERS_HISTORY_FILE, 'utf-8')); }
    catch (_) { return {}; }
}
function saveRoomUsersHistory(history) {
    fs.writeFileSync(ROOM_USERS_HISTORY_FILE, JSON.stringify(history, null, 2));
}
function recordRoomUsers(users) {
    if (!users || users.length === 0) return;
    const history = loadRoomUsersHistory();
    let changed = false;
    for (const u of users) {
        const uid = String(u.user_id);
        if (!history[uid]) {
            history[uid] = { user_id: uid, name: u.name || '', photo_url: u.photo_url || '', username: u.username || '', first_seen: new Date().toISOString() };
            changed = true;
        } else if (u.name && u.name !== history[uid].name) {
            history[uid].name = u.name;
            history[uid].photo_url = u.photo_url || history[uid].photo_url;
            changed = true;
        }
        history[uid].last_seen = new Date().toISOString();
    }
    if (changed) saveRoomUsersHistory(history);
}

// Bot's numeric user ID
const CH_BOT_USER_ID = parseInt(process.env.CH_BOT_USER_ID || '1602673216');

app.post('/api/clubhouse/start_keepalive', requirePlayerAuth, async (req, res) => {
    const { channel, accountId, skipRaiseHand } = req.body;
    if (!channel) return res.json({ success: false, error_message: 'Missing channel' });

    // Use channel:accountId as key to support multiple accounts in same room
    const kaKey = channel + ':' + (accountId || 'main');
    // Stop existing keepalive for this channel+account if any
    if (activeSessions.has(kaKey)) {
        const old = activeSessions.get(kaKey);
        clearInterval(old.pingInterval);
        clearInterval(old.pollInterval);
        activeSessions.delete(kaKey);
    }

    const acctInfo = getAccount(accountId);
    const keepaliveAccountId = acctInfo ? acctInfo.id : null;
    const keepaliveBotUserId = acctInfo ? acctInfo.userId : CH_BOT_USER_ID;
    // Preserve isSpeaker and invitedUsers from previous session (handles restart/double-start)
    const oldSession = activeSessions.get(kaKey);
    const session = { isSpeaker: oldSession?.isSpeaker || false, pingCount: 0, pingFailCount: 0, pollFailCount: 0, acceptedAt: oldSession?.acceptedAt || null, startedAt: new Date().toISOString(), accountId: keepaliveAccountId, bridgePort: null, roomInfo: null, sessionId: null, invitedUsers: oldSession?.invitedUsers || new Set() };
    console.log(`🔑 [Keepalive] Using account: ${acctInfo ? acctInfo.label : 'default'} (${keepaliveAccountId || 'main'})`);

    // Active ping every ~30-35s (matches official Clubhouse app) — CRITICAL for staying in room
    session.pingInterval = setInterval(async () => {
        try {
            const data = await clubhousePost('active_ping', { channel, channel_id: null }, session.accountId);
            session.pingCount++;
            session.pingErrorCount = 0; // Reset on success
            if (session.pingCount % 8 === 0) { // Log every ~4 minutes
                session.pingFailCount = 0; // Reset on success
                console.log(`📡 [Keepalive] Ping #${session.pingCount} for ${channel}`);
            }
            if (data.should_leave === true || String(data.should_leave) === 'true') {
                console.log(`🛑 [Keepalive] Server says LEAVE: ${channel} (account: ${session.accountId || 'default'}, pingCount: ${session.pingCount}) - stopping keepalive`);
                clearInterval(session.pingInterval);
                clearInterval(session.pollInterval);
                activeSessions.delete(kaKey);
                saveKeepaliveState();
                return;
            }

            // Periodic unmute removed (single-room: only unmute on detection via get_channel poll)
        } catch (e) {
            const status = e.response?.status;
            const msg = e.response?.data?.error_message || e.message;
            session.pingErrorCount = (session.pingErrorCount || 0) + 1;
            console.error(`❌ [Keepalive] Ping failed #${session.pingErrorCount} for ${channel}: ${msg}`);
            
            // 401/403 = token invalid -> stop immediately
            if (status === 401 || status === 403) {
                console.log(`🛑 [Keepalive] AUTH FAILED (${status}) - stopping keepalive for ${channel}`);
                clearInterval(session.pingInterval);
                clearInterval(session.pollInterval);
                activeSessions.delete(kaKey);
                saveKeepaliveState();
                return;
            }
            // 5 consecutive failures -> pause 5 min then auto-retry (not permanent stop)
            if (session.pingErrorCount >= 5 && !session._pausedUntil) {
                const pauseMs = 5 * 60 * 1000; // 5 minutes
                session._pausedUntil = Date.now() + pauseMs;
                session.pingErrorCount = 0; // Reset for next cycle
                console.log(`⏸️ [Keepalive] 5 consecutive failures - pausing keepalive for ${channel} for 5 minutes (will auto-retry)`);
                return;
            }
            // Skip pings while paused
            if (session._pausedUntil) {
                if (Date.now() < session._pausedUntil) return; // Still paused
                // Pause expired, resume
                delete session._pausedUntil;
                console.log(`▶️ [Keepalive] Resuming keepalive for ${channel} after pause`);
            }
        }
    }, 30000 + Math.floor(Math.random() * 5000)); // 30-35s, match official app

    // Poll get_channel every ~120-150s (recommended interval) — detect speaker invitation + auto-accept
    session.pollInterval = setInterval(async () => {
        try {
            const data = await clubhousePost('get_channel', { channel }, session.accountId);
            session.pollErrorCount = 0; // Reset on success
            console.log(`📊 [Poll] get_channel OK for ${channel}: ${(data.users || []).length} users`);
            if (!data.success && data.success !== undefined) {
                // get_channel may fail for rooms not created by this token - not critical
                // Auto-unmute is now handled by active_ping, so this is non-blocking
                return;
            }
            const users = data.users || [];
                // Debug: show all users and their status
                const wl = loadSpeakerWhitelist();
                const wlCfg = loadWhitelistConfig();
                for (const u of users) {
                    const uid = parseInt(u.user_id);
                    const onWl = wl.includes(uid);
                    console.log(`  👤 [Poll] ${u.name} (${uid}): speaker=${u.is_speaker}, invited=${u.is_invited_as_speaker}, hand=${u.is_hand_raised}, onWhitelist=${onWl}`);
                }
                console.log(`  📋 [Poll] Mode=${wlCfg.mode}, invitedUsers=${session.invitedUsers ? session.invitedUsers.size : 0}`);
                // Cache room users for party mode
                partyMgr.updateRoomUsersCache(users);
                recordRoomUsers(users);
            const me = users.find(u => parseInt(u.user_id) === keepaliveBotUserId);
            if (!me) {
                console.log(`⚠️ [Keepalive] Bot not found in user list for ${channel}`);
                return;
            }

            // Bridge health check moved to independent watchdog (see BridgeWatchdog below)

            // Conditional unmute: only when detected as muted AND not manually muted by operator
            if (me.is_speaker && me.is_muted && !channelMuteOverride.get(channel)) {
                console.log(`🔇 [Keepalive] Bot is muted in ${channel}, auto-unmuting...`);
                try {
                    await clubhousePost('update_channel_user_status', { channel, is_muted: false }, session.accountId);
                    console.log(`🔊 [Keepalive] Auto-unmuted in ${channel}`);
                    // Also unmute Agora bridge
                    try {
                        const bridgePort = session.bridgePort || 8767;
                        const WebSocket = require('ws');
                        const bws = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
                        bws.on('open', () => {
                            bws.send(JSON.stringify({ action: 'unmute' }));
                            console.log(`🔊 [Keepalive] Bridge unmute sent on port ${bridgePort}`);
                            setTimeout(() => { try { bws.close(); } catch(_){} }, 1000);
                        });
                        bws.on('error', () => {});
                    } catch (_) {}
                } catch (ue) {
                    console.log(`⚠️ [Keepalive] Auto-unmute failed in ${channel}: ${ue.message}`);
                }
            }

            // Check if we got invited to speak
            if (me.is_invited_as_speaker && !me.is_speaker && !session.isSpeaker) {
                console.log(`🎉 [Keepalive] Speaker invite detected in ${channel}!`);
                try {
                    // Use become_speaker API (discovered 2026-03-09, replaces deprecated accept_speaker_invite)
                    const becomeData = await clubhousePost('become_speaker', { channel }, session.accountId);
                    if (becomeData && becomeData.token) {
                        console.log(`✅ [Keepalive] become_speaker succeeded for ${channel}! Got Agora token.`);
                        session.isSpeaker = true;
                        session.acceptedAt = Date.now();
                        io.emit('clubhouse_speaker_accepted', { channel, timestamp: Date.now() });
                        // Auto-unmute mic via update_channel_user_status
                        try {
                            const unmuteData = await clubhousePost('update_channel_user_status', { channel, is_muted: false }, session.accountId);
                            console.log(`  🔊 Auto-unmute result: ${JSON.stringify(unmuteData).slice(0,100)}`);
                        } catch (ue) {
                            console.log(`  ⚠️ Auto-unmute failed: ${ue.message}`);
                        }
                    } else if (becomeData && becomeData.success === false) {
                        console.log(`⚠️ [Keepalive] become_speaker failed: ${becomeData.error_message || 'unknown'}`);
                    } else {
                        // become_speaker may return token without success field
                        console.log(`✅ [Keepalive] become_speaker response received for ${channel}`);
                        session.isSpeaker = true;
                        session.acceptedAt = Date.now();
                        io.emit('clubhouse_speaker_accepted', { channel, timestamp: Date.now() });
                        // Auto-unmute mic
                        try {
                            await clubhousePost('update_channel_user_status', { channel, is_muted: false }, session.accountId);
                            console.log(`  🔊 Auto-unmuted`);
                        } catch (ue) { /* ignore */ }
                    }
                } catch (speakerErr) {
                    console.log(`❌ [Keepalive] become_speaker error: ${speakerErr.response?.status || speakerErr.message}`);
                }
            } else if (me.is_speaker && !session.isSpeaker) {
                session.isSpeaker = true;
                console.log(`✅ [Keepalive] Already speaker in ${channel}`);
                // Auto-unmute only if actually muted AND not manually muted by operator
                if (me.is_muted && !channelMuteOverride.get(channel)) {
                    try {
                        await clubhousePost('update_channel_user_status', { channel, is_muted: false }, session.accountId);
                        console.log(`  🔊 [Keepalive] Auto-unmuted (was muted)`);
                    } catch (ue) {
                        console.log(`  ⚠️ [Keepalive] Auto-unmute failed: ${ue.message}`);
                    }
                } else {
                    console.log(`  ✅ [Keepalive] Already unmuted, skipping API call`);
                    // Sync bridge mute state periodically (every 2 min) in case Agora layer drifted
                    const now = Date.now();
                    if (!channelMuteOverride.get(channel) && (!session._lastBridgeUnmute || now - session._lastBridgeUnmute > 120000)) {
                        session._lastBridgeUnmute = now;
                        try {
                            const bPort = session.bridgePort || 8767;
                            const WebSocket = require('ws');
                            const bws = new WebSocket(`ws://127.0.0.1:${bPort}`);
                            bws.on('open', () => {
                                bws.send(JSON.stringify({ action: 'unmute' }));
                                setTimeout(() => { try { bws.close(); } catch(_){} }, 1000);
                            });
                            bws.on('error', () => {});
                        } catch (_) {}
                    }
                }
            }

            // Auto-invite whitelisted users (dual mode: 'auto' or 'hand')
            if (session.isSpeaker) {
                const whitelist = loadSpeakerWhitelist();
                const wlConfig = loadWhitelistConfig();
                if (whitelist.length > 0) {
                    if (!session.invitedUsers) session.invitedUsers = new Set();
                    for (const u of users) {
                        const uid = parseInt(u.user_id);
                        if (!u.is_speaker && whitelist.includes(uid)) {
                            let shouldInvite = false;
                            if (wlConfig.mode === 'auto') {
                                // Auto mode: invite on sight, once per session
                                shouldInvite = !u.is_invited_as_speaker && !session.invitedUsers.has(uid);
                            } else {
                                // Hand mode: only when user raises hand
                                shouldInvite = u.is_hand_raised && !u.is_invited_as_speaker;
                            }
                            if (shouldInvite) {
                                try {
                                    await clubhousePost('invite_speaker', { channel, user_id: uid }, session.accountId);
                                    session.invitedUsers.add(uid);
                                    console.log(`🎤 [Keepalive] Auto-invited ${u.name} (${uid}) [mode=${wlConfig.mode}]`);
                                } catch (ie) {
                                    console.log(`⚠️ [Keepalive] Auto-invite failed for ${u.name}: ${ie.message}`);
                                }
                            }
                        }
                    }
                }
            }

            // Cleanup: remove departed users from invitedUsers so they get
            // re-invited when they return. This is memory-only, no API calls.
            if (session.invitedUsers && session.invitedUsers.size > 0) {
                const currentUserIds = new Set(users.map(u => parseInt(u.user_id)));
                let cleared = 0;
                for (const uid of [...session.invitedUsers]) {
                    if (!currentUserIds.has(uid)) {
                        session.invitedUsers.delete(uid);
                        cleared++;
                    }
                }
                if (cleared > 0) {
                    console.log(`🧹 [Keepalive] Cleared ${cleared} departed users from invitedUsers (remaining: ${session.invitedUsers.size})`);
                }
            }

            // Auto-kick: web listeners, permanent blacklist, keyword blocklist
            // Reuses the get_channel data already fetched above — zero extra API calls
            if (session.isSpeaker) {
                const akCfg = loadAutokickConfig();
                if (akCfg.enabled) {
                    if (!session.kickedUsers) session.kickedUsers = new Set();
                    // Only check listeners (non-speaker, non-moderator)
                    const listeners = users.filter(u => !u.is_speaker && !u.is_moderator);
                    for (const u of listeners) {
                        const uid = parseInt(u.user_id);
                        if ((akCfg.whitelistIds || []).includes(uid)) continue;
                        if (session.kickedUsers.has(uid)) continue;
                        let reason = null;
                        if ((akCfg.blacklistIds || []).includes(uid)) {
                            reason = '永久黑名单';
                        } else if (akCfg.kickWebListeners && u.is_web_listener) {
                            reason = 'web listener';
                        } else {
                            const nameLower = (u.name || '').toLowerCase();
                            const hit = (akCfg.keywordBlocklist || []).find(kw => nameLower.includes(kw.toLowerCase()));
                            if (hit) reason = `用户名含关键词「${hit}」`;
                        }
                        if (reason) {
                            try {
                                await clubhousePost('block_from_channel', { channel, user_id: uid }, session.accountId);
                                session.kickedUsers.add(uid);
                                console.log(`🚫 [AutoKick] Kicked ${u.name} (${uid}): ${reason}`);
                            } catch (ke) {
                                console.log(`⚠️ [AutoKick] Kick failed for ${u.name} (${uid}): ${ke.message}`);
                            }
                        }
                    }
                    // Remove departed users from kickedUsers (allow re-entry check on return)
                    const currentIds = new Set(users.map(u => parseInt(u.user_id)));
                    for (const uid of [...session.kickedUsers]) {
                        if (!currentIds.has(uid)) session.kickedUsers.delete(uid);
                    }
                }
            }
        } catch (e) {
            const status = e.response?.status;
            const msg = e.response?.data?.error_message || e.message;
            session.pollErrorCount = (session.pollErrorCount || 0) + 1;
            
            if (status === 401 || status === 403) {
                console.log(`🛑 [Keepalive] Poll AUTH FAILED (${status}) - stopping all keepalive for ${channel}`);
                clearInterval(session.pingInterval);
                clearInterval(session.pollInterval);
                activeSessions.delete(kaKey);
                saveKeepaliveState();
                return;
            }
            if (e.response?.status === 404 || (msg && msg.includes('not available'))) {
                console.log(`⚠️ [Keepalive] Room no longer available: ${channel} (error #${session.pollErrorCount})`);
            }
            if (session.pollErrorCount >= 3) {
                console.log(`🛑 [Keepalive] Poll ${session.pollErrorCount} consecutive failures - stopping poll for ${channel}`);
                clearInterval(session.pollInterval);
                return;
            }
        }
    }, 120000 + Math.floor(Math.random() * 30000)); // 120-150s, match recommendation

    activeSessions.set(kaKey, session);
    saveKeepaliveState();

    // Immediate first ping
    try {
        await clubhousePost('active_ping', { channel, channel_id: null }, session.accountId);
        console.log(`📡 [Keepalive] Started for ${channel} (bot: ${keepaliveBotUserId}, account: ${session.accountId || 'default'})`);
    } catch (e) {
        console.log(`⚠️ [Keepalive] First ping failed, but keepalive started: ${e.message}`);
    }

    // Auto raise hand (skip if restoring keepalive — bot already in room)
    if (!skipRaiseHand) try {
        if (session.accountId && session.accountId !== 'main') {
            console.log(`ℹ️ [Keepalive] Skipping chweb raise_hand for non-main account (${session.accountId})`);
            // For non-main accounts, use direct API raise_hand
            try {
                const raiseData = await clubhousePost('audience_reply', { channel, raise_hands: true, unraise_hands: false }, session.accountId);
                console.log(`✋ [Keepalive] Direct raise_hand for ${session.accountId}: ${JSON.stringify(raiseData).slice(0,80)}`);
            } catch (re) {
                console.log(`ℹ️ [Keepalive] Raise hand skipped: ${re.response?.status || re.message} (${JSON.stringify(re.response?.data).slice(0,60) || ''} )`);
            }
        } else {
        // Use chweb backend for raise hand
        const jwtFile3 = '/root/chweb-jwt.json';
        if (require('fs').existsSync(jwtFile3)) {
            const { jwt: chwebJwt3 } = JSON.parse(require('fs').readFileSync(jwtFile3, 'utf8'));
            const raiseRes = await require('axios').post('http://127.0.0.1:8080/api/audience_reply',
                { channel, raise_hands: true, unraise_hands: false },
                { headers: { 'Authorization': 'Bearer ' + chwebJwt3, 'Content-Type': 'application/json' }, timeout: 10000 }
            );
            console.log(`✋ [Keepalive] Auto-raised hand via chweb in ${channel}`);
        }
        console.log(`✋ [Keepalive] Auto-raised hand in ${channel}`);
        }
    } catch (e) {
        console.log(`ℹ️ [Keepalive] Raise hand skipped: ${e.response?.data?.error_message || e.message}`);
    }

    res.json({
        success: true,
        channel,
        botUserId: keepaliveBotUserId,
        message: 'Keepalive started: ping every 30s, poll every 15s, auto-accept enabled'
    });
});


// Get active rooms (channels with running keepalive)
app.get('/api/clubhouse/active_rooms', (req, res) => {
    const rooms = [];
    for (const [channel, session] of activeSessions.entries()) {
        rooms.push({
            channel,
            isSpeaker: session.isSpeaker || false,
            pingCount: session.pingCount || 0,
            startedAt: session.startedAt || null,
        });
    }
    res.json({ rooms });
});

app.post('/api/clubhouse/stop_keepalive', requirePlayerAuth, (req, res) => {
    const { channel, accountId } = req.body;
    if (!channel) return res.json({ success: false, error_message: 'Missing channel' });

    // Try channel:accountId key first, fallback to legacy channel key
    const kaKey = channel + ':' + (accountId || 'main');
    const key = activeSessions.has(kaKey) ? kaKey : (activeSessions.has(channel) ? channel : null);
    if (key) {
        const session = activeSessions.get(key);
        clearInterval(session.pingInterval);
        clearInterval(session.pollInterval);
        activeSessions.delete(key);
        saveKeepaliveState();
        console.log(`🛑 [Keepalive] Stopped for ${key} (${session.pingCount} pings sent)`);
        res.json({ success: true, channel, pingsSent: session.pingCount });
    } else {
        res.json({ success: false, error_message: 'No active keepalive for this channel' });
    }
});

// Speaker whitelist + room users history management
app.get('/api/clubhouse/speaker_whitelist', (req, res) => {
    const whitelist = loadSpeakerWhitelist();
    const history = loadRoomUsersHistory();
    // Merge: return all historical users with whitelist status
    const users = Object.values(history).map(u => ({
        ...u,
        whitelisted: whitelist.includes(parseInt(u.user_id))
    }));
    // Sort: whitelisted first, then by last_seen
    users.sort((a, b) => {
        if (a.whitelisted !== b.whitelisted) return b.whitelisted ? 1 : -1;
        return (b.last_seen || '').localeCompare(a.last_seen || '');
    });
    const config = loadWhitelistConfig();
    res.json({ whitelist, users, mode: config.mode });
});
app.post('/api/clubhouse/speaker_whitelist/add', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, error: 'Missing user_id' });
    const list = loadSpeakerWhitelist();
    const uid = parseInt(user_id);
    if (!list.includes(uid)) list.push(uid);
    saveSpeakerWhitelist(list);
    console.log(`📋 [Whitelist] Added: ${uid}`);
    res.json({ success: true });
});
app.post('/api/clubhouse/speaker_whitelist/remove', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, error: 'Missing user_id' });
    const uid = parseInt(user_id);
    const list = loadSpeakerWhitelist().filter(id => id !== uid);
    saveSpeakerWhitelist(list);
    console.log(`📋 [Whitelist] Removed: ${uid}`);
    res.json({ success: true });
});

app.get('/api/clubhouse/whitelist_config', (req, res) => {
    res.json(loadWhitelistConfig());
});

app.post('/api/clubhouse/whitelist_config', (req, res) => {
    const { mode } = req.body;
    if (!['auto', 'hand'].includes(mode)) return res.json({ success: false, error: 'Invalid mode' });
    saveWhitelistConfig({ mode });
    console.log(`📋 [Whitelist] Mode changed to: ${mode}`);
    res.json({ success: true, mode });
});

// Get keepalive status
app.get('/api/clubhouse/keepalive_status', (req, res) => {
    const sessions = {};
    for (const [channel, session] of activeSessions) {
        sessions[channel] = {
            isSpeaker: session.isSpeaker,
            pingCount: session.pingCount,
            acceptedAt: session.acceptedAt,
        };
    }
    res.json({ sessions, count: activeSessions.size });
});

// Force leave: stop keepalive + leave channel + stop broadcast session all at once
app.post('/api/clubhouse/force_leave', requirePlayerAuth, async (req, res) => {
    const { channel, sessionId, accountId } = req.body;
    const results = { keepalive: false, leave: false, broadcast: false };
    
    // 1. Stop keepalive (try channel:accountId key, fallback to channel)
    const fkaKey = channel ? channel + ':' + (accountId || 'main') : null;
    const fkey = fkaKey && activeSessions.has(fkaKey) ? fkaKey : (channel && activeSessions.has(channel) ? channel : null);
    if (fkey) {
        const kaSession = activeSessions.get(fkey);
        clearInterval(kaSession.pingInterval);
        clearInterval(kaSession.pollInterval);
        activeSessions.delete(fkey);
        saveKeepaliveState();
        results.keepalive = true;
        console.log(`🔌 [Force Leave] Keepalive stopped for ${fkey}`);
    }
    
    // 2. Leave Clubhouse channel via API
    if (channel) {
        try {
            await clubhousePost('leave_channel', { channel }, accountId || null);
            results.leave = true;
            console.log(`🔌 [Force Leave] Left channel ${channel}`);
        } catch (e) {
            console.log(`⚠️ [Force Leave] leave_channel failed: ${e.message}`);
            // Also try via chweb
            try {
                const jwtFile = '/root/chweb-jwt.json';
                if (require('fs').existsSync(jwtFile)) {
                    const { jwt: chwebJwt } = JSON.parse(require('fs').readFileSync(jwtFile, 'utf8'));
                    await axios.post('http://127.0.0.1:8080/api/leave_channel',
                        { channel },
                        { headers: { 'Authorization': 'Bearer ' + chwebJwt }, timeout: 5000 }
                    );
                    results.leave = true;
                    console.log(`🔌 [Force Leave] Left via chweb`);
                }
            } catch (e2) { /* ignore */ }
        }
    }
    
    // 3. Stop broadcast session if sessionId provided
    if (sessionId) {
        try {
            const result = await sessionMgr.deleteSession(sessionId);
            if (!result?.error) {
                results.broadcast = true;
                console.log(`🔌 [Force Leave] Broadcast session ${sessionId} deleted`);
            } else {
                console.log(`⚠️ [Force Leave] deleteSession failed for ${sessionId}: ${result.error}`);
            }
        } catch (e) {
            console.log(`⚠️ [Force Leave] Broadcast delete failed: ${e.message}`);
        }
    }
    
    console.log(`🔌 [Force Leave] Results:`, results);
    res.json({ success: true, results });
});




// === Authenticated File Downloads ===
const PROJECT_PASSWORD = 'MC26@Party';

function checkProjectAuth(req) {
    const token = req.query.token || req.headers['x-project-token'] || '';
    const crypto = require('crypto');
    const expectedHash = crypto.createHash('sha256').update(PROJECT_PASSWORD).digest('hex');
    return token === expectedHash;
}

app.get('/api/download/ssh-key', (req, res) => {
    if (!checkProjectAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const filePath = __dirname + '/secure-downloads/ssh_key.zip';
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath, 'ssh_key.zip');
});

app.get('/api/download/project-accounts', (req, res) => {
    if (!checkProjectAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const filePath = __dirname + '/secure-downloads/project_accounts.zip';
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath, 'project_accounts.zip');
});

// === SSH Key Management ===
app.delete('/api/project-key', (req, res) => {
    const fs = require('fs');
    const keyPath = __dirname + '/secure-downloads/ssh_key.zip';
    try {
        if (fs.existsSync(keyPath)) {
            fs.unlinkSync(keyPath);
            console.log('[Project] SSH key package deleted');
            res.json({ ok: true, message: 'Key deleted' });
        } else {
            res.json({ ok: true, message: 'Key already deleted' });
        }
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
});

app.get('/api/project-key/status', (req, res) => {
    const fs = require('fs');
    const keyPath = __dirname + '/secure-downloads/ssh_key.zip';
    res.json({ exists: require('fs').existsSync(keyPath) });
});


// === Project Accounts Key Management ===
app.delete('/api/project-accounts', (req, res) => {
    const fs = require('fs');
    const filePath = __dirname + '/secure-downloads/project_accounts.zip';
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log('[Project] Accounts package deleted');
            res.json({ ok: true, message: 'Accounts deleted' });
        } else {
            res.json({ ok: true, message: 'Already deleted' });
        }
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
});

app.get('/api/project-accounts/status', (req, res) => {
    const fs = require('fs');
    const filePath = __dirname + '/secure-downloads/project_accounts.zip';
    res.json({ exists: require('fs').existsSync(filePath) });
});

server.listen(PORT, '0.0.0.0', () => {
    // Auto-restore keepalive from previous session
    // === PulseAudio Health Watchdog ===
    // Check every 60s if PulseAudio is alive; auto-restart + recreate sinks if dead
    setInterval(() => {
        const { execSync, exec } = require('child_process');
        try {
            execSync('su - studio -c "pulseaudio --check"', { timeout: 5000 });
        } catch (_) {
            console.log('💀 [PulseAudio] DEAD — restarting...');
            try {
                execSync('su - studio -c "pulseaudio --kill 2>/dev/null; sleep 1; pulseaudio --start --exit-idle-time=-1 --log-target=syslog"', { timeout: 10000 });
                console.log('✅ [PulseAudio] Restarted');
                // Recreate sinks for all active sessions
                const _sm2 = require('./session-manager');
                let sessions = [];
                try { sessions = _sm2.listSessions ? _sm2.listSessions() : []; } catch(_) {}
                if (!Array.isArray(sessions)) sessions = [];
                for (const sess of sessions) {
                    if (sess.needsBridge) {
                        const sinkName = 'session_' + sess.shortId;
                        try {
                            execSync(`su - studio -c 'pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=${sinkName}'`, { timeout: 5000 });
                            console.log(`  🔊 [PulseAudio] Recreated sink: ${sinkName}`);
                            // Move Chrome audio to this sink (delayed to allow Chrome to reconnect)
                            setTimeout(() => {
                                try {
                                    const inputs = execSync('su - studio -c "pactl list short sink-inputs"', { timeout: 5000 }).toString().trim();
                                    if (inputs) {
                                        for (const line of inputs.split('\n')) {
                                            const idx = line.split('\t')[0];
                                            if (idx) {
                                                try {
                                                    execSync(`su - studio -c "pactl move-sink-input ${idx} ${sinkName}"`, { timeout: 3000 });
                                                    console.log(`  🔀 [PulseAudio] Moved input ${idx} → ${sinkName}`);
                                                } catch(_) {}
                                            }
                                        }
                                    }
                                } catch(_) {}
                            }, 3000);
                        } catch (e2) {
                            console.log(`  ⚠️ [PulseAudio] Sink recreate failed: ${e2.message}`);
                        }
                    }
                }
            } catch (e) {
                console.log(`❌ [PulseAudio] Restart failed: ${e.message}`);
            }
        }
    }, 60000);
    console.log('🩺 [PulseAudio] Health watchdog started (60s interval)');

    // === Orphaned PA Sink Cleanup (every 60s) ===
    setInterval(async () => {
        try {
            const raw = typeof sessionMgr.listSessions === 'function' ? sessionMgr.listSessions() : null;
            const activeSessions = raw && raw.sessions ? raw.sessions : [];
            const activeIds = new Set(activeSessions.map(s => s.shortId));

            const sinkList = await runCmd(
                `sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl list short sinks 2>/dev/null || true`
            );
            if (!sinkList) return;
            const sessionSinks = sinkList.split('\n').filter(l => l.includes('session_'));
            // Only cleanup if orphaned sinks exceed active sessions + 2
            if (sessionSinks.length <= activeSessions.length + 2) return;

            const moduleList = await runCmd(
                `sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl list short modules 2>/dev/null || true`
            );
            let cleaned = 0;
            for (const line of sessionSinks) {
                const parts = line.trim().split('\t');
                if (parts.length < 2) continue;
                const sinkName = parts[1];
                const shortId = sinkName.replace('session_', '');
                if (activeIds.has(shortId)) continue;
                const modLine = (moduleList || '').split('\n').find(m => m.includes('sink_name=' + sinkName));
                if (modLine) {
                    const modIdx = modLine.trim().split('\t')[0];
                    try {
                        await runCmd(`sudo -u studio XDG_RUNTIME_DIR=/tmp/runtime-studio pactl unload-module ${modIdx} 2>/dev/null || true`);
                        cleaned++;
                    } catch(_) {}
                }
            }
            if (cleaned > 0) console.log(`🧹 [PulseAudio] Cleaned ${cleaned} orphaned sinks`);
        } catch(_) {}
    }, 60000);

    // === Bridge operation lock (using module-level _bridgeOpInProgress and _bridgeLastRestartTime) ===

    // === Bridge Health Watchdog (independent of keepalive) ===
    // Safe mode: detect dead bridge, restart it, but with mutex to prevent concurrent restarts
    let _bridgeWatchdogBusy = false;
    // _bridgeLastRestartTime is now module-level
    setInterval(async () => {
        if (_bridgeWatchdogBusy) return;
        if (_bridgeOpInProgress) return; // Skip if reconnect is handling bridge
        // Cooldown: Wine needs 30-45s. Skip checks for 120s after any restart
        if (Date.now() - _bridgeLastRestartTime < 120000) return;

        const raw = typeof sessionMgr.listSessions === 'function' ? sessionMgr.listSessions() : null;
        const sessions = raw && raw.sessions ? raw.sessions : [];
        if (sessions.length === 0) return;

        for (const sess of sessions) {
            if (!sess.bridgePort) continue;
            const net = require('net');
            try {
                await new Promise((resolve, reject) => {
                    const sock = net.connect(sess.bridgePort, '127.0.0.1', () => { sock.destroy(); resolve(); });
                    sock.on('error', reject);
                    sock.setTimeout(2000, () => { sock.destroy(); reject(new Error('timeout')); });
                });
            } catch (_) {
                _bridgeWatchdogBusy = true;
                _bridgeLastRestartTime = Date.now();
                console.log(`⚠️ [BridgeWatchdog] Port ${sess.bridgePort} dead for ${sess.shortId}, restarting...`);
                try {
                    const result = await sessionMgr.restartBridge(sess.sessionId);
                    if (result && result.success) {
                        console.log(`✅ [BridgeWatchdog] Restarted on port ${sess.bridgePort}, waiting 40s for Wine...`);
                        // Wait 40s for Wine/Electron to fully start, then get fresh token + join Agora
                        const roomInfo = sess.roomInfo || {};
                        if (roomInfo.channel) {
                            setTimeout(async () => {
                                // Verify bridge is actually ready before join
                                const checkSock = net.connect(sess.bridgePort, '127.0.0.1', () => {
                                    checkSock.destroy();
                                    console.log(`[BridgeWatchdog] Bridge port ${sess.bridgePort} confirmed ready`);
                                    // Get fresh Agora token via join_channel (old token may be expired)
                                    (async () => {
                                        // Use stored token - DO NOT call join_channel (it resets speaker status = muted)
                                        let freshToken = roomInfo.token || '';
                                        let freshAppId = '938de3e8055e42b281bb8c6f69c21f78';
                                        console.log('[BridgeWatchdog] Using stored Agora token (skipping join_channel to avoid mute)');
                                        // Only unmute via API if actually muted (conditional - R2 safety)
                                        // Note: we don't have is_muted info here, so always unmute after bridge restart (one-time, acceptable)
                                        try {
                                            await clubhousePost('update_channel_user_status', { channel: roomInfo.channel, is_muted: false }, sess.accountId || 'main');
                                            console.log('[BridgeWatchdog] API unmute sent');
                                        } catch(_) {}

                                        // Now send join + unmute to bridge with fresh token
                                        try {
                                            const WebSocket = require('ws');
                                            const ws = new WebSocket('ws://127.0.0.1:' + sess.bridgePort);
                                            ws.on('open', () => {
                                                ws.send(JSON.stringify({ action: 'leave' }));
                                                setTimeout(() => {
                                                    if (ws.readyState !== 1) return;
                                                    ws.send(JSON.stringify({ id: 1, action: 'join', token: freshToken, channel_name: roomInfo.channel, user_id: roomInfo.botUserId || 0, speaker: true, app_id: freshAppId }));
                                                    console.log('[BridgeWatchdog] Agora join sent (fresh token)');
                                                }, 300);
                                                setTimeout(() => {
                                                    if (ws.readyState === 1) { ws.send(JSON.stringify({ action: 'unmute' })); console.log('[BridgeWatchdog] Unmute sent'); ws.close(); }
                                                }, 5000);
                                            });
                                            ws.on('error', (e) => console.log('[BridgeWatchdog] WS error: ' + e.message));
                                        } catch (e) { console.log('[BridgeWatchdog] Join error: ' + e.message); }
                                    })();
                                });
                                checkSock.on('error', () => { console.log(`[BridgeWatchdog] Bridge port ${sess.bridgePort} still not ready after 40s`); });
                                checkSock.setTimeout(3000, () => { checkSock.destroy(); });
                            }, 40000); // Wait 40s for Wine to fully start
                        }
                        io.emit('bridge_restarted', { bridgePort: sess.bridgePort, sessionId: sess.sessionId });
                    } else {
                        console.log(`❌ [BridgeWatchdog] Restart returned: ${JSON.stringify(result)}`);
                    }
                } catch (re) { console.error(`❌ [BridgeWatchdog] Restart failed: ${re.message}`); }
                _bridgeWatchdogBusy = false;
            }
        }
    }, 30000);
    console.log('🩺 [BridgeWatchdog] Independent bridge watchdog started (30s interval, 90s cooldown)');

    // One-shot zombie ffplay cleanup at startup.
    // Long-running deployments accumulate ffplay processes stuck in T/Tl (stopped) state
    // (4+ found in production, oldest from May). They hold PulseAudio sinks in RUNNING state
    // and leak file descriptors. Safe to kill: stopped processes are not playing audio.
    try {
        const { execSync } = require('child_process');
        // List ffplay processes that are stopped (state starts with T)
        const out = execSync(`ps -eo pid,stat,cmd | awk '$3 ~ /ffplay/ && $2 ~ /^T/ {print $1}'`,
            { encoding: 'utf8', timeout: 3000 }).trim();
        const zombiePids = out ? out.split('\n').filter(Boolean) : [];
        if (zombiePids.length > 0) {
            console.log(`🧹 [Cleanup] Found ${zombiePids.length} zombie ffplay process(es): ${zombiePids.join(', ')}`);
            for (const pid of zombiePids) {
                try { execSync(`kill -9 ${pid} 2>/dev/null || true`); } catch (_) {}
            }
            console.log(`🧹 [Cleanup] Killed ${zombiePids.length} zombie ffplay process(es)`);
        } else {
            console.log('🧹 [Cleanup] No zombie ffplay processes found');
        }
    } catch (e) {
        console.log('⚠️ [Cleanup] ffplay zombie scan failed: ' + e.message);
    }

    const savedKA = loadKeepaliveState();
    if (savedKA.length > 0) {
        console.log(`\n🔄 [Keepalive] Restoring ${savedKA.length} keepalive session(s)...`);
        setTimeout(async () => {
            for (const ka of savedKA) {
                try {
                    const res = await fetch(`http://127.0.0.1:${PORT}/api/clubhouse/start_keepalive`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ channel: ka.channel, accountId: ka.accountId === 'main' ? undefined : ka.accountId, skipRaiseHand: true })
                    });
                    const data = await res.json();
                    console.log(`  ✅ Restored keepalive: ${ka.channel} (${data.success ? 'ok' : data.error_message})`);
                    // After server restart the Clubhouse state may have reset mute — force unmute regardless of cached state
                    setTimeout(async () => {
                        try {
                            await clubhousePost('update_channel_user_status', { channel: ka.channel, is_muted: false }, ka.accountId === 'main' ? null : ka.accountId);
                            console.log(`  🔊 [Restore] Force-unmuted ${ka.channel} after restart`);
                        } catch (ue) {
                            console.log(`  ⚠️ [Restore] Force-unmute failed for ${ka.channel}: ${ue.message}`);
                        }
                    }, 5000);
                } catch (e) {
                    console.log(`  ❌ Failed to restore keepalive for ${ka.channel}: ${e.message}`);
                }
            }
        }, 3000); // Wait 3s for server to fully initialize
    }

    const hasPlayer = !!getPasswordHash('player');
    const hasLyrics = !!getPasswordHash('lyrics');
    const hasSlots = !!getPasswordHash('slots');
    const hasSleep = !!getPasswordHash('sleep');
    console.log(`🌟 Prince Music → http://localhost:${PORT}`);

    // Auto-next callback: when ffplay finishes a song and skipTrack picks the next one,
    // emit state_update to the correct session room so Remote UI shows the right track name
    // Server-driven playback: push progress to session rooms
sessionMgr.setIOBroadcast((sessionId, eventType, data) => {
    if (eventType === 'state_update') {
        const summary = JSON.stringify(data).slice(0, 120);
        console.log(`📤 [IOBroadcast] → session:${sessionId?.slice(0,8)} | ${summary}`);
    }
    io.to(`session:${sessionId}`).emit(eventType, data);
    // Keep socket.js playerState in sync so new clients get current progress
    if (eventType === 'state_update' && sessionManager.updatePlayerState) {
        sessionManager.updatePlayerState(sessionId, data);
        // If the broadcast says playing:true but socket.js still has null currentTrack
        // (e.g. after reconnect without a fresh 'load' action), inject the track info
        // stored in session-manager so reconnected Remote pages show the correct song.
        if (data.playing === true && sessionManager.getPlayerState) {
            const ps = sessionManager.getPlayerState(sessionId);
            if (ps && !ps.currentTrack) {
                const trackInfo = sessionMgr.getCurrentTrackInfo(sessionId);
                if (trackInfo) {
                    sessionManager.updatePlayerState(sessionId, { currentTrack: trackInfo });
                    io.to(`session:${sessionId}`).emit('state_update', { currentTrack: trackInfo });
                }
            }
        }
    }
});

sessionMgr.setOnAutoNextCallback((sessionId, trackInfo) => {
        const room = 'session:' + sessionId;
        const trackPayload = { id: trackInfo.id || trackInfo.url, title: trackInfo.title, url: trackInfo.url };
        console.log(`[Audio] Auto-next → UI: "${trackInfo.title?.slice(0,40)}" → room ${room}`);
        io.to(room).emit('state_update', {
            currentTrack: trackPayload,
            currentIndex: trackInfo.index,
            playing: true,
            currentTime: 0
        });
        // Sync into socket.js playerState so new connections get the correct track
        if (sessionManager.updatePlayerState) {
            sessionManager.updatePlayerState(sessionId, {
                currentTrack: trackPayload,
                playing: true,
                currentTime: 0
            });
        }
        // Keep session-manager's track info in sync for ioBroadcastCallback injection
        sessionMgr.setCurrentTrackInfo(sessionId, trackPayload);
    });

    // Party mode: auto-play next from queue when track ends
    sessionMgr.setOnTrackEndHook((sessionId) => {
        const ps = partyMgr.getState();
        if (!ps.enabled) return false; // Not in party mode
        if (!ps.currentItem && ps.queue.filter(q => q.status === 'waiting').length === 0) return false;
        
        const next = partyMgr.onTrackEnd();
        if (!next) {
            // Queue exhausted - let normal shuffle take over
            console.log('🎉 [Party] Queue empty, resuming normal playback');
            io.emit('party_update', partyMgr.getState());
            return false;
        }
        
        console.log(`🎉 [Party] Auto-next: ${next.song.title?.slice(0, 30)} by ${next.nickname}`);
        sessionMgr.playTrack(sessionId, next.song.url).catch(() => {});
        sessionMgr.updateTracks(sessionId, null, next.song);
        const room = 'session:' + sessionId;
        io.to(room).emit('state_update', {
            currentTrack: { id: next.song.id || next.song.url, title: next.song.title, url: next.song.url }
        });
        io.emit('party_update', partyMgr.getState());
        return true; // Handled - skip normal skipTrack
    });

    // Party mode: periodic time limit checker (every 10 seconds)
    const partyTimeLimitChecker = setInterval(() => {
        const result = partyMgr.checkTimeLimit();
        if (result.shouldSkip) {
            console.log(`⏰ [Party] Time limit: ${result.reason}`);
            const next = partyMgr.onTrackEnd();
            if (next) {
                // Find active session to play next track
                const sessions = Object.keys(io.sockets.adapter.rooms).length > 0 ? 
                    Array.from(io.sockets.adapter.rooms.keys()) : [];
                // Use the first connected session's room
                const sessionId = sessions.find(s => s.startsWith('session:'))?.replace('session:', '');
                if (sessionId) {
                    sessionMgr.playTrack(sessionId, next.song.url).catch(() => {});
                    sessionMgr.updateTracks(sessionId, null, next.song);
                }
                io.emit('state_update', {
                    currentTrack: { id: next.song.id || next.song.url, title: next.song.title, url: next.song.url }
                });
                io.emit('party_update', partyMgr.getState());
                io.emit('party_error', result.reason);
            } else {
                // Queue empty
                io.emit('party_update', partyMgr.getState());
            }
        }
    }, 10000);
    console.log(`🔐 Player: ${hasPlayer ? '✅' : '❌'} | 歌词: ${hasLyrics ? '✅' : '❌'} | Slots: ${hasSlots ? '✅' : '❌'} | Sleep: ${hasSleep ? '✅' : '❌'}`);
    if (!hasPlayer || !hasLyrics || !hasSlots || !hasSleep) {
        console.log('⚠️  请运行 node set-password.js <类型> <密码> 设置密码');
    }
});
