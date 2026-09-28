// Recherche des points de report et balises pour la barre de recherche.
// En dev : points et balises autorouter de toute l'Europe (test local, voir scripts/autorouter-search.ts) ;
// sinon : nos données (France).
import type { FeatureCollection, Point } from 'geojson';
import type { LngLat } from './georef.ts';

export interface NavResult {
  ident: string;
  kind: 'waypoint' | 'navaid';
  /** « VOR-DME », « NDB »… pour une balise */
  type?: string;
  name?: string;
  lngLat: LngLat;
}

const LIMIT = 8;

let local: Promise<NavResult[]> | null = null;

function loadLocal(): Promise<NavResult[]> {
  const load = (name: string, kind: NavResult['kind']) =>
    fetch(`/data/${name}.geojson`)
      .then((res): Promise<FeatureCollection<Point>> | FeatureCollection<Point> => (res.ok ? res.json() : { type: 'FeatureCollection', features: [] }))
      .then((fc) =>
        fc.features.map((f) => ({
          ident: String(f.properties?.ident ?? ''),
          kind,
          type: f.properties?.type,
          name: f.properties?.name,
          lngLat: f.geometry.coordinates as LngLat,
        })),
      );
  local ??= Promise.all([load('navaids', 'navaid'), load('waypoints', 'waypoint')]).then((lists) => lists.flat());
  return local;
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

/** Pertinence, sur la même échelle que les aérodromes (voir scoreAirports) : 100 identifiant exact, 60 début
 * d'identifiant, 30 nom ; balises un peu devant les points de report */
export function navScore(r: NavResult, query: string): number {
  const q = normalize(query.trim());
  let score = 0;
  if (r.ident === q) score = 100;
  else if (r.ident.startsWith(q)) score = 60;
  else if (r.name && normalize(r.name).includes(q)) score = 30;
  return score && score + (r.kind === 'navaid' ? 5 : 0);
}

async function searchLocal(query: string): Promise<NavResult[]> {
  const scored: { r: NavResult; score: number }[] = [];
  for (const r of await loadLocal()) {
    const score = navScore(r, query);
    if (score) scored.push({ r, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.r.ident.localeCompare(b.r.ident))
    .slice(0, LIMIT)
    .map((s) => s.r);
}

/** Points et balises correspondant à la recherche, les plus proches de `near` d'abord à pertinence égale */
export async function searchNav(query: string, near?: LngLat, signal?: AbortSignal): Promise<NavResult[]> {
  if (query.trim().length < 2) return [];
  if (!import.meta.env.DEV) return searchLocal(query);
  const params = new URLSearchParams({ q: query.trim() });
  if (near) {
    params.set('lon', String(near[0]));
    params.set('lat', String(near[1]));
  }
  const res = await fetch(`/dev/autorouter/search?${params}`, { signal });
  return res.ok ? res.json() : searchLocal(query);
}
