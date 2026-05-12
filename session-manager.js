const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_SESSIONS = 3;
const SITE_URL = 'https://clubhouses.party/';
const BRIDGE_PORTS = [8767, 8768, 8769];

// PulseAudio settings (studio user)
const PA_ENV = {
    XDG_RUNTIME_DIR: '/tmp/runtime-studio',
    PULSE_SERVER: 'unix:/tmp/runtime-studio/pulse/native'
};

const activeSessions = new Map();

// Callback hooks
let onTrackEndHook = null;
let onAutoNextCallback = null;
// IO callback: called to broadcast time/state updates to session room
let ioBroadcastCallback = null;

function setOnTrackEndHook(fn) { onTrackEndHook = fn; }
function setOnAutoNextCallback(fn) { onAutoNextCallback = fn; }
function setIOBroadcast(fn) { ioBroadcastCallback = fn; }

function getFreeBridgePort() {
    const { execSync } = require('child_process');
    const usedPorts = new Set();
    for (const [, info] of activeSessions) {
        if (info.bridgePort) {
            // Verify bridge is actually alive before counting port as "used"
            try {
                const result = execSync(
                    `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${info.bridgePort}/ 2>/dev/null || echo 000`,
                    { encoding: 'utf8', timeout: 3000 }
                ).trim();
                if (result === '426') {
                    usedPorts.add(info.bridgePort);
                } else {
                    console.log(`[getFreeBridgePort] Port ${info.bridgePort} not responding (${result}), treating as free`);
                }
            } catch (_) {
                console.log(`[getFreeBridgePort] Port ${info.bridgePort} check failed, treating as free`);
            }
        }
    }
    return BRIDGE_PORTS.find(p => !usedPorts.has(p)) || null;
}

