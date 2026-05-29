import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // `ws: true` also proxies the /api/sync WebSocket upgrade to the server.
      '/api': { target: 'http://localhost:3000', ws: true },
    },
  },
});
