// Lecture d'une route au format plan de vol OACI (case 15), par exemple :
//   LFPG/27L N0481F350 AGOP6A AGOPA DCT ARKIP DCT LMG DCT MAGEC MAGE2S LFBZ/27
// Les points sont résolus dans les données chargées (points de report et routes de l'eAIP France, balises et
// aérodromes d'Europe). Les SID et STAR ne sont pas décrites point par point : elles sont représentées par un
// segment direct entre la piste et le premier (ou dernier) point en route.
import type { FeatureCollection } from 'geojson';
import { loadAirports, loadDetails } from './data.ts';
import type { LngLat } from './georef.ts';
import type { Airport } from './types.ts';

export type PointKind = 'airport' | 'runway' | 'waypoint' | 'navaid' | 'coordinates';

export interface RoutePoint {
  ident: string;
  kind: PointKind;
  lngLat: LngLat;
  name?: string;
}

export interface RouteLeg {
  from: RoutePoint;
  to: RoutePoint;
  /** « DCT », nom de route aérienne, de SID ou de STAR */
  via: string;
  procedure: boolean;
  distanceNm: number;
  courseT: number;
}

export interface Terminal {
  airport: Airport;
  runway: string | null;
}

export interface FlightRoute {
  departure: Terminal | null;
  arrival: Terminal | null;
  speed: string | null;
  level: string | null;
  sid: string | null;
  star: string | null;
  /** Premier et dernier point en route (points de transition de la SID et de la STAR) */
  sidFix: string | null;
  starFix: string | null;
  legs: RouteLeg[];
  totalNm: number;
  /** Éléments de la route qui n'ont pas pu être localisés */
  unresolved: string[];
}

// ───────── Données de navigation ─────────

interface Candidate {
  kind: PointKind;
  lngLat: LngLat;
  name?: string;
}

interface NavData {
  byIdent: Map<string, Candidate[]>;
  /** Routes aériennes : pour chaque nom, voisins de chaque point (clé de coordonnées) */
  airways: Map<string, Map<string, string[]>>;
  /** Identifiant des points connus, par clé de coordonnées */
  identAt: Map<string, string>;
  airports: Airport[];
}

type PointFeature = { geometry: { coordinates: LngLat }; properties: { ident: string; name?: string; type?: string } };
type LineFeature = { geometry: { coordinates: LngLat[] }; properties: { name: string } };

const key = ([lon, lat]: LngLat) => `${lon.toFixed(4)},${lat.toFixed(4)}`;

async function geojson<T>(name: string): Promise<T[]> {
  const res = await fetch(`/data/${name}.geojson`);
  return res.ok ? (await res.json()).features : [];
}

let navData: Promise<NavData> | null = null;

function loadNavData(): Promise<NavData> {
  navData ??= (async () => {
    const [waypoints, navaids, airways, airports] = await Promise.all([
      geojson<PointFeature>('waypoints'),
      geojson<PointFeature>('navaids'),
      geojson<LineFeature>('airways'),
      loadAirports(),
    ]);
    const byIdent = new Map<string, Candidate[]>();
    const identAt = new Map<string, string>();
    const add = (ident: string, c: Candidate) => {
      byIdent.set(ident, [...(byIdent.get(ident) ?? []), c]);
      identAt.set(key(c.lngLat), ident);
    };
    for (const f of waypoints) add(f.properties.ident, { kind: 'waypoint', lngLat: f.geometry.coordinates });
    for (const f of navaids) {
      add(f.properties.ident, { kind: 'navaid', lngLat: f.geometry.coordinates, name: `${f.properties.type} ${f.properties.name}` });
    }
    for (const a of airports) if (a.icao) add(a.icao, { kind: 'airport', lngLat: [a.lon, a.lat], name: a.name });

    const graph = new Map<string, Map<string, string[]>>();
    for (const f of airways) {
      const [a, b] = f.geometry.coordinates.map(key);
      const g = graph.get(f.properties.name) ?? new Map<string, string[]>();
      g.set(a, [...(g.get(a) ?? []), b]);
      g.set(b, [...(g.get(b) ?? []), a]);
      graph.set(f.properties.name, g);
    }
    return { byIdent, airways: graph, identAt, airports };
  })();
  return navData;
}

