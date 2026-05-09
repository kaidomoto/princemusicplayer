/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,jsx}'],
    theme: {
        extend: {
            colors: {
                'prince-night': '#0C1445',
                'prince-deep': '#0A0F2E',
                'prince-gold': '#E8B64A',
                'prince-rose': '#D4456A',
                'prince-cream': '#F4F0E6',
                'prince-muted': '#7B8CAD',
                'prince-card': '#121A4A',
                'prince-star': '#FFF8DC',
            },
            fontFamily: {
                'hand': ['"Patrick Hand"', 'cursive'],
                'body': ['Inter', 'sans-serif'],
            },
            animation: {
                'twinkle': 'twinkle 3s ease-in-out infinite',
                'twinkle-slow': 'twinkle 5s ease-in-out infinite',
                'float': 'float 6s ease-in-out infinite',
                'rose-bloom': 'roseBloom 2s ease-out forwards',
            },
            keyframes: {
                twinkle: {
                    '0%, 100%': { opacity: 0.3, transform: 'scale(0.8)' },
                    '50%': { opacity: 1, transform: 'scale(1.2)' },
                },
                float: {
                    '0%, 100%': { transform: 'translateY(0px)' },
                    '50%': { transform: 'translateY(-8px)' },
                },
                roseBloom: {
                    '0%': { transform: 'scale(0) rotate(-45deg)', opacity: 0 },
                    '100%': { transform: 'scale(1) rotate(0deg)', opacity: 1 },
                },
            },
            boxShadow: {
                'star': '0 0 10px rgba(232, 182, 74, 0.4), 0 0 20px rgba(232, 182, 74, 0.2)',
                'rose': '0 0 12px rgba(212, 69, 106, 0.4), 0 0 24px rgba(212, 69, 106, 0.2)',
            },
        },
    },
    plugins: [],
};
