/**
 * Party Mode Manager
 * 
 * Manages a shared song queue where multiple users can add songs.
 * Songs play in round-robin order (alternating users).
 * Persists to data/party.json.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'party.json');
const MAX_SONGS_PER_USER = 3;
const TIME_LIMIT = 10 * 60 * 1000;       // 10 minutes in ms
const GRACE_PERIOD = 5 * 60 * 1000;      // 5 minute grace in ms

// In-memory state
let state = {
    enabled: true,          // Party mode is ON by default
    queue: [],              // Array of { id, song, userId, nickname, photoUrl, addedAt, status }
    currentItem: null,      // Currently playing queue item
    playStartTime: 0,       // When current song started playing (ms)
    graceStartTime: 0,      // When grace period started (ms), 0 = not in grace
    onlineUsers: new Map(), // socketId -> { userId, nickname, photoUrl }
    claimedUsers: new Map() // userId -> socketId (prevent impersonation)
};

// Room users cache (from get_channel, refreshed by keepalive)
let roomUsersCache = [];
let roomUsersCacheTime = 0;

let nextQueueId = 1;

// === Persistence ===

function loadState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            state.enabled = saved.enabled !== undefined ? saved.enabled : true;
            state.queue = saved.queue || [];
            nextQueueId = saved.nextQueueId || 1;
            
            // Reset playing state on load — playback doesn't survive restart
            // Mark any 'playing' items back to 'waiting'
            state.queue.forEach(q => {
                if (q.status === 'playing') q.status = 'waiting';
            });
            state.currentItem = null;
            state.playStartTime = 0;
            state.graceStartTime = 0;
            
            console.log(`🎉 [Party] Loaded: ${state.queue.length} songs in queue, enabled=${state.enabled}`);
        }
    } catch (e) {
        console.log(`⚠️ [Party] Load failed: ${e.message}`);
    }
}

function saveState() {
    try {
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            enabled: state.enabled,
            queue: state.queue,
            currentItem: state.currentItem,
            nextQueueId
        }, null, 2));
    } catch (e) {
        console.log(`⚠️ [Party] Save failed: ${e.message}`);
    }
}

// === Queue Management ===

function addToQueue(song, userId, nickname, photoUrl) {
    // Check: party mode enabled
    if (!state.enabled) return { error: 'Party 模式未开启' };

    // User already verified via party_join socket registration

    // Check: max songs per user
    const userSongs = state.queue.filter(q => q.userId === userId && q.status === 'waiting');
    if (userSongs.length >= MAX_SONGS_PER_USER) {
        return { error: `最多同时排 ${MAX_SONGS_PER_USER} 首歌` };
    }

    const item = {
        id: 'q' + (nextQueueId++),
        song: { id: song.id, title: song.title, url: song.url },
        userId,
        nickname,
        photoUrl: photoUrl || '',
        addedAt: new Date().toISOString(),
        status: 'waiting'
    };

    state.queue.push(item);
    saveState();
    console.log(`🎉 [Party] ${nickname} added: ${song.title?.slice(0, 30)}`);
    return { success: true, item };
}

function removeFromQueue(queueId, userId) {
    const idx = state.queue.findIndex(q => q.id === queueId);
    if (idx === -1) return { error: '未找到该歌曲' };
    const item = state.queue[idx];
    // Only the user who added it can remove it
    if (item.userId !== userId) return { error: '只能移除自己的歌曲' };
    const wasPlaying = item.status === 'playing';
    if (wasPlaying) {
        state.currentItem = null;
    }
    state.queue.splice(idx, 1);
    saveState();
    return { success: true, wasPlaying };
}

/**
 * Round-robin: get next song to play.
 * Alternates between different users. If only one user has songs, play sequentially.
 */
function getNextTrack(lastUserId) {
    const waiting = state.queue.filter(q => q.status === 'waiting');
    if (waiting.length === 0) return null;

    // Try to find a song from a different user than lastUserId
    let next = waiting.find(q => q.userId !== lastUserId);
    // If all remaining songs are from the same user, just take the first
    if (!next) next = waiting[0];

    return next;
}

/**
 * Mark a queue item as playing
 */
function markPlaying(queueId) {
    // Mark previous playing item as done
    if (state.currentItem) {
        const prev = state.queue.find(q => q.id === state.currentItem.id);
        if (prev) prev.status = 'done';
    }

    const item = state.queue.find(q => q.id === queueId);
    if (item) {
        item.status = 'playing';
        state.currentItem = item;
        state.playStartTime = Date.now();
        state.graceStartTime = 0; // Reset grace period
    }

    // Clean up done items (keep last 5 for history)
    const done = state.queue.filter(q => q.status === 'done');
    if (done.length > 5) {
        const toRemove = done.slice(0, done.length - 5);
        state.queue = state.queue.filter(q => !toRemove.includes(q));
    }

    saveState();
}

/**
 * Check time limit for currently playing song.
 * Returns { shouldSkip, reason } if time limit exceeded.
 * 
 * Rules:
 * 1. Song playing > 10min AND other users' songs in queue → auto-skip
 * 2. Song playing > 10min AND only own songs in queue → continue
 *    BUT if another user's song appears → 5min grace period → auto-skip
 * 3. If remaining song time < limit → let it finish naturally
 */
