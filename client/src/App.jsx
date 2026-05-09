import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import Player from './views/Player';
import Broadcast from './views/Broadcast';
import Remote from './views/Remote';
import AuthModal from './components/AuthModal';
import Stars from './components/Stars';

export const SocketContext = React.createContext();

function App() {
    const [socket, setSocket] = useState(null);
    const [mode, setMode] = useState('remote');
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [pendingBroadcast, setPendingBroadcast] = useState(false);
    const [isConnected, setIsConnected] = useState(false);

    // Token management
    const getToken = (type) => sessionStorage.getItem(`auth_${type}`);
    const setToken = (type, token) => sessionStorage.setItem(`auth_${type}`, token);

    useEffect(() => {
        let userId = localStorage.getItem('prince_userid');
        if (!userId) {
            userId = 'p_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
            localStorage.setItem('prince_userid', userId);
        }

        // Get session ID from URL params
        const urlParams = new URLSearchParams(window.location.search);
        const sessionId = urlParams.get('session') || 'default';
        const newSocket = io('/', {
            path: '/socket.io',
            transports: ['websocket', 'polling'],
            auth: { sessionId, userId }
        });

        newSocket.on('connect', () => setIsConnected(true));
        newSocket.on('disconnect', () => setIsConnected(false));
        setSocket(newSocket);
        return () => newSocket.close();
    }, []);

    const handleModeSwitch = () => {
        if (mode === 'remote') {
            // Check if already authenticated
            const token = getToken('player');
            if (token) {
                fetch('/api/auth/verify?type=player', { headers: { 'x-auth-token': token } })
                    .then(r => r.json())
                    .then(d => {
                        if (d.valid) setMode('player');
                        else setShowAuthModal(true);
                    })
                    .catch(() => setShowAuthModal(true));
            } else {
                setShowAuthModal(true);
            }
        } else {
            setMode('remote');
        }
    };

    const handleAuthSuccess = (token) => {
        setToken('player', token);
        setMode('player');
        setShowAuthModal(false);
    };

    // Prevent default touch actions
    useEffect(() => {
        document.body.addEventListener('touchmove', (e) => {
            if (e.target.closest('.scroll-allowed')) return;
            e.preventDefault();
        }, { passive: false });
    }, []);

    if (!socket) {
        return (
            <div className="h-full bg-prince-deep flex flex-col items-center justify-center relative overflow-hidden">
                <Stars />
                <div className="text-prince-gold font-hand text-2xl animate-float z-10">
                    ✨ 正在连接星球...
                </div>
            </div>
        );
    }

    return (
        <SocketContext.Provider value={socket}>
            <div className="fixed inset-0 w-full h-full overflow-hidden bg-prince-deep text-prince-cream flex flex-col">
                <Stars />

                {/* Header */}
                <div className="flex justify-between items-center px-4 py-3 border-b border-prince-gold/10 shrink-0 z-50 bg-prince-deep/80 backdrop-blur-md relative">
                    <h1 className="font-hand text-xl text-prince-gold flex items-center gap-2">
                        <span className="text-2xl">🌹</span>
                        <span>小王子の星球</span>
                        {mode === 'player' && <span className="text-xs text-prince-rose ml-1">♪ Player</span>}
                    </h1>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400 shadow-star' : 'bg-red-400'}`} />
                        <button
                            onClick={() => {
                                const t = sessionStorage.getItem('auth_player');
                                if (t) { setMode('broadcast'); }
                                else { setShowAuthModal(true); setPendingBroadcast(true); }
                            }}
                            className={`text-xs px-2.5 py-1.5 rounded-full border transition-all font-hand ${mode === 'broadcast' ? 'border-prince-rose/60 text-prince-rose bg-prince-rose/10' : 'border-prince-gold/20 text-prince-muted hover:text-prince-gold hover:border-prince-gold/30'}`}
                        >
                            📡
                        </button>
                        <button
                            onClick={handleModeSwitch}
                            className="text-xs px-3 py-1.5 rounded-full border border-prince-gold/30 text-prince-gold hover:bg-prince-gold/10 transition-all font-hand"
                        >
                            {mode === 'remote' ? '🎵 Player' : '🎮 Remote'}
                        </button>
                    </div>
                </div>

                {/* Content: Broadcast stays mounted (persistent WS/PubNub).
                    Player conditionally rendered (unmounts when hidden to stop audio).
                    Remote stays mounted (lightweight, no audio). */}
                <div className="flex-1 relative overflow-hidden z-10">
                    <div className="h-full" style={{ display: mode === 'broadcast' ? 'block' : 'none' }}>
                        <Broadcast />
                    </div>
                    {mode === 'player' && (
                        <div className="h-full">
                            <Player />
                        </div>
                    )}
                    <div className="h-full" style={{ display: mode === 'remote' ? 'block' : 'none' }}>
                        <Remote />
                    </div>
                </div>

                {/* Auth Modal */}
                {showAuthModal && (
                    <AuthModal
                        type="player"
                        title="通往 Player 的星门"
                        onSuccess={(token) => { handleAuthSuccess(token); if (pendingBroadcast) { setPendingBroadcast(false); setMode('broadcast'); } }}
                        onClose={() => setShowAuthModal(false)}
                    />
                )}
            </div>
        </SocketContext.Provider>
    );
}

export default App;
