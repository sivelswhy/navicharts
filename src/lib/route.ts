// Lecture d'une route au format plan de vol OACI (case 15), par exemple :
//   LFPG/27L N0481F350 AGOP6A AGOPA DCT ARKIP DCT LMG DCT MAGEC MAGE2S LFBZ/27
// Les points sont résolus dans les données chargées (points de report et routes de l'eAIP France, balises et
// aérodromes d'Europe). Les SID et STAR des aérodromes français sont tracées point par point d'après les tableaux
// de codage de l'eAIP ; ailleurs, elles sont représentées par un segment direct entre la piste et la route.
// En dev, les SID et STAR viennent des tuiles autorouter (test local), pour tous les aérodromes couverts.
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

/** Tracé en route, procédure publiée (SID/STAR), ou segment approximatif (procédure inconnue, fin d'arrivée) */
export type LegStyle = 'route' | 'procedure' | 'approximate';
/** Phase du vol, pour la couleur du tracé : départ (SID), croisière, arrivée (STAR et approche) */
export type LegPhase = 'departure' | 'enroute' | 'arrival';

export interface RouteLeg {
  from: RoutePoint;
  to: RoutePoint;
  /** « DCT », nom de route aérienne, de SID ou de STAR */
  via: string;
  style: LegStyle;
  phase: LegPhase;
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
  /** Remarques sur le tracé (procédure remplacée par sa révision en vigueur, procédure non tracée…) */
  notes: string[];
  /** Procédures effectivement tracées, et choix possibles pour la piste de départ / d'arrivée (France) */
  sidUsed: Procedure | null;
  starUsed: Procedure | null;
  sidOptions: Procedure[];
  starOptions: Procedure[];
  departureRunways: string[];
  arrivalRunways: string[];
  /** Approche choisie (nom : « ILS Z »), tracée, et choix possibles pour la piste d'arrivée */
  approach: string | null;
  approachUsed: Approach | null;
  approachOptions: Approach[];
}

// ───────── SID et STAR ─────────

export interface Procedure {
  type: 'SID' | 'STAR';
  name: string;
  ident: string;
  runways: string[];
  fixes: string[];
}

/** Approche aux instruments d'une piste (tableaux de codage INA et FNA de l'eAIP France, voir server/procedures.ts) */
export interface Approach {
  name: string;
  runway: string;
  initial: { iaf: string; fixes: string[] }[];
  final: string[];
  missed: string[];
}

export interface AirportProcedures {
  procedures: Procedure[];
  waypoints: Record<string, LngLat>;
  approaches?: Approach[];
}

/** Pays couverts par les sector files IVAO (voir server/sectorfiles.ts) */
export const SECTOR_FILE_COUNTRIES = new Set(['US', 'CA', 'EC', 'UY', 'JP', 'SG', 'ID', 'TH']);

/** Procédures publiées dans les tableaux de codage de l'eAIP France (non disponibles ailleurs) */
/** Procédures publiées : eAIP France, AIXM du DECEA au Brésil, sector files IVAO dans les autres pays des Amériques */
async function fetchEaipProcedures(airport: Airport): Promise<AirportProcedures | null> {
  // Brésil : fichiers générés depuis l'AIXM du DECEA (scripts/build-decea-procedures.ts)
  // (à défaut, sector files Aurora via l'API ci-dessous)
  if (airport.country === 'BR' && /^[A-Z]{4}$/.test(airport.icao)) {
    const res = await fetch(`/data/procedures/${airport.icao}.json`);
    // Fichier absent : le serveur peut répondre la page de l'application (200, HTML)
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      const decea: AirportProcedures = await res.json();
      if (decea.approaches?.length) return decea;
      // Approches absentes de l'AIXM du DECEA : celles des sector files Aurora, s'il y en a
      const other = await fetch(`/api/procedures/${airport.icao}`).then((r) => (r.ok ? (r.json() as Promise<AirportProcedures>) : null), () => null);
      if (!other?.approaches?.length) return decea;
      return { ...decea, approaches: other.approaches, waypoints: { ...other.waypoints, ...decea.waypoints } };
    }
  }
  // Aérodromes du SIA : métropole et outre-mer (voir server/sia.ts)
  // Tout aérodrome doté d'un code OACI (le serveur répond 404 sans procédures) ; sans code, les petits terrains couverts
  // par les sector files (identifiant FAA…)
  const ident = /^[A-Z]{4}$/.test(airport.icao) ? airport.icao : SECTOR_FILE_COUNTRIES.has(airport.country) ? airport.icao || airport.ident : null;
  if (!ident || !/^[A-Z0-9]{3,4}$/.test(ident)) return null;
  const res = await fetch(`/api/procedures/${ident}`);
  return res.ok ? res.json() : null;
}

