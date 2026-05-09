// Socket.IO handler — Session-aware version for staging
// Each session has independent playerState, scoped broadcasts via Socket.IO rooms
const { loadData, saveData } = require('./db');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '.auth');
const MAX_SESSIONS = 3;

function verifySlotPassword(plain) {
    const file = path.join(AUTH_DIR, 'slots.hash');
    if (!fs.existsSync(file)) return false;
    const stored = fs.readFileSync(file, 'utf8').trim();
    const hash = crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored, 'hex'));
    } catch { return false; }
}

const SLOT_TEMPLATES = [
    { id: 0, duration: 60, label: '1分钟' },
    { id: 1, duration: 180, label: '3分钟' },
    { id: 2, duration: 300, label: '5分钟' },
    { id: 3, duration: 420, label: '7分钟' },
    { id: 4, duration: 600, label: '10分钟' },
    { id: 5, duration: 1800, label: '半小时' },
];

module.exports = (io) => {
    // Hook: called when socket.js selects a new track (next/prev/shuffle)
    // server.js sets this to trigger ffplay for broadcast sessions
    let onTrackSelected = null;
    function setOnTrackSelected(fn) { onTrackSelected = fn; }
    // Session states: Map<sessionId, { playerState, sleepLocked, shuffleCooldown }>
    const sessionStates = new Map();
    const DEFAULT_SESSION = 'default';

    function getOrCreateSession(sessionId) {
        if (!sessionStates.has(sessionId)) {
            sessionStates.set(sessionId, {
                playerState: {
                    playing: false, currentTrack: null, volume: 1.0,
                    currentTime: 0, duration: 0, loopMode: 'list', gain: 1.0
                },
                sleepLocked: false,
                shuffleCooldown: {} // playlistId -> cooldown counter
            });
            console.log(`📻 Session created: ${sessionId}`);
        }
        return sessionStates.get(sessionId);
    }

    // Voice Slots — per-user sessions (global, not session-scoped)
    const userSessions = new Map();
    const socketUserMap = new Map();

    // Tick every second for slot transitions
    setInterval(() => {
        const now = Date.now();
        let globalChanged = false;

        for (const [userId, sessions] of userSessions.entries()) {
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
                userSessions.set(userId, filtered);
                userChanged = true;
                globalChanged = true;
            }

            if (userChanged) {
                const userSockets = Array.from(io.sockets.sockets.values()).filter(s => s.handshake.auth.userId === userId);
                userSockets.forEach(s => s.emit('my_slot_update', userSessions.get(userId) || []));
            }
        }

        if (globalChanged) {
            io.emit('slots_update', Array.from(userSessions.values()).flat());
        }
    }, 1000);

    // === Shuffle helper: cross-playlist random with cooldown ===
    function shuffleNext(session, songs) {
        const allSongs = songs.filter(s => !s.hidden);
        if (allSongs.length === 0) return null;

        // Group by playlist
        const byPlaylist = {};
        allSongs.forEach(s => {
            if (!byPlaylist[s.playlistId]) byPlaylist[s.playlistId] = [];
            byPlaylist[s.playlistId].push(s);
        });

        const playlistIds = Object.keys(byPlaylist);
        const cooldown = session.shuffleCooldown;

        // Decay all cooldowns
        playlistIds.forEach(id => {
            if (cooldown[id] > 0) cooldown[id]--;
        });

        // Filter out cooled-down playlists
        let available = playlistIds.filter(id => !cooldown[id] || cooldown[id] <= 0);
        if (available.length === 0) available = playlistIds; // fallback: all playlists

        // Pick random playlist
        const pickedPlaylistId = available[Math.floor(Math.random() * available.length)];
        const candidates = byPlaylist[pickedPlaylistId];

        // Avoid same song
        const currentId = session.playerState.currentTrack?.id;
        const filtered = candidates.filter(s => s.id !== currentId);
        const pool = filtered.length > 0 ? filtered : candidates;

        // Pick random song
        const nextSong = pool[Math.floor(Math.random() * pool.length)];

        // Apply cooldown to picked playlist
        cooldown[pickedPlaylistId] = (cooldown[pickedPlaylistId] || 0) + 2;

        return nextSong;
    }

    io.on('connection', (socket) => {
        const userId = socket.handshake.auth.userId || socket.id;
        const sessionId = socket.handshake.auth.sessionId || DEFAULT_SESSION;

        console.log(`User connected: ${userId} session: ${sessionId} (${socket.handshake.address})`);

        // Join Socket.IO room for this session
        socket.join(`session:${sessionId}`);
        socketUserMap.set(socket.id, userId);

        // Get or create session state
        const session = getOrCreateSession(sessionId);
        const ps = session.playerState;

        // Restore voice slots
        if (userSessions.has(userId)) {
            const slots = userSessions.get(userId);
            slots.forEach(s => s.socketId = socket.id);
            socket.emit('my_slot_update', slots);
        }

        // Send current state for THIS session
        socket.emit('state_update', ps);
        socket.emit('slot_templates', SLOT_TEMPLATES);
        socket.emit('slots_update', Array.from(userSessions.values()).flat());
        socket.emit('sleep_lock_update', session.sleepLocked);
        socket.emit('session_info', {
            sessionId,
            activeSessions: Array.from(sessionStates.keys()),
            maxSessions: MAX_SESSIONS
        });

        const refreshData = () => {
            const { playlists, songs } = loadData();
            socket.emit('data_update', { playlists, songs });
            socket.emit('state_update', ps);
        };
        refreshData();

        socket.on('get_data', refreshData);

        // Player Actions — scoped to session room
        socket.on('player_action', (action) => {
            const MANUAL_ACTIONS = ['play', 'pause', 'seek', 'volume', 'load', 'gain', 'loop'];
            if (session.sleepLocked && MANUAL_ACTIONS.includes(action.type)) return;

            if (action.type === 'play') ps.playing = true;
            if (action.type === 'pause') ps.playing = false;
            if (action.type === 'volume') ps.volume = action.payload;
            if (action.type === 'seek') ps.currentTime = action.payload;
            if (action.type === 'duration') ps.duration = action.payload;
            if (action.type === 'loop') ps.loopMode = action.payload;
            if (action.type === 'gain') ps.gain = action.payload;

            if (action.type === 'load') {
                ps.currentTrack = action.payload;
                ps.playing = true;
                ps.currentTime = 0;
                ps.duration = 0;
            }

            if (action.type === 'next' || action.type === 'prev') {
                const { songs } = loadData();
                const isNext = action.type === 'next';

                // Shuffle mode: cross-playlist random
                if (ps.loopMode === 'shuffle') {
                    const nextSong = shuffleNext(session, songs);
                    if (nextSong) {
                        ps.currentTrack = nextSong;
                        ps.playing = true;
                        ps.currentTime = 0;
                        ps.duration = 0;
                        io.to(`session:${sessionId}`).emit('player_action', { type: 'load', payload: ps.currentTrack });
                        io.to(`session:${sessionId}`).emit('state_update', ps);
                        if (onTrackSelected) onTrackSelected(sessionId, nextSong);
                    }
                    return;
                }

                // Normal next/prev within playlist
                const currentId = ps.currentTrack?.id;
                const siblings = ps.currentTrack
                    ? songs.filter(s => s.playlistId === ps.currentTrack.playlistId && !s.hidden)
                    : [];

                if (siblings.length > 0) {
                    let idx = siblings.findIndex(s => s.id === currentId);
                    if (idx === -1) idx = 0;

                    let nextIdx = idx;

                    if (ps.loopMode === 'single') {
                        if (isNext) nextIdx++; else nextIdx--;
                    } else if (ps.loopMode === 'order') {
                        if (isNext) nextIdx++; else nextIdx--;
                        if (nextIdx >= siblings.length) {
                            ps.playing = false;
                            io.to(`session:${sessionId}`).emit('state_update', ps);
                            return;
                        }
                    } else {
                        if (isNext) nextIdx++; else nextIdx--;
                    }

                    if (nextIdx >= siblings.length) nextIdx = 0;
                    if (nextIdx < 0) nextIdx = siblings.length - 1;

                    ps.currentTrack = siblings[nextIdx];
                    ps.playing = true;
                    ps.currentTime = 0;
                    ps.duration = 0;
                    io.to(`session:${sessionId}`).emit('player_action', { type: 'load', payload: ps.currentTrack });
                    io.to(`session:${sessionId}`).emit('state_update', ps);
                    if (onTrackSelected) onTrackSelected(sessionId, ps.currentTrack);
                    return;
                }
            }

            // Broadcast to session room only
            io.to(`session:${sessionId}`).emit('player_action', action);
            if (sessionId === DEFAULT_SESSION) {
                // Default session: send full state as before
                console.log(`📤 [socket.js] DEFAULT state_update → session:default | playing=${ps.playing} track=${ps.currentTrack?.title?.slice(0,20)}`);
                io.to(`session:${sessionId}`).emit('state_update', ps);
            } else {
                // Broadcast sessions: send only changed fields to avoid wiping currentTrack
                // (server.js manages full state via ioBroadcastCallback; ps.currentTrack may be null)
                const delta = {};
                if (action.type === 'pause')       delta.playing = false;
                else if (action.type === 'play')   delta.playing = true;
                else if (action.type === 'volume') delta.volume = ps.volume;
                else if (action.type === 'seek')   delta.currentTime = ps.currentTime;
                else if (action.type === 'loop')   delta.loopMode = ps.loopMode;
                else if (action.type === 'gain')   delta.gain = ps.gain;
                else if (action.type === 'load') {
                    delta.currentTrack = ps.currentTrack;
                    delta.playing = ps.playing;
                    delta.currentTime = ps.currentTime;
                    delta.duration = ps.duration;
                }
                if (Object.keys(delta).length > 0) {
                    console.log(`📤 [socket.js] BROADCAST state_update → session:${sessionId.slice(0,8)} | ${JSON.stringify(delta).slice(0,80)}`);
                    io.to(`session:${sessionId}`).emit('state_update', delta);
                }
            }
        });

        socket.on('time_update', (time) => {
            // For broadcast sessions, ignore client time_update (server timer is source of truth)
            if (sessionId !== 'default' && sessionId !== DEFAULT_SESSION) return;
            ps.currentTime = time;
            socket.to(`session:${sessionId}`).emit('state_update', { currentTime: time });
        });

        // Sleep Lock — per session
        socket.on('set_sleep_lock', () => {
            session.sleepLocked = true;
            io.to(`session:${sessionId}`).emit('sleep_lock_update', true);
            console.log(`🌙 Sleep lock activated (session: ${sessionId})`);
        });

        socket.on('sleep_unlock', () => {
            session.sleepLocked = false;
            io.to(`session:${sessionId}`).emit('sleep_lock_update', false);
            console.log(`✨ Sleep lock released (session: ${sessionId})`);
        });

        // Slot Management (global, not session-scoped)
        socket.on('activate_slot', ({ slotId }) => {
            const sessions = userSessions.get(userId) || [];
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
            userSessions.set(userId, sessions);

            socket.emit('my_slot_update', sessions);
            io.emit('slots_update', Array.from(userSessions.values()).flat());
        });

        socket.on('reset_slots', (pwd) => {
            if (verifySlotPassword(pwd)) {
                userSessions.clear();
                io.emit('my_slot_update', []);
                io.emit('slots_update', []);
                io.emit('force_reset');
            }
        });

        // Voice Data Relay
        socket.on('voice_data', (data) => {
            data.userId = userId;
            const sessions = userSessions.get(userId) || [];
            const activeSession = sessions.find(s => s.stage === 'active');
            if (activeSession) {
                if (data.isHeader) activeSession.header = data.buffer;
                if (activeSession.header) data.header = activeSession.header;
                socket.broadcast.emit('voice_data', data);
            }
        });

        // Data Management
        socket.on('create_playlist', (name) => {
            const { playlists, songs } = loadData();
            const newId = Date.now().toString();
            playlists.push({ id: newId, name, hidden: false });
            saveData(playlists, songs);
            refreshData();
        });

        socket.on('delete_playlist', (id) => {
            const { playlists, songs } = loadData();
            const filteredPlaylists = playlists.filter(p => p.id !== id);
            const filteredSongs = songs.filter(s => s.playlistId !== id);
            saveData(filteredPlaylists, filteredSongs);
            refreshData();
        });

        socket.on('delete_song', (id) => {
            const { playlists, songs } = loadData();
            const filteredSongs = songs.filter(s => s.id !== id);
            saveData(playlists, filteredSongs);
            refreshData();
        });

        // Rename playlist
        socket.on('rename_playlist', ({ id, name }) => {
            if (!id || !name) return;
            const { playlists, songs } = loadData();
            const pl = playlists.find(p => p.id === id);
            if (pl) {
                pl.name = name;
                saveData(playlists, songs);
                refreshData();
                console.log(`📝 Playlist renamed: ${id} → ${name}`);
            }
        });

        // Move song to another playlist
        socket.on('move_song', ({ songId, targetPlaylistId }) => {
            if (!songId || !targetPlaylistId) return;
            const { playlists, songs } = loadData();
            const song = songs.find(s => s.id === songId);
            const targetPl = playlists.find(p => p.id === targetPlaylistId);
            if (song && targetPl) {
                const oldPlId = song.playlistId;
                song.playlistId = targetPlaylistId;
                saveData(playlists, songs);
                refreshData();
                console.log(`📦 Song moved: "${song.title?.slice(0,30)}" → ${targetPl.name}`);
            }
        });

        socket.on('disconnect', () => {
            socketUserMap.delete(socket.id);
            const slots = userSessions.get(userId);
            if (slots) {
                slots.forEach(s => {
                    if (s.socketId === socket.id) s.socketId = null;
                });
            }
        });
    });

    // === Session management API (called from server.js) ===
    return {
        setOnTrackSelected,
        // Called by server.js to sync server-driven progress into socket.js playerState
        updatePlayerState: (sessionId, updates) => {
            const session = sessionStates.get(sessionId);
            if (session) {
                const ps = session.playerState;
                if (updates.currentTime !== undefined) ps.currentTime = updates.currentTime;
                if (updates.duration !== undefined) ps.duration = updates.duration;
                if (updates.playing !== undefined) ps.playing = updates.playing;
                if (updates.currentTrack !== undefined) ps.currentTrack = updates.currentTrack;
            }
        },
        getPlayerState: (sessionId) => {
            const session = sessionStates.get(sessionId);
            return session ? session.playerState : null;
        },
        getActiveSessions: () => Array.from(sessionStates.keys()),
        getSessionCount: () => sessionStates.size,
        getMaxSessions: () => MAX_SESSIONS,
        createSession: () => {
            if (sessionStates.size >= MAX_SESSIONS) return null;
            const id = crypto.randomUUID();
            getOrCreateSession(id);
            return id;
        },
        deleteSession: (id) => {
            if (id === DEFAULT_SESSION) return false;
            sessionStates.delete(id);
            // Disconnect all sockets in the session room
            const room = io.sockets.adapter.rooms.get(`session:${id}`);
            if (room) {
                room.forEach(socketId => {
                    const s = io.sockets.sockets.get(socketId);
                    if (s) s.disconnect(true);
                });
            }
            console.log(`🗑️ Session deleted: ${id}`);
            return true;
        }
    };
};
