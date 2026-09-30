// Plan de l'aérodrome au sol (taxiways, aires de trafic, points d'attente, postes de stationnement)
// d'après les sector files IVAO quand ils couvrent l'aérodrome (Amérique du Nord, voir sectorfiles.ts), sinon
// d'après OpenStreetMap, via l'API Overpass. Résultat mis en cache sur disque par aérodrome.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAuroraGround } from './aurora.ts';
import { getSectorGround } from './sectorfiles.ts';

const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache', 'ground');
const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const RADIUS_KM = 5;

// Le serveur principal est souvent saturé : on essaie les miroirs à tour de rôle
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const USER_AGENT = 'NaviCharts/0.1 (simulation de vol, usage personnel)';

type LngLat = [number, number];
type Geometry = { type: 'Point'; coordinates: LngLat } | { type: 'LineString'; coordinates: LngLat[] } | { type: 'Polygon'; coordinates: LngLat[][] };

export interface GroundFeature {
  type: 'Feature';
  geometry: Geometry;
  properties: {
    /** `building` et `pier` (passerelles) : sector files IVAO uniquement */
    kind: 'taxiway' | 'taxiway-label' | 'runway' | 'apron' | 'building' | 'pier' | 'holding' | 'stand';
    ref: string | null;
    /** Point d'attente : « runway », « ILS », « intermediate »… */
    holdingType?: string | null;
    /** Orientation du symbole (degrés), perpendiculaire au taxiway */
    bearing?: number;
  };
}

interface OsmElement {
  type: 'node' | 'way';
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

async function overpass(query: string): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const server of SERVERS) {
    try {
      const res = await fetch(server, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      // En cas de surcharge, Overpass répond parfois 200 avec une page HTML d'erreur
      if (!res.ok || !text.startsWith('{')) throw new Error(`${server} : HTTP ${res.status}`);
      return JSON.parse(text).elements ?? [];
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Overpass indisponible (${lastError instanceof Error ? lastError.message : lastError})`);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const toLngLat = (p: { lat: number; lon: number }): LngLat => [round(p.lon), round(p.lat)];

function bearingDeg([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const θ = Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
  return ((θ * 180) / Math.PI + 360) % 360;
}

/** Direction du tronçon de taxiway le plus proche d'un point (pour orienter le symbole de point d'attente) */
function nearestTaxiwayBearing(point: LngLat, taxiways: LngLat[][]): number | null {
  const kx = Math.cos((point[1] * Math.PI) / 180);
  let best: { d: number; bearing: number } | null = null;
  for (const line of taxiways) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const dx = (bx - ax) * kx;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, (((point[0] - ax) * kx) * dx + (point[1] - ay) * dy) / len2));
      const d = Math.hypot((point[0] - ax) * kx - t * dx, point[1] - ay - t * dy);
      if (!best || d < best.d) best = { d, bearing: bearingDeg(line[i - 1], line[i]) };
    }
  }
  return best && best.d < 0.0005 ? best.bearing : null; // ~50 m
}

async function fetchGround(lat: number, lon: number): Promise<GroundFeature[]> {
  const dLat = RADIUS_KM / 111;
  const dLon = RADIUS_KM / (111 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(5)).join(',');
  const elements = await overpass(
    `[out:json][timeout:25];(` +
      `way["aeroway"~"^(taxiway|taxilane|runway|apron|holding_position)$"](${bbox});` +
      `node["aeroway"~"^(holding_position|parking_position|gate)$"](${bbox});` +
      `);out geom;`,
  );

  const features: GroundFeature[] = [];
  const taxiwayLines: LngLat[][] = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    const ref = tags.ref ?? null;
    if (e.type === 'way' && e.geometry && e.geometry.length >= 2) {
      const coords = e.geometry.map(toLngLat);
      const closed = coords.length > 3 && coords[0][0] === coords.at(-1)![0] && coords[0][1] === coords.at(-1)![1];
      switch (tags.aeroway) {
        case 'apron':
          if (closed) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: { kind: 'apron', ref } });
          break;
        case 'taxiway':
        case 'taxilane':
          taxiwayLines.push(coords);
          features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'taxiway', ref } });
          break;
        case 'runway':
          if (!closed) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'runway', ref } });
          break;
        case 'holding_position':
          // Point d'attente cartographié en travers du taxiway : on garde son milieu, orienté selon le trait
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: coords[Math.floor(coords.length / 2)] },
            properties: { kind: 'holding', ref, holdingType: tags['holding_position:type'] ?? null, bearing: bearingDeg(coords[0], coords.at(-1)!) },
          });
          break;
      }
    } else if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
      const at = toLngLat({ lat: e.lat, lon: e.lon });
      if (tags.aeroway === 'holding_position') {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: at },
          properties: { kind: 'holding', ref, holdingType: tags['holding_position:type'] ?? null },
        });
      } else if (ref) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { kind: 'stand', ref } });
      }
    }
  }

  // Symbole de point d'attente perpendiculaire au taxiway (si l'orientation n'est pas déjà connue)
  for (const f of features) {
    if (f.properties.kind !== 'holding' || f.properties.bearing !== undefined || f.geometry.type !== 'Point') continue;
    const along = nearestTaxiwayBearing(f.geometry.coordinates, taxiwayLines);
    f.properties.bearing = along === null ? 0 : (along + 90) % 360;
  }
  return features;
}

const pending = new Map<string, Promise<GroundFeature[]>>();
// Après un échec (Overpass saturé), on attend avant de réessayer pour ne pas le solliciter en boucle
const RETRY_DELAY_MS = 2 * 60 * 1000;
const failures = new Map<string, { at: number; error: Error }>();

export async function getGround(ident: string, lat: number, lon: number): Promise<GroundFeature[]> {
  const sector = (await getSectorGround(ident).catch(() => null)) ?? (await getAuroraGround(ident).catch(() => null));
  if (sector?.length) return sector;

  const file = path.join(CACHE_DIR, `${ident}.json`);
  const fresh = await stat(file).then((s) => Date.now() - s.mtimeMs < CACHE_MAX_AGE_MS, () => false);
  if (fresh) return JSON.parse(await readFile(file, 'utf8'));

  const failure = failures.get(ident);
  if (failure && Date.now() - failure.at < RETRY_DELAY_MS) throw failure.error;

  let entry = pending.get(ident);
  if (!entry) {
    entry = fetchGround(lat, lon).then(async (features) => {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(features));
      failures.delete(ident);
      return features;
    });
    entry.catch((error: Error) => failures.set(ident, { at: Date.now(), error }));
    entry.finally(() => pending.delete(ident)).catch(() => undefined);
    pending.set(ident, entry);
  }
  return entry;
}
