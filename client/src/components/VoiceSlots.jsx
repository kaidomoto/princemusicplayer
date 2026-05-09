import React, { useState, useEffect, useContext, useRef } from 'react';
import { SocketContext } from '../App';
import clsx from 'clsx';
import { Mic, MicOff, RefreshCw } from 'lucide-react';

// Hook to refresh UI every second for timers
function useNow() {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const i = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(i);
    }, []);
    return now;
}

export default function VoiceSlots({ onSlotAction, addLog: externalAddLog }) {
    const socket = useContext(SocketContext);
    const addLog = externalAddLog || (() => { });

    const [templates, setTemplates] = useState([
        { id: 0, duration: 60, label: '1分钟' },
        { id: 1, duration: 180, label: '3分钟' },
        { id: 2, duration: 300, label: '5分钟' },
        { id: 3, duration: 420, label: '7分钟' },
        { id: 4, duration: 600, label: '10分钟' },
        { id: 5, duration: 1800, label: '半小时' },
    ]);
    const [mySessions, setMySessions] = useState([]); // [{ slotId, endTime, stage, ... }]
    const mediaRecorderRef = useRef(null);
    useNow(); // Force re-render every second for timer display

    useEffect(() => {
        if (!socket) return;

        socket.on('slot_templates', (tpls) => setTemplates(tpls));

        socket.on('my_slot_update', (sessions) => {
            const arr = Array.isArray(sessions) ? sessions : (sessions ? [sessions] : []);
            setMySessions(arr);

            const active = arr.find(s => s.stage === 'active');
            if (!active) {
                stopRecording();
            } else {
                addLog(`[Session] Active: ${active.slotId}`);
            }
        });

        socket.on('force_reset', () => {
            setMySessions([]);
            stopRecording();
            addLog('[Reset] Forced by Admin');
        });

        return () => {
            socket.off('slot_templates');
            socket.off('my_slot_update');
            socket.off('force_reset');
            stopRecording();
        };
    }, [socket]);

    const startRecording = async () => {
        const activeSession = mySessions.find(s => s.stage === 'active');
        if (!activeSession) return;

        addLog('[Rec] Requesting Mic...');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const types = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
            const supported = types.filter(t => MediaRecorder.isTypeSupported(t));
            addLog(`[Info] Supported: ${supported.join(', ')}`);

            let mimeType = '';
            if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
            else if (MediaRecorder.isTypeSupported('audio/aac')) mimeType = 'audio/aac';
            else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';

            addLog(`[Rec] MimeType: ${mimeType}`);

            const options = mimeType ? { mimeType } : {};
            const mediaRecorder = new MediaRecorder(stream, options);
            mediaRecorderRef.current = mediaRecorder;
            let chunkCount = 0;

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0 && socket) {
                    const isFirst = chunkCount === 0;
                    socket.emit('voice_data', {
                        buffer: event.data,
                        type: mediaRecorder.mimeType || mimeType,
                        slotId: activeSession.slotId,
                        isHeader: isFirst
                    });

                    if (chunkCount % 10 === 0) addLog(`[Rec] Sent #${chunkCount}`);
                    chunkCount++;
                }
            };
            mediaRecorder.start(100);
            addLog('[Rec] Started');
        } catch (err) {
            console.error('Mic Error', err);
            addLog(`[Err] Mic: ${err.message}`);
            alert('Cannot access microphone');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
            addLog('[Rec] Stopped');
        }
    };

    const [pendingSlot, setPendingSlot] = useState(null);

    const handleSlotClick = (id) => {
        const myActive = mySessions.find(s => s.stage === 'active');
        const thisSlotSilence = mySessions.find(s => s.slotId === id && s.stage === 'silence');
        if (myActive || thisSlotSilence) return;

        const slot = templates.find(t => t.id === id);
        if (!slot) return;
        setPendingSlot(slot);
    };

    const confirmActivation = (id) => {
        addLog(`[Confirm] Slot ${id}`);
        socket.emit('activate_slot', { slotId: id });
        setPendingSlot(null);
    };

    const cancelActivation = () => {
        setPendingSlot(null);
        addLog(`[Cancel] Activation`);
    };

    const handleReset = async (e) => {
        e.stopPropagation();

        const LOCKOUT_DURATION = 24 * 60 * 60 * 1000;
        const lockoutTime = localStorage.getItem('reset_lockout_until');
        if (lockoutTime && Date.now() < parseInt(lockoutTime)) {
            const hoursLeft = ((parseInt(lockoutTime) - Date.now()) / (1000 * 60 * 60)).toFixed(1);
            alert(`Too many failed attempts. Locked for ${hoursLeft} hours.`);
            return;
        }

        const pwd = prompt('🔐 Enter Reset Password:');
        if (!pwd) return;

        try {
            const res = await fetch(`${window.location.pathname.replace(/\/$/, '')}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pwd, type: 'slots' })
            });
            if (res.ok) {
                socket && socket.emit('reset_slots', pwd);
                localStorage.removeItem('reset_attempts');
            } else {
                alert('密码错误');
                let attempts = parseInt(localStorage.getItem('reset_attempts') || '0') + 1;
                localStorage.setItem('reset_attempts', attempts);
                if (attempts >= 3) {
                    const lockoutUntil = Date.now() + LOCKOUT_DURATION;
                    localStorage.setItem('reset_lockout_until', lockoutUntil);
                    alert('3 Failed Attempts. Button locked for 24 hours.');
                }
            }
        } catch (e) {
            alert('验证失败');
        }
    };

    // Auto-start recording when session becomes active
    useEffect(() => {
        const active = mySessions.find(s => s.stage === 'active');
        if (active) {
            startRecording();
            if (onSlotAction) onSlotAction();
        } else {
            stopRecording();
        }
    }, [mySessions.some(s => s.stage === 'active')]);

    return (
        <div className="w-full h-full flex flex-col relative">
            <div className="flex justify-center mb-3">
                <button type="button" onClick={handleReset}
                    className="text-xs text-prince-gold font-bold hover:text-prince-cream flex items-center gap-1 px-4 py-1.5 rounded-full border border-prince-gold/30 active:scale-95 transition-transform font-hand">
                    <RefreshCw size={12} /> Reform & Reset
                </button>
            </div>

            <div className="grid grid-cols-3 gap-3 flex-1">
                {templates.map(slot => {
                    const session = mySessions.find(s => s.slotId === slot.id);
                    const isMyCurrent = !!session;
                    const isSilence = session && session.stage === 'silence';
                    const isActive = session && session.stage === 'active';

                    const timeLeft = isMyCurrent ? Math.max(0, Math.floor((session.endTime - Date.now()) / 1000)) : 0;

                    const hasAnyActive = mySessions.some(s => s.stage === 'active');
                    const isBlocked = (hasAnyActive && !isActive) || isSilence;

                    return (
                        <button
                            key={slot.id}
                            onClick={() => handleSlotClick(slot.id)}
                            disabled={isBlocked}
                            className={clsx(
                                "relative rounded-xl flex flex-col items-center justify-center font-bold transition-all border-b-4 h-full min-h-[60px]",
                                isActive ? "bg-green-600 border-green-800 text-white" :
                                    isSilence ? "bg-orange-600 border-orange-800 text-white" :
                                        hasAnyActive ? "bg-prince-card border-prince-deep opacity-50 cursor-not-allowed text-prince-muted" :
                                            "bg-prince-cream text-prince-deep border-prince-muted/30 hover:-translate-y-1 hover:border-b-8 shadow-lg"
                            )}
                        >
                            <span className="text-sm font-hand">{slot.label}</span>
                            {isMyCurrent && (
                                <span className="text-xs animate-pulse font-mono">
                                    {isSilence ? '静默 ' : ''}{timeLeft}s
                                </span>
                            )}
                            {isActive && <Mic size={14} className="mt-1" />}
                            {isSilence && <MicOff size={14} className="mt-1 opacity-50" />}
                        </button>
                    );
                })}
            </div>

            {/* Confirmation Modal */}
            {pendingSlot && (
                <div className="absolute inset-x-0 bottom-0 top-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end animate-in">
                    <div className="w-full bg-prince-deep/95 border-t border-prince-gold/20 rounded-t-2xl p-6 shadow-2xl">
                        <div className="text-center mb-6">
                            <div className="w-16 h-16 bg-prince-gold/20 rounded-full flex items-center justify-center mx-auto mb-4">
                                <Mic className="text-prince-gold" size={32} />
                            </div>
                            <h3 className="text-xl font-bold text-prince-cream mb-2 font-hand">确认开始发言？</h3>
                            <p className="text-prince-muted text-sm">你将占用【{pendingSlot.label}】的时长并开启麦克风。</p>
                        </div>
                        <div className="flex gap-4">
                            <button
                                onClick={cancelActivation}
                                className="flex-1 py-4 rounded-xl bg-prince-card/50 text-prince-muted font-bold hover:bg-prince-card transition-colors font-hand"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => confirmActivation(pendingSlot.id)}
                                className="flex-1 py-4 rounded-xl bg-gradient-to-r from-prince-rose to-prince-gold text-prince-deep font-bold shadow-star transition-all active:scale-95 font-hand"
                            >
                                确认开启
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