/**
 * En dev, procédures reconstituées depuis les tuiles autorouter (test local, voir scripts/autorouter-procedures.ts),
 * pour tout aérodrome couvert. Autorouter ne donne pas les pistes : elles sont reprises de l'eAIP quand la procédure
 * y figure, sinon la procédure est proposée pour toutes les pistes. Repli sur l'eAIP si autorouter n'a rien.
 */
export async function fetchProcedures(airport: Airport): Promise<AirportProcedures | null> {
  const eaip = fetchEaipProcedures(airport).catch(() => null);
  if (!import.meta.env.DEV) return eaip;
  const res = await fetch(`/dev/autorouter/procedures/${airport.icao}?lon=${airport.lon}&lat=${airport.lat}`).catch(() => null);
  const autorouter: AirportProcedures | null = res?.ok ? await res.json() : null;
  if (!autorouter?.procedures.length) return eaip;
  const fromEaip = await eaip;
  if (fromEaip) {
    for (const p of autorouter.procedures) {
      p.runways = [...new Set(fromEaip.procedures.filter((q) => q.type === p.type && q.ident === p.ident).flatMap((q) => q.runways))];
    }
    // Approches : seulement dans l'eAIP (autorouter n'en publie pas), avec leurs points
    autorouter.approaches = fromEaip.approaches;
    autorouter.waypoints = { ...fromEaip.waypoints, ...autorouter.waypoints };
  }
  return autorouter;
}

/**
 * Procédure demandée pour la piste donnée. Si la désignation exacte n'existe plus (révision : MAGE2S → MAGE3S),
 * on retient la même procédure dans sa révision en vigueur.
 */
/** Point de transition d'une procédure : dernier point d'une SID, premier point d'une STAR */
const transitionOf = (p: Procedure) => (p.type === 'SID' ? p.fixes.at(-1) : p.fixes[0]);

type Match = { procedure: Procedure; reason: 'exact' | 'revision' | 'runway' };

/**
 * Procédure demandée pour la piste donnée. À défaut : sa révision en vigueur (MAGE2S → MAGE3S), puis la procédure
 * de cette piste qui dessert le même point de transition (utile quand on change de piste).
 */
function findProcedure(
  data: AirportProcedures,
  type: 'SID' | 'STAR',
  ident: string,
  runway: string | null,
  transition: string | null,
): Match | null {
  const candidates = data.procedures.filter((p) => p.type === type);
  const onRunway = (p: Procedure) => !runway || !p.runways.length || p.runways.includes(runway);
  const revision = new RegExp(`^${ident.replace(/\d(?=[A-Z]?$)/, '\\d')}$`);
  const exact = candidates.find((p) => p.ident === ident && onRunway(p));
  if (exact) return { procedure: exact, reason: 'exact' };
  const revised = candidates.find((p) => revision.test(p.ident) && onRunway(p));
  if (revised) return { procedure: revised, reason: 'revision' };
  const sameTransition = transition ? candidates.find((p) => transitionOf(p) === transition && onRunway(p)) : undefined;
  if (sameTransition) return { procedure: sameTransition, reason: 'runway' };
  const elsewhere = candidates.find((p) => p.ident === ident);
  return elsewhere ? { procedure: elsewhere, reason: 'exact' } : null;
}

