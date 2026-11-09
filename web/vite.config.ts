import { defineConfig } from 'vite';
export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/v1': 'http://127.0.0.1:4317' } },
});
