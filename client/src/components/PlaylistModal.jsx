import React from 'react';

export default function PlaylistModal({ playlists, onSelect, onClose }) {
    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] animate-in backdrop-blur-sm">
            <div className="glass-panel p-5 rounded-2xl w-72 max-w-[90vw]">
                <h3 className="font-hand text-prince-gold mb-3 text-center">🪐 选择播放列表</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto scroll-allowed">
                    {playlists.map(p => (
                        <button
                            key={p.id}
                            onClick={() => onSelect(p.id)}
                            className="w-full text-left p-2.5 rounded-lg transition-colors hover:bg-prince-gold/10 text-prince-cream text-sm border border-prince-gold/10"
                        >
                            {p.name}
                        </button>
                    ))}
                    {playlists.length === 0 && (
                        <p className="text-prince-muted text-center text-xs py-4">还没有播放列表</p>
                    )}
                </div>
                <button
                    onClick={onClose}
                    className="w-full mt-3 py-2 text-xs text-prince-muted hover:text-prince-cream transition-colors"
                >
                    取消
                </button>
            </div>
        </div>
    );
}
