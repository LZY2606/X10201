import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  server: {
    host: '127.0.0.1',
    port: 5261,
    strictPort: true
  },
  build: {
    outDir: '../../dist'
  }
});
