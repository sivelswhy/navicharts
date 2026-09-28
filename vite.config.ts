import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApi } from './server/api.ts';
import { loadAutorouterTile, type AutorouterKind } from './scripts/autorouter-tiles.ts';
import { getAutorouterNav } from './scripts/autorouter-nav.ts';
import { getAutorouterProcedures } from './scripts/autorouter-procedures.ts';
import { getAutorouterNavaid, searchAutorouterNav } from './scripts/autorouter-search.ts';

// Monte l'API (/api/*) dans le serveur de développement Vite.
const api: Plugin = {
  name: 'navicharts-api',
  configureServer(server) {
    // Tuiles autorouter pour tester en local : uniquement en dev, jamais dans le build ni sur server/
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname.match(/^\/dev\/autorouter\/procedures\/([A-Z0-9]{4})$/);
      if (!p) return next();
      getAutorouterProcedures(p[1], Number(url.searchParams.get('lon')), Number(url.searchParams.get('lat'))).then(
        (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)),
        (err) => res.writeHead(502).end(String(err)),
      );
    });
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/dev\/autorouter\/navaid\/([A-Z0-9]{1,5})$/);
      if (!m) return next();
      const at = [Number(url.searchParams.get('lon')), Number(url.searchParams.get('lat'))] as [number, number];
      if (at.some(Number.isNaN)) return res.writeHead(400).end();
      getAutorouterNavaid(m[1], at).then(
        (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data && { ...data.props, lngLat: data.lngLat })),
        (err) => res.writeHead(502).end(String(err)),
      );
    });
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/dev/autorouter/search') return next();
      const near = [Number(url.searchParams.get('lon')), Number(url.searchParams.get('lat'))] as [number, number];
      searchAutorouterNav(url.searchParams.get('q') ?? '', near.some(Number.isNaN) ? undefined : near).then(
        (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)),
        (err) => res.writeHead(502).end(String(err)),
      );
    });
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/dev/autorouter/nav') return next();
      const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
      if (bbox.length !== 4 || bbox.some(Number.isNaN)) return res.writeHead(400).end();
      getAutorouterNav(bbox).then(
        (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)),
        (err) => res.writeHead(502).end(String(err)),
      );
    });
    server.middlewares.use((req, res, next) => {
      const m = req.url?.match(/^\/dev\/autorouter\/(airway|sid|star|airport|navaid|designatedpoint|airspace)\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
      if (!m) return next();
      loadAutorouterTile(m[1] as AutorouterKind, m[2], m[3], m[4]).then(
        (data) => {
          if (data.length === 0) return res.writeHead(204).end();
          res.writeHead(200, { 'Content-Type': 'application/vnd.mapbox-vector-tile' }).end(data);
        },
        () => res.writeHead(502).end(),
      );
    });
    server.middlewares.use((req, res, next) => {
      handleApi(req, res).then((handled) => handled || next(), next);
    });
  },
};

export default defineConfig({
  plugins: [react(), api],
});
