// Routes /api/* partagées entre le serveur de développement (plugin Vite) et le serveur de production.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { currentCycle } from './airac.ts';
import { computeGeoref, type GeorefResult } from './georef.ts';
import { getGround } from './ground.ts';
import { getAtis, getPilot, getTraffic } from './ivao.ts';
import { getMetars, getNearestMetar } from './metar.ts';
import { getNatTracks } from './nat.ts';
import { getNotams } from './notam.ts';
import { getProcedures } from './procedures.ts';
import { getAuroraProcedures } from './aurora.ts';
import { getSectorProcedures } from './sectorfiles.ts';
import { SIA_ICAO } from './sia.ts';
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

    // Trafic IVAO en direct, et session de vol d'un membre (VID)
    if (url.pathname === '/api/ivao') {
      try {
        sendJson(res, 200, await getTraffic());
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'IVAO indisponible' });
      }
      return true;
    }
    const ivaoAtis = url.pathname.match(/^\/api\/ivao\/atis\/([A-Z]{4})$/);
    if (ivaoAtis) {
      try {
        sendJson(res, 200, { atis: await getAtis(ivaoAtis[1]) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'IVAO indisponible' });
      }
      return true;
    }
    const ivaoPilot = url.pathname.match(/^\/api\/ivao\/pilot\/(\d{3,8})$/);
    if (ivaoPilot) {
      try {
        sendJson(res, 200, await getPilot(Number(ivaoPilot[1])));
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'IVAO indisponible' });
      }
      return true;
    }

    // NOTAM d'un aérodrome (API FAA, identifiants dans .env)
    const notams = url.pathname.match(/^\/api\/notams\/([A-Z0-9]{4})$/);
    if (notams) {
      sendJson(res, 200, await getNotams(notams[1]));
      return true;
    }

    // Tracks de l'Atlantique Nord (FAA NMS)
    if (url.pathname === '/api/nat') {
      try {
        sendJson(res, 200, { tracks: await getNatTracks() });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'Tracks NAT indisponibles' });
      }
      return true;
    }

    // METAR de la station la plus proche d'un point (aérodrome sans METAR)
    if (url.pathname === '/api/metar/nearest') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      const exclude = url.searchParams.get('exclude') ?? undefined;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        sendJson(res, 400, { error: 'Position attendue' });
        return true;
      }
      try {
        sendJson(res, 200, { nearby: await getNearestMetar(lat, lon, exclude && /^[A-Z0-9]{4}$/.test(exclude) ? exclude : undefined) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'Météo indisponible' });
      }
      return true;
    }

    // METAR (au plus 4 aérodromes par requête)
    if (url.pathname === '/api/metar') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((i) => /^[A-Z0-9]{4}$/.test(i)).slice(0, 4);
      if (!ids.length) {
        sendJson(res, 400, { error: 'Indicatifs OACI attendus' });
        return true;
      }
      try {
        sendJson(res, 200, { metars: await getMetars(ids) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : 'Météo indisponible' });
      }
      return true;
    }

    // SID, STAR et approches : tableaux de codage des eAIP du SIA (métropole, outre-mer), sector files IVAO (dépôts GitHub,
    // puis sector files Aurora copiés en local)
    const procedures = url.pathname.match(/^\/api\/procedures\/([A-Z0-9]{3,4})$/);
    if (procedures) {
      const ident = procedures[1];
      const data = SIA_ICAO.test(ident)
        ? await getProcedures(ident)
        : ((await getSectorProcedures(ident).catch(() => null)) ?? (await getAuroraProcedures(ident).catch(() => null)));
      if (data) sendJson(res, 200, data);
      else sendJson(res, 404, { error: 'Aucune procédure pour cet aérodrome' });
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