/** Procédures proposées pour une piste : celles qui desservent le point de transition de la route d'abord */
function procedureOptions(data: AirportProcedures | null, type: 'SID' | 'STAR', runway: string | null, transition: string | null): Procedure[] {
  if (!data) return [];
  const seen = new Set<string>();
  return data.procedures
    .filter((p) => p.type === type && (!runway || !p.runways.length || p.runways.includes(runway)))
    .filter((p) => !seen.has(p.ident) && seen.add(p.ident))
    .sort((a, b) => Number(transitionOf(b) === transition) - Number(transitionOf(a) === transition) || a.ident.localeCompare(b.ident));
}

function substitutionNote(type: 'SID' | 'STAR', requested: string, match: Match, runway: string | null): string | null {
  const used = `${match.procedure.ident} (${match.procedure.name})`;
  if (match.reason === 'revision') return `${type} ${requested} absente du cycle en vigueur : ${used} tracée à la place.`;
  if (match.reason === 'runway') return `${type} ${requested} ne dessert pas la piste ${runway ?? '—'} : ${used} tracée à la place.`;
  return null;
}

/** Pistes d'un aérodrome (désignations de chaque extrémité) */
async function runwaysOf(t: Terminal | null): Promise<string[]> {
  if (!t) return [];
  const details = await loadDetails(t.airport);
  return (details?.runways ?? []).flatMap((r) => r.ends.map((e) => e.ident)).filter(Boolean);
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
type LineFeature = { geometry: { coordinates: LngLat[] }; properties: { name: string; from?: string | null; to?: string | null } };

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
      // Coordonnées invalides (donnée source défectueuse) : ignorées plutôt que de bloquer toute l'analyse
      if (!Number.isFinite(c.lngLat?.[0]) || !Number.isFinite(c.lngLat?.[1])) return;
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
      if (!f.geometry.coordinates.flat().every(Number.isFinite)) continue;
      const [a, b] = f.geometry.coordinates.map(key);
      // Extrémités nommées dans l'eAIP (balises aux coordonnées légèrement différentes de celles de la base)
      if (f.properties.from && !identAt.has(a)) identAt.set(a, f.properties.from);
      if (f.properties.to && !identAt.has(b)) identAt.set(b, f.properties.to);
      const g = graph.get(f.properties.name) ?? new Map<string, string[]>();
      g.set(a, [...(g.get(a) ?? []), b]);
      g.set(b, [...(g.get(b) ?? []), a]);
      graph.set(f.properties.name, g);
    }
    return { byIdent, airways: graph, identAt, airports };
  })();
  return navData;
}

interface AutorouterNav {
  points: { ident: string; kind: 'waypoint' | 'navaid' | 'airport'; lngLat: LngLat; name?: string }[];
  airways: { name: string; from: LngLat; to: LngLat; fromIdent: string; toIdent: string }[];
}

/**
 * En dev, points et routes aériennes autorouter de la zone du vol (test local, voir scripts/autorouter-nav.ts),
 * à la place de nos points de report ; les routes autorouter remplacent celles de l'eAIP du même nom, comme sur la carte.
 */
