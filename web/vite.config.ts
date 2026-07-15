import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  base: '/web-assets/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('origin', 'http://127.0.0.1:3000');
          });
        },
      },
      '/auth': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
});
