// Routes /api/* partagées entre le serveur de développement (plugin Vite) et le serveur de production.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { currentCycle } from './airac.ts';
import { computeGeoref, type GeorefResult } from './georef.ts';
import { getGround } from './ground.ts';
import { getProcedures } from './procedures.ts';
import { CHART_HOSTS, getCharts } from './charts.ts';

const USER_AGENT = { 'User-Agent': 'NaviCharts (usage personnel)' };

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** N'accepte que les documents PDF des services d'information aéronautique pris en charge */
function chartPdfUrl(target: string | null): URL | null {
  try {
    const url = new URL(target ?? '');
    const ok = url.protocol === 'https:' && CHART_HOSTS.has(url.hostname) && /\.pdf$/i.test(url.pathname);
    return ok ? url : null;
  } catch {
    return null;
  }
}

// Relaie un PDF officiel du SIA vers le navigateur (le SIA n'autorise ni CORS ni l'affichage en iframe).
// Rien n'est conservé côté serveur.
async function proxyPdf(target: string | null, res: ServerResponse) {
  const url = chartPdfUrl(target);
  if (!url) return sendJson(res, 403, { error: 'Seuls les PDF des services d’information aéronautique pris en charge sont autorisés' });

  const upstream = await fetch(url, { headers: USER_AGENT });
  if (!upstream.ok || !upstream.body) {
    return sendJson(res, upstream.status === 404 ? 404 : 502, { error: `SIA : HTTP ${upstream.status}` });
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Cache-Control': 'private, max-age=86400',
    ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length')! } : {}),
  });
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
}

// Calage automatique, calculé une fois par carte (l'URL contient le cycle AIRAC)
const georefCache = new Map<string, Promise<GeorefResult | null>>();

async function georef(params: URLSearchParams, res: ServerResponse) {
  const url = chartPdfUrl(params.get('url'));
  if (!url) return sendJson(res, 403, { error: 'Seuls les PDF des services d’information aéronautique pris en charge sont autorisés' });
  const lon = Number(params.get('lon'));
  const lat = Number(params.get('lat'));
  const expected: [number, number] | undefined = Number.isFinite(lon) && Number.isFinite(lat) && params.has('lon') ? [lon, lat] : undefined;

  const key = `${url.href}|${expected?.join(',') ?? ''}`;
  let entry = georefCache.get(key);
  if (!entry) {
    entry = fetch(url, { headers: USER_AGENT }).then(async (r) => {
      if (!r.ok) throw new Error(`SIA : HTTP ${r.status}`);
      return computeGeoref(new Uint8Array(await r.arrayBuffer()), expected);
    });
    entry.catch(() => georefCache.delete(key));
    georefCache.set(key, entry);
  }
  sendJson(res, 200, { georef: await entry });
}

/** Retourne false si la requête ne concerne pas l'API. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    if (url.pathname === '/api/airac') {
      const c = currentCycle();
      sendJson(res, 200, { ident: c.ident, effective: c.effective, expires: c.expires });
      return true;
    }

    const charts = url.pathname.match(/^\/api\/charts\/([A-Z]{4})$/);
    if (charts) {
      sendJson(res, 200, await getCharts(charts[1]));
      return true;
    }

    const ground = url.pathname.match(/^\/api\/ground\/([A-Z0-9-]{2,12})$/);
    if (ground) {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || !url.searchParams.has('lat')) {
        sendJson(res, 400, { error: 'Position invalide' });
        return true;
      }
      try {
        sendJson(res, 200, { type: 'FeatureCollection', features: await getGround(ground[1], lat, lon) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'OpenStreetMap indisponible' });
      }
      return true;
    }

    // SID et STAR (tableaux de codage de l'eAIP France)
    const procedures = url.pathname.match(/^\/api\/procedures\/(LF[A-Z]{2})$/);
    if (procedures) {
      sendJson(res, 200, await getProcedures(procedures[1]));
      return true;
    }

    if (url.pathname === '/api/georef') {
      await georef(url.searchParams, res);
      return true;
    }

    if (url.pathname === '/api/pdf') {
      await proxyPdf(url.searchParams.get('url'), res);
      return true;
    }

    sendJson(res, 404, { error: 'Route inconnue' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 502, { error: 'Le SIA est injoignable pour le moment' });
    else res.destroy();
  }
  return true;
}
