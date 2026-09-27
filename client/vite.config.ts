import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.API_URL ?? 'http://localhost:3001';

// The portfolio owns the domain root, so the game is served under a prefix. Traefik strips it
// before the request reaches the server, which keeps every Express route and the Socket.IO path
// at the root (so the container healthcheck and the bots need no prefix at all).
const base = process.env.BASE_PATH ?? '/puzzlelove/';
const strip = (path: string) => path.slice(base.length - 1);

export default defineConfig({
  base,
  plugins: [react()],
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    host: true,
    // Mirrors the production StripPrefix so dev and prod see the same URLs.
    proxy: {
      [`${base}api`]: { target, changeOrigin: true, rewrite: strip },
      [`${base}socket.io`]: { target, ws: true, changeOrigin: true, rewrite: strip },
    },
  },
});
