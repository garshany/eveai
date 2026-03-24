import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/client/',
  plugins: [react(), tailwindcss()],
  build: {
    manifest: true,
    outDir: 'dist/client',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'client/src/main.tsx'),
    },
  },
});
