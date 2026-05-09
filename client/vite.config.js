import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
    plugins: [react()],
    server: {
        proxy: { '/api': 'http://localhost:3003', '/socket.io': { target: 'http://localhost:3003', ws: true } }
    }
});
