import React, { useState, useEffect, useContext, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { SocketContext } from '../App';
import clsx from 'clsx';
import {
    Play, Pause, SkipBack, SkipForward, Repeat, Repeat1, List,
    Shuffle, Volume2, VolumeX, Download, Plus, Music2, Upload,
    Mic, ChevronDown, ChevronUp, Lock, Unlock
} from 'lucide-react';
import LyricViewer from '../components/LyricViewer';
import VoiceSlots from '../components/VoiceSlots';
import PlaylistModal from '../components/PlaylistModal';
import PartyQueue, { IdentityModal, WhitelistModal } from '../components/PartyQueue';
import axios from 'axios';

const formatTime = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
};

export default function Remote() {
    const socket = useContext(SocketContext);
    const [state, setState] = useState({
        playing: false, currentTrack: null, volume: 0, currentTime: 0,
        duration: 0, loopMode: 'list', gain: 1
    });
    const [data, setData] = useState({ playlists: [], songs: [] });
    const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
    const [userBrowsing, setUserBrowsing] = useState(false);
    const browseTimerRef = useRef(null);

    // UI States
    const [showDownloader, setShowDownloader] = useState(false);
    const [downloadUrl, setDownloadUrl] = useState('');
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(null);
    const [parsedSongs, setParsedSongs] = useState([]);
    const [uploadingLocal, setUploadingLocal] = useState(false);
    const uploadInputRef = useRef(null);
    const [showPlaylistModal, setShowPlaylistModal] = useState(false);
    const [urlToAdd, setUrlToAdd] = useState(null);
    const [showCookieInput, setShowCookieInput] = useState(false);
    const [cookieContent, setCookieContent] = useState('');
    const [showLyrics, setShowLyrics] = useState(false);
    const [showVoiceDrawer, setShowVoiceDrawer] = useState(false);
    const [voiceEnabled, setVoiceEnabled] = useState(false);
    const [showVoicePwd, setShowVoicePwd] = useState(false);
    const [voicePwd, setVoicePwd] = useState('');

    // Sleep Lock (server-side global)
    const [isLocked, setIsLocked] = useState(false);

    // Voice Chat toggle: requires Player password, synced via socket
    const handleVoiceToggle = () => {
        if (voiceEnabled) {
            socket && socket.emit('set_voice_enabled', false);
            setShowVoiceDrawer(false);
            return;
        }
        setVoicePwd('');
        setShowVoicePwd(true);
    };
    const submitVoicePwd = async () => {
        if (!voicePwd) return;
        try {
            const bp = window.location.pathname.replace(/\/$/, '');
            const res = await fetch(bp + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: voicePwd, type: 'player' })
            });
            if (res.ok) {
                socket && socket.emit('set_voice_enabled', true);
                setShowVoicePwd(false);
                setVoicePwd('');
            } else {
                alert('密码错误');
            }
        } catch (e) {
            alert('验证失败');
        }
    };

    // Listen for voice_enabled changes from server
    useEffect(() => {
        if (!socket) return;
        const onVoiceEnabled = (enabled) => {
            setVoiceEnabled(enabled);
            if (!enabled) setShowVoiceDrawer(false);
        };
        socket.on('voice_enabled', onVoiceEnabled);
        return () => socket.off('voice_enabled', onVoiceEnabled);
    }, [socket]);
    const [showUnlockModal, setShowUnlockModal] = useState(false);
    const [unlockPassword, setUnlockPassword] = useState('');
    const [unlockError, setUnlockError] = useState('');
    const [unlockLoading, setUnlockLoading] = useState(false);
    // Party Mode
    const [partyState, setPartyState] = useState({ enabled: false, queue: [], currentItem: null });
    const [partyUser, setPartyUser] = useState(() => {
        try { return JSON.parse(localStorage.getItem('partyUser')); } catch { return null; }
    });
    const [showIdentity, setShowIdentity] = useState(false);
    const [showWhitelist, setShowWhitelist] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);
    const [showAdminAuth, setShowAdminAuth] = useState(null); // null | 'whitelist' | 'party_on' | 'party_off'
    const [adminPassword, setAdminPassword] = useState('');
    const [adminError, setAdminError] = useState('');
    const [roomUsers, setRoomUsers] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [partyError, setPartyError] = useState('');
    const [showPartyToggle, setShowPartyToggle] = useState(false);
    const [partyPassword, setPartyPassword] = useState('');
    const [partyToggleLoading, setPartyToggleLoading] = useState(false);



    // === Party Mode Handlers ===
    const handleShowIdentity = async () => {
        setLoadingUsers(true);
        setShowIdentity(true);
        try {
            const basePath = window.location.pathname.replace(/\/$/, '');
            const res = await axios.get(basePath + '/api/party/room-users');
            setRoomUsers(res.data.users || []);
        } catch (e) {
            setRoomUsers([]);
        }
        setLoadingUsers(false);
    };

    const handleSelectIdentity = (user) => {
        if (!socket) return;
        socket.emit('party_join', {
            userId: String(user.user_id),
            nickname: user.name,
            photoUrl: user.photo_url || ''
        }, (res) => {
            if (res?.error) {
                setPartyError(res.error);
                setTimeout(() => setPartyError(''), 3000);
                return;
            }
            setPartyUser(user);
            localStorage.setItem('partyUser', JSON.stringify(user));
            setShowIdentity(false);
        });
    };


    // === 播放列表自动定位 ===
    const currentPlayingPlaylistId = useMemo(() => {
        if (!state.currentTrack?.id) return null;
        const song = data.songs.find(s => s.id === state.currentTrack.id);
        return song?.playlistId || null;
    }, [state.currentTrack?.id, data.songs]);

    useEffect(() => {
        if (currentPlayingPlaylistId && !userBrowsing) {
            setSelectedPlaylistId(currentPlayingPlaylistId);
        }
    }, [currentPlayingPlaylistId]);

    useEffect(() => {
        return () => { clearTimeout(browseTimerRef.current); };
    }, []);

    const handlePlaylistClick = (playlistId) => {
        setSelectedPlaylistId(playlistId);
        clearTimeout(browseTimerRef.current);
        if (playlistId !== currentPlayingPlaylistId && currentPlayingPlaylistId) {
            setUserBrowsing(true);
            browseTimerRef.current = setTimeout(() => {
                setSelectedPlaylistId(currentPlayingPlaylistId);
                setUserBrowsing(false);
            }, 30000);
        } else {
            setUserBrowsing(false);
        }
    };

    const handlePartySongClick = (song) => {
        if (partyState.enabled && partyUser) {
            // Direct add to queue (no confirm dialog)
            if (!socket) return;
            socket.emit('party_add', { song }, (res) => {
                if (res?.error) {
                    setPartyError(res.error);
                    setTimeout(() => setPartyError(''), 3000);
                } else {
                    setPartyError('✅ ' + (song.title?.slice(0, 20) || '歌曲') + ' 已加入队列');
                    setTimeout(() => setPartyError(''), 2000);
                }
            });
        } else if (partyState.enabled && !partyUser) {
            handleShowIdentity();
        } else {
            handleAction('load', song);
        }
    };

    // Party toggle: requires admin password
    const handlePartyToggle = async () => {
        if (partyState.enabled) {
            // Trying to disable -> need password
            setShowPartyToggle(true);
            setPartyPassword('');
        } else {
            // Trying to enable -> also need password
            setShowPartyToggle(true);
            setPartyPassword('');
        }
    };

    const handlePartyToggleSubmit = async () => {
        if (!partyPassword) return;
        setPartyToggleLoading(true);
        try {
            const basePath = window.location.pathname.replace(/\/$/, '');
            // Step 1: verify password via same auth as Player
            const authRes = await fetch(basePath + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: partyPassword, type: 'player' })
            });
            if (!authRes.ok) {
                const err = await authRes.json();
                setPartyError(err.error || '密码错误');
                setTimeout(() => setPartyError(''), 3000);
                setPartyToggleLoading(false);
                return;
            }
            const { token } = await authRes.json();
            // Step 2: toggle party mode with token
            const res = await fetch(basePath + '/api/party/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
                body: JSON.stringify({ enabled: !partyState.enabled })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setShowPartyToggle(false);
                setPartyError(partyState.enabled ? '🔒 Party 已关闭' : '🎉 Party 已开启');
                setTimeout(() => setPartyError(''), 2000);
            } else {
                setPartyError(data.error || '操作失败');
                setTimeout(() => setPartyError(''), 3000);
            }
        } catch {
            setPartyError('连接失败');
            setTimeout(() => setPartyError(''), 3000);
        }
        setPartyToggleLoading(false);
    };

    const handleLockToggle = () => {
        if (isLocked) {
            setShowUnlockModal(true);
            setUnlockPassword('');
            setUnlockError('');
        } else {
            socket && socket.emit('set_sleep_lock');
        }
    };

    const handleUnlock = async () => {
        if (!unlockPassword) return;
        setUnlockLoading(true);
        setUnlockError('');
        try {
            const res = await fetch((window.location.pathname.replace(/\/$/, '')) + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: unlockPassword, type: 'sleep' })
            });
            if (res.ok) {
                socket && socket.emit('sleep_unlock');
                setShowUnlockModal(false);
            } else if (res.status === 429) {
                setUnlockError('⏳ 尝试次数过多，请稍后再试');
            } else {
                setUnlockError('🌹 密码不对哦');
            }
        } catch {
            setUnlockError('连接失败...');
        } finally {
            setUnlockLoading(false);
        }
    };

    // Seek
    const [isSeeking, setIsSeeking] = useState(false);
    const [seekValue, setSeekValue] = useState(0);

    useEffect(() => {
        if (!socket) return;
        socket.on('state_update', (newState) => setState(prev => ({ ...prev, ...newState })));
        socket.on('data_update', setData);
        socket.on('download_progress', setDownloadProgress);
        socket.on('download_complete', () => { setDownloading(false); setDownloadProgress(null); });
        socket.on('download_error', () => { setDownloading(false); setDownloadProgress(null); });
        socket.on('sleep_lock_update', setIsLocked);
        socket.emit('get_data');

        // Party mode listeners
        socket.on('party_update', (data) => setPartyState(data));
        socket.on('party_error', (msg) => {
            setPartyError(msg);
            setTimeout(() => setPartyError(''), 3000);
        });
        socket.emit('get_party_state');

        // Auto-join party if user was previously registered
        if (partyUser) {
            socket.emit('party_join', {
                userId: String(partyUser.user_id),
                nickname: partyUser.name,
                photoUrl: partyUser.photo_url || ''
            }, (res) => {
                if (res?.error) {
                    // Identity rejected (impersonation), clear localStorage
                    localStorage.removeItem('partyUser');
                    setPartyUser(null);
                }
            });
        }

        return () => {
            socket.off('state_update');
            socket.off('data_update');
            socket.off('download_progress');
            socket.off('download_complete');
            socket.off('download_error');
            socket.off('sleep_lock_update');
        };
    }, [socket]);

    const handleAction = (type, payload) => {
        socket && socket.emit('player_action', { type, payload });
    };

    const toggleLoop = () => {
        const modes = ['list', 'single', 'order'];
        const next = modes[(modes.indexOf(state.loopMode) + 1) % modes.length];
        handleAction('loop', next);
    };

    const handleSeekStart = () => { setIsSeeking(true); setSeekValue(state.currentTime); };
    const handleSeekChange = (e) => setSeekValue(parseFloat(e.target.value));
    const handleSeekEnd = () => { handleAction('seek', seekValue); setIsSeeking(false); };

    const currentDisplayTime = isSeeking ? seekValue : state.currentTime;
    const duration = state.duration || 1;
    const progressPercent = Math.min(100, Math.max(0, (currentDisplayTime / duration) * 100));

    // Downloads
    const handleDownload = async (type) => {
        if (!downloadUrl) return;
        setDownloading(true);
        try {
            const res = await fetch((window.location.pathname.replace(/\/$/, '')) + '/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: downloadUrl, type })
            });
            const d = await res.json();
            if (type === 'parse' && d.entries) {
                setParsedSongs(d.entries.map(e => ({ title: e.title || e.id, url: e.url })));
                setDownloading(false);
            }
        } catch (e) { setDownloading(false); }
    };

    const openAddToForUrl = (song) => {
        setUrlToAdd(song);
        setShowPlaylistModal(true);
    };

    const handleAddToPlaylist = async (playlistId) => {
        setShowPlaylistModal(false);
        const songToAdd = urlToAdd || { url: downloadUrl };
        if (!songToAdd.url) return;
        setDownloading(true);
        try {
            await fetch((window.location.pathname.replace(/\/$/, '')) + '/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: songToAdd.url, type: 'download',
                    playlistId, title: songToAdd.title
                })
            });
        } catch (e) { console.error(e); }
        setUrlToAdd(null);
    };

    const handleCreatePlaylist = () => {
        const name = prompt('🌟 新播放列表名称:');
        if (name) socket.emit('create_playlist', name);
    };

    const handleSaveCookies = async () => {
        if (!cookieContent) return;
        try {
            const token = sessionStorage.getItem('auth_player');
            await fetch((window.location.pathname.replace(/\/$/, '')) + '/api/cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': token || '' },
                body: JSON.stringify({ content: cookieContent })
            });
            setCookieContent('');
            setShowCookieInput(false);
            alert('🍪 Cookies 已保存!');
        } catch (e) { alert('保存失败'); }
    };

    const handleLocalTrackUpload = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!selectedPlaylistId) {
            alert('请先选择一个播放列表（下方横向列表）');
            return;
        }
        const token = sessionStorage.getItem('auth_player');
        if (!token) {
            alert('需要 Player 登录：请点击 🎵 Player 输入密码后再试');
            return;
        }
        setUploadingLocal(true);
        try {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('playlistId', selectedPlaylistId);
            const base = (window.location.pathname.replace(/\/$/, '')) || '';
            const res = await fetch(base + '/api/upload/track', {
                method: 'POST',
                headers: { 'x-auth-token': token },
                body: fd
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || '上传失败');
        } catch (err) {
            alert(err.message || '上传失败');
        } finally {
            setUploadingLocal(false);
        }
    };

    return (
        <div className="flex flex-col h-full overflow-x-hidden overflow-y-auto scroll-allowed relative">
            {/* All content scrollable */}
            <div className="flex flex-col gap-3 p-4 pb-0 relative z-10">

                {/* Track Title + Sleep Lock */}
                <div className="text-center mb-1 relative">
                    <button
                        onClick={() => !isLocked && state.currentTrack && setShowLyrics(true)}
                        className={clsx(
                            "font-hand text-xl text-prince-cream truncate px-4 max-w-full transition-all active:scale-95 inline-block",
                            isLocked ? "cursor-default opacity-50" :
                                state.currentTrack ? "cursor-pointer hover:text-prince-gold" : "cursor-default"
                        )}
                    >
                        {state.currentTrack?.title || "🌹 等待播放..."}
                    </button>
                    {state.currentTrack && !isLocked && (
                        <div className="text-[10px] text-prince-rose/60 uppercase tracking-widest mt-0.5 animate-pulse font-hand">
                            ✨ 点击查看歌词
                        </div>
                    )}
                    {/* Sleep Lock Button */}
                    <button
                        onClick={handleLockToggle}
                        className={clsx(
                            "absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2.5 py-1.5 rounded-full border transition-all active:scale-90 font-hand text-xs",
                            isLocked
                                ? "bg-prince-gold/20 border-prince-gold/40 text-prince-gold shadow-star"
                                : "bg-prince-card/40 border-prince-gold/10 text-prince-muted hover:text-prince-cream hover:border-prince-gold/30"
                        )}
                        title={isLocked ? "点击解锁" : "点击锁定"}
                    >
                        <span className="text-sm">🌙</span>
                        {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                </div>

                {/* Controls Panel */}
                <div className={clsx("glass-panel p-3 flex flex-col gap-2 transition-all duration-300", isLocked && "opacity-30 pointer-events-none")}>

                    {/* Progress */}
                    <div className="w-full flex flex-col gap-1">
                        <div className="relative w-full h-4 flex items-center group">
                            <div className="absolute left-0 right-0 h-1 bg-prince-night rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-prince-rose to-prince-gold transition-all duration-300"
                                    style={{ width: `${progressPercent}%` }}
                                />
                            </div>
                            <input
                                type="range"
                                min="0" max={duration} step="0.1"
                                value={currentDisplayTime}
                                onMouseDown={handleSeekStart}
                                onTouchStart={handleSeekStart}
                                onChange={handleSeekChange}
                                onMouseUp={handleSeekEnd}
                                onTouchEnd={handleSeekEnd}
                                className="absolute w-full h-4 opacity-0 cursor-pointer z-10"
                            />
                            <div
                                className="absolute w-3 h-3 bg-prince-gold rounded-full shadow-star pointer-events-none transition-all duration-300 group-hover:scale-125"
                                style={{ left: `clamp(6px, calc(${progressPercent}% - 6px), calc(100% - 6px))` }}
                            />
                        </div>
                        <div className="flex justify-between text-xs text-prince-muted font-mono">
                            <span>{formatTime(currentDisplayTime)}</span>
                            <span>{formatTime(duration)}</span>
                        </div>
                    </div>

                    {/* Playback Buttons */}
                    <div className="flex justify-between items-center px-2">
                        <button className="text-prince-muted hover:text-prince-gold transition-colors" onClick={toggleLoop}>
                            {state.loopMode === 'single' ? <Repeat1 size={20} className="text-prince-gold" /> :
                                state.loopMode === 'order' ? <List size={20} className="text-blue-400" /> :
                                    <Repeat size={20} className={state.loopMode === 'list' ? "text-prince-gold" : ""} />}
                        </button>
                        <div className="flex items-center gap-6">
                            <button onClick={() => handleAction('prev')} className="text-prince-cream hover:text-prince-gold transition-colors">
                                <SkipBack size={24} />
                            </button>
                            <button
                                onClick={() => handleAction(state.playing ? 'pause' : 'play')}
                                className="w-12 h-12 rounded-full bg-gradient-to-br from-prince-gold to-prince-rose text-prince-deep flex items-center justify-center hover:scale-105 transition-transform shadow-star"
                            >
                                {state.playing ? <Pause fill="#0A0F2E" size={20} /> : <Play fill="#0A0F2E" size={20} className="ml-0.5" />}
                            </button>
                            <button onClick={() => handleAction('next')} className="text-prince-cream hover:text-prince-gold transition-colors">
                                <SkipForward size={24} />
                            </button>
                        </div>
                        <button className={`transition-colors ${state.loopMode === 'shuffle' ? 'text-green-400' : 'text-prince-muted hover:text-prince-gold'}`} onClick={() => handleAction('loop', state.loopMode === 'shuffle' ? 'list' : 'shuffle')}><Shuffle size={20} /></button>
                    </div>

                    {/* Volume + Gain */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); handleAction('volume', state.volume === 0 ? 1 : 0); }}
                            className="text-prince-muted hover:text-prince-cream shrink-0"
                        >
                            {state.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                        </button>
                        <div className="flex-1 relative h-6 flex items-center">
                            <input
                                type="range" min="0" max="1" step="0.01"
                                value={state.volume}
                                onInput={(e) => { e.stopPropagation(); handleAction('volume', parseFloat(e.target.value)); }}
                                className="prince-slider w-full" style={{ touchAction: "auto" }}
                            />
                        </div>
                        <div className="w-px h-4 bg-prince-gold/10 shrink-0" />
                        <div className={clsx("text-[9px] font-bold transition-colors shrink-0",
                            state.gain > 1.0 ? "text-prince-rose" : "text-prince-muted/50")}>
                            BOOST
                        </div>
                        <div className="w-16 relative h-6 flex items-center shrink-0">
                            <input
                                type="range" min="1" max="10" step="0.1"
                                value={state.gain || 1}
                                onInput={(e) => { e.stopPropagation(); handleAction('gain', parseFloat(e.target.value)); }}
                                className="prince-slider w-full" style={{ touchAction: "auto" }}
                            />
                        </div>
                        <span className="text-[9px] text-prince-muted font-mono shrink-0">x{state.gain || 1}</span>
                    </div>
                </div>

                {/* Downloader Toggle */}
                <button
                    onClick={() => setShowDownloader(!showDownloader)}
                    className="w-full btn-prince flex justify-center items-center gap-2 py-1.5 text-xs font-hand text-base"
                >
                    <Download size={14} /> 从星空中采集音乐 ✨
                </button>

                <input
                    ref={uploadInputRef}
                    type="file"
                    accept=".mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,audio/*"
                    className="hidden"
                    onChange={handleLocalTrackUpload}
                />
                <button
                    type="button"
                    disabled={uploadingLocal}
                    onClick={() => {
                        if (!selectedPlaylistId) {
                            alert('请先选择一个播放列表（下方横向列表）');
                            return;
                        }
                        uploadInputRef.current?.click();
                    }}
                    className="w-full btn-prince flex justify-center items-center gap-2 py-1.5 text-xs font-hand border border-prince-gold/20 opacity-100"
                >
                    <Upload size={14} /> {uploadingLocal ? '上传中…' : '本地上传到当前播放列表 📂'}
                </button>

                {/* Downloader Area */}
                {showDownloader && (
                    <div className="glass-panel p-3 space-y-2 animate-in text-xs">
                        <div className="flex gap-2">
                            <input
                                className="input-prince"
                                placeholder="🔗 YouTube URL..."
                                value={downloadUrl}
                                onChange={e => setDownloadUrl(e.target.value)}
                            />
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => handleDownload('parse')} disabled={downloading}
                                className="flex-1 btn-prince text-xs">
                                {downloading ? '解析中...' : '🔍 解析 URL / 播放列表'}
                            </button>
                        </div>
                        {downloadProgress && (
                            <div className="w-full bg-prince-night h-1.5 rounded-full overflow-hidden">
                                <div className="bg-gradient-to-r from-prince-rose to-prince-gold h-full transition-all duration-300"
                                    style={{ width: `${downloadProgress.progress}%` }} />
                            </div>
                        )}
                        {parsedSongs.length > 0 && (
                            <div className="max-h-48 overflow-y-auto scroll-allowed space-y-1 border-t border-prince-gold/10 pt-1">
                                {parsedSongs.map((s, i) => (
                                    <div key={i} className="flex justify-between items-center p-1.5 hover:bg-prince-gold/5 rounded">
                                        <span className="truncate flex-1 text-prince-cream">{s.title}</span>
                                        <button onClick={() => openAddToForUrl({ title: s.title, url: s.url })}
                                            className="p-1 text-prince-gold shrink-0 ml-2"><Plus size={14} /></button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <button onClick={() => { setUrlToAdd(null); setShowPlaylistModal(true); }}
                                className="flex-1 btn-prince flex justify-between items-center text-xs">
                                添加到播放列表... <Plus size={12} />
                            </button>
                            <button onClick={handleCreatePlaylist} className="btn-prince px-2" title="New Playlist">
                                <Plus size={14} />
                            </button>
                        </div>

                        <div className="pt-1 border-t border-prince-gold/5">
                            <button
                                onClick={() => setShowCookieInput(!showCookieInput)}
                                className="w-full text-[10px] text-prince-muted/50 hover:text-prince-cream transition-colors flex justify-center items-center gap-1 py-1"
                            >
                                <List size={10} /> 🍪 Cookie Manager
                            </button>
                            {showCookieInput && (
                                <div className="mt-2 space-y-2 animate-in">
                                    <textarea
                                        className="w-full h-24 bg-prince-deep/80 border border-prince-gold/10 rounded-lg p-2 font-mono text-[10px] text-prince-cream focus:border-prince-gold outline-none scroll-allowed"
                                        placeholder="Paste Netscape cookie format..."
                                        value={cookieContent}
                                        onChange={e => setCookieContent(e.target.value)}
                                    />
                                    <button onClick={handleSaveCookies}
                                        className="w-full btn-rose py-1.5 text-xs">
                                        保存 Cookies
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Playlists */}
            <div className="px-4 pt-3 relative z-10">
                <h3 className="text-xs font-hand text-prince-gold uppercase tracking-wider mb-2">🪐 播放列表</h3>
                <div className="flex gap-2 overflow-x-auto no-scrollbar snap-x pb-2 scroll-allowed">
                    {data.playlists.map(p => (
                        <button
                            key={p.id}
                            onClick={() => handlePlaylistClick(p.id)}
                            className={clsx(
                                "snap-center shrink-0 px-4 h-10 rounded-xl flex items-center justify-center text-xs font-medium border transition-all font-hand",
                                selectedPlaylistId === p.id
                                    ? "bg-prince-gold/20 text-prince-gold border-prince-gold/40 scale-105 shadow-star"
                                    : "bg-prince-card/50 border-prince-gold/10 hover:bg-prince-gold/10 text-prince-cream/70"
                            )}
                        >
                            {p.name}{currentPlayingPlaylistId === p.id && selectedPlaylistId !== p.id && <span className="ml-1 text-yellow-400 animate-pulse">♫</span>}
                        </button>
                    ))}
                </div>
            </div>

            {/* Songs */}
            <div className="px-4 pt-2 pb-16 relative z-10">
                <h3 className="text-xs font-hand text-prince-gold uppercase tracking-wider py-1">🎵 曲目</h3>
                <div className="glass-panel flex flex-col">
                {/* Party Queue Panel */}
                <PartyQueue
                    partyState={partyState}
                    partyUser={partyUser}
                />

                {/* Party Toast */}
                {partyError && (
                    <div className={
                        "fixed top-14 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full shadow-lg text-xs font-medium " +
                        (partyError.startsWith('✅')
                            ? "bg-green-500/20 border border-green-500/30 text-green-400"
                            : "bg-red-500/20 border border-red-500/30 text-red-400")
                    }>
                        {partyError}
                    </div>
                )}



                {data.songs
                        .filter(s => s.playlistId === selectedPlaylistId)
                        .map(s => (
                            <button
                                key={s.id}
                                onClick={() => !isLocked && handlePartySongClick(s)}
                                className={clsx(
                                    "w-full text-left p-2.5 text-sm border-b border-prince-gold/5 last:border-0 flex items-center gap-2 transition-colors",
                                    isLocked ? "opacity-40 cursor-default" :
                                        state.currentTrack?.id === s.id ? "text-prince-gold bg-prince-gold/10" : "text-prince-cream/70 active:bg-prince-gold/10"
                                )}
                            >
                                <Music2 size={14} className="shrink-0 text-prince-rose/50" />
                                <span className="truncate">{s.title || s.url}</span>
                                {state.currentTrack?.id === s.id && (
                                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-prince-gold animate-pulse shadow-star" />
                                )}
                            </button>
                        ))
                    }
                    {(!selectedPlaylistId || data.songs.filter(s => s.playlistId === selectedPlaylistId).length === 0) && (
                        <div className="flex items-center justify-center text-prince-muted text-xs p-6 font-hand">
                            {selectedPlaylistId ? "🌌 这个星球还没有音乐" : "👆 请选择一个播放列表"}
                        </div>
                    )}
                </div>
            </div>

            {/* Voice Drawer */}
            <div className={clsx(
                "fixed bottom-0 left-0 right-0 z-50 flex flex-col items-center transition-all duration-300",
                showVoiceDrawer ? 'translate-y-0' : 'translate-y-[calc(100%-40px)]',
                isLocked && "opacity-30 pointer-events-none"
            )}>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => voiceEnabled && setShowVoiceDrawer(!showVoiceDrawer)}
                        className={`bg-gradient-to-r from-prince-rose to-prince-gold text-prince-deep px-5 py-2 rounded-tl-xl shadow-lg flex items-center gap-1 transition-all font-hand ${!voiceEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                        <span className={`text-lg ${voiceEnabled ? 'animate-pulse' : ''}`}>🎙️</span>
                        {showVoiceDrawer ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    </button>
                    <button
                        onClick={handleVoiceToggle}
                        className={`px-4 py-2 rounded-tr-xl shadow-lg text-xs font-bold font-hand transition-all ${voiceEnabled ? 'bg-green-500 text-white' : 'bg-gradient-to-r from-prince-rose/60 to-prince-gold/60 text-prince-deep'}`}
                    >
                        {voiceEnabled ? '🔊 ON' : '🔇 OFF'}
                    </button>
                </div>
                <div className="w-full bg-prince-deep/95 backdrop-blur-xl border-t border-prince-gold/10 pb-4 pt-2 px-2 shadow-2xl h-64">
                    <VoiceSlots onSlotAction={() => setShowVoiceDrawer(false)} />
                </div>
            </div>

            {/* Modals */}
            {/* Voice Password Modal */}
            {showVoicePwd && (
                <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center" onClick={() => setShowVoicePwd(false)}>
                    <div className="bg-prince-deep/95 border border-prince-gold/20 rounded-2xl p-6 w-72 shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-prince-cream text-center font-bold mb-4 font-hand">🔐 输入密码</h3>
                        <input
                            type="password"
                            value={voicePwd}
                            onChange={e => setVoicePwd(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && submitVoicePwd()}
                            autoFocus
                            className="w-full bg-prince-card text-prince-cream px-4 py-3 rounded-xl border border-prince-gold/20 focus:border-prince-gold/50 outline-none text-center text-lg tracking-widest mb-4"
                            placeholder="••••••"
                        />
                        <div className="flex gap-3">
                            <button onClick={() => setShowVoicePwd(false)} className="flex-1 py-3 rounded-xl bg-prince-card/50 text-prince-muted font-bold font-hand">取消</button>
                            <button onClick={submitVoicePwd} className="flex-1 py-3 rounded-xl bg-gradient-to-r from-prince-rose to-prince-gold text-prince-deep font-bold font-hand">确认</button>
                        </div>
                    </div>
                </div>
            )}

            {showPlaylistModal && (
                <PlaylistModal
                    playlists={data.playlists}
                    onSelect={handleAddToPlaylist}
                    onClose={() => setShowPlaylistModal(false)}
                />
            )}
            {showLyrics && ReactDOM.createPortal(
                <LyricViewer
                    song={state.currentTrack}
                    currentTime={state.currentTime}
                    onClose={() => setShowLyrics(false)}
                />,
                document.body
            )}

            {/* Sleep Lock Unlock Modal */}
            {showUnlockModal && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] backdrop-blur-sm animate-in">
                    <div className="glass-panel p-6 rounded-2xl w-80 max-w-[90vw] text-center">
                        <div className="text-4xl mb-3 animate-float">🌙</div>
                        <h3 className="font-hand text-xl text-prince-gold mb-1">解除睡眠锁</h3>
                        <p className="text-prince-muted text-xs mb-4">
                            "只有用心才能看清，本质的东西用眼睛是看不到的"
                        </p>
                        <input
                            type="password"
                            className="input-prince mb-3 text-center"
                            value={unlockPassword}
                            onChange={e => setUnlockPassword(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                            placeholder="输入唤醒密码..."
                            autoFocus
                        />
                        {unlockError && (
                            <p className="text-prince-rose text-xs mb-3 animate-in">{unlockError}</p>
                        )}
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowUnlockModal(false)}
                                className="flex-1 py-2 text-xs text-prince-muted hover:text-prince-cream rounded-lg transition-colors"
                            >
                                返回
                            </button>
                            <button
                                onClick={handleUnlock}
                                disabled={unlockLoading}
                                className="flex-1 py-2 text-xs btn-rose font-bold rounded-lg"
                            >
                                {unlockLoading ? '验证中...' : '✨ 唤醒'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* Party Toggle Password Modal */}
            {showPartyToggle && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowPartyToggle(false)}>
                    <div className="bg-prince-dark/95 border border-prince-gold/30 rounded-2xl p-6 w-full max-w-xs shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-prince-cream font-bold text-center mb-1">
                            {partyState.enabled ? '🔒 关闭 Party 模式' : '🎉 开启 Party 模式'}
                        </h3>
                        <p className="text-prince-muted text-xs text-center mb-4">需要管理员密码</p>
                        <input
                            type="password"
                            value={partyPassword}
                            onChange={e => setPartyPassword(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handlePartyToggleSubmit()}
                            placeholder="输入密码"
                            className="w-full px-3 py-2 rounded-lg bg-white border border-prince-gold/20 text-black text-sm focus:border-prince-gold/50 outline-none mb-3"
                            autoFocus
                        />
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowPartyToggle(false)}
                                className="flex-1 py-2 rounded-lg bg-prince-gold/10 text-prince-muted text-xs"
                            >取消</button>
                            <button
                                onClick={handlePartyToggleSubmit}
                                disabled={partyToggleLoading}
                                className="flex-1 py-2 rounded-lg bg-prince-gold/80 text-prince-dark text-xs font-bold"
                            >{partyToggleLoading ? '验证中...' : '确认'}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Party Identity Modal */}
            {showIdentity && (
                <IdentityModal 
                    onSelect={handleSelectIdentity}
                    onClose={() => setShowIdentity(false)}
                    roomUsers={roomUsers}
                    loading={loadingUsers}
                />
            )}

            {/* Whitelist Modal */}
            {showWhitelist && (
                <WhitelistModal onClose={() => setShowWhitelist(false)} />
            )}

            {/* Admin Auth Modal (for whitelist access) */}
            {showAdminAuth && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowAdminAuth(null)}>
                    <div className="bg-prince-dark/95 border border-prince-gold/30 rounded-2xl p-6 w-full max-w-xs shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-prince-cream font-bold text-sm mb-3">🔑 输入密码</h3>
                        <input
                            type="password"
                            value={adminPassword}
                            onChange={e => setAdminPassword(e.target.value)}
                            onKeyDown={async e => {
                                if (e.key === 'Enter') {
                                    const basePath = window.location.pathname.replace(/\/$/, '');
                                    try {
                                        const res = await fetch(basePath + '/api/auth/login', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ password: adminPassword, type: 'player' })
                                        });
                                        if (res.ok) {
                                            setIsAdmin(true);
                                            const action = showAdminAuth;
                                            setShowAdminAuth(null);
                                            if (action === 'whitelist') setShowWhitelist(true);
                                        } else {
                                            setAdminError('密码错误');
                                        }
                                    } catch (_) { setAdminError('验证失败'); }
                                }
                            }}
                            placeholder="输入密码"
                            className="w-full bg-white border border-prince-gold/30 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-prince-gold/60"
                            autoFocus
                        />
                        {adminError && <p className="text-prince-rose text-xs mt-2">{adminError}</p>}
                        <div className="flex gap-2 mt-3">
                            <button
                                onClick={() => setShowAdminAuth(null)}
                                className="flex-1 text-xs py-1.5 rounded-lg bg-prince-gold/10 text-prince-muted hover:text-prince-cream transition-colors"
                            >取消</button>
                            <button
                                onClick={async () => {
                                    const basePath = window.location.pathname.replace(/\/$/, '');
                                    try {
                                        const res = await fetch(basePath + '/api/auth/login', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ password: adminPassword, type: 'player' })
                                        });
                                        if (res.ok) {
                                            setIsAdmin(true);
                                            const action = showAdminAuth;
                                            setShowAdminAuth(null);
                                            if (action === 'whitelist') setShowWhitelist(true);
                                        } else {
                                            setAdminError('密码错误');
                                        }
                                    } catch (_) { setAdminError('验证失败'); }
                                }}
                                className="flex-1 text-xs py-1.5 rounded-lg bg-prince-gold/20 text-prince-gold font-bold hover:bg-prince-gold/30 transition-colors"
                            >确认</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Party Toggle + Identity Button */}
            <div className="fixed bottom-20 right-4 z-40 flex items-center gap-2">
                {/* Whitelist */}
                <button
                    onClick={() => {
                        if (isAdmin) { setShowWhitelist(true); }
                        else { setShowAdminAuth('whitelist'); setAdminPassword(''); setAdminError(''); }
                    }}
                    className="flex items-center gap-1 px-2.5 py-2 rounded-full shadow-lg bg-prince-dark/80 border border-prince-gold/20 text-prince-muted hover:text-prince-gold transition-colors"
                    title="管理上台白名单"
                >
                    <span className="text-xs">白</span>
                </button>
                {/* Admin toggle */}
                <button
                    onClick={handlePartyToggle}
                    className="flex items-center gap-1 px-2.5 py-2 rounded-full shadow-lg bg-prince-dark/80 border border-prince-gold/20 text-prince-muted hover:text-prince-gold transition-colors"
                    title={partyState.enabled ? '关闭 Party 模式' : '开启 Party 模式'}
                >
                    <span className="text-xs font-bold">🎉P</span>
                </button>
                {/* Identity */}
                {partyState.enabled && (
                <button
                    onClick={partyUser ? () => {} : handleShowIdentity}
                    className={
                        partyUser
                            ? "flex items-center gap-2 px-3 py-2 rounded-full shadow-lg bg-prince-gold/20 border border-prince-gold/30 text-prince-gold"
                            : "flex items-center gap-2 px-3 py-2 rounded-full shadow-lg bg-prince-rose/80 border border-prince-rose text-white animate-pulse"
                    }
                >
                    {partyUser ? (
                        <>
                            {partyUser.photo_url && <img src={partyUser.photo_url} className="w-5 h-5 rounded-full" alt="" />}
                            <span className="text-xs">{partyUser.name}</span>
                        </>
                    ) : (
                        <span className="text-xs font-bold">选择身份 🎉</span>
                    )}
                </button>
                )}
            </div>
        </div>
    );
}
