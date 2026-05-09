import React, { useState, useEffect, useRef, useContext } from 'react';
import { SocketContext } from '../App';
import clsx from 'clsx';
import {
    X, Edit3, Save, Search, Upload, Link, Plus, Minus,
    ShieldCheck, Loader2, RefreshCw
} from 'lucide-react';
import AuthModal from './AuthModal';

export default function LyricViewer({ song, currentTime, onClose }) {
    const socket = useContext(SocketContext);
    const [lyrics, setLyrics] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [syncing, setSyncing] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [showAuth, setShowAuth] = useState(false);
    const [authToken, setAuthToken] = useState(() => sessionStorage.getItem('auth_lyrics') || '');
    const [pendingAction, setPendingAction] = useState(null);
    const lineRefs = useRef([]);
    const containerRef = useRef(null);
    const textareaRef = useRef(null);

    // Parse LRC
    const parseLRC = (text) => {
        const lines = [];
        text.split('\n').forEach(line => {
            const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
            if (match) {
                const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / (match[3].length === 3 ? 1000 : 100);
                lines.push({ time, text: match[4].trim() });
            }
        });
        return lines.sort((a, b) => a.time - b.time);
    };

    // Load lyrics via auto endpoint (handles local cache + LRCLIB search)
    const [autoSource, setAutoSource] = useState(null);
    useEffect(() => {
        if (!song?.id) return;
        setLoading(true);
        setAutoSource(null);
        setLyrics([]);
        setEditContent('');

        const params = new URLSearchParams({ songId: song.id, title: song.title || '' });
        fetch(`${window.location.pathname.replace(/\/$/, '')}/api/lyrics/auto?${params}`)
            .then(r => r.json())
            .then(data => {
                if (data.found && data.type === 'synced') {
                    setLyrics(parseLRC(data.lrc));
                    setEditContent(data.lrc);
                    setAutoSource({ artist: data.artist || '', track: data.track || '', source: data.source });
                } else if (data.found && data.type === 'plain') {
                    setEditContent(data.text);
                    setAutoSource({ artist: data.artist || '', track: data.track || '', source: data.source, plain: true });
                }
            })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, [song?.id]);

    // Scroll sync
    useEffect(() => {
        if (lyrics.length === 0 || isEditing) return;
        let idx = -1;
        for (let i = lyrics.length - 1; i >= 0; i--) {
            if (currentTime >= lyrics[i].time) { idx = i; break; }
        }
        if (idx !== activeIndex) {
            setActiveIndex(idx);
            if (lineRefs.current[idx]) {
                lineRefs.current[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }, [currentTime, lyrics, isEditing]);

    const requireAuth = (action) => {
        if (authToken) {
            fetch(`${window.location.pathname.replace(/\/$/, '')}/api/auth/verify?type=lyrics`, { headers: { 'x-auth-token': authToken } })
                .then(r => r.json())
                .then(d => {
                    if (d.valid) action();
                    else { setPendingAction(() => action); setShowAuth(true); }
                })
                .catch(() => { setPendingAction(() => action); setShowAuth(true); });
        } else {
            setPendingAction(() => action);
            setShowAuth(true);
        }
    };

    const handleAuthSuccess = (token) => {
        setAuthToken(token);
        sessionStorage.setItem('auth_lyrics', token);
        setShowAuth(false);
        if (pendingAction) { pendingAction(); setPendingAction(null); }
    };

    const handleEdit = () => requireAuth(() => setIsEditing(true));

    const handleSave = async () => {
        try {
            await fetch(`${window.location.pathname.replace(/\/$/, '')}/api/lyrics/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
                body: JSON.stringify({ songId: song.id, text: editContent })
            });
            setLyrics(parseLRC(editContent));
            setIsEditing(false);
        } catch (e) { alert('保存失败'); }
    };

    const handleUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('lyric', file);
        formData.append('songId', song.id);
        try {
            await fetch(`${window.location.pathname.replace(/\/$/, '')}/api/lyrics/upload`, {
                method: 'POST',
                headers: { 'x-auth-token': authToken },
                body: formData
            });
            // Reload
            const text = await file.text();
            setLyrics(parseLRC(text));
            setEditContent(text);
        } catch (e) { alert('Upload failed'); }
    };

    const handleSearch = () => {
        const q = encodeURIComponent(song?.title || '');
        window.open(`https://www.google.com/search?q=${q}+lrc+歌词`, '_blank');
    };

    const handleReplace = async () => {
        if (!song?.id) return;
        try {
            await fetch(`${window.location.pathname.replace(/\/$/, '')}/api/lyrics/auto?songId=${song.id}`, { method: 'DELETE' });
        } catch { }
        // Clear everything → show manual search/upload state
        setLyrics([]);
        setEditContent('');
        setAutoSource(null);
    };

    const insertTimestamp = () => {
        if (!textareaRef.current) return;
        const ta = textareaRef.current;
        const pos = ta.selectionStart;
        const m = Math.floor(currentTime / 60).toString().padStart(2, '0');
        const s = Math.floor(currentTime % 60).toString().padStart(2, '0');
        const ms = Math.floor((currentTime % 1) * 100).toString().padStart(2, '0');
        const tag = `[${m}:${s}.${ms}]`;
        const newContent = editContent.slice(0, pos) + tag + editContent.slice(pos);
        setEditContent(newContent);
    };

    const removeTimestamp = () => {
        if (!textareaRef.current) return;
        const ta = textareaRef.current;
        const pos = ta.selectionStart;
        const lineStart = editContent.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd = editContent.indexOf('\n', pos);
        const line = editContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const cleaned = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '');
        setEditContent(editContent.slice(0, lineStart) + cleaned + editContent.slice(lineEnd === -1 ? editContent.length : lineEnd));
    };

    return (
        <div className="fixed inset-0 z-[150] bg-prince-deep/95 backdrop-blur-md flex flex-col animate-in">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-prince-gold/10 shrink-0">
                <button onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-prince-card/60 border border-prince-gold/30 text-prince-cream hover:bg-prince-gold/20 hover:text-prince-gold transition-all active:scale-95">
                    <X size={16} />
                    <span className="text-xs font-hand">返回</span>
                </button>
                <h3 className="font-hand text-prince-gold truncate flex-1 text-center">
                    {song?.title || '歌词'}
                </h3>
                <div className="flex gap-2">
                    {isEditing ? (
                        <button onClick={handleSave} className="p-2 text-prince-gold hover:text-prince-cream">
                            <Save size={18} />
                        </button>
                    ) : (
                        <button onClick={handleEdit} className="p-2 text-prince-muted hover:text-prince-cream">
                            <Edit3 size={18} />
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div ref={containerRef} className="flex-1 overflow-y-auto scroll-allowed p-6 relative">
                {loading ? (
                    <div className="flex-1 flex flex-col items-center justify-center">
                        <Loader2 className="animate-spin text-prince-gold mb-4" size={32} />
                        <p className="text-prince-muted font-hand">加载中...</p>
                    </div>
                ) : isEditing ? (
                    <div className="flex-1 flex flex-col h-full animate-in relative">
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-4 z-10">
                            <button onClick={insertTimestamp} title="Insert Timestamp"
                                className="w-12 h-12 rounded-full bg-prince-gold text-prince-deep flex items-center justify-center shadow-star active:scale-90 transition-all hover:scale-110">
                                <Plus size={24} />
                            </button>
                            <button onClick={removeTimestamp} title="Remove Timestamp"
                                className="w-12 h-12 rounded-full bg-prince-card text-prince-muted flex items-center justify-center border border-prince-gold/10 active:scale-90 transition-all hover:text-prince-cream">
                                <Minus size={24} />
                            </button>
                        </div>
                        <textarea
                            ref={textareaRef}
                            className="flex-1 bg-prince-deep/80 border border-prince-gold/10 rounded-2xl p-4 pr-16 text-sm font-mono text-prince-cream/80 focus:outline-none focus:border-prince-gold/50 resize-none scroll-allowed"
                            value={editContent}
                            onChange={e => setEditContent(e.target.value)}
                            placeholder="粘贴 LRC 歌词..."
                            spellCheck="false"
                        />
                    </div>
                ) : lyrics.length > 0 ? (
                    <div className="pb-40 space-y-8 text-center w-full">
                        <div className="text-xs text-prince-muted/60 mb-4 flex items-center justify-center gap-2">
                            <span>
                                {autoSource?.source === 'local' ? '💾 已保存的歌词' :
                                    autoSource ? `✨ 自动匹配: ${autoSource.track} — ${autoSource.artist}` : ''}
                            </span>
                            <button onClick={handleReplace} title="更换歌词"
                                className="p-1 rounded-full hover:bg-prince-gold/20 hover:text-prince-gold transition-colors">
                                <RefreshCw size={12} />
                            </button>
                        </div>
                        {lyrics.map((line, i) => (
                            <div
                                key={i}
                                ref={el => lineRefs.current[i] = el}
                                className={clsx(
                                    "transition-all duration-500 text-lg font-medium font-hand",
                                    activeIndex === i
                                        ? "text-prince-gold scale-110 opacity-100"
                                        : "text-prince-cream/20 scale-100 px-4"
                                )}
                            >
                                {line.text}
                            </div>
                        ))}
                    </div>
                ) : autoSource?.plain ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                        <div className="text-5xl mb-4 animate-float">📝</div>
                        <h4 className="font-hand text-xl text-prince-gold mb-1">找到歌词文本</h4>
                        <p className="text-prince-muted text-xs mb-2">
                            匹配: {autoSource.track} — {autoSource.artist}
                        </p>
                        <p className="text-prince-muted text-xs mb-6">
                            纯文本歌词（无时间戳），可编辑后添加时间戳
                        </p>
                        <button onClick={handleEdit}
                            className="flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-prince-gold/20 text-prince-gold font-bold hover:scale-105 transition-transform border border-prince-gold/30">
                            <Edit3 size={18} /> 打开编辑器
                        </button>
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                        <div className="text-5xl mb-6 animate-float">🌹</div>
                        <h4 className="font-hand text-xl text-prince-gold mb-2">暂无歌词</h4>
                        <p className="text-prince-muted text-sm mb-8">自动搜索未找到匹配歌词</p>
                        <div className="flex flex-col gap-3 w-full">
                            <button onClick={handleSearch}
                                className="flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-prince-gold/20 text-prince-gold font-bold hover:scale-105 transition-transform border border-prince-gold/30">
                                <Search size={18} /> 手动搜索歌词
                            </button>
                            <label className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-prince-card/50 text-prince-muted hover:bg-prince-gold/10 cursor-pointer border border-prince-gold/10 transition-colors">
                                <Upload size={18} /> 上传 LRC
                                <input type="file" accept=".lrc" className="hidden" onChange={(e) => requireAuth(() => handleUpload(e))} />
                            </label>
                        </div>
                    </div>
                )}
            </div>

            {/* Progress footer */}
            <div className="h-1.5 bg-prince-night shrink-0">
                <div className="h-full bg-gradient-to-r from-prince-rose to-prince-gold transition-all duration-500"
                    style={{ width: `${(currentTime / (song?.duration || 1)) * 100}%` }} />
            </div>

            {/* Auth Modal */}
            {showAuth && (
                <AuthModal type="lyrics" title="🌹 歌词编辑权限" onSuccess={handleAuthSuccess} onClose={() => setShowAuth(false)} />
            )}
        </div>
    );
}
