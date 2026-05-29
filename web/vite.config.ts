import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? '/douyin-follower-monitor/' : '/',
  plugins: [react()],
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
    emptyOutDir: true,
    cssMinify: false
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
}));
