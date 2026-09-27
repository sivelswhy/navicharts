// Serveur de production : sert l'application compilée (dist/) et l'API.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { handleApi } from './api.ts';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const PORT = Number(process.env.PORT ?? 4173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  if (await handleApi(req, res)) return;

  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  let file = path.join(DIST, path.normalize(pathname));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info || info.isDirectory()) file = path.join(DIST, 'index.html');

  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`NaviCharts → http://localhost:${PORT}`);
});
