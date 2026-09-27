import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApi } from './server/api.ts';

// Monte l'API (/api/*) dans le serveur de développement Vite.
const api: Plugin = {
  name: 'navicharts-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      handleApi(req, res).then((handled) => handled || next(), next);
    });
  },
};

export default defineConfig({
  plugins: [react(), api],
});