// ───────── Géodésie ─────────

const toRad = (d: number) => (d * Math.PI) / 180;

function distanceNm([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const a = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function courseTrue([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const θ = Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
  return ((θ * 180) / Math.PI + 360) % 360;
}

// ───────── Analyse ─────────

const SPEED_LEVEL = /^[NKM]\d{3,4}(?:[FAM]\d{3}|S\d{4}|VFR)$/;
const PROCEDURE = /^[A-Z]{2,5}\d[A-Z]?$/;
const AIRWAY = /^[A-Z]{1,2}\d{1,4}[A-Z]?$/;
const COORDINATES = /^(\d{2})(\d{2})?([NS])(\d{3})(\d{2})?([EW])$/;
const TERMINAL = /^([A-Z]{4})(?:\/([0-9]{2}[LRC]?))?$/;

function parseCoordinates(token: string): LngLat | null {
  const m = COORDINATES.exec(token);
  if (!m) return null;
  const lat = (Number(m[1]) + Number(m[2] ?? 0) / 60) * (m[3] === 'S' ? -1 : 1);
  const lon = (Number(m[4]) + Number(m[5] ?? 0) / 60) * (m[6] === 'W' ? -1 : 1);
  return [lon, lat];
}

/** Seuil de la piste demandée (coordonnées OurAirports), sinon le point de référence de l'aérodrome */
async function terminalPoint(t: Terminal): Promise<RoutePoint> {
  const fallback: RoutePoint = { ident: t.airport.icao || t.airport.ident, kind: 'airport', lngLat: [t.airport.lon, t.airport.lat], name: t.airport.name };
  if (!t.runway) return fallback;
  const details = await loadDetails(t.airport);
  const end = details?.runways.flatMap((r) => r.ends).find((e) => e.ident === t.runway);
  if (!end || end.lat === null || end.lon === null) return fallback;
  return { ident: `${fallback.ident} ${t.runway}`, kind: 'runway', lngLat: [end.lon, end.lat], name: t.airport.name };
}

export async function parseRoute(text: string): Promise<FlightRoute> {
  const nav = await loadNavData();
  const tokens = text.toUpperCase().replace(/[()-]/g, ' ').split(/\s+/).filter(Boolean);

  const terminal = (token: string | undefined): Terminal | null => {
    const m = token ? TERMINAL.exec(token) : null;
    const airport = m && nav.airports.find((a) => a.icao === m[1]);
    return airport ? { airport, runway: m[2] ?? null } : null;
  };

  const departure = terminal(tokens[0]);
  if (departure) tokens.shift();
  const arrival = terminal(tokens.at(-1));
  if (arrival) tokens.pop();

  const route: FlightRoute = {
    departure,
    arrival,
    speed: null,
    level: null,
    sid: null,
    star: null,
    sidFix: null,
    starFix: null,
    legs: [],
    totalNm: 0,
    unresolved: [],
  };

  const points: { point: RoutePoint; via: string; procedure: boolean }[] = [];
  let previous: LngLat | null = departure ? [departure.airport.lon, departure.airport.lat] : null;
  let pendingVia = 'DCT';

  const resolve = (ident: string): RoutePoint | null => {
    const coords = parseCoordinates(ident);
    if (coords) return { ident, kind: 'coordinates', lngLat: coords };
    const candidates = nav.byIdent.get(ident);
    if (!candidates?.length) return null;
    // Identifiants homonymes : on retient le plus proche du point précédent
    const best = previous ? candidates.reduce((a, b) => (distanceNm(previous!, a.lngLat) <= distanceNm(previous!, b.lngLat) ? a : b)) : candidates[0];
    return { ident, ...best };
  };

  const push = (point: RoutePoint, via: string, procedure = false) => {
    points.push({ point, via, procedure });
    previous = point.lngLat;
  };

  for (let i = 0; i < tokens.length; i++) {
    // « ARMAL/N0450F370 » : changement de vitesse ou de niveau sur un point
    const token = tokens[i].split('/')[0];
    if (!token || token === 'IFR' || token === 'VFR') continue;
    if (SPEED_LEVEL.test(tokens[i])) {
      const m = /^([NKM]\d{3,4})(.+)$/.exec(tokens[i])!;
      route.speed ??= m[1];
      route.level ??= m[2];
      continue;
    }
    if (token === 'DCT') {
      pendingVia = 'DCT';
      continue;
    }
    const point = resolve(token);
    if (point) {
      push(point, pendingVia);
      pendingVia = 'DCT';
      continue;
    }
    // SID juste après le départ, STAR juste avant l'arrivée
    if (PROCEDURE.test(token) && points.length === 0 && !route.sid) {
      route.sid = token;
      continue;
    }
    if (PROCEDURE.test(token) && i === tokens.length - 1) {
      route.star = token;
      continue;
    }
    // Route aérienne : on la déroule jusqu'au point de sortie
    const graph = AIRWAY.test(token) ? nav.airways.get(token) : undefined;
    const exit = tokens[i + 1]?.split('/')[0];
    const entry = points.at(-1)?.point;
    if (graph && entry && exit) {
      const path = walkAirway(graph, key(entry.lngLat), exit, nav.identAt);
      if (path) {
        for (const k of path) {
          const ident = nav.identAt.get(k)!;
          const [lon, lat] = k.split(',').map(Number);
          push(resolve(ident) ?? { ident, kind: 'waypoint', lngLat: [lon, lat] }, token);
        }
        i++; // le point de sortie a été ajouté
        continue;
      }
    }
    if (AIRWAY.test(token) && !graph) {
      // Route hors des données (étranger) : liaison directe vers le point suivant
      route.unresolved.push(token);
      pendingVia = token;
      continue;
    }
    route.unresolved.push(token);
  }

  route.sidFix = points[0]?.point.ident ?? null;
  route.starFix = points.at(-1)?.point.ident ?? null;

  // Segments de procédure : piste → premier point (SID) et dernier point → piste (STAR)
  const start = departure ? await terminalPoint(departure) : null;
  const end = arrival ? await terminalPoint(arrival) : null;
  const sequence = [
    ...(start ? [{ point: start, via: '', procedure: false }] : []),
    ...points.map((p, index) => (index === 0 && start ? { ...p, via: route.sid ?? 'DCT', procedure: Boolean(route.sid) } : p)),
    ...(end ? [{ point: end, via: route.star ?? 'DCT', procedure: Boolean(route.star) }] : []),
  ];

  for (let i = 1; i < sequence.length; i++) {
    const from = sequence[i - 1].point;
    const to = sequence[i].point;
    const distance = distanceNm(from.lngLat, to.lngLat);
    route.legs.push({ from, to, via: sequence[i].via, procedure: sequence[i].procedure, distanceNm: distance, courseT: courseTrue(from.lngLat, to.lngLat) });
    route.totalNm += distance;
  }
  return route;
}

/** Parcours d'une route aérienne depuis le point d'entrée jusqu'au point de sortie (points intermédiaires inclus) */
function walkAirway(graph: Map<string, string[]>, from: string, exitIdent: string, identAt: Map<string, string>): string[] | null {
  if (!graph.has(from)) return null;
  const cameFrom = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    if (current !== from && identAt.get(current) === exitIdent) {
      const path: string[] = [];
      for (let k: string | null = current; k && k !== from; k = cameFrom.get(k) ?? null) path.unshift(k);
      return path;
    }
    for (const next of graph.get(current) ?? []) {
      if (!cameFrom.has(next)) {
        cameFrom.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

// ───────── Affichage ─────────

export function routeGeoJson(route: FlightRoute): FeatureCollection {
  const points = route.legs.length ? [route.legs[0].from, ...route.legs.map((l) => l.to)] : [];
  return {
    type: 'FeatureCollection',
    features: [
      ...route.legs.map((leg) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [leg.from.lngLat, leg.to.lngLat] },
        properties: { via: leg.via, procedure: leg.procedure },
      })),
      ...points.map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: p.lngLat },
        properties: { ident: p.ident, kind: p.kind },
      })),
    ],
  };
}
