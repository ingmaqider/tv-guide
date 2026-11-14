import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 127.0.0.1, not localhost: the API listens on IPv4 only and localhost may resolve to ::1.
    // ws: /api/events is a WebSocket.
    proxy: { '/api': { target: 'http://127.0.0.1:3001', ws: true } },
  },
});
