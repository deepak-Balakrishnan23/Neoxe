import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  // `vite preview` serves the production build in dist/renderer on a fixed local port.
  // host: true exposes it on the LAN so other machines can reach it at http://<your-ip>:4173.
  preview: {
    port: 4173,
    host: true,
    strictPort: true,
  },
});
