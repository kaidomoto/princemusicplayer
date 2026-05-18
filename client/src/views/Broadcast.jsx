import React, { useState, useEffect, useRef } from 'react';
import { Radio, Mic, MicOff, PhoneOff, Link2, Users, Clock, Bell, BellOff, Hand } from 'lucide-react';
import PubNub from 'pubnub';
import { io as socketIO } from 'socket.io-client';

const CH_API = '/api/clubhouse';

/** 与 server.js STATIC_CREATE_ROOM_HOUSES 一致：create_channel 用 social_club_id（字符串，防大整数精度丢失） */
const STATIC_CREATE_HOUSE_OPTIONS = [
    { socialClubId: '5117210297323161974', displayLabel: '朝酒晚舞（聊天）' },
    { socialClubId: '1718288493', displayLabel: '朝酒晚舞（学习）' },
];
// Use wss:// via nginx proxy to avoid HTTPS mixed-content block
const AGORA_WS_URL = `wss://${window.location.host}/agora-ws/`;
const ROOM_STORAGE_KEY = 'broadcast_room';
const PUBNUB_SUB_KEY = 'sub-c-a4abea84-9ca3-11ea-8e71-f2b83ac9263d';
const PUBNUB_PUB_KEY = 'pub-c-6878d382-5ae6-4494-9099-f930f938868b';
const CH_USER_ID = 450417781;