async function withAutorouter(base: NavData, departure: Terminal | null, arrival: Terminal | null): Promise<NavData> {
  const ends = [departure, arrival].flatMap((t) => (t ? [[t.airport.lon, t.airport.lat]] : []));
  if (!ends.length) return base;
  const margin = ends.length === 1 ? 4 : 1.5;
  const lons = ends.map((e) => e[0]);
  const lats = ends.map((e) => e[1]);
  // Autorouter ne couvre que l'Europe : zone limitée à celle-ci (un vol Paris–Pékin dépasserait sinon le nombre de
  // tuiles admis par le serveur, et aucune donnée ne viendrait)
  const bbox = [
    Math.max(Math.min(...lons) - margin, -32),
    Math.max(Math.min(...lats) - margin, 34),
    Math.min(Math.max(...lons) + margin, 45),
    Math.min(Math.max(...lats) + margin, 72),
  ];
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return base;
  const res = await fetch(`/dev/autorouter/nav?bbox=${bbox.map((n) => n.toFixed(2)).join(',')}`).catch(() => null);
  const data: AutorouterNav | null = res?.ok ? await res.json() : null;
  if (!data) return base;

  // Nos points de report d'Europe sont en veille pendant les tests (autorouter les remplace) ; ceux d'ailleurs
  // (Asie, Amériques, outre-mer) restent, autorouter ne couvrant que l'Europe
  const inEurope = ([lon, lat]: LngLat) => lat > 34 && lat < 72 && lon > -32 && lon < 45;
  const byIdent = new Map<string, Candidate[]>();
  for (const [ident, candidates] of base.byIdent) {
    const kept = candidates.filter((c) => c.kind !== 'waypoint' || !inEurope(c.lngLat));
    if (kept.length) byIdent.set(ident, kept);
  }
  const identAt = new Map(base.identAt);
  const known = (ident: string, lngLat: LngLat) => byIdent.get(ident)?.some((c) => distanceNm(c.lngLat, lngLat) < 1);
  for (const p of data.points) {
    // Aérodromes : déjà dans nos données ; balises seulement si elles n'y sont pas déjà
    if (p.kind === 'airport' || known(p.ident, p.lngLat)) continue;
    byIdent.set(p.ident, [...(byIdent.get(p.ident) ?? []), { kind: p.kind, lngLat: p.lngLat, name: p.name }]);
  }
  // Tronçons autorouter ajoutés aux routes du même nom : un même nom peut désigner une autre route sur un autre
  // continent (N161, M11…), qu'il ne faut pas effacer
  const airways = new Map([...base.airways].map(([name, g]) => [name, new Map(g)]));
  for (const s of data.airways) {
    if (!airways.has(s.name)) airways.set(s.name, new Map());
    const [a, b] = [key(s.from), key(s.to)];
    identAt.set(a, s.fromIdent);
    identAt.set(b, s.toIdent);
    const g = airways.get(s.name)!;
    g.set(a, [...(g.get(a) ?? []), b]);
    g.set(b, [...(g.get(b) ?? []), a]);
  }
  return { ...base, byIdent, identAt, airways };
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
// Au-delà, le plus proche de plusieurs homonymes est sans doute sur un autre continent ; un point unique est toujours
// retenu (la route peut traverser des pays sans données : le point précédent est alors loin)
const MAX_NAMED_LEG_NM = 2500;
// Au-delà, l'avion suivi n'est plus sur la partie tracée de la route
const OFF_ROUTE_NM = 30;

// ───────── Tracks de l'Atlantique Nord ─────────

type NatPoint = { ident: string } | { lngLat: LngLat; token: string };
interface NatMessageTrack {
  letter: string;
  points: NatPoint[];
  validFrom: string;
  validTo: string;
}

let natTracks: Promise<NatMessageTrack[]> | null = null;

/** Tracks NAT publiés (en vigueur et à venir), relus au plus tous les quarts d'heure */
function loadNatTracks(): Promise<NatMessageTrack[]> {
  natTracks ??= fetch('/api/nat')
    .then((res) => (res.ok ? (res.json() as Promise<{ tracks: NatMessageTrack[] }>) : { tracks: [] }))
    .then((d) => d.tracks, () => []);
  const current = natTracks;
  setTimeout(() => natTracks === current && (natTracks = null), 15 * 60 * 1000);
  return natTracks;
}

/** Track de cette lettre : celui en vigueur, sinon le prochain */
async function natTrack(letter: string): Promise<NatMessageTrack | null> {
  const now = Date.now();
  const same = (await loadNatTracks()).filter((t) => t.letter === letter).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return same.find((t) => Date.parse(t.validFrom) <= now && now < Date.parse(t.validTo)) ?? same.find((t) => Date.parse(t.validFrom) > now) ?? null;
}

/** « 62/20 » (degrés), « 6230/30 » (degrés et minutes) → « 62N020W », forme plan de vol */
const natLabel = (token: string) => {
  const [lat, lon] = token.split('/');
  return `${lat.slice(0, 2)}${lat.slice(2) || ''}N${lon.padStart(3, '0')}W`;
};

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

export async function parseRoute(text: string, options: { approach?: string | null } = {}): Promise<FlightRoute> {
  const base = await loadNavData();
  const tokens = text.toUpperCase().replace(/[()-]/g, ' ').split(/\s+/).filter(Boolean);

  const terminal = (token: string | undefined): Terminal | null => {
    const m = token ? TERMINAL.exec(token) : null;
    const airport = m && base.airports.find((a) => a.icao === m[1]);
    return airport ? { airport, runway: m[2] ?? null } : null;
  };

  const departure = terminal(tokens[0]);
  if (departure) tokens.shift();
  const arrival = terminal(tokens.at(-1));
  if (arrival) tokens.pop();
  const nav = import.meta.env.DEV ? await withAutorouter(base, departure, arrival) : base;

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
    notes: [],
    sidUsed: null,
    starUsed: null,
    sidOptions: [],
    starOptions: [],
    departureRunways: [],
    arrivalRunways: [],
    approach: options.approach ?? null,
    approachUsed: null,
    approachOptions: [],
  };

  const points: { point: RoutePoint; via: string }[] = [];
  let previous: LngLat | null = departure ? [departure.airport.lon, departure.airport.lat] : null;
  let pendingVia = 'DCT';

  const resolve = (ident: string): RoutePoint | null => {
    const coords = parseCoordinates(ident);
    if (coords) return { ident, kind: 'coordinates', lngLat: coords };
    const candidates = nav.byIdent.get(ident);
    if (!candidates?.length) return null;
    // Identifiants homonymes : on retient le plus proche du point précédent, s'il est plausible
    const best = previous ? candidates.reduce((a, b) => (distanceNm(previous!, a.lngLat) <= distanceNm(previous!, b.lngLat) ? a : b)) : candidates[0];
    if (previous && candidates.length > 1 && best.kind !== 'airport' && distanceNm(previous, best.lngLat) > MAX_NAMED_LEG_NM) return null;
    return { ident, ...best };
  };

  const push = (point: RoutePoint, via: string) => {
    points.push({ point, via });
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
    // Track de l'Atlantique Nord (« NATB ») : ses points, du point d'entrée au point de sortie
    if (/^NAT[A-Z]$/.test(token)) {
      const track = await natTrack(token.slice(3));
      const entry = points.at(-1)?.point.ident;
      const exitIdent = tokens[i + 1]?.split('/')[0];
      const named = (p: NatPoint) => ('ident' in p ? p.ident : null);
      const list = track?.points ?? [];
      const from = list.findIndex((p) => named(p) === entry);
      const to = list.findIndex((p) => named(p) === exitIdent);
      if (track && to >= 0) {
        // Entrée absente du track : depuis son premier point (dans le sens du vol)
        const start = from >= 0 ? from : to > 0 ? 0 : list.length - 1;
        const step = to >= start ? 1 : -1;
        for (let k = start + (from >= 0 ? step : 0); k !== to + step; k += step) {
          const p = list[k];
          const point: RoutePoint | null = 'ident' in p ? resolve(p.ident) : { ident: natLabel(p.token), kind: 'coordinates', lngLat: p.lngLat };
          if (point) push(point, token);
        }
        i++; // le point de sortie a été ajouté
        continue;
      }
      route.notes.push(
        track
          ? `Track NAT ${token.slice(3)} du jour : ne passe pas par ${exitIdent ?? '—'} (les tracks changent deux fois par jour) : segment direct.`
          : `Track NAT ${token.slice(3)} non publié actuellement : segment direct.`,
      );
      pendingVia = token;
      continue;
    }

    // Route aérienne : on la déroule jusqu'au point de sortie
    const graph = AIRWAY.test(token) ? nav.airways.get(token) : undefined;
    const exit = tokens[i + 1]?.split('/')[0];
    const entry = points.at(-1)?.point;
    if (graph && entry && exit) {
      // Point d'entrée : mêmes coordonnées, sinon nœud de la route portant le même identifiant
      const start = graph.has(key(entry.lngLat)) ? key(entry.lngLat) : [...graph.keys()].find((k) => nav.identAt.get(k) === entry.ident);
      const path = start ? walkAirway(graph, start, exit, nav.identAt) : null;
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

  const start = departure ? await terminalPoint(departure) : null;
  const end = arrival ? await terminalPoint(arrival) : null;
  const [depProcedures, arrProcedures, departureRunways, arrivalRunways] = await Promise.all([
    departure ? fetchProcedures(departure.airport) : null,
    arrival ? fetchProcedures(arrival.airport) : null,
    runwaysOf(departure),
    runwaysOf(arrival),
  ]);
  route.departureRunways = departureRunways;
  route.arrivalRunways = arrivalRunways;
  route.sidOptions = procedureOptions(depProcedures, 'SID', departure?.runway ?? null, route.sidFix);
  route.starOptions = procedureOptions(arrProcedures, 'STAR', arrival?.runway ?? null, route.starFix);
  // Approches de la piste d'arrivée (« 04L-04R » : plusieurs pistes)
  route.approachOptions = (arrProcedures?.approaches ?? []).filter((a) => !arrival?.runway || a.runway.split('-').includes(arrival.runway));

  /** Points d'une procédure, localisés d'après ses propres coordonnées puis les données en route */
  const procedurePoints = (fixes: string[], data: AirportProcedures, near: LngLat): RoutePoint[] =>
    fixes.flatMap((ident) => {
      const own = data.waypoints[ident];
      if (own) return [{ ident, kind: 'waypoint' as const, lngLat: own }];
      previous = near;
      const found = resolve(ident);
      return found ? [found] : [];
    });

  const sequence: { point: RoutePoint; via: string; style: LegStyle; phase: LegPhase }[] = [];
  if (start) sequence.push({ point: start, via: '', style: 'route', phase: 'departure' });

  // Départ : SID publiée jusqu'au premier point en route, sinon segment direct
  const sid = route.sid && depProcedures ? findProcedure(depProcedures, 'SID', route.sid, departure!.runway, route.sidFix) : null;
  route.sidUsed = sid?.procedure ?? null;
  if (sid) {
    const fixes = sid.procedure.fixes.at(-1) === route.sidFix ? sid.procedure.fixes.slice(0, -1) : sid.procedure.fixes;
    for (const point of procedurePoints(fixes, depProcedures!, start!.lngLat)) {
      sequence.push({ point, via: sid.procedure.ident, style: 'procedure', phase: 'departure' });
    }
    const note = substitutionNote('SID', route.sid!, sid, departure!.runway);
    if (note) route.notes.push(note);
  } else if (route.sid) {
    route.notes.push(
      depProcedures
        ? `SID ${route.sid} introuvable pour la piste ${departure?.runway ?? '—'} : segment direct.`
        : `SID ${route.sid} : tracé exact disponible uniquement pour les aérodromes français (segment direct).`,
    );
  }
  points.forEach((p, index) =>
    sequence.push(
      index === 0 && start && route.sid
        ? { ...p, via: sid ? sid.procedure.ident : route.sid, style: sid ? 'procedure' : 'approximate', phase: 'departure' }
        : { ...p, style: 'route', phase: 'enroute' },
    ),
  );

  // Approche choisie : branche initiale partant du dernier point atteint (fin de STAR), puis finale jusqu'au seuil
  const approach = route.approach ? route.approachOptions.find((a) => a.name === route.approach) ?? null : null;
  route.approachUsed = approach;
  if (route.approach && !approach) route.notes.push(`Approche ${route.approach} indisponible pour la piste ${arrival?.runway ?? '—'}.`);
  const approachLabel = approach ? `${approach.name} ${approach.runway}` : 'APP';
  const pushApproach = () => {
    if (!approach || !end || !arrProcedures) return false;
    const last = sequence.at(-1)?.point.ident;
    const branch = approach.initial.find((b) => b.iaf === last);
    const fixes = [...(branch ? branch.fixes.slice(1) : []), ...approach.final].filter((f, i, all) => f !== last && f !== all[i - 1] && !/^RW/.test(f));
    for (const point of procedurePoints(fixes, arrProcedures, end.lngLat)) {
      sequence.push({ point, via: approachLabel, style: 'procedure', phase: 'arrival' });
    }
    sequence.push({ point: end, via: approachLabel, style: 'procedure', phase: 'arrival' });
    return true;
  };

  // Arrivée : STAR publiée depuis le dernier point en route, puis approche ou segment jusqu'au seuil de piste
  const star = route.star && arrProcedures ? findProcedure(arrProcedures, 'STAR', route.star, arrival!.runway, route.starFix) : null;
  route.starUsed = star?.procedure ?? null;
  if (star && end) {
    const fixes = star.procedure.fixes[0] === route.starFix ? star.procedure.fixes.slice(1) : star.procedure.fixes;
    for (const point of procedurePoints(fixes, arrProcedures!, end.lngLat)) {
      sequence.push({ point, via: star.procedure.ident, style: 'procedure', phase: 'arrival' });
    }
    if (!pushApproach()) sequence.push({ point: end, via: 'APP', style: 'approximate', phase: 'arrival' });
    const note = substitutionNote('STAR', route.star!, star, arrival!.runway);
    if (note) route.notes.push(note);
  } else if (end) {
    if (!pushApproach()) {
      sequence.push({
        point: end,
        via: route.star ?? 'DCT',
        style: route.star ? 'approximate' : 'route',
        phase: route.star ? 'arrival' : 'enroute',
      });
    }
    if (route.star) {
      route.notes.push(
        arrProcedures
          ? `STAR ${route.star} introuvable pour la piste ${arrival?.runway ?? '—'} : segment direct.`
          : `STAR ${route.star} : tracé exact non disponible pour cet aérodrome (segment direct).`,
      );
    }
  }

  for (let i = 1; i < sequence.length; i++) {
    const from = sequence[i - 1].point;
    const to = sequence[i].point;
    const distance = distanceNm(from.lngLat, to.lngLat);
    const { via, style, phase } = sequence[i];
    route.legs.push({ from, to, via, style, phase, distanceNm: distance, courseT: courseTrue(from.lngLat, to.lngLat) });
    route.totalNm += distance;
  }
  return route;
}

export interface RouteProgress {
  /** Branche en cours (index dans route.legs) et point vers lequel l'avion se dirige */
  legIndex: number;
  next: RoutePoint;
  toNextNm: number;
  /** Distance restante le long de la route jusqu'à l'arrivée */
  remainingNm: number;
}

/** Position de l'avion sur la route : branche la plus proche, prochain point et distance restante */
export function routeProgress(route: FlightRoute, position: LngLat): RouteProgress | null {
  if (!route.legs.length) return null;
  // Distance point-segment en projection locale (suffisante pour choisir la branche)
  const k = Math.cos(toRad(position[1]));
  const project = ([lon, lat]: LngLat): [number, number] => [lon * k, lat];
  const [px, py] = project(position);
  let best = { index: 0, d: Infinity, t: 0, closest: position };
  route.legs.forEach((leg, index) => {
    const [ax, ay] = project(leg.from.lngLat);
    const [bx, by] = project(leg.to.lngLat);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.d) best = { index, d, t, closest: [(ax + t * dx) / k, ay + t * dy] };
  });
  // Avion trop loin de la route tracée (route partiellement localisée, déroutement…) : pas de progression fiable
  if (distanceNm(position, best.closest) > OFF_ROUTE_NM) return null;
  // Arrivé au bout d'une branche : on vise déjà le point suivant
  const legIndex = best.t > 0.98 && best.index < route.legs.length - 1 ? best.index + 1 : best.index;
  const leg = route.legs[legIndex];
  const toNextNm = distanceNm(position, leg.to.lngLat);
  const remainingNm = toNextNm + route.legs.slice(legIndex + 1).reduce((sum, l) => sum + l.distanceNm, 0);
  return { legIndex, next: leg.to, toNextNm, remainingNm };
}

export interface RouteChange {
  /** Approche (nom), null pour la retirer : choix hors du texte de la route, qui ne la mentionne pas */
  approach?: string | null;
  departureRunway?: string;
  arrivalRunway?: string;
  /** Nouvelle SID / STAR (désignation plan de vol), null pour la retirer */
  sid?: string | null;
  star?: string | null;
}

/** Réécrit la route texte après un choix dans l'interface (piste, SID, STAR), le reste de la route étant conservé */
export function editRoute(text: string, route: FlightRoute, change: RouteChange): string {
  const tokens = text.trim().split(/\s+/);
  const hasDeparture = Boolean(route.departure && TERMINAL.test(tokens[0]));
  const hasArrival = Boolean(route.arrival && TERMINAL.test(tokens.at(-1) ?? ''));

  if (change.departureRunway && hasDeparture) tokens[0] = `${route.departure!.airport.icao}/${change.departureRunway}`;
  if (change.arrivalRunway && hasArrival) tokens[tokens.length - 1] = `${route.arrival!.airport.icao}/${change.arrivalRunway}`;

  if (change.sid !== undefined) {
    const index = route.sid ? tokens.findIndex((t) => t.split('/')[0] === route.sid) : -1;
    if (index >= 0) {
      if (change.sid) tokens[index] = change.sid;
      else tokens.splice(index, 1);
    } else if (change.sid) {
      // Juste après l'aérodrome de départ et le groupe vitesse/niveau
      let at = hasDeparture ? 1 : 0;
      if (SPEED_LEVEL.test(tokens[at] ?? '')) at++;
      tokens.splice(at, 0, change.sid);
    }
  }

  if (change.star !== undefined) {
    let index = -1;
    if (route.star) for (let i = tokens.length - 1; i >= 0 && index < 0; i--) if (tokens[i].split('/')[0] === route.star) index = i;
    if (index >= 0) {
      if (change.star) tokens[index] = change.star;
      else tokens.splice(index, 1);
    } else if (change.star) {
      tokens.splice(hasArrival ? tokens.length - 1 : tokens.length, 0, change.star);
    }
  }
  return tokens.join(' ');
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
  // Chaque point prend la couleur de la branche qui y mène (le départ, celle de la SID)
  const points = route.legs.length
    ? [{ point: route.legs[0].from, phase: route.legs[0].phase }, ...route.legs.map((l) => ({ point: l.to, phase: l.phase }))]
    : [];
  return {
    type: 'FeatureCollection',
    features: [
      ...route.legs.map((leg, i) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [leg.from.lngLat, leg.to.lngLat] },
        properties: {
          style: leg.style,
          phase: leg.phase,
          // Nom de la SID, de la STAR ou de la route affiché une seule fois, sur sa première branche
          label: leg.via !== 'DCT' && leg.via !== route.legs[i - 1]?.via ? leg.via : null,
        },
      })),
      ...points.map(({ point, phase }) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: point.lngLat },
        properties: { ident: point.ident, kind: point.kind, phase },
      })),
    ],
  };
}
