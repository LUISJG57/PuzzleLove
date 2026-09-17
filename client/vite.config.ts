import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.API_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, ws: true, changeOrigin: true },
    },
  },
});
