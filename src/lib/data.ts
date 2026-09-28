import type { ControlPoint } from './georef.ts';
import type { Airport, AirportCharts, AirportDetails } from './types.ts';

interface Feature<P> {
  geometry: { coordinates: [number, number] };
  properties: P;
}

let airportsPromise: Promise<Airport[]> | null = null;
const detailsByCountry = new Map<string, Promise<Record<string, AirportDetails>>>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function loadAirports(): Promise<Airport[]> {
  airportsPromise ??= getJson<{ features: Feature<Omit<Airport, 'lon' | 'lat'>>[] }>('/data/airports.geojson').then(
    (fc) =>
      fc.features.map((f) => ({
        ...f.properties,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      })),
  );
  return airportsPromise;
}

/** Fiche détaillée d'un aérodrome (fichiers découpés par pays, chargés à la demande) */
export async function loadDetails(airport: Pick<Airport, 'ident' | 'country'>): Promise<AirportDetails | null> {
  let bucket = detailsByCountry.get(airport.country);
  if (!bucket) {
    bucket = getJson<Record<string, AirportDetails>>(`/data/details/${encodeURIComponent(airport.country)}.json`);
    bucket.catch(() => detailsByCountry.delete(airport.country));
    detailsByCountry.set(airport.country, bucket);
  }
  return (await bucket)[airport.ident] ?? null;
}

export function fetchCharts(icao: string): Promise<AirportCharts> {
  return getJson(`/api/charts/${icao}`);
}

export interface AutoGeoref {
  points: ControlPoint[];
  rmsMeters: number;
  graduations: number;
}

/** Calage automatique d'une carte à partir de ses graduations (null si la carte n'en a pas de lisibles) */
export async function fetchAutoGeoref(chartUrl: string, airport?: Airport): Promise<AutoGeoref | null> {
  const params = new URLSearchParams({ url: chartUrl });
  if (airport) {
    params.set('lon', String(airport.lon));
    params.set('lat', String(airport.lat));
  }
  return (await getJson<{ georef: AutoGeoref | null }>(`/api/georef?${params}`)).georef;
}

export interface Notam {
  id: string;
  number: string;
  type: string;
  category: string;
  start: string | null;
  end: string | null;
  estimated: boolean;
  schedule: string | null;
  text: string;
  /** Traduction française (NOTAM émis en France) */
  textFr: string | null;
  lower: string | null;
  upper: string | null;
}

export type NotamResult = { status: 'ok'; source: string; issued: string | null; notams: Notam[] } | { status: 'error'; message: string };

export function fetchNotams(icao: string): Promise<NotamResult> {
  return getJson(`/api/notams/${icao}`);
}

export function pdfUrl(chartUrl: string): string {
  return `/api/pdf?url=${encodeURIComponent(chartUrl)}`;
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Aérodromes correspondant à la recherche, avec leur pertinence (100 code exact, 60 début de code, 30 nom ou ville) */
export function scoreAirports(airports: Airport[], query: string, limit = 8): { a: Airport; score: number }[] {
  const q = normalize(query.trim());
  if (!q) return [];
  const scored: { a: Airport; score: number }[] = [];
  for (const a of airports) {
    const codes = [a.icao, a.iata, a.ident].filter(Boolean).map(normalize);
    let score = 0;
    if (codes.includes(q)) score = 100;
    else if (codes.some((c) => c.startsWith(q))) score = 60;
    else if (normalize(a.name).includes(q) || normalize(a.city).includes(q)) score = 30;
    if (!score) continue;
    // À pertinence égale, les grands aérodromes et ceux dotés de cartes SIA d'abord
    score += { large_airport: 6, medium_airport: 4, small_airport: 2, seaplane_base: 1, heliport: 0 }[a.type];
    if (a.icao) score += 3;
    scored.push({ a, score });
  }
  return scored
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name))
    .slice(0, limit);
}
