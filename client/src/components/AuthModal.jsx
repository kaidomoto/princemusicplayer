import React, { useState } from 'react';

export default function AuthModal({ type, title, onSuccess, onClose }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [attempts, setAttempts] = useState(0);

    const LOCKOUT_KEY = `auth_lockout_${type}`;
    const LOCKOUT_DURATION = 512 * 60 * 60 * 1000;

    const isLockedOut = () => {
        const lockout = localStorage.getItem(LOCKOUT_KEY);
        return lockout && Date.now() < parseInt(lockout);
    };

    const handleSubmit = async () => {
        if (isLockedOut()) {
            const hrs = ((parseInt(localStorage.getItem(LOCKOUT_KEY)) - Date.now()) / 3600000).toFixed(1);
            setError(`⏳ 安全锁定中，剩余 ${hrs} 小时`);
            return;
        }
        if (!password) return;
        setLoading(true);
        setError('');

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, type })
            });
            const data = await res.json();

            if (res.ok && data.token) {
                localStorage.removeItem(`auth_attempts_${type}`);
                onSuccess(data.token);
            } else {
                const newAttempts = attempts + 1;
                setAttempts(newAttempts);
                if (newAttempts >= 3) {
                    localStorage.setItem(LOCKOUT_KEY, (Date.now() + LOCKOUT_DURATION).toString());
                    setError('🌑 太多错误尝试，星门已关闭 512 小时');
                } else {
                    setError(`🌹 密码不对哦 (${newAttempts}/3)`);
                }
            }
        } catch (e) {
            setError('连接失败...');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] backdrop-blur-sm animate-in">
            <div className="glass-panel p-6 rounded-2xl w-80 max-w-[90vw] text-center">
                <div className="text-4xl mb-3 animate-float">⭐</div>
                <h3 className="font-hand text-xl text-prince-gold mb-1">{title || '验证密码'}</h3>
                <p className="text-prince-muted text-xs mb-4">
                    "真正重要的东西，用眼睛是看不到的"
                </p>

                <input
                    type="password"
                    className="input-prince mb-3 text-center"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    placeholder="输入星门密码..."
                    autoFocus
                />

                {error && (
                    <p className="text-prince-rose text-xs mb-3 animate-in">{error}</p>
                )}

                <div className="flex gap-2">
                    <button
                        onClick={onClose}
                        className="flex-1 py-2 text-xs text-prince-muted hover:text-prince-cream rounded-lg transition-colors"
                    >
                        返回
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={loading}
                        className="flex-1 py-2 text-xs btn-rose font-bold rounded-lg"
                    >
                        {loading ? '验证中...' : '✨ 验证'}
                    </button>
                </div>
            </div>
        </div>
    );
}
