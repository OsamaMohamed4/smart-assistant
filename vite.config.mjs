import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'admin-src',
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api'        : 'http://localhost:3000',
      '/chat'       : 'http://localhost:3000',
      '/chat-voice' : 'http://localhost:3000',
      '/webhook'    : 'http://localhost:3000',
    },
  },
  build: {
    outDir       : '../public/admin',
    emptyOutDir  : true,
    sourcemap    : false,
  },
});
