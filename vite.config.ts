import { defineConfig, type Plugin } from 'vite';
import { createApiHandler } from './src/server/api';
import { openDb } from './src/server/db';

function meshClinicApi(): Plugin {
  return {
    name: 'mesh-clinic-api',
    configureServer(server) {
      const db = openDb(new URL('./data/mesh-clinic.db', import.meta.url).pathname);
      const handler = createApiHandler(db);
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next);
      });
    }
  };
}

export default defineConfig({
  plugins: [meshClinicApi()],
  server: {
    host: '127.0.0.1',
    port: 5261,
    strictPort: true
  }
});