function checkTimeLimit() {
    if (!state.enabled || !state.currentItem) return { shouldSkip: false };

    const elapsed = Date.now() - state.playStartTime;
    if (elapsed < TIME_LIMIT) return { shouldSkip: false }; // Under 10 min, no action

    const currentUserId = state.currentItem.userId;
    const waiting = state.queue.filter(q => q.status === 'waiting');
    const hasOtherUserSongs = waiting.some(q => q.userId !== currentUserId);

    if (!hasOtherUserSongs) {
        // Only own songs → reset grace, keep playing
        if (state.graceStartTime) {
            state.graceStartTime = 0;
            console.log(`🎉 [Party] Grace period reset - no other users' songs left`);
        }
        return { shouldSkip: false };
    }

    // Other users' songs exist in queue
    if (!state.graceStartTime) {
        // First time detecting other users while past 10 min
        if (elapsed < TIME_LIMIT + 1000) {
            // Just crossed 10 min with other songs already waiting → skip now
            return { shouldSkip: true, reason: `⏰ 已播放超过10分钟，轮到下一位` };
        }
        // Was playing solo past 10 min, now another user joins → start grace
        state.graceStartTime = Date.now();
        console.log(`🎉 [Party] Grace period started - other user's song detected, 5 min extension`);
        return { shouldSkip: false };
    }

    // In grace period
    const graceElapsed = Date.now() - state.graceStartTime;
    if (graceElapsed >= GRACE_PERIOD) {
        return { shouldSkip: true, reason: `⏰ 延长5分钟已到，轮到下一位` };
    }

    return { shouldSkip: false };
}

/**
 * Called when a track finishes. Returns next track to play, or null.
 * Skips offline users.
 */
function onTrackEnd() {
    const lastUserId = state.currentItem?.userId;

    // Mark current as done
    if (state.currentItem) {
        const item = state.queue.find(q => q.id === state.currentItem.id);
        if (item) item.status = 'done';
        state.currentItem = null;
    }

    // Find next track, skipping offline users
    let attempts = 0;
    const waiting = state.queue.filter(q => q.status === 'waiting');

    while (attempts < waiting.length) {
        const next = getNextTrack(lastUserId);
        if (!next) break;

        // Check if user is still online (has active socket)
        if (isUserOnline(next.userId)) {
            markPlaying(next.id);
            return next;
        } else {
            // User offline, skip
            console.log(`🎉 [Party] Skipping ${next.nickname}'s song (offline): ${next.song.title?.slice(0, 30)}`);
            next.status = 'skipped';
            attempts++;
        }
    }

    saveState();
    return null; // Queue empty or all users offline → resume shuffle
}

// === User Management ===

function isUserInRoom(userId) {
    return roomUsersCache.some(u => String(u.user_id) === String(userId));
}

function isUserOnline(userId) {
    return state.claimedUsers.has(String(userId));
}

function getClaimedSocket(userId) {
    return state.claimedUsers.get(String(userId)) || null;
}

function registerUser(socketId, userId, nickname, photoUrl) {
    const uid = String(userId);

    // Check impersonation: if this userId is already claimed by another socket
    const existingSocketId = state.claimedUsers.get(uid);
    if (existingSocketId && existingSocketId !== socketId) {
        // Check if old socket is still actually connected
        if (state.onlineUsers.has(existingSocketId)) {
            return { error: '该用户已在另一设备登录' };
        }
        // Old socket is dead — allow re-registration
        console.log(`🎉 [Party] ${nickname} (${uid}) re-registering (old socket dead)`);
        state.onlineUsers.delete(existingSocketId);
    }

    state.onlineUsers.set(socketId, { userId: uid, nickname, photoUrl });
    state.claimedUsers.set(uid, socketId);
    console.log(`🎉 [Party] ${nickname} (${uid}) registered`);
    return { success: true };
}

function unregisterUser(socketId) {
    const user = state.onlineUsers.get(socketId);
    if (user) {
        state.onlineUsers.delete(socketId);
        // Only release the claim if this socket owns it
        if (state.claimedUsers.get(user.userId) === socketId) {
            state.claimedUsers.delete(user.userId);
        }
        console.log(`🎉 [Party] ${user.nickname} disconnected`);
    }
}

function getUserBySocket(socketId) {
    return state.onlineUsers.get(socketId) || null;
}

// === Room Users Cache ===

function updateRoomUsersCache(users) {
    roomUsersCache = users || [];
    roomUsersCacheTime = Date.now();
}

function getRoomUsers() {
    return {
        users: roomUsersCache,
        cachedAt: roomUsersCacheTime,
        stale: (Date.now() - roomUsersCacheTime) > 60000 // stale if > 1 min
    };
}

// === Toggle ===

function toggle(enabled) {
    state.enabled = enabled;
    if (!enabled) {
        // Clear queue when disabled
        state.queue = state.queue.filter(q => q.status === 'playing');
    }
    saveState();
    console.log(`🎉 [Party] Mode ${enabled ? 'ON' : 'OFF'}`);
    return { success: true, enabled };
}

// === Getters ===

function getState() {
    return {
        enabled: state.enabled,
        queue: state.queue.filter(q => q.status !== 'done' && q.status !== 'skipped'),
        currentItem: state.currentItem
    };
}

function getUserQueueCount(userId) {
    return state.queue.filter(q => q.userId === String(userId) && q.status === 'waiting').length;
}

// Initialize
loadState();

module.exports = {
    addToQueue,
    removeFromQueue,
    onTrackEnd,
    getNextTrack,
    markPlaying,
    checkTimeLimit,
    registerUser,
    unregisterUser,
    getUserBySocket,
    updateRoomUsersCache,
    getRoomUsers,
    toggle,
    getState,
    getUserQueueCount,
    MAX_SONGS_PER_USER
};