function runCmd(cmd, timeout = 15000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

async function pactl(cmd) {
    return runCmd(`sudo -u studio env XDG_RUNTIME_DIR=/tmp/runtime-studio PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native pactl ${cmd}`);
}

// Get audio duration using ffprobe
async function getAudioDuration(url) {
    try {
        const result = await runCmd(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${url}"`,
            10000
        );
        const dur = parseFloat(result);
        return isNaN(dur) ? 0 : dur;
    } catch (e) {
        console.log(`[Audio] ffprobe failed: ${e.message}`);
        return 0;
    }
}

// === Server-side progress tracking ===
function startProgressTimer(session) {
    stopProgressTimer(session);
    session._playStartTime = Date.now();
    session._playOffset = session._pausedAt || 0;
    
    session._progressTimer = setInterval(() => {
        if (!session._playing) return;
        const elapsed = (Date.now() - session._playStartTime) / 1000;
        const currentTime = session._playOffset + elapsed;
        
        // Broadcast time_update to session room
        if (ioBroadcastCallback && session._sessionId) {
            ioBroadcastCallback(session._sessionId, 'state_update', {
                currentTime: Math.min(currentTime, session._duration || Infinity),
                duration: session._duration || 0,
                playing: true
            });
        }
        
        // Auto-stop if we've exceeded duration (ffplay exit handler will also catch this)
        if (session._duration && currentTime >= session._duration) {
            stopProgressTimer(session);
        }
    }, 1000);
}

function stopProgressTimer(session) {
    if (session._progressTimer) {
        clearInterval(session._progressTimer);
        session._progressTimer = null;
    }
}

async function createSession(needsBridge = true) {
    if (activeSessions.size >= MAX_SESSIONS) {
        return { error: `Max sessions (${MAX_SESSIONS}) reached` };
    }

    const sessionId = require('crypto').randomUUID();
    // Memory safety check
    const freeMB = parseInt(require("child_process").execSync("free -m | awk '/Mem:/{print $7}'").toString().trim());
    if (freeMB < 500) {
        throw new Error(`内存不足 (${freeMB}MB)，拒绝创建 session`);
    }
    console.log(`[Session] Memory OK: ${freeMB}MB available`);
    
    const shortId = sessionId.slice(0, 8);
    const sinkName = `session_${shortId}`;

    console.log(`📻 Creating session: ${sessionId} (needsBridge=${needsBridge})`);

    try {
        let bridgePort = null;
        let bridgeWsUrl = null;
        let bridgePid = null;
        let sinkModule = null;

        // 1. Create PulseAudio null-sink for this session
        console.log(`  🔊 Creating PulseAudio sink: ${sinkName}`);
        const moduleId = await pactl(
            `load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=Session_${shortId}`
        );
        sinkModule = moduleId;
        console.log(`  🔊 Sink created (module ${moduleId})`);

        // Set initial volume to 0% (user will raise it via Remote page)
        try { await pactl(`set-sink-volume ${sinkName} 0%`); } catch (_) {}
        console.log(`  🔇 Initial volume set to 0%`);

        // 2. Start or reuse bridge for this session (NO Chrome needed!)
        if (needsBridge) {
            bridgePort = getFreeBridgePort();
            if (!bridgePort) {
                if (sinkModule) try { await pactl(`unload-module ${sinkModule}`); } catch (_) {}
                return { error: 'No free bridge port available' };
            }

            // Check if bridge WS server is already running BEFORE killing anything.
            // (Previous order was pkill → curl, which killed Wine before checking,
            // so bridgeAlreadyRunning was always false and reuse path never ran.)
            let bridgeAlreadyRunning = false;
            try {
                const check = await runCmd(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${bridgePort}/ 2>/dev/null || echo 000`);
                bridgeAlreadyRunning = (check === '426');
                if (bridgeAlreadyRunning) console.log(`  ✅ Bridge alive on port ${bridgePort} (HTTP 426), will attempt reuse`);
            } catch (_) {}

            // Only kill stale wrapper processes when we know we'll start fresh.
            if (!bridgeAlreadyRunning) {
                try {
                    await runCmd(`pkill -f 'start-bridge.sh ${bridgePort}' 2>/dev/null || true`);
                    console.log('  🧹 Killed old start-bridge.sh processes for port ' + bridgePort);
                } catch (_) {}
            }

            if (bridgeAlreadyRunning) {
                // === REUSE existing bridge ===
                console.log(`  ♻️ Bridge already running on port ${bridgePort}, reusing`);

                // Build set of OTHER active session monitors that we MUST NOT touch
                // (otherwise we'd steal another bot's audio capture, breaking that session)
                const protectedMonitors = new Set();
                for (const [otherId, otherInfo] of activeSessions) {
                    if (otherId !== sessionId && otherInfo && otherInfo.sinkName) {
                        protectedMonitors.add(`${otherInfo.sinkName}.monitor`);
                    }
                }

                // Build source index → name map to resolve "Source: <num>" in source-output blocks
                const sourceIdxToName = {};
                try {
                    const sourcesRaw = await runCmd(
                        `su - studio -c 'pactl list sources short' 2>/dev/null || true`
                    );
                    (sourcesRaw || '').split('\n').forEach(line => {
                        const parts = line.trim().split('\t');
                        if (parts.length >= 2) sourceIdxToName[parts[0]] = parts[1];
                    });
                } catch (_) {}

                // Try to redirect ONLY source-outputs that aren't bound to a protected monitor
                let movedCount = 0;
                try {
                    const soFull = await runCmd(
                        `su - studio -c 'pactl list source-outputs' 2>/dev/null || true`
                    );
                    const blocks = (soFull || '').split(/(?=^Source Output #)/m);
                    for (const block of blocks) {
                        const idMatch = block.match(/Source Output #(\d+)/);
                        const srcMatch = block.match(/Source:\s*(\d+)/);
                        if (!idMatch || !srcMatch) continue;
                        const soIndex = idMatch[1];
                        const srcIdx = srcMatch[1];
                        const srcName = sourceIdxToName[srcIdx] || '';
                        if (protectedMonitors.has(srcName)) {
                            console.log(`  ⏭️ Skip source-output ${soIndex} (already on active ${srcName})`);
                            continue;
                        }
                        await runCmd(
                            `su - studio -c 'pactl move-source-output ${soIndex} ${sinkName}.monitor' 2>/dev/null || true`
                        );
                        console.log(`  🔄 Redirected source-output ${soIndex} → ${sinkName}.monitor (was on ${srcName || 'unknown'})`);
                        movedCount++;
                    }
                } catch (e) {
                    console.log(`  ⚠️ Audio redirect failed: ${e.message}`);
                }

                if (movedCount === 0) {
                    // No safe orphan — reuse is unsafe (would either do nothing useful
                    // or steal another active bot's stream). Kill & start fresh below.
                    console.log(`  ⚠️ No orphan source-output for bridge reuse; killing bridge for fresh restart with correct source binding`);
                    try { await runCmd(`fuser -k ${bridgePort}/tcp 2>/dev/null || true`); } catch (_) {}
                    await new Promise(r => setTimeout(r, 2000));
                    bridgeAlreadyRunning = false;
                } else {
                    // Reuse path succeeded. Now anti-echo: redirect bridge sink-inputs → virtual_in
                    try {
                        const siRaw = await runCmd(
                            `su - studio -c 'pactl list sink-inputs 2>/dev/null' || true`
                        );
                        if (siRaw) {
                            const blocks = siRaw.split(/(?=Sink Input #)/);
                            for (const block of blocks) {
                                if (block.includes('agora-rtc-ws-connector')) {
                                    const m = block.match(/Sink Input #(\d+)/);
                                    if (m) {
                                        await runCmd(
                                            `su - studio -c 'pactl move-sink-input ${m[1]} virtual_in 2>/dev/null || true'`
                                        );
                                        console.log(`  🔇 Bridge sink-input ${m[1]} → virtual_in (anti-echo)`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.log(`  ⚠️ Bridge sink-input anti-echo redirect failed: ${e.message}`);
                    }

                    bridgeWsUrl = `/agora-ws-${bridgePort}/`;
                    console.log(`  🔗 Bridge reused: port ${bridgePort}, ws=${bridgeWsUrl}`);
                }
            }

            if (!bridgeAlreadyRunning) {
                // === START new bridge ===
                await runCmd(`fuser -k ${bridgePort}/tcp 2>/dev/null || true`);
                await new Promise(r => setTimeout(r, 2000));

                const bridgeDir = `/home/studio/agora-bridge-${bridgePort}`;
                console.log(`  🎵 Starting NEW bridge on port ${bridgePort}...`);

                const bridgeProc = spawn('sudo', [
                    '-u', 'studio',
                    '/home/studio/start-bridge.sh',
                    String(bridgePort),
                    'virtual_out',
                    `${sinkName}.monitor`
                ], {
                    cwd: bridgeDir,
                    env: {
                        ...process.env,
                        HOME: '/home/studio',
                        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                    detached: true
                });
                bridgeProc.unref();
                bridgePid = bridgeProc.pid;
                console.log(`  🎵 Bridge started (PID ${bridgePid}, port ${bridgePort})`);

                // Wait for bridge to initialize (Wine startup)
                console.log(`  ⏳ Waiting for bridge to initialize...`);
                await new Promise(r => setTimeout(r, 8000));

                // Verify bridge is listening
                try {
                    const check = await runCmd(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${bridgePort}/ 2>/dev/null || echo 000`);
                    if (check === '426') {
                        console.log(`  ✅ Bridge verified (HTTP 426 = WebSocket ready)`);
                    } else {
                        console.log(`  ⚠️ Bridge check returned: ${check} (may need more time)`);
                    }
                } catch (_) {}

                // Redirect bridge's received audio (sink-inputs) → virtual_in to prevent echo loop
                try {
                    const siRaw = await runCmd(
                        `su - studio -c 'pactl list sink-inputs 2>/dev/null' || true`
                    );
                    if (siRaw) {
                        const blocks = siRaw.split(/(?=Sink Input #)/);
                        for (const block of blocks) {
                            if (block.includes('agora-rtc-ws-connector')) {
                                const m = block.match(/Sink Input #(\d+)/);
                                if (m) {
                                    await runCmd(
                                        `su - studio -c 'pactl move-sink-input ${m[1]} virtual_in 2>/dev/null || true'`
                                    );
                                    console.log(`  🔇 Bridge sink-input ${m[1]} → virtual_in (anti-echo)`);
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.log(`  ⚠️ Bridge sink-input anti-echo redirect failed: ${e.message}`);
                }

                bridgeWsUrl = `/agora-ws-${bridgePort}/`;
                console.log(`  🔗 Bridge ready: port ${bridgePort}, ws=${bridgeWsUrl}`);
            }
        }

        // Store session info (NO chromePid, NO debugPort, NO userDataDir)
        activeSessions.set(sessionId, {
            shortId,
            sinkName,
            sinkModule,
            createdAt: new Date().toISOString(),
            bridgePort,
            bridgePid,
            needsBridge,
            channel: null,
            // Server-driven playback state
            _sessionId: sessionId,
            _playing: false,
            _duration: 0,
            _pausedAt: 0,
            _playStartTime: null,
            _progressTimer: null,
            ffplayProc: null,
            lastUrl: null,
        });

        const remoteUrl = `${SITE_URL}?session=${sessionId}`;

        return {
            sessionId,
            shortId,
            playerUrl: remoteUrl,
            bridgePort,
            bridgeWsUrl,
            count: activeSessions.size,
            maxSessions: MAX_SESSIONS
        };
    } catch (err) {
        console.error(`  ❌ Session creation failed:`, err.message);
        return { error: err.message };
    }
}

async function deleteSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return { error: 'Session not found' };

    console.log(`🗑️ Deleting session: ${sessionId}`);

    try {
        // 1. Stop progress timer
        stopProgressTimer(session);

        // 2. Kill ffplay
        if (session.ffplayProc) {
            try { process.kill(-session.ffplayProc.pid, 'SIGKILL'); } catch (_) {}
            session.ffplayProc = null;
        }

        // 3. Bridge: keep running for reuse
        if (session.bridgePid) {
            console.log(`  ♻️ Bridge kept alive for reuse (PID ${session.bridgePid}, port ${session.bridgePort})`);
            try {
                const WebSocket = require('ws');
                const ws = new WebSocket(`ws://127.0.0.1:${session.bridgePort}`);
                ws.on('open', () => {
                    ws.send(JSON.stringify({ action: 'leave' }));
                    ws.send(JSON.stringify({ action: 'mute' }));
                    console.log(`  🔇 Bridge leave+mute sent`);
                    setTimeout(() => ws.close(), 500);
                });
                ws.on('error', () => {});
            } catch (_) {}
        }

        // 4. Remove PulseAudio sink
        if (session.sinkModule) {
            try {
                await pactl(`unload-module ${session.sinkModule}`);
                console.log(`  🔊 Sink removed (module ${session.sinkModule})`);
            } catch (_) {}
        }

        activeSessions.delete(sessionId);
        return { success: true, count: activeSessions.size };
    } catch (err) {
        return { error: err.message };
    }
}

function listSessions() {
    const sessions = [];
    for (const [id, info] of activeSessions) {
        sessions.push({
            sessionId: id,
            shortId: info.shortId,
            createdAt: info.createdAt,
            bridgePort: info.bridgePort || null,
            needsBridge: info.needsBridge,
            channel: info.channel || null,
            accountId: info.accountId || null,
            bridgeWsUrl: info.bridgePort ? `/agora-ws-${info.bridgePort}/` : null,
            roomInfo: info.roomInfo || null
        });
    }
    return {
        sessions,
        count: activeSessions.size,
        maxSessions: MAX_SESSIONS
    };
}

function setSessionChannel(sessionId, channel) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.channel = channel;
        console.log(`  📡 Channel stored for session ${sessionId.slice(0,8)}: ${channel.slice(0,20)}...`);
    }
}

function getSessionChannel(sessionId) {
    const session = activeSessions.get(sessionId);
    return session ? session.channel : null;
}


// === Play a track using ffplay (direct PulseAudio output) + server-side progress ===
const { spawn: spawnChild } = require('child_process');

async function playTrack(sessionId, url) {
    let session = activeSessions.get(sessionId);

    // Prevent concurrent playTrack calls for the same session (race condition guard)
    if (session?._playLock) {
        console.log(`[Audio] playTrack already running for ${sessionId.slice(0,8)}, ignoring duplicate call`);
        return;
    }
    if (session) session._playLock = true;

    try {

    if (!session?.sinkName) {
        // Auto-adopt: create minimal session entry (e.g., after PM2 restart)
        console.log(`[Audio] Auto-adopting orphan session ${sessionId.slice(0,8)}...`);
        try {
            const shortId = sessionId.slice(0, 8);
            const sinkName = `session_${shortId}`;
            const moduleId = await pactl(
                `load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=Session_${shortId}`
            );
            
            // Redirect bridge source-output to new sink monitor
            try {
                const soList = await runCmd(
                    `su - studio -c 'pactl list source-outputs short ' 2>/dev/null || true`
                );
                if (soList) {
                    for (const line of soList.split('\n')) {
                        const parts = line.trim().split('\t');
                        if (parts.length >= 2) {
                            await runCmd(
                                `su - studio -c 'pactl move-source-output ${parts[0]} ${sinkName}.monitor ' 2>/dev/null || true`
                            );
                            console.log(`  🔄 Redirected source-output ${parts[0]} → ${sinkName}.monitor`);
                        }
                    }
                }
            } catch (_) {}

            // Redirect bridge's received audio (sink-inputs) → virtual_in to prevent echo loop
            try {
                const siRaw = await runCmd(
                    `su - studio -c 'pactl list sink-inputs 2>/dev/null' || true`
                );
                if (siRaw) {
                    const blocks = siRaw.split(/(?=Sink Input #)/);
                    for (const block of blocks) {
                        if (block.includes('agora-rtc-ws-connector')) {
                            const m = block.match(/Sink Input #(\d+)/);
                            if (m) {
                                await runCmd(
                                    `su - studio -c 'pactl move-sink-input ${m[1]} virtual_in 2>/dev/null || true'`
                                );
                                console.log(`  🔇 Bridge sink-input ${m[1]} → virtual_in (anti-echo)`);
                            }
                        }
                    }
                }
            } catch (_) {}
            
            activeSessions.set(sessionId, {
                shortId,
                sinkName,
                sinkModule: moduleId,
                createdAt: new Date().toISOString(),
                bridgePort: null,
                bridgePid: null,
                needsBridge: false,
                channel: null,
                _sessionId: sessionId,
                _playing: false,
                _duration: 0,
                _pausedAt: 0,
                _playStartTime: null,
                _progressTimer: null,
                ffplayProc: null,
                lastUrl: null,
            });
            session = activeSessions.get(sessionId);
            console.log(`  ✅ Session auto-adopted: ${shortId} (sink module ${moduleId})`);
        } catch (e) {
            console.log(`[Audio] Auto-adopt failed: ${e.message}`);
            return;
        }
    }
    
    // Kill previous ffplay
    if (session.ffplayProc) {
        try { process.kill(-session.ffplayProc.pid, 'SIGKILL'); } catch (_) {}
        session.ffplayProc = null;
    }
    // Also kill any orphan ffplay processes for this sink (sudo spawn can leave orphans)
    try {
        require('child_process').execSync(
            `pkill -9 -f "play-audio.sh ${session.sinkName}" 2>/dev/null || true`,
            { timeout: 3000 }
        );
    } catch (_) {}
    stopProgressTimer(session);
    
    if (url.startsWith('/')) url = 'https://clubhouses.party' + url;
    session.lastUrl = url;
    console.log(`[Audio] Playing on ${session.sinkName}: ${url.slice(-40)}`);
    
    // Get duration via ffprobe
    const duration = await getAudioDuration(url);
    session._duration = duration;
    session._pausedAt = 0;
    session._playing = true;
    console.log(`[Audio] Duration: ${duration.toFixed(1)}s`);
    
    // Broadcast initial state (duration + playing)
    if (ioBroadcastCallback) {
        ioBroadcastCallback(sessionId, 'state_update', {
            currentTime: 0,
            duration: duration,
            playing: true
        });
    }
    
    const ffplay = spawnChild('sudo', [
        '-u', 'studio',
        'env',
        'DISPLAY=:99',
        'XDG_RUNTIME_DIR=/tmp/runtime-studio',
        'PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native',
        `/home/studio/play-audio.sh`,
        session.sinkName,
        url
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
    });
    
    ffplay.unref();
    session.ffplayProc = ffplay;
    
    // Start server-side progress timer
    startProgressTimer(session);
    
    ffplay.on('exit', (code) => {
        console.log(`[Audio] ffplay exited (code ${code}) for ${sessionId}`);
        if (session.ffplayProc === ffplay) {
            session.ffplayProc = null;
            session._playing = false;
            stopProgressTimer(session);
            
            // Broadcast stopped state
            if (ioBroadcastCallback) {
                ioBroadcastCallback(sessionId, 'state_update', {
                    currentTime: session._duration || 0,
                    duration: session._duration || 0,
                    playing: false
                });
            }
            
            // code 0 = song finished naturally -> auto-next
            if (code === 0) {
                if (onTrackEndHook) {
                    const handled = onTrackEndHook(sessionId);
                    if (handled) return;
                }
                const tryNext = async () => {
                    try {
                        const trackInfo = await skipTrack(sessionId, 1);
                        if (trackInfo) {
                            console.log(`[Audio] Server-side auto-next: ${trackInfo.title?.slice(0,40)}`);
                            if (onAutoNextCallback) {
                                onAutoNextCallback(sessionId, trackInfo);
                            }
                        }
                    } catch (e) {
                        console.log(`[Audio] Auto-next failed for ${sessionId.slice(0,8)}: ${e.message}`);
                    }
                };
                tryNext();
            }
        }
    });

    } finally {
        // Release play lock regardless of success or failure
        const s = activeSessions.get(sessionId);
        if (s) s._playLock = false;
    }
}


// Pause ffplay (SIGSTOP) + pause progress timer
function pauseTrack(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    // Always stop the timer and mark as paused FIRST, regardless of ffplayProc state.
    // This handles the race condition where pauseTrack is called while getAudioDuration
    // is still awaiting (ffplayProc not yet spawned but _playing is already true).
    if (session._playStartTime) {
        const elapsed = (Date.now() - session._playStartTime) / 1000;
        session._pausedAt = (session._playOffset || 0) + elapsed;
    }
    session._playing = false;
    stopProgressTimer(session);
    console.log(`[Audio] Paused session ${sessionId.slice(0,8)} at ${session._pausedAt?.toFixed(1)}s`);

    // Broadcast paused state immediately
    if (ioBroadcastCallback) {
        ioBroadcastCallback(sessionId, 'state_update', {
            currentTime: session._pausedAt || 0,
            duration: session._duration || 0,
            playing: false
        });
    }

    // Send SIGSTOP only if there is an actual ffplay process running
    if (session.ffplayProc) {
        try {
            try { process.kill(-session.ffplayProc.pid, 'SIGSTOP'); } catch (_) {}
            // Also target ffplay for this session's sink in case it escaped the process group
            try {
                require('child_process').execSync(
                    `pkill -STOP -f "play-audio.sh ${session.sinkName}" 2>/dev/null || true`,
                    { timeout: 3000 }
                );
            } catch (_) {}
        } catch (_) {}
    }
}

// Resume ffplay (SIGCONT) + resume progress timer
function resumeTrack(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    // Always update logical state and broadcast first, regardless of ffplayProc.
    // This handles the race where playTrack is still in `await getAudioDuration`
    // (ffplayProc not yet set) but the user clicks Play.
    session._playing = true;
    startProgressTimer(session);
    console.log(`[Audio] Resumed session ${sessionId.slice(0,8)} from ${session._pausedAt?.toFixed(1)}s`);

    if (ioBroadcastCallback) {
        ioBroadcastCallback(sessionId, 'state_update', {
            currentTime: session._pausedAt || 0,
            duration: session._duration || 0,
            playing: true
        });
    }

    // Send SIGCONT only if there is an actual ffplay process running
    if (session.ffplayProc) {
        try {
            try { process.kill(-session.ffplayProc.pid, 'SIGCONT'); } catch (_) {}
            try {
                require('child_process').execSync(
                    `pkill -CONT -f "play-audio.sh ${session.sinkName}" 2>/dev/null || true`,
                    { timeout: 3000 }
                );
            } catch (_) {}
        } catch (_) {}
    }
}

// Stop ffplay
function stopTrack(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    session._playing = false;
    stopProgressTimer(session);
    console.log(`[Audio] Stopped session ${sessionId.slice(0,8)}`);

    if (ioBroadcastCallback) {
        ioBroadcastCallback(sessionId, 'state_update', {
            currentTime: 0,
            duration: session._duration || 0,
            playing: false
        });
    }

    if (session.ffplayProc) {
        try { process.kill(-session.ffplayProc.pid, 'SIGKILL'); } catch (_) {}
        session.ffplayProc = null;
    }
}

// Set volume via PulseAudio (0-100)
async function setVolume(sessionId, volume) {
    const session = activeSessions.get(sessionId);
    if (!session?.sinkName) return;
    const vol = Math.max(0, Math.min(100, Math.round(volume * 100)));
    try {
        await pactl(`set-sink-volume ${session.sinkName} ${vol}%`);
        console.log(`[Audio] Volume ${vol}% for ${sessionId.slice(0,8)}`);
    } catch (_) {}
}


// Seek: restart ffplay at specific position + update progress
async function seekTrack(sessionId, position) {
    const session = activeSessions.get(sessionId);
    if (!session?.sinkName || !session.lastUrl) return;
    console.log(`[Audio] Seek to ${position}s for ${sessionId.slice(0,8)}`);
    
    // Kill current ffplay
    if (session.ffplayProc) {
        try { process.kill(-session.ffplayProc.pid, 'SIGKILL'); } catch (_) {}
        session.ffplayProc = null;
    }
    stopProgressTimer(session);
    
    // Update position state
    session._pausedAt = position;
    session._playing = true;
    
    // Restart at position
    const url = session.lastUrl;
    const ffplay = spawnChild('sudo', [
        '-u', 'studio',
        '/home/studio/play-audio.sh',
        session.sinkName,
        url,
        String(Math.floor(position))
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
    });
    ffplay.unref();
    session.ffplayProc = ffplay;
    
    // Restart progress timer from new position
    startProgressTimer(session);
    
    // Broadcast seek position
    if (ioBroadcastCallback) {
        ioBroadcastCallback(sessionId, 'state_update', {
            currentTime: position,
            duration: session._duration || 0,
            playing: true
        });
    }
    
    ffplay.on('exit', (code) => {
        if (session.ffplayProc === ffplay) {
            session.ffplayProc = null;
            session._playing = false;
            stopProgressTimer(session);
            if (code === 0) {
                skipTrack(sessionId, 1).then(trackInfo => {
                    if (trackInfo) {
                        console.log(`[Audio] Seek-end auto-next: ${trackInfo.title?.slice(0,40)}`);
                        if (onAutoNextCallback) {
                            onAutoNextCallback(sessionId, trackInfo);
                        }
                    }
                }).catch(e => {
                    console.log(`[Audio] Seek-end auto-next failed: ${e.message}`);
                });
            }
        }
    });
}


// Skip track (next/prev) - reads songs from DB
async function skipTrack(sessionId, direction) {
    const session = activeSessions.get(sessionId);
    if (!session) return Promise.resolve();
    
    let songs = [];
    try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));
        songs = Array.isArray(data) ? data : [];
    } catch (e) {
        console.log(`[Audio] Skip: cannot read songs.json: ${e.message}`);
        return null;
    }
    
    if (songs.length === 0) {
        console.log(`[Audio] Skip: no songs available`);
        return null;
    }
    
    // Find current track index by matching lastUrl
    let currentIdx = -1;
    if (session.lastUrl) {
        currentIdx = songs.findIndex(s => session.lastUrl.includes(s.url) || s.url === session.lastUrl);
    }
    if (currentIdx < 0) currentIdx = 0;
    
    let nextIdx;
    if (session.shuffleMode) {
        nextIdx = Math.floor(Math.random() * songs.length);
        if (songs.length > 1 && nextIdx === currentIdx) {
            nextIdx = (nextIdx + 1) % songs.length;
        }
    } else {
        nextIdx = (currentIdx + direction + songs.length) % songs.length;
    }
    
    const nextTrack = songs[nextIdx];
    if (!nextTrack?.url) {
        console.log(`[Audio] Skip: no URL for track ${nextIdx}`);
        return Promise.resolve();
    }
    
    console.log(`[Audio] Skip ${direction > 0 ? 'next' : 'prev'}: [${nextIdx}/${songs.length}] ${nextTrack.title || nextTrack.url.slice(-30)}`);
    
    await playTrack(sessionId, nextTrack.url);
    return { index: nextIdx, title: nextTrack.title, url: nextTrack.url, id: nextTrack.id, total: songs.length };
}

// Update session track list
function updateTracks(sessionId, tracks, currentTrack) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    if (Array.isArray(tracks) && tracks.length > 0) {
        session.tracks = tracks;
    }
    if (currentTrack) {
        const idx = (session.tracks || []).findIndex(t => t.id === currentTrack.id || t.url === currentTrack.url);
        if (idx >= 0) session.currentTrackIdx = idx;
    }
}

// Set shuffle mode
function setShuffleMode(sessionId, enabled) {
    const session = activeSessions.get(sessionId);
    if (session) session.shuffleMode = enabled;
}

function setSessionMeta(sessionId, key, value) {
    const info = activeSessions.get(sessionId);
    if (info) info[key] = value;
}

// Store the currently-playing track info so ioBroadcastCallback can inject it
// into state_update when socket.js ps.currentTrack is null (e.g. after reconnect)
function setCurrentTrackInfo(sessionId, trackInfo) {
    const session = activeSessions.get(sessionId);
    if (session) session._currentTrackInfo = trackInfo || null;
}

function getCurrentTrackInfo(sessionId) {
    const session = activeSessions.get(sessionId);
    return session ? (session._currentTrackInfo || null) : null;
}


// Auto-restart a crashed bridge for a session
async function restartBridge(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.bridgePort) return { error: 'No bridge to restart' };

    const port = session.bridgePort;
    const sinkName = session.sinkName;
    console.log(`🔄 [BridgeRestart] Restarting bridge on port ${port} for session ${sessionId.slice(0,8)}`);

    // 1. Kill any zombie process on this port
    try { await runCmd(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch (_) {}
    try { if (session.bridgePid) process.kill(session.bridgePid, 'SIGTERM'); } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));

    // 2. Start new bridge
    const bridgeDir = `/home/studio/agora-bridge-${port}`;
    const bridgeProc = spawn('sudo', [
        '-u', 'studio',
        '/home/studio/start-bridge.sh',
        String(port),
        'virtual_out',
        `${sinkName}.monitor`
    ], {
        cwd: bridgeDir,
        env: {
            ...process.env,
            HOME: '/home/studio',
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
    });
    bridgeProc.unref();
    session.bridgePid = bridgeProc.pid;
    console.log(`  🎵 Bridge restarted (PID ${bridgeProc.pid}, port ${port})`);

    // 3. Wait for Wine startup
    await new Promise(r => setTimeout(r, 45000));

    // 4. Verify bridge is listening
    try {
        const check = await runCmd(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ 2>/dev/null || echo 000`);
        if (check.trim() === '426') {
            console.log(`  ✅ Bridge verified (HTTP 426 = WebSocket ready)`);
            return { success: true, bridgePort: port, bridgeWsUrl: `/agora-ws-${port}/` };
        } else {
            console.log(`  ⚠️ Bridge check returned: ${check.trim()}`);
            return { success: true, bridgePort: port, bridgeWsUrl: `/agora-ws-${port}/`, warning: 'may need more time' };
        }
    } catch (_) {
        return { success: true, bridgePort: port, bridgeWsUrl: `/agora-ws-${port}/` };
    }
}

module.exports = {
    setOnTrackEndHook, setOnAutoNextCallback, setIOBroadcast,
    playTrack, pauseTrack, resumeTrack, stopTrack, setVolume, seekTrack, skipTrack,
    updateTracks, setShuffleMode,
    getSession: (id) => activeSessions.get(id),
    setSessionChannel, getSessionChannel,
    createSession, deleteSession, listSessions, setSessionMeta, MAX_SESSIONS,
    restartBridge,
    setCurrentTrackInfo, getCurrentTrackInfo,
};
