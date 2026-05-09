import React, { useMemo } from 'react';

export default function Stars() {
    const stars = useMemo(() => {
        return Array.from({ length: 50 }, (_, i) => ({
            id: i,
            left: Math.random() * 100,
            top: Math.random() * 100,
            size: Math.random() * 3 + 1,
            duration: Math.random() * 4 + 2,
            delay: Math.random() * 5,
        }));
    }, []);

    return (
        <div className="stars-bg">
            {stars.map(s => (
                <div
                    key={s.id}
                    className="star"
                    style={{
                        left: `${s.left}%`,
                        top: `${s.top}%`,
                        width: `${s.size}px`,
                        height: `${s.size}px`,
                        '--duration': `${s.duration}s`,
                        '--delay': `${s.delay}s`,
                    }}
                />
            ))}
        </div>
    );
}