function Broadcast() {
    const [roomInput, setRoomInput] = useState('');
    // Multi-room: Map<sessionId, roomState>
    const [activeRooms, setActiveRooms] = useState(new Map());
    const activeRoomsRef = useRef(new Map()); // ref mirror for closures
    const [isJoining, setIsJoining] = useState(false);
    const [error, setError] = useState('');
    const [logs, setLogs] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [sessionLoading, setSessionLoading] = useState(false);
    const requestIdRef = useRef(1);
    const statusCheckRef = useRef(null);
    const pubnubRef = useRef(null);
    const [roomNotification, setRoomNotification] = useState(null);
    const [pubnubConnected, setPubnubConnected] = useState(false);
    const [pubnubEnabled, setPubnubEnabled] = useState(true);
    const sessionFetchErrorLoggedRef = useRef(false);
    // Helper to update a specific room in the Map
    const updateRoom = (sessionId, updates) => {
        setActiveRooms(prev => {
            const next = new Map(prev);
            const room = next.get(sessionId);
            if (room) next.set(sessionId, { ...room, ...updates });
            activeRoomsRef.current = next;
            return next;
        });
    };
    const removeRoom = (sessionId) => {
        setActiveRooms(prev => {
            const next = new Map(prev);
            const room = next.get(sessionId);
            if (room) {
                if (room.wsRef) try { room.wsRef.close(); } catch {}
                if (room.timerRef) clearInterval(room.timerRef);
                if (room.pingRef) clearInterval(room.pingRef);
                if (room.refreshRef) clearInterval(room.refreshRef);
            }
            next.delete(sessionId);
            activeRoomsRef.current = next;
            return next;
        });
    };

    // === Unified Broadcast State ===
    const [broadcastSessions, setBroadcastSessions] = useState([]);
    const [broadcastLoading, setBroadcastLoading] = useState('');
    const [joinRoomUrl, setJoinRoomUrl] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [showManualControl, setShowManualControl] = useState(false);
    const [broadcastError, setBroadcastError] = useState('');
    const [chAccounts, setChAccounts] = useState({});
    const [selectedAccount, setSelectedAccount] = useState('');
    const [autokickEnabled, setAutokickEnabled] = useState(null);
    const [autokickLoading, setAutokickLoading] = useState(false);

    // Create-room: optional House（social_club_id，与下拉硬编码一致）
    const [createHouseClubId, setCreateHouseClubId] = useState('');

    // Fetch active sessions on mount
    useEffect(() => {
        fetchBroadcastSessions();
        const interval = setInterval(fetchBroadcastSessions, 10000);
    
    return () => clearInterval(interval);
    }, []);

    // Fetch available CH accounts
    useEffect(() => {
        async function fetchAccounts() {
            try {
                const res = await fetch('/api/clubhouse/accounts', {
                    headers: { 'x-auth-token': sessionStorage.getItem('auth_player') || '' },
                });
                const data = await res.json();
                setChAccounts(data.accounts || {});
                if (data.default) setSelectedAccount(data.default);
            } catch (e) { console.error('Fetch accounts:', e); }
        }
        fetchAccounts();
    }, []);

    // Fetch autokick enabled state (requires Player token — skip if unauthenticated to avoid 401 log spam;
    // Broadcast stays mounted even on Remote tab, so this runs on every full page load.)
    useEffect(() => {
        async function fetchAutokick() {
            const token = sessionStorage.getItem('auth_player');
            if (!token) {
                setAutokickEnabled(null);
                return;
            }
            try {
                const res = await fetch('/api/autokick/config', {
                    headers: { 'x-auth-token': token },
                });
                if (res.ok) {
                    const data = await res.json();
                    setAutokickEnabled(data.enabled);
                }
            } catch (e) { console.error('Fetch autokick:', e); }
        }
        fetchAutokick();
    }, []);

    const toggleAutokick = async () => {
        setAutokickLoading(true);
        try {
            const res = await fetch('/api/autokick/toggle', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': sessionStorage.getItem('auth_player') || '',
                },
                body: JSON.stringify({ enabled: !autokickEnabled }),
            });
            const data = await res.json();
            if (data.success) {
                setAutokickEnabled(data.enabled);
                addLog(`🚫 自动踢人已${data.enabled ? '开启' : '关闭'}`);
            }
        } catch (e) {
            addLog('❌ 切换自动踢人失败: ' + e.message);
        } finally {
            setAutokickLoading(false);
        }
    };

    // --- Diagnostic Panel State ---
    const [diagResult, setDiagResult] = React.useState(null);
    const [diagLoading, setDiagLoading] = React.useState(false);
    const [repairLoading, setRepairLoading] = React.useState(false);
    const [diagExpanded, setDiagExpanded] = React.useState(false);

    const runDiagnose = async () => {
        setDiagLoading(true);
        try {
            const res = await fetch('/api/bridge/diagnose', {
                headers: { 'x-auth-token': sessionStorage.getItem('broadcast-token') || '' },
            });
            const data = await res.json();
            setDiagResult(data);
            setDiagExpanded(true);
        } catch (e) {
            setDiagResult({ issues: ['❌ 诊断请求失败: ' + e.message], checks: {} });
        }
        setDiagLoading(false);
    };

    const runRepair = async () => {
        setRepairLoading(true);
        try {
            const res = await fetch('/api/bridge/repair', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': sessionStorage.getItem('broadcast-token') || '',
                },
            });
            const data = await res.json();
            setDiagResult(prev => ({
                ...prev,
                repairSteps: data.steps,
                repairSuccess: data.success,
                repairChannel: data.channel,
            }));
            // Auto re-diagnose after repair
            setTimeout(runDiagnose, 3000);
        } catch (e) {
            setDiagResult(prev => ({
                ...prev,
                repairSteps: ['❌ 修复请求失败: ' + e.message],
                repairSuccess: false,
            }));
        }
        setRepairLoading(false);
    };

    // Reconnect playback (rebuild Chrome+Bridge without Clubhouse API join)
    const handleReconnect = async () => {
        const acctId = selectedAccount || 'main';
        addLog('🔄 重连播放...');
        try {
            const res = await fetch('/api/broadcast/reconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': sessionStorage.getItem('auth_player') || '' },
                body: JSON.stringify({ accountId: acctId })
            });
            const data = await res.json();
            if (data.success) {
                addLog('✅ ' + data.message + ' (API calls: ' + data.apiCalls + ')');
                addLog('📡 Channel: ' + data.channel);
                if (data.sessionUrl) {
                    window.open(data.sessionUrl, '_blank');
                }
            } else {
                addLog('❌ 重连失败: ' + data.error);
            }
        } catch (e) {
            addLog('❌ 重连请求失败: ' + e.message);
        }
    };


    async function handleChwebAutoLogin() {
        const token = sessionStorage.getItem('auth_player');
        try {
            const res = await fetch('/api/chweb-autologin', {
                headers: { 'x-auth-token': token }
            });
            const data = await res.json();
            if (data.error) { setBroadcastError('chweb登录失败: ' + data.error); return; }
            // Open chweb in new window and inject the token
            const win = window.open('/chweb/#/', '_blank');
            if (!win) { setBroadcastError('请允许弹出窗口'); return; }
            // Wait for chweb to load then inject
            setTimeout(() => {
                try {
                    win.eval(data.script);
                } catch (e) {
                    addLog('⚠️ 自动注入失败，请手动执行: ' + data.script.substring(0, 50) + '...');
                }
            }, 2000);
            addLog('🔓 chweb 自动登录中...');
        } catch (e) { setBroadcastError('登录错误: ' + e.message); }
    }

    async function fetchBroadcastSessions() {
        try {
            const res = await fetch('/api/sessions');
            const data = await res.json();
            setBroadcastSessions(data.sessions || []);
            const sessions = data.sessions || [];
            // Reconcile room cards with actual server sessions:
            // - remove stale cards that no longer exist server-side
            // - drop old pre-reconnect cards for the same account/channel
            setActiveRooms(prev => {
                const next = new Map(prev);
                for (const [sid, room] of next.entries()) {
                    const match = sessions.find(s =>
                        s.sessionId === sid ||
                        (((s.accountId || 'main') === (room.accountId || 'main')) && s.channel && s.channel === room.channel)
                    );
                    // No matching live session at all -> remove stale card
                    if (!match) {
                        if (room.timerRef) clearInterval(room.timerRef);
                        if (room.pingRef) clearInterval(room.pingRef);
                        if (room.refreshRef) clearInterval(room.refreshRef);
                        if (room.wsPingInterval) clearInterval(room.wsPingInterval);
                        if (room.wsRef) try { room.wsRef.close(); } catch {}
                        next.delete(sid);
                        continue;
                    }
                    // Same room/account but old sessionId -> drop the stale pre-reconnect card
                    if (match.sessionId !== sid) {
                        if (room.timerRef) clearInterval(room.timerRef);
                        if (room.pingRef) clearInterval(room.pingRef);
                        if (room.refreshRef) clearInterval(room.refreshRef);
                        if (room.wsPingInterval) clearInterval(room.wsPingInterval);
                        if (room.wsRef) try { room.wsRef.close(); } catch {}
                        next.delete(sid);
                    }
                }
                activeRoomsRef.current = next;
                return next;
            });

            // Auto-create room cards for sessions not in activeRooms
            for (const s of sessions) {
                if (s.channel && !activeRoomsRef.current.has(s.sessionId)) {
                    const roomEntry = {
                        roomInfo: s.roomInfo || { channel: s.channel },
                        channel: s.channel,
                        accountId: s.accountId || 'main',
                        accountLabel: s.accountId || 'main',
                        isMuted: false,
                        agoraJoined: true,
                        agoraConnected: false,
                        isSpeaker: true,
                        keepaliveActive: true,
                        wsRef: null,
                        bridgeWsUrl: s.bridgeWsUrl || null,
                        bridgePort: s.bridgePort || null,
                        joinTime: new Date(s.createdAt).getTime(),
                        elapsedTime: Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 1000),
                        sessionId: s.sessionId,
                        timerRef: null,
                        pingRef: null,
                        refreshRef: null,
                    };
                    // Start elapsed timer
                    const jt = roomEntry.joinTime;
                    roomEntry.timerRef = setInterval(() => {
                        setActiveRooms(prev => {
                            const next = new Map(prev);
                            const r = next.get(s.sessionId);
                            if (r) next.set(s.sessionId, { ...r, elapsedTime: Math.floor((Date.now() - jt) / 1000) });
                            activeRoomsRef.current = next;
                            return next;
                        });
                    }, 1000);
                    setActiveRooms(prev => {
                        const next = new Map(prev);
                        next.set(s.sessionId, roomEntry);
                        activeRoomsRef.current = next;
                        return next;
                    });
                }
            }
        } catch (e) { console.error('Fetch sessions:', e); }
    }

    async function handleBroadcastStart(mode) {
        setBroadcastLoading(mode);
        setBroadcastError('');
        const token = sessionStorage.getItem('auth_player');
        try {
            const body = { mode };
            if (selectedAccount) body.accountId = selectedAccount;
            if (mode === 'create-room' && createHouseClubId) {
                const sid = String(createHouseClubId).trim();
                if (/^\d+$/.test(sid)) body.socialClubId = sid;
            }
            if (mode === 'join-room') {
                if (!joinRoomUrl.trim()) { setBroadcastError('请输入房间链接'); setBroadcastLoading(''); return; }
                body.roomUrl = joinRoomUrl.trim();
            }
            const res = await fetch('/api/broadcast/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (data.error) { setBroadcastError(data.error); }
            else {
                addLog(`✅ ${mode}: session ${data.session?.shortId} 已创建`);
                if (data.room?.channel) addLog(`📡 房间: ${data.room.channel}`);
                if (data.room?.error) addLog(`⚠️ 房间: ${data.room.error}`);
                setJoinRoomUrl('');
                fetchBroadcastSessions();
                // Auto-connect to bridge WebSocket for join-room or create-room
                if ((mode === 'join-room' || mode === 'create-room') && data.room?.channel && data.room?.token) {
                    const sid = data.session?.sessionId || data.session?.shortId;
                    const acctId = selectedAccount || 'main';
                    const acctLabel = chAccounts[acctId]?.label || acctId;
                    const bridgeWsUrl = data.session?.bridgeWsUrl;
                    const joinTime = Date.now();
                    // Remove existing rooms for same account (auto-replace)
                    setActiveRooms(prev => {
                        const next = new Map();
                        for (const [existId, existRoom] of prev.entries()) {
                            if ((existRoom.accountId || 'main') !== acctId) {
                                next.set(existId, existRoom); // keep rooms from other accounts
                            } else {
                                // Clean up old room's timers/WS
                                if (existRoom.timerRef) clearInterval(existRoom.timerRef);
                                if (existRoom.pingRef) clearInterval(existRoom.pingRef);
                                if (existRoom.refreshRef) clearInterval(existRoom.refreshRef);
                                if (existRoom.wsPingInterval) clearInterval(existRoom.wsPingInterval);
                                if (existRoom.wsRef) try { existRoom.wsRef.close(); } catch {}
                                addLog('♻️ 移除旧房间卡片: ' + existId.slice(0, 8));
                            }
                        }
                        activeRoomsRef.current = next;
                        return next;
                    });

                    // Create room entry in Map
                    const roomEntry = {
                        roomInfo: data.room,
                        channel: data.room.channel,
                        accountId: acctId,
                        accountLabel: acctLabel,
                        isMuted: true,
                        agoraJoined: false,
                        agoraConnected: false,
                        isSpeaker: false,
                        keepaliveActive: false,
                        wsRef: null,
                        bridgeWsUrl: bridgeWsUrl,
                        bridgePort: data.session?.bridgePort,
                        joinTime: joinTime,
                        elapsedTime: 0,
                        sessionId: sid,
                        timerRef: null,
                        pingRef: null,
                        refreshRef: null,
                    };
                    // Start timer for this room
                    roomEntry.timerRef = setInterval(() => {
                        setActiveRooms(prev => {
                            const next = new Map(prev);
                            const r = next.get(sid);
                            if (r) next.set(sid, { ...r, elapsedTime: Math.floor((Date.now() - joinTime) / 1000) });
                            activeRoomsRef.current = next;
                            return next;
                        });
                    }, 1000);
                    setActiveRooms(prev => {
                        const next = new Map(prev);
                        next.set(sid, roomEntry);
                        activeRoomsRef.current = next;
                        return next;
                    });
                    addLog(`🔊 自动连接 Bridge (port ${data.session?.bridgePort})...`);
                    setRoomInput(data.room.channel);
                    // connectAgoraWs removed: server handles bridge join+unmute via fire-and-forget
                    // and auto-starts keepalive on successful join/create.
                }
            }
        } catch (e) { setBroadcastError(e.message); }
        setBroadcastLoading('');
    }

    async function handleBroadcastStop(sessionId, channel) {
        const token = sessionStorage.getItem('auth_player');
        try {
            await fetch('/api/broadcast/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
                body: JSON.stringify({ sessionId, channel }),
            });
            addLog(`🛑 Session 已停止`);
            fetchBroadcastSessions();
        } catch (e) { addLog(`❌ 停止失败: ${e.message}`); }
    }

    async function handleForceLeave(sessionId, channel, acctId) {
        const token = sessionStorage.getItem('auth_player');
        try {
            const resp = await fetch('/api/clubhouse/force_leave', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
                body: JSON.stringify({ sessionId, channel, accountId: acctId || 'main' }),
            });
            const data = await resp.json();
            if (!resp.ok || data.success === false) {
                addLog(`❌ 强制下线失败: ${data.error || data.error_message || `HTTP ${resp.status}`}`);
                return;
            }
            addLog(`🔌 强制下线: keepalive=${data.results?.keepalive} leave=${data.results?.leave}`);
            if (sessionId) removeRoom(sessionId);
            fetchBroadcastSessions();
        } catch (e) { addLog(`❌ 强制下线失败: ${e.message}`); }
    }

    const addLog = (msg) => {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        setLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 50));
    };

    const playerAuthHeaders = () => ({
        'Content-Type': 'application/json',
        'x-auth-token': sessionStorage.getItem('auth_player') || ''
    });

    /** Refresh user list for room admin toolbar (uses same bot account as the room). */
    const loadRoomAdminUsers = async (sessionId) => {
        const room = activeRoomsRef.current.get(sessionId);
        if (!room?.channel) return;
        updateRoom(sessionId, { adminLoading: true, adminError: '' });
        try {
            const res = await fetch(`${CH_API}/get_channel`, {
                method: 'POST',
                headers: playerAuthHeaders(),
                body: JSON.stringify({ channel: room.channel, accountId: room.accountId || 'main' })
            });
            const data = await res.json();
            if (res.status === 401) {
                updateRoom(sessionId, { adminLoading: false, adminError: '需要 Player 登录', adminUsersList: [] });
                return;
            }
            const errMsg = data.error_message || data.error;
            const users = data.users || [];
            if (errMsg && users.length === 0) {
                updateRoom(sessionId, { adminLoading: false, adminError: String(errMsg), adminUsersList: [] });
                return;
            }
            const r2 = activeRoomsRef.current.get(sessionId);
            updateRoom(sessionId, {
                adminLoading: false,
                adminUsersList: users,
                adminError: '',
                roomInfo: { ...(r2?.roomInfo || {}), users, topic: data.topic || r2?.roomInfo?.topic }
            });
        } catch (e) {
            updateRoom(sessionId, { adminLoading: false, adminError: e.message, adminUsersList: [] });
        }
    };

    const toggleRoomAdminToolbar = async (sessionId) => {
        const room = activeRoomsRef.current.get(sessionId);
        if (!room) return;
        if (room.adminToolbarOpen) {
            updateRoom(sessionId, { adminToolbarOpen: false });
            return;
        }
        updateRoom(sessionId, { adminToolbarOpen: true, adminSelectedUserId: '' });
        await loadRoomAdminUsers(sessionId);
    };

    const roomAdminAction = async (sessionId, action) => {
        const room = activeRoomsRef.current.get(sessionId);
        if (!room?.channel) return;
        const uidRaw = room.adminSelectedUserId;
        if (uidRaw === undefined || uidRaw === null || uidRaw === '') {
            addLog('⚠️ 请先在列表中选择一位用户');
            return;
        }
        const uid = parseInt(String(uidRaw), 10);
        if (Number.isNaN(uid)) {
            addLog('⚠️ 无效的用户 ID');
            return;
        }
        const accountId = room.accountId || 'main';
        const body = { channel: room.channel, user_id: uid, accountId };
        const url = action === 'block'
            ? `${CH_API}/block_user`
            : action === 'invite'
                ? `${CH_API}/invite_speaker`
                : `${CH_API}/make_moderator`;
        updateRoom(sessionId, { adminActionLoading: true });
        try {
            const res = await fetch(url, { method: 'POST', headers: playerAuthHeaders(), body: JSON.stringify(body) });
            const data = await res.json();
            if (res.status === 401) {
                addLog('❌ 需要 Player 登录');
                return;
            }
            const em = data.error_message || data.error;
            if (data.success === false || (em && String(em).length > 0)) {
                addLog(`❌ 操作失败: ${em}（Bot 需为房间管理员）`);
                return;
            }
            if (action === 'block') addLog(`✅ 已移出 ${uid}`);
            else if (action === 'invite') addLog(`✅ 已邀请上麦 ${uid}`);
            else addLog(`✅ 已设为 mod ${uid}`);
            await loadRoomAdminUsers(sessionId);
        } catch (e) {
            addLog(`❌ ${e.message}`);
        } finally {
            updateRoom(sessionId, { adminActionLoading: false });
        }
    };

    // === Session Management ===
    const fetchSessions = async () => {
        try {
            const res = await fetch('/api/sessions', { headers: { 'x-auth-token': sessionStorage.getItem('auth_player') || '' } });
            const data = await res.json();
            setSessions(data.sessions || []);
            sessionFetchErrorLoggedRef.current = false;
        } catch (e) {
            if (!sessionFetchErrorLoggedRef.current) {
                addLog('Session fetch error: ' + e.message);
                sessionFetchErrorLoggedRef.current = true;
            }
        }
    };

    const createNewSession = async () => {
        setSessionLoading(true);
        try {
            const res = await fetch('/api/sessions/create', { method: 'POST', headers: { 'x-auth-token': sessionStorage.getItem('auth_player') || '' } });
            const data = await res.json();
            if (data.error) { addLog('\u274c ' + data.error); }
            else {
                addLog('\ud83d\udcfb Broadcast session created: ' + data.shortId);
                addLog('\ud83d\udd17 ' + data.playerUrl);
            }
            fetchSessions();
        } catch (e) { addLog('\u274c Create error: ' + e.message); }
        setSessionLoading(false);
    };

    const deleteSessionById = async (id) => {
        try {
            const res = await fetch('/api/sessions/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': sessionStorage.getItem('auth_player') || '' },
                body: JSON.stringify({ sessionId: id })
            });
            const data = await res.json();
            if (data.error) addLog('\u274c ' + data.error);
            else addLog('\ud83d\uddd1\ufe0f Session deleted');
            fetchSessions();
        } catch (e) { addLog('\u274c Delete error: ' + e.message); }
    };

    useEffect(() => {
        fetchSessions();
        const iv = setInterval(fetchSessions, 10000);
        return () => clearInterval(iv);
    }, []);


    // Restore room panels from localStorage on mount
    useEffect(() => {
        try {
            const saved = localStorage.getItem(ROOM_STORAGE_KEY);
            if (!saved) return;
            const savedData = JSON.parse(saved);
            if (!savedData || typeof savedData !== 'object') return;

            // New format: { sessionId: { roomInfo, channel, accountId, accountLabel, joinTime, bridgeWsUrl, bridgePort } }
            // Old format: { roomInfo, joinedAt } — skip
            if (savedData.roomInfo) {
                addLog('♻️ 旧格式房间数据，跳过恢复');
                localStorage.removeItem(ROOM_STORAGE_KEY);
                return;
            }

            // Restore each room
            (async () => {
                try {
                    // Fetch active sessions to match bridge ports
                    const sessRes = await fetch('/api/sessions', {
                        headers: { 'x-auth-token': sessionStorage.getItem('auth_player') || '' }
                    });
                    const sessData = await sessRes.json();
                    const activeSessions = sessData.sessions || [];

                    const restoredEntries = {};
                    const restoredSessionIds = new Set();
                    for (const [sid, rd] of Object.entries(savedData)) {
                        if (!rd.roomInfo || !rd.channel) continue;
                        const savedAccountId = rd.accountId || 'main';
                        // Only restore if a matching active session exists for the same account.
                        // If a reconnect created a NEW sessionId for the same room/account, normalize
                        // the restored card to the current active sessionId instead of reviving the old one.
                        const matchSession = activeSessions.find(s => 
                            s.sessionId === sid ||
                            ((s.accountId || 'main') === savedAccountId && s.channel === rd.channel)
                        );
                        if (!matchSession) {
                            addLog(`🗑️ 跳过已失效的房间: ${rd.channel?.slice(0, 8)}...`);
                            continue;
                        }
                        const restoredSid = matchSession.sessionId;
                        if (restoredSessionIds.has(restoredSid)) continue;
                        restoredSessionIds.add(restoredSid);

                        const restoredChannel = matchSession.channel || rd.channel;
                        const restoredAccountId = matchSession.accountId || savedAccountId;
                        const restoredAccountLabel = rd.accountLabel || restoredAccountId || 'unknown';
                        restoredEntries[restoredSid] = {
                            ...rd,
                            channel: restoredChannel,
                            accountId: restoredAccountId,
                            accountLabel: restoredAccountLabel,
                            bridgeWsUrl: matchSession.bridgeWsUrl || rd.bridgeWsUrl,
                            bridgePort: matchSession.bridgePort || rd.bridgePort,
                        };
                        const joinTime = rd.joinTime || Date.now();
                        const bridgeWsUrl = matchSession.bridgeWsUrl || rd.bridgeWsUrl;
                        const bridgePort = matchSession.bridgePort || rd.bridgePort;

                        addLog(`♻️ 恢复房间: ${restoredChannel} (${restoredAccountLabel})`);

                        // Create room entry in activeRooms Map
                        const roomEntry = {
                            roomInfo: rd.roomInfo,
                            channel: restoredChannel,
                            accountId: restoredAccountId,
                            accountLabel: restoredAccountLabel,
                            isMuted: true,
                            agoraJoined: false,
                            agoraConnected: false,
                            isSpeaker: false,
                            keepaliveActive: false,
                            wsRef: null,
                            bridgeWsUrl: bridgeWsUrl,
                            bridgePort: bridgePort,
                            joinTime: joinTime,
                            elapsedTime: Math.floor((Date.now() - joinTime) / 1000),
                            sessionId: restoredSid,
                            timerRef: null,
                            pingRef: null,
                            refreshRef: null,
                        };

                        // Start timer
                        roomEntry.timerRef = setInterval(() => {
                            setActiveRooms(prev => {
                                const next = new Map(prev);
                                const r = next.get(restoredSid);
                                if (r) next.set(restoredSid, { ...r, elapsedTime: Math.floor((Date.now() - joinTime) / 1000) });
                                activeRoomsRef.current = next;
                                return next;
                            });
                        }, 1000);

                        setActiveRooms(prev => {
                            const next = new Map(prev);
                            next.set(restoredSid, roomEntry);
                            activeRoomsRef.current = next;
                            return next;
                        });

                        // Reconnect bridge WebSocket if available
                        if (bridgeWsUrl) {
                            addLog(`🔗 恢复 Bridge (port ${bridgePort})...`);
                            // connectAgoraWs removed: server handles bridge join+unmute
                        } else {
                            addLog('ℹ️ 无活跃 Bridge（bot 仍在房间）');
                        }
                    }
                    if (Object.keys(restoredEntries).length > 0) {
                        localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(restoredEntries));
                    } else {
                        localStorage.removeItem(ROOM_STORAGE_KEY);
                    }
                } catch (e) {
                    console.error('Room restore error:', e);
                }
            })();
        } catch { /* ignore */ }
    }, []);

    // Save room state
    useEffect(() => {
        if (activeRooms.size > 0) {
            const roomsData = {};
            for (const [sid, room] of activeRooms.entries()) {
                roomsData[sid] = { roomInfo: room.roomInfo, channel: room.channel, accountId: room.accountId, accountLabel: room.accountLabel, joinTime: room.joinTime, bridgeWsUrl: room.bridgeWsUrl, bridgePort: room.bridgePort };
            }
            localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(roomsData));
        } else {
            localStorage.removeItem(ROOM_STORAGE_KEY);
        }
    }, [activeRooms]);

    // Server-side room state fallback (for incognito / new devices)
    useEffect(() => {
        if (activeRooms.size > 0) return; // Already have rooms
        const saved = localStorage.getItem(ROOM_STORAGE_KEY);
        if (saved) return; // localStorage has data, will be handled by other useEffect
        
        (async () => {
            try {
                const res = await fetch(`${CH_API}/active_rooms`);
                const data = await res.json();
                if (data.rooms && data.rooms.length > 0) {
                    const room = data.rooms[0]; // Use first active room
                    addLog(`🔄 从服务端恢复房间: ${room.channel}`);
                    // Fetch full room info from Clubhouse
                    const chRes = await fetch(`${CH_API}/get_channel`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': sessionStorage.getItem('auth_player') || '' },
                        body: JSON.stringify({ channel: room.channel })
                    });
                    const chData = await chRes.json();
                    if (chData.success) {
                        const ri = { channel: room.channel, topic: chData.topic || '直播中', users: chData.users || [], token: chData.token };
                        // (legacy) setRoomInfo(ri);
                        setRoomInput(room.channel);
                        // (legacy) setIsJoined(true);
                        // (legacy) setIsMuted(true);
                        // (legacy) joinTimeRef.current = room.startedAt ? new Date(room.startedAt).getTime() : Date.now();
// (legacy)                         timerRef.current = setInterval(() => {
                            // (legacy) setElapsedTime(Math.floor((Date.now() - joinTimeRef.current) / 1000));
                        // (legacy) }, 1000);
                        addLog(`✅ 房间已恢复 (${chData.users?.length || 0} 人)`);
                    }
                }
            } catch { /* ignore */ }
        })();
    }, []);

    // Send JSON to agora-bridge WebSocket (legacy, unused — per-room WS used instead)
    const agoraSend = (data) => { return false; };

    // Send request with ID (for join/leave that expect response)
    const agoraSendRequest = (data) => {
        const id = requestIdRef.current++;
        return agoraSend({ id, ...data });
    };

    // Connect to agora-bridge WebSocket and join the Agora channel
    const connectAgoraWs = (info, sessionId = 'legacy', retryCount = 0, reconnectOnly = false) => {
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 3000;
        // Close previous WS for this session if any
        const prevRoom = activeRoomsRef.current.get(sessionId);
        if (prevRoom?.wsRef) {
            try { prevRoom.wsRef.close(); } catch { }
        }
        try {
            // Use session-specific bridge URL if available, otherwise fall back to default
            const wsUrl = info?.bridgeWsUrl 
                ? `wss://${window.location.host}${info.bridgeWsUrl}`
                : AGORA_WS_URL;
            addLog(`🔗 连接 Bridge: ${wsUrl.replace(/wss:\/\/[^/]+/, '')}${retryCount > 0 ? ` (重试 ${retryCount}/${MAX_RETRIES})` : ''}`);
            const ws = new WebSocket(wsUrl);
            updateRoom(sessionId, { wsRef: ws, bridgeWsUrl: info?.bridgeWsUrl || null, agoraJoined: false });

            ws.onopen = () => {
                addLog('🔗 Agora-Bridge WebSocket 已连接');
                updateRoom(sessionId, { agoraConnected: true });

                // reconnectOnly=false: send full Agora join (first connect or 1006 retry)
                // reconnectOnly=true: bridge already has Agora session (1005 idle timeout)
                if (!reconnectOnly && info && info.token) {
                    const joinMsg = {
                        id: requestIdRef.current++,
                        action: 'join',
                        token: info.token,
                        channel_name: info.channel,
                        user_id: info.botUserId || 450417781,
                        speaker: true,
                        app_id: info.agora_app_id || '938de3e8055e42b281bb8c6f69c21f78'
                    };
                    ws.send(JSON.stringify(joinMsg));
                    addLog(`📡 Agora join 发送: ch=${info.channel}${retryCount > 0 ? ' (重试)' : ''}`);
                } else if (reconnectOnly) {
                    // Bridge keeps Agora joined on WS close — just ensure unmuted
                    ws.send(JSON.stringify({ action: 'unmute' }));
                    addLog('🔗 WS 重连成功 (保持 Agora 会话)');
                }

                // Ping keepalive: send unmute periodically to keep WS alive
                // Bridge only handles join/leave/mute/unmute, so we use unmute as heartbeat
                const wsPingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ action: 'unmute' }));
                    } else {
                        clearInterval(wsPingInterval);
                    }
                }, 15000);
                // Store ping interval for cleanup
                updateRoom(sessionId, { wsPingInterval });
            };

            ws.onclose = (e) => {
                addLog(`🔌 Agora-Bridge 断开 (code=${e.code}, reason=${e.reason || 'none'})`);
                const curRoom = activeRoomsRef.current.get(sessionId);
                if (curRoom?.wsPingInterval) clearInterval(curRoom.wsPingInterval);
                updateRoom(sessionId, { agoraConnected: false, wsPingInterval: null });
                // Auto-retry on abnormal close
                if ((e.code === 1006 || e.code === 1005) && retryCount < MAX_RETRIES) {
                    // 1005 = idle timeout (bridge already has Agora session) → reconnect only
                    // 1006 = bridge not ready yet → need full join
                    const isIdleTimeout = e.code === 1005;
                    addLog(`⏳ ${RETRY_DELAY/1000}秒后重试连接... (${retryCount + 1}/${MAX_RETRIES})`);
                    setTimeout(() => connectAgoraWs(info, sessionId, retryCount + 1, true), RETRY_DELAY);  // reconnectOnly: bridge keeps Agora alive
                }
            };
            ws.onerror = () => addLog('❌ Agora-Bridge 连接错误');
            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.ok !== undefined) {
                        const curRoom = activeRoomsRef.current.get(sessionId);
                        if (Number(msg.ok) === 0 && !(curRoom?.agoraJoined)) {
                            addLog('✅ Agora 加入成功!');
                            updateRoom(sessionId, { agoraJoined: true, isSpeaker: true });
                            // Auto-unmute on same connection right after join success
                            addLog('🎙️ 正在发送 unmute...');
                            ws.send(JSON.stringify({ action: 'unmute' }));
                            updateRoom(sessionId, { isMuted: false });
                            addLog('✅ unmute 已发送，麦克风已开启');
                        } else {
                        if (Number(msg.ok) !== 0) {
                            addLog(`❌ Agora 加入失败: ok=${msg.ok}`);
                        }
                        }
                    } else if (msg.action === 'on_muted') {
                        addLog(`🔇 用户 ${msg.uid} 已静音`);
                    } else if (msg.action === 'on_unmuted') {
                        addLog(`🎙️ 用户 ${msg.uid} 已开麦`);
                    } else {
                        addLog(`📩 Agora: ${JSON.stringify(msg).slice(0, 80)}`);
                    }
                } catch {
                    addLog(`📩 Agora: ${String(e.data).slice(0, 60)}`);
                }
            };
        } catch (e) {
            addLog(`❌ WS 连接失败: ${e.message}`);
        }
    };

    // Mic toggle — via server-side API (reliable, no WS complexity)
    const toggleMuteForRoom = async (sessionId) => {
        const room = activeRoomsRef.current.get(sessionId);
        if (!room) {
            addLog('⚠️ toggleMute: room not found');
            return;
        }
        const newMuted = !room.isMuted;
        updateRoom(sessionId, { isMuted: newMuted });
        addLog(newMuted ? '🔇 正在静音...' : '🎙️ 正在开麦...');
        try {
            const token = sessionStorage.getItem('auth_player') || '';
            const res = await fetch('/api/broadcast/mute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
                body: JSON.stringify({ sessionId, muted: newMuted }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                addLog(newMuted ? '🔇 已静音' : '🎙️ 已开麦');
            } else {
                const err = data.error || data.detail || `HTTP ${res.status}`;
                addLog('❌ ' + err);
                updateRoom(sessionId, { isMuted: !newMuted }); // revert
            }
        } catch (e) {
            addLog('❌ 请求失败: ' + e.message);
            updateRoom(sessionId, { isMuted: !newMuted }); // revert
        }
    };

    // Parse Clubhouse link
    const parseChannelId = (input) => {
        if (!input) return null;
        const trimmed = input.trim();
        // Handle full Clubhouse URLs: extract slug before : or ? or /
        const urlMatch = trimmed.match(/clubhouse\.com\/room\/([a-zA-Z0-9_-]+)/);
        if (urlMatch) return urlMatch[1];
        // Handle raw channel IDs (alphanumeric, 4-30 chars)
        if (/^[a-zA-Z0-9_-]{4,30}$/.test(trimmed)) return trimmed;
        return null;
    };

    // Join room
    const handleJoin = async () => {
        const channelId = parseChannelId(roomInput);
        if (!channelId) { setError('请输入有效的房间 ID 或 Clubhouse 链接'); return; }
        setError('');
        setIsJoining(true);
        addLog(`正在加入房间: ${channelId}`);
        try {
            const res = await fetch(`${CH_API}/join`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': sessionStorage.getItem('auth_player') || '' },
                body: JSON.stringify({ channel: channelId })
            });
            const data = await res.json();
            if (data.success) {
                // Manual room info no longer sets global state
                addLog(`📡 频道信息: ${data.channel || 'unknown'}`);
                // (legacy) setIsMuted(false); // Will be set to false after agora ok=0
                // (legacy) joinTimeRef.current = Date.now();
                addLog(`✅ 成功加入: ${data.topic || channelId}`);
                addLog(`👤 ${data.users?.length || 0} 人在房间`);
                // (legacy) timerRef.current = setInterval(() => {
                    // (legacy) setElapsedTime(Math.floor((Date.now() - joinTimeRef.current) / 1000));
                // (legacy) }, 1000);
                // connectAgoraWs removed: server handles bridge
                startKeepalive(data.channel);
            } else {
                setError(data.error_message || '加入失败');
                addLog(`❌ 加入失败: ${data.error_message}`);
            }
        } catch (e) {
            setError('网络错误: ' + e.message);
            addLog(`❌ 网络错误: ${e.message}`);
        }
        setIsJoining(false);
    };

    // Start server-side keepalive
    const startKeepalive = async (channel, acctId) => {
        try {
            const res = await fetch(`${CH_API}/start_keepalive`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': sessionStorage.getItem('auth_player') || ''
                },
                body: JSON.stringify({ channel, accountId: acctId || selectedAccount })
            });
            const data = await res.json();
            if (data.success) {
                // Find room by channel and update keepaliveActive
                for (const [sid, room] of activeRoomsRef.current.entries()) {
                    if (room.channel === channel) updateRoom(sid, { keepaliveActive: true });
                }
                addLog(`💓 Keepalive 已启动 (bot: ${data.botUserId})`);
            } else {
                addLog(`⚠️ Keepalive 启动失败: ${data.error_message || data.error || `HTTP ${res.status}`}`);
            }
        } catch (e) {
            addLog(`⚠️ Keepalive 请求失败: ${e.message}`);
        }
    };

    const stopKeepalive = async (channel, acctId) => {
        try {
            await fetch(`${CH_API}/stop_keepalive`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': sessionStorage.getItem('auth_player') || ''
                },
                body: JSON.stringify({ channel, accountId: acctId || selectedAccount })
            });
            setKeepaliveActive(false);
            // Speaker status managed per-room
        } catch { }
    };

    const handleRaiseHand = async (sessionId) => {
        const room = sessionId ? activeRoomsRef.current.get(sessionId) : activeRoomsRef.current.values().next().value;
        if (!room) return;
        try {
            const res = await fetch(`${CH_API}/raise_hand`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: room.channel, accountId: room.accountId || selectedAccount })
            });
            const data = await res.json();
            addLog(data.success !== false ? '✋ 已举手请求上台' : `❌ 举手失败: ${data.error_message}`);
        } catch (e) {
            addLog(`❌ 举手请求失败: ${e.message}`);
        }
    };

    // Listen for server-side auto-accept notifications
    useEffect(() => {
        const socket = socketIO({ path: '/socket.io' });
        socket.on('clubhouse_speaker_accepted', (data) => {
            if (roomInfo && data.channel === roomInfo.channel) {
                // Speaker status managed per-room
                addLog('🎉 自动接受上台邀请成功！已成为 Speaker');
            }
        });

        // Listen for bridge auto-restart (server detected crash and restarted bridge)
        socket.on('bridge_restarted', (data) => {
            addLog(`🔄 Bridge 自动重启 (port ${data.bridgePort})`);
            // Find matching room and reconnect WS
            const rooms = activeRoomsRef.current;
            for (const [sid, room] of rooms) {
                if (room.channel === data.channel || room.accountId === data.accountId) {
                    addLog(`🔗 正在重连 Bridge: ${data.bridgeWsUrl}`);
                    if (room.wsPingInterval) clearInterval(room.wsPingInterval);
                    if (room.wsRef) try { room.wsRef.close(); } catch {}
                    // Full Agora join — bridge is fresh, no existing session
                    // connectAgoraWs removed: server handles bridge
                    break;
                }
            }
        });

        return () => socket.disconnect();
    }, []);

    // Leave room — per session
    const handleLeaveRoom = async (sessionId) => {
        const room = activeRoomsRef.current.get(sessionId);
        if (!room) return;
        addLog(`正在离开房间 ${room.channel}...`);
        await handleForceLeave(sessionId, room.channel, room.accountId);
        addLog('👋 已离开房间');
    };
    // Legacy compat: leave first room
    const handleLeave = async () => {
        const firstKey = activeRoomsRef.current.keys().next().value;
        if (firstKey) await handleLeaveRoom(firstKey);
    };

    // Create room
    const handleCreate = async () => {
        setError('');
        setIsJoining(true);
        addLog('正在创建房间...');
        try {
            const res = await fetch(`${CH_API}/create`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': sessionStorage.getItem('auth_player') || '' },
                body: JSON.stringify({ topic: '🎵 Music Studio' })
            });
            const data = await res.json();
            if (data.success) {
                // (legacy) setRoomInfo(data);
                setRoomInput(data.channel);
                // (legacy) setIsJoined(true);
                // (legacy) setIsMuted(false);
                // Speaker status managed per-room
                // (legacy) joinTimeRef.current = Date.now();
                addLog(`✅ 房间已创建: ${data.channel}`);
                // (legacy) timerRef.current = setInterval(() => {
                    // (legacy) setElapsedTime(Math.floor((Date.now() - joinTimeRef.current) / 1000));
                // (legacy) }, 1000);
                // connectAgoraWs removed: server handles bridge
                startKeepalive(data.channel);
            } else {
                setError(data.error_message || '创建失败');
                addLog(`❌ 创建失败: ${data.error_message}`);
            }
        } catch (e) {
            setError('网络错误: ' + e.message);
            addLog(`❌ 网络错误: ${e.message}`);
        }
        setIsJoining(false);
    };

    const formatTime = (s) => {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
            : `${m}:${String(sec).padStart(2, '0')}`;
    };

    // Active ping heartbeat — keeps speaker status alive (every 30s)
    // Ping/refresh intervals disabled — handled per-room by server keepalive

    useEffect(() => {
        if (activeRooms.size === 0) {
            if (statusCheckRef.current) clearInterval(statusCheckRef.current);
            return;
        }

        // Frontend ping disabled — server keepalive handles active_ping
        // Per-room keepalive is started in handleBroadcastStart

        // Channel refresh and ping disabled — handled per-room by server keepalive
        return () => {};
    }, []);

    // PubNub subscription for room notifications
    useEffect(() => {
        if (!pubnubEnabled) {
            if (pubnubRef.current) {
                pubnubRef.current.unsubscribeAll();
                pubnubRef.current = null;
                setPubnubConnected(false);
                addLog('🔔 PubNub 已关闭');
            }
            return;
        }
        try {
            const pn = new PubNub({
                subscribeKey: PUBNUB_SUB_KEY,
                publishKey: PUBNUB_PUB_KEY,
                userId: String(CH_USER_ID),
            });
            pubnubRef.current = pn;

            pn.addListener({
                status: (s) => {
                    if (s.category === 'PNConnectedCategory') {
                        setPubnubConnected(true);
                        addLog('🔔 PubNub 已连接，监听房间通知...');
                    } else if (s.category === 'PNNetworkDownCategory') {
                        setPubnubConnected(false);
                        addLog('⚠️ PubNub 网络断开');
                    }
                },
                message: (msg) => {
                    const data = msg.message;
                    addLog(`📨 通知: ${JSON.stringify(data).slice(0, 100)}`);
                    // Detect room-related notifications
                    if (data.channel || data.type === 'channel_update' || data.action === 'join_channel') {
                        const roomChannel = data.channel || data.channel_id;
                        const topic = data.topic || data.club?.name || '未知房间';
                        setRoomNotification({ channel: roomChannel, topic, time: Date.now(), raw: data });
                        addLog(`🌟 检测到房间: ${topic} (${roomChannel})`);
                    }
                }
            });

            pn.subscribe({ channels: [`users.${CH_USER_ID}`] });
            addLog(`🔔 PubNub 订阅: users.${CH_USER_ID}`);
        } catch (e) {
            addLog(`❌ PubNub 连接失败: ${e.message}`);
        }

        return () => {
            if (pubnubRef.current) {
                pubnubRef.current.unsubscribeAll();
            }
        };
    }, [pubnubEnabled]);

    useEffect(() => () => {
        if (timerRef.current) clearInterval(timerRef.current);
        // WS close handled per-room in removeRoom
        if (statusCheckRef.current) clearInterval(statusCheckRef.current);
        if (pubnubRef.current) pubnubRef.current.unsubscribeAll();
    }, []);

    return (
        <div className="h-full overflow-y-auto scroll-allowed p-4 pb-20 space-y-4">

            {/* Title */}
            <div className="text-center mb-2">
                <h2 className="font-hand text-2xl text-prince-gold flex items-center justify-center gap-2">
                    <Radio className="w-6 h-6 text-prince-rose animate-pulse" />
                    Clubhouse 直播
                </h2>
                <div className="mt-1">

                    {/* === Unified Broadcast Section === */}
                    <div className="space-y-3 mb-6 p-3 rounded-xl bg-prince-gold/5 border border-prince-gold/10">
                        <h3 className="text-prince-gold text-sm font-hand">🚀 一键广播</h3>

                        {/* Player-only button */}
                        <button
                            onClick={() => handleBroadcastStart('player-only')}
                            disabled={!!broadcastLoading}
                            className="w-full py-2 rounded-xl font-hand text-sm transition-all duration-300 flex items-center justify-center gap-2 border border-prince-gold/30 text-prince-gold hover:bg-prince-gold/10 active:scale-[0.98] disabled:opacity-50"
                        >
                            {broadcastLoading === 'player-only' ? '⏳ 创建中...' : '🎵 创建 Session（仅播放器）'}
                        </button>
                    {/* Reconnect button - shown when no active rooms but keepalive is running */}
                    <button onClick={handleReconnect} style={{width:'100%',padding:'10px',marginTop:'8px',background:'#2563eb',color:'white',border:'none',borderRadius:'8px',cursor:'pointer',fontSize:'14px'}}>
                        🔄 重连播放（不调用 Join API）
                    </button>

                    {/* === Diagnostic Panel === */}
                    <div style={{marginTop:'12px',border:'1px solid rgba(168,131,60,0.2)',borderRadius:'10px',overflow:'hidden'}}>
                        <div style={{display:'flex',gap:'6px',padding:'8px'}}>
                            <button
                                onClick={runDiagnose}
                                disabled={diagLoading}
                                style={{flex:1,padding:'8px',background:'rgba(168,131,60,0.15)',color:'#a8833c',border:'1px solid rgba(168,131,60,0.3)',borderRadius:'8px',cursor:'pointer',fontSize:'13px',fontWeight:'bold'}}
                            >
                                {diagLoading ? '⏳ 诊断中...' : '🔍 系统诊断'}
                            </button>
                            <button
                                onClick={runRepair}
                                disabled={repairLoading || !diagResult}
                                style={{flex:1,padding:'8px',background:'rgba(34,197,94,0.15)',color:'#22c55e',border:'1px solid rgba(34,197,94,0.3)',borderRadius:'8px',cursor:'pointer',fontSize:'13px',fontWeight:'bold',opacity:diagResult?1:0.5}}
                            >
                                {repairLoading ? '⏳ 修复中...' : '🔧 一键修复'}
                            </button>
                        </div>

                        {diagResult && diagExpanded && (
                            <div style={{padding:'8px 10px',borderTop:'1px solid rgba(168,131,60,0.1)',fontSize:'12px',lineHeight:'1.6',maxHeight:'300px',overflowY:'auto',background:'rgba(0,0,0,0.2)'}}>
                                {/* Issues Summary */}
                                <div style={{marginBottom:'8px'}}>
                                    <strong style={{color:'#a8833c'}}>状态概览</strong>
                                    {diagResult.issues?.map((issue, i) => (
                                        <div key={i} style={{padding:'2px 0',color: issue.startsWith('✅') ? '#22c55e' : issue.startsWith('⚠') || issue.startsWith('⏸') ? '#eab308' : '#ef4444'}}>
                                            {issue}
                                        </div>
                                    ))}
                                </div>

                                {/* Detailed Checks */}
                                {diagResult.checks && (
                                    <div style={{marginBottom:'8px'}}>
                                        <strong style={{color:'#a8833c'}}>详细检查</strong>
                                        <table style={{width:'100%',borderCollapse:'collapse',marginTop:'4px'}}>
                                            <tbody>
                                                {diagResult.checks.session && (
                                                    <tr><td style={{color:'#888',padding:'2px 6px'}}>Session</td><td style={{color:diagResult.checks.session.exists?'#22c55e':'#ef4444'}}>{diagResult.checks.session.exists ? `${diagResult.checks.session.shortId} (roomInfo: ${diagResult.checks.session.hasRoomInfo ? '✅' : '❌'})` : '无'}</td></tr>
                                                )}
                                                {diagResult.checks.bridge && (
                                                    <tr><td style={{color:'#888',padding:'2px 6px'}}>Bridge</td><td style={{color:diagResult.checks.bridge.listening?'#22c55e':'#ef4444'}}>{diagResult.checks.bridge.listening ? `端口 ${diagResult.checks.bridge.port} ✅` : `端口 ${diagResult.checks.bridge.port} ❌`}</td></tr>
                                                )}
                                                {diagResult.checks.pulseAudio && (
                                                    <>
                                                        <tr><td style={{color:'#888',padding:'2px 6px'}}>Bridge 录音</td><td style={{color:diagResult.checks.pulseAudio.bridgeRecording?'#22c55e':'#ef4444'}}>{diagResult.checks.pulseAudio.bridgeRecording ? `${diagResult.checks.pulseAudio.sourceOutputCount} 个 source-output ✅` : '❌ 未录音'}</td></tr>
                                                        <tr><td style={{color:'#888',padding:'2px 6px'}}>音乐播放</td><td style={{color:diagResult.checks.pulseAudio.ffplayPlaying?'#22c55e':'#eab308'}}>{diagResult.checks.pulseAudio.ffplayPlaying ? `${diagResult.checks.pulseAudio.sinkInputCount} 个播放器 ✅` : '⚠️ 无播放器'}</td></tr>
                                                    </>
                                                )}
                                                {diagResult.checks.keepalive && (
                                                    <tr><td style={{color:'#888',padding:'2px 6px'}}>Keepalive</td><td style={{color:diagResult.checks.keepalive.running?'#22c55e':'#ef4444'}}>{diagResult.checks.keepalive.running ? (diagResult.checks.keepalive.paused ? `⏸️ 暂停 (${diagResult.checks.keepalive.pauseRemaining}s)` : `✅ ch=${diagResult.checks.keepalive.channel} (ping #${diagResult.checks.keepalive.pingCount})`) : '❌ 未运行'}</td></tr>
                                                )}
                                                {diagResult.checks.chApi && (
                                                    <tr><td style={{color:'#888',padding:'2px 6px'}}>CH API</td><td style={{color:diagResult.checks.chApi.reachable?'#22c55e':'#ef4444'}}>{diagResult.checks.chApi.reachable ? `✅ ${diagResult.checks.chApi.user}` : `❌ ${diagResult.checks.chApi.error} (${diagResult.checks.chApi.source})`}</td></tr>
                                                )}
                                                {diagResult.checks.token && (
                                                    <tr><td style={{color:'#888',padding:'2px 6px'}}>Token</td><td style={{color:diagResult.checks.token.hasToken?'#22c55e':'#ef4444'}}>{diagResult.checks.token.hasToken ? `✅ ${diagResult.checks.token.account} (len=${diagResult.checks.token.tokenLen})` : '❌ 为空'}</td></tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {/* Repair Steps */}
                                {diagResult.repairSteps && (
                                    <div style={{marginTop:'8px',padding:'6px 8px',background:'rgba(34,197,94,0.08)',borderRadius:'6px',border:'1px solid rgba(34,197,94,0.15)'}}>
                                        <strong style={{color:'#22c55e'}}>修复结果</strong>
                                        {diagResult.repairSteps.map((step, i) => (
                                            <div key={i} style={{padding:'2px 0',color: step.startsWith('✅') ? '#22c55e' : step.startsWith('⚠') ? '#eab308' : step.startsWith('❌') ? '#ef4444' : '#ccc'}}>
                                                {step}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div style={{marginTop:'6px',color:'#555',fontSize:'11px'}}>
                                    诊断时间: {diagResult.timestamp ? new Date(diagResult.timestamp).toLocaleTimeString() : '?'}
                                </div>
                            </div>
                        )}
                    </div>

                        {/* House：硬编码 social_club_id（与 server STATIC_CREATE_ROOM_HOUSES 一致） */}
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-prince-muted/60 font-hand whitespace-nowrap">🏠 创建位置</span>
                            <select
                                value={createHouseClubId}
                                onChange={e => setCreateHouseClubId(e.target.value)}
                                disabled={!!broadcastLoading}
                                className="flex-1 px-3 py-1.5 rounded-xl bg-prince-deep/60 border border-prince-gold/20 text-prince-light text-xs font-body outline-none focus:border-prince-gold/40 cursor-pointer disabled:opacity-50"
                            >
                                <option value="">公开（不指定 House）</option>
                                {STATIC_CREATE_HOUSE_OPTIONS.map(h => (
                                    <option key={h.socialClubId} value={h.socialClubId}>
                                        {h.displayLabel}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Create room button */}
                        <button
                            onClick={() => handleBroadcastStart('create-room')}
                            disabled={!!broadcastLoading}
                            className="w-full py-2 rounded-xl font-hand text-sm transition-all duration-300 flex items-center justify-center gap-2 border border-green-500/30 text-green-400 hover:bg-green-500/10 active:scale-[0.98] disabled:opacity-50"
                        >
                            {broadcastLoading === 'create-room' ? '⏳ 创建中...' : '📡 创建房间并广播'}
                        </button>

                        {/* Account picker */}
                        {Object.keys(chAccounts).length > 1 && (
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-prince-muted/60 font-hand whitespace-nowrap">👤 账号:</span>
                                <select
                                    value={selectedAccount}
                                    onChange={e => {
                                        setSelectedAccount(e.target.value);
                                        setCreateHouseClubId('');
                                    }}
                                    className="flex-1 px-3 py-1.5 rounded-xl bg-prince-deep/60 border border-prince-gold/20 text-prince-light text-xs font-body outline-none focus:border-prince-gold/40 cursor-pointer"
                                >
                                    {Object.entries(chAccounts).map(([id, acct]) => (
                                        <option key={id} value={id}>
                                            {acct.label} ({acct.userId})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Join room */}
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={joinRoomUrl}
                                onChange={e => setJoinRoomUrl(e.target.value)}
                                placeholder="粘贴 Clubhouse 房间链接..."
                                className="flex-1 px-3 py-2 rounded-xl bg-prince-deep/60 border border-prince-gold/20 text-prince-light text-xs font-body placeholder-prince-muted/50 outline-none focus:border-prince-gold/40"
                            />
                        </div>
                        <button
                            onClick={() => handleBroadcastStart('join-room')}
                            disabled={!!broadcastLoading || !joinRoomUrl.trim()}
                            className="w-full py-2 rounded-xl font-hand text-sm transition-all duration-300 flex items-center justify-center gap-2 border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 active:scale-[0.98] disabled:opacity-50"
                        >
                            {broadcastLoading === 'join-room' ? '⏳ 加入中...' : '🎙️ 加入房间并广播'}
                        </button>

                        {/* Advanced options - collapsible */}
                        <div className="mt-2">
                            <button
                                onClick={() => setShowAdvanced(!showAdvanced)}
                                className="w-full py-1 text-xs font-hand text-prince-muted/50 hover:text-prince-muted transition-all flex items-center justify-center gap-1"
                            >
                                <span className="text-[10px]">{showAdvanced ? '▼' : '▶'}</span>
                                高级选项
                            </button>
                            {showAdvanced && (
                                <div className="flex items-center gap-2 mt-1 animate-fadeIn">
                                    <button
                                        onClick={handleChwebAutoLogin}
                                        className="flex-1 py-1.5 rounded-lg text-xs font-hand border border-purple-500/30 text-purple-400 hover:bg-purple-500/10 transition-all"
                                    >
                                        🔓 自动登录 chweb
                                    </button>
                                    <a
                                        href="/chweb/#/"
                                        target="_blank"
                                        className="flex-1 py-1.5 rounded-lg text-xs font-hand border border-prince-gold/20 text-prince-muted hover:bg-prince-gold/5 transition-all text-center"
                                    >
                                        🌐 打开 chweb
                                    </a>
                                </div>
                            )}
                        </div>

                        {broadcastError && (
                            <p className="text-red-400 text-xs font-body">{broadcastError}</p>
                        )}

                        {/* Active sessions list */}
                        {broadcastSessions.length > 0 && (
                            <div className="space-y-2 mt-3">
                                <h4 className="text-prince-muted text-xs font-body">活跃 Sessions ({broadcastSessions.length}/3)</h4>
                                {broadcastSessions.map(s => {
                                    const acctLabel = s.accountId && chAccounts[s.accountId] ? chAccounts[s.accountId].label : '小王子';
                                    const acctColor = s.accountId === 'prince' ? 'text-purple-300' : 'text-cyan-300';
                                    return (
                                    <div key={s.sessionId} className="p-2 rounded-lg bg-prince-deep/40 border border-prince-gold/10 space-y-1.5">
                                        <div className="flex items-center justify-between flex-wrap gap-1">
                                            <div className="text-xs font-body flex items-center gap-1.5 flex-wrap">
                                                <span className="text-prince-gold">#{s.shortId}</span>
                                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] border ${s.accountId === 'prince' ? 'border-purple-400/40 bg-purple-500/10 text-purple-300' : 'border-cyan-400/40 bg-cyan-500/10 text-cyan-300'}`}>
                                                    👤 {acctLabel}
                                                </span>
                                                {s.channel && <span className="text-blue-300" title={s.channel} style={{maxWidth: "100px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom"}}>📡 {s.channel}</span>}
                                            </div>
                                            <span className="text-prince-muted text-[10px]">{new Date(s.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                                        </div>
                                        <div className="flex gap-1 flex-wrap">
                                            <button
                                                onClick={() => window.open('/?session=' + s.sessionId, '_blank')}
                                                className="px-2 py-1 rounded-lg text-[11px] font-hand text-blue-300 border border-blue-500/30 hover:bg-blue-500/10 transition-all"
                                            >
                                                📱
                                            </button>
                                            <button
                                                onClick={() => handleBroadcastStop(s.sessionId)}
                                                className="px-2 py-1 rounded-lg text-[11px] font-hand text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-all"
                                            >
                                                🛑 停止
                                            </button>
                                            <button
                                                onClick={() => handleForceLeave(s.sessionId, s.channel, s.accountId)}
                                                className="px-2 py-1 rounded-lg text-[11px] font-hand text-orange-400 border border-orange-500/30 hover:bg-orange-500/10 transition-all"
                                                title="强制停止 keepalive + 离开房间 + 终止 session"
                                            >
                                                🔌 下线
                                            </button>
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                </div>
            </div>

            {/* Room Notification Banner */}
            {roomNotification && activeRooms.size === 0 && (
                <div className="bg-gradient-to-r from-prince-rose/20 to-prince-gold/20 backdrop-blur-sm rounded-2xl border border-prince-rose/30 p-4 animate-pulse">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="flex items-center gap-2">
                                <Bell className="w-4 h-4 text-prince-rose" />
                                <span className="font-hand text-prince-gold text-sm">🌟 检测到房间!</span>
                            </div>
                            <p className="text-prince-cream text-xs mt-1">{roomNotification.topic}</p>
                            {roomNotification.channel && (
                                <p className="text-prince-muted text-[10px] mt-0.5">ID: {roomNotification.channel}</p>
                            )}
                        </div>
                        <div className="flex gap-2">
                            {roomNotification.channel && (
                                <button onClick={() => { setRoomInput(roomNotification.channel); setRoomNotification(null); handleJoin(); }}
                                    className="px-3 py-1.5 rounded-lg bg-prince-gold text-prince-deep text-xs font-hand hover:bg-prince-gold/90 active:scale-95 transition-all">
                                    🎙️ 加入
                                </button>
                            )}
                            <button onClick={() => setRoomNotification(null)}
                                className="px-2 py-1.5 rounded-lg text-prince-muted text-xs hover:text-prince-cream transition-all">
                                ✕
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Manual Clubhouse Control - collapsible */}
            {activeRooms.size === 0 && (
                <div className="bg-prince-card/40 backdrop-blur-sm rounded-2xl border border-prince-gold/10">
                    <button
                        onClick={() => setShowManualControl(!showManualControl)}
                        className="w-full px-5 py-3 flex items-center justify-between text-sm font-hand text-prince-muted/60 hover:text-prince-muted transition-all"
                    >
                        <span>🎛️ 手动 Clubhouse 控制（旧版）</span>
                        <span className="text-xs">{showManualControl ? '▼' : '▶'}</span>
                    </button>
                    {showManualControl && (
                <div className="px-5 pb-5 space-y-4">
                    <div>
                        <label className="text-prince-gold/80 text-sm font-hand mb-2 block">🔗 房间链接或 ID</label>
                        <input type="text" value={roomInput}
                            onChange={(e) => setRoomInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                            placeholder="粘贴 Clubhouse 链接或房间 ID..."
                            className="w-full bg-prince-deep/60 border border-prince-gold/20 rounded-xl px-4 py-3 text-prince-cream text-sm font-body placeholder:text-prince-muted/50 focus:outline-none focus:border-prince-gold/50 focus:ring-1 focus:ring-prince-gold/30 transition-all"
                        />
                    </div>
                    <button onClick={handleJoin} disabled={isJoining || !roomInput.trim()}
                        className="w-full py-3 rounded-xl font-hand text-lg transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-prince-gold/90 to-prince-gold/70 text-prince-deep hover:from-prince-gold hover:to-prince-gold/80 hover:shadow-star active:scale-[0.98]">
                        <Mic className="w-5 h-5" />
                        {isJoining ? '正在加入...' : '🎙️ 加入房间 (API)'}
                    </button>
                    <a href="/chweb/" target="_blank" rel="noopener noreferrer"
                        className="w-full py-2.5 rounded-xl font-hand text-sm transition-all duration-300 flex items-center justify-center gap-2 border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 hover:border-blue-500/60 active:scale-[0.98]">
                        🌐 打开 Clubhouse-Web 加入外部房间
                    </a>
                    <div className="flex items-center gap-3">
                        <div className="flex-1 h-px bg-prince-gold/10" />
                        <span className="text-prince-muted text-xs font-body">或</span>
                        <div className="flex-1 h-px bg-prince-gold/10" />
                    </div>
                    <button onClick={handleCreate} disabled={isJoining}
                        className="w-full py-3 rounded-xl font-hand text-lg transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-40 border border-prince-rose/40 text-prince-rose hover:bg-prince-rose/10 hover:border-prince-rose/60 active:scale-[0.98]">
                        <Radio className="w-5 h-5" />
                        {isJoining ? '正在创建...' : '📡 创建新房间'}
                    </button>
                    {error && <div className="text-red-400 text-sm text-center font-body bg-red-400/10 rounded-lg px-3 py-2">{error}</div>}
                </div>
                    )}
                </div>
            )}

            {/* Room Status Cards — one per active room */}
            {activeRooms.size > 0 && (
                <div className="space-y-3">
                    {[...activeRooms.entries()].map(([sid, room]) => (
                        <div key={sid} className={`bg-prince-card/80 backdrop-blur-sm rounded-2xl border p-4 space-y-3 ${room.accountId === 'prince' ? 'border-purple-500/30' : 'border-prince-gold/20'}`}>
                            <div className="flex items-start justify-between">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse shadow-star" />
                                        <span className={`text-xs px-2 py-0.5 rounded-full font-body ${room.accountId === 'prince' ? 'bg-purple-500/20 text-purple-300' : 'bg-cyan-500/20 text-cyan-300'}`}>
                                            {room.accountLabel || room.accountId}
                                        </span>
                                        <span className="font-hand text-sm text-prince-gold truncate">{room.roomInfo?.topic || '直播中'}</span>
                                    </div>
                                    <p className="text-prince-muted text-[10px] mt-1 font-body truncate">
                                        {room.channel} · Agora: {room.agoraJoined ? '🟢' : '🔴'}
                                        {room.keepaliveActive && ' · 💓'}
                                        {room.isSpeaker ? ' · 🎙️' : ' · 👤'}
                                    </p>
                                </div>
                                <button onClick={() => handleLeaveRoom(sid)}
                                    className="p-1.5 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all ml-2 flex-shrink-0"
                                    title="离开房间">
                                    <PhoneOff className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="bg-prince-deep/40 rounded-lg p-2 text-center">
                                    <Users className="w-3 h-3 text-prince-gold mx-auto mb-0.5" />
                                    <span className="text-prince-cream text-sm font-hand block">{room.roomInfo?.users?.length ?? (room.adminUsersList?.length || 0)}</span>
                                    <span className="text-prince-muted text-[9px]">在房</span>
                                </div>
                                <div className="bg-prince-deep/40 rounded-lg p-2 text-center">
                                    <Clock className="w-3 h-3 text-prince-gold mx-auto mb-0.5" />
                                    <span className="text-prince-cream text-sm font-hand block">{formatTime(room.elapsedTime || 0)}</span>
                                    <span className="text-prince-muted text-[9px]">时长</span>
                                </div>
                                <div onClick={() => toggleMuteForRoom(sid)}
                                    className={`bg-prince-deep/40 rounded-lg p-2 text-center cursor-pointer transition-all active:scale-95 ${room.isMuted ? 'border border-red-500/30' : 'border border-green-500/30'}`}>
                                    {room.isMuted ? <MicOff className="w-3 h-3 text-red-400 mx-auto mb-0.5" /> : <Mic className="w-3 h-3 text-green-400 mx-auto mb-0.5" />}
                                    <span className="text-prince-cream text-sm font-hand block">{room.isMuted ? '🔇' : '🎙️'}</span>
                                    <span className={`text-[9px] ${room.isMuted ? 'text-red-400' : 'text-green-400'}`}>{room.isMuted ? '静音' : '开麦'}</span>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => toggleRoomAdminToolbar(sid)}
                                className="w-full py-1.5 rounded-lg text-[11px] font-hand border border-prince-gold/25 text-prince-gold/90 hover:bg-prince-gold/10 transition-all"
                            >
                                {room.adminToolbarOpen ? '▲ 收起房管工具' : '▼ 房管工具（拉人 / 踢人 / mod）'}
                            </button>
                            {room.adminToolbarOpen && (
                                <div className="rounded-lg border border-prince-gold/20 bg-prince-deep/50 p-2 space-y-2">
                                    <p className="text-[9px] text-prince-muted leading-snug">
                                        打开时拉取当前在房用户；操作使用该房的 Bot 账号（需为管理员，否则接口会失败）。
                                    </p>
                                    {room.adminLoading && <div className="text-[10px] text-prince-muted">加载成员列表…</div>}
                                    {room.adminError && <div className="text-[10px] text-red-400">{room.adminError}</div>}
                                    <select
                                        className="w-full bg-prince-deep border border-prince-gold/20 rounded-lg px-2 py-1.5 text-[11px] text-prince-cream"
                                        value={room.adminSelectedUserId === undefined || room.adminSelectedUserId === null ? '' : String(room.adminSelectedUserId)}
                                        onChange={(e) => updateRoom(sid, { adminSelectedUserId: e.target.value === '' ? '' : e.target.value })}
                                        disabled={!!room.adminLoading}
                                    >
                                        <option value="">选择用户…</option>
                                        {(room.adminUsersList || []).map((u) => (
                                            <option key={String(u.user_id)} value={String(u.user_id)}>
                                                {(u.name || '用户')} ({u.user_id}){u.is_speaker ? ' 🎙' : ''}{u.is_moderator ? ' 👑' : ''}
                                            </option>
                                        ))}
                                    </select>
                                    <div className="flex flex-wrap gap-1.5 justify-center">
                                        <button
                                            type="button"
                                            disabled={!!room.adminActionLoading || !!room.adminLoading}
                                            onClick={() => roomAdminAction(sid, 'block')}
                                            className="px-2 py-1 rounded-md text-[10px] bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-40"
                                        >
                                            移出
                                        </button>
                                        <button
                                            type="button"
                                            disabled={!!room.adminActionLoading || !!room.adminLoading}
                                            onClick={() => roomAdminAction(sid, 'invite')}
                                            className="px-2 py-1 rounded-md text-[10px] bg-emerald-500/20 text-emerald-200 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-40"
                                        >
                                            拉上台
                                        </button>
                                        <button
                                            type="button"
                                            disabled={!!room.adminActionLoading || !!room.adminLoading}
                                            onClick={() => roomAdminAction(sid, 'mod')}
                                            className="px-2 py-1 rounded-md text-[10px] bg-amber-500/15 text-amber-200 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-40"
                                        >
                                            设为 mod
                                        </button>
                                    </div>
                                </div>
                            )}
                            {room.roomInfo?.url && (
                                <button onClick={() => { navigator.clipboard.writeText(room.roomInfo.url); addLog('📋 房间链接已复制'); }}
                                    className="w-full py-1.5 rounded-lg text-xs font-body text-prince-muted border border-prince-gold/10 hover:border-prince-gold/30 hover:text-prince-gold transition-all flex items-center justify-center gap-1">
                                    <Link2 className="w-3 h-3" /> 复制链接
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Player iframe removed — use session Remote for control */}


            {/* Session Management Panel */}
            <div className="bg-prince-card/60 backdrop-blur-sm rounded-2xl border border-green-500/30 p-4">
                <div className="flex items-center justify-between mb-3">
                    <span className="font-hand text-sm text-green-400">📻 Sessions ({sessions.length}/3)</span>
                    <button
                        onClick={createNewSession}
                        disabled={sessionLoading || sessions.length >= 3}
                        className="px-3 py-1 bg-green-600/30 text-green-300 text-xs rounded-full
                            hover:bg-green-600/50 disabled:opacity-30 transition-all font-hand"
                    >
                        {sessionLoading ? '创建中...' : '+ 新建 Session'}
                    </button>
                </div>
                {sessions.length === 0 ? (
                    <div className="text-prince-muted/40 text-center py-3 text-xs">暂无活跃 session</div>
                ) : (
                    <div className="space-y-2">
                        {sessions.map(s => (
                            <div key={s.sessionId} className="flex items-center justify-between bg-black/20 rounded-lg px-3 py-2">
                                <div className="flex-1 min-w-0">
                                    <div className="text-xs text-green-300 font-mono">🔗 {s.shortId}</div>
                                    <div className="text-[10px] text-prince-muted truncate">
                                        PID: {s.chromePid} | Sink: {s.sinkName}
                                    </div>
                                </div>
                                <div className="flex gap-2 ml-2">
                                    <button
                                        onClick={() => window.open('/?session=' + s.sessionId, '_blank')}
                                        className="text-[10px] px-2 py-1 bg-blue-600/30 text-blue-300 rounded hover:bg-blue-600/50"
                                    >Remote</button>
                                    <button
                                        onClick={() => deleteSessionById(s.sessionId)}
                                        className="text-[10px] px-2 py-1 bg-red-600/30 text-red-300 rounded hover:bg-red-600/50"
                                    >删除</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* AutoKick Toggle */}
            <div className="bg-prince-card/60 backdrop-blur-sm rounded-2xl border border-orange-500/20 p-4">
                <div className="flex items-center justify-between">
                    <div>
                        <span className="font-hand text-sm text-orange-300">🚫 自动踢人</span>
                        <p className="text-prince-muted text-[10px] mt-0.5">
                            黑名单 · 关键词 · Web Listener
                        </p>
                    </div>
                    <button
                        onClick={toggleAutokick}
                        disabled={autokickLoading || autokickEnabled === null}
                        className={`relative inline-flex items-center w-12 h-6 rounded-full transition-all duration-300 focus:outline-none disabled:opacity-50
                            ${autokickEnabled ? 'bg-orange-500' : 'bg-prince-deep border border-prince-gold/20'}`}
                    >
                        <span className={`inline-block w-5 h-5 rounded-full shadow transition-transform duration-300
                            ${autokickEnabled ? 'translate-x-6 bg-white' : 'translate-x-0.5 bg-prince-muted'}`} />
                    </button>
                </div>
            </div>

            {/* Log Panel */}
            <div className="bg-prince-card/40 backdrop-blur-sm rounded-2xl border border-prince-gold/10 p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="font-hand text-sm text-prince-gold/70">📋 日志</span>
                    <button onClick={() => setLogs([])} className="text-[10px] text-prince-muted hover:text-prince-gold transition-all">清除</button>
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto scroll-allowed text-[11px] font-mono text-prince-muted/80">
                    {logs.length > 0 ? logs.map((log, i) => <div key={i}>{log}</div>) :
                        <div className="text-prince-muted/40 text-center py-2">等待操作...</div>}
                </div>
            </div>
        </div>
    );
}

export default Broadcast;
