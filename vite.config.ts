import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0', port: 5173, strictPort: true, proxy: { '/ws': { target: 'ws://127.0.0.1:3000', ws: true }, '/api': 'http://127.0.0.1:3000' } },
  build: { outDir: 'dist/client', chunkSizeWarningLimit: 650 },
});
