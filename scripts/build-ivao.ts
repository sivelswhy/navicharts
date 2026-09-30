// Données statiques tirées des sector files IVAO d'Amérique du Nord (voir server/sectorfiles.ts) :
//   routes aériennes (.awh/.awl, airways.high/.low), balises (.vor/.ndb) et points de ces routes (.fix),
//   points et routes VFR (.vfi/.vrt), limites des ARTCC/FIR, des approches et des classes B/C/D (.artcc),
//   altitudes minimales radar (.mva), secteurs des positions ATC en ligne (online.ply),
//   aérodromes (.ap), pistes (.rw) et fréquences ATC (.atc).
// Formats (champs séparés par « ; ») :
//   routes : « L;nom;… » place une étiquette et ouvre un tracé, les lignes « T;nom;point;point » suivantes en donnent
//            les points dans l'ordre
//   VOR / NDB : ident[ (nom)];fréquence;lat;lon      points : ident;lat;lon[;type]      points VFR : ident;nom;lat;lon
//   routes VFR : nom;n;lat;lon      limites et MVA : « T;nom;lat;lon » (tracé), « L;texte;lat;lon » (étiquette)
//   secteurs : « POSITION;couleur;… » puis « lat;lon »      aérodromes : ident;altitude;altitude de transition;lat;lon;nom
//   pistes : ident;QFU1;QFU2;altitude1;altitude2;cap1;cap2;lat1;lon1;lat2;lon2      ATC : indicatif;fréquence;préfixes
// Les modèles d'ATIS (.cpr) et les fonds radar (videomaps) sont propres au client Aurora : ils ne sont pas repris.
import { DIVISIONS, distance, isCoordinate, position, repoFiles, sectorFiles, type Division } from '../server/sectorfiles.ts';
import { buildAurora } from './build-aurora.ts';

type Position = [number, number];
type Candidate = { at: Position; kind: 'navaid' | 'fix' };
type Feature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };

// Au-delà (en degrés, ~1000 NM), un tronçon relie un homonyme mal résolu ; les routes océaniques restent en deçà
const MAX_LEG = 1000 / 60;
// Niveaux usuels : routes hautes (J, Q) du FL180 au FL450, basses (V, T) jusqu'au FL180
const LEVELS = { high: { lowerFl: 180, upperFl: 450 }, low: { lowerFl: null, upperFl: 180 } };

export interface SectorAirport {
  ident: string;
  country: string;
  continent: string;
  name: string;
  elevationFt: number;
  transitionAltitudeFt: number | null;
  lat: number;
  lon: number;
  /** Aérodrome doté de SID, STAR ou approches dans les sector files */
  procedures: boolean;
}

export interface SectorRunway {
  airport: string;
  ends: { ident: string; elevationFt: number; headingT: number; lat: number; lon: number }[];
}

export interface IvaoData {
  divisions: string[];
  airways: Feature[];
  waypoints: Feature[];
  navaids: Feature[];
  vfr: Feature[];
  airspaces: Feature[];
  mva: Feature[];
  sectors: Feature[];
  airports: SectorAirport[];
  runways: SectorRunway[];
  /** Fréquences ATC par aérodrome (« KPCT_APP » → KPCT) */
  atc: { airport: string; callsign: string; mhz: number }[];
}

// Environ 10 m : bien assez pour les MVA et les secteurs ATC, les fichiers les plus lourds
const coarse = (at: Position): Position => [Math.round(at[0] * 1e4) / 1e4, Math.round(at[1] * 1e4) / 1e4];

const point = (at: Position, properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: at },
  properties,
});
const valid = (at: Position) => Number.isFinite(at[0]) && Number.isFinite(at[1]) && (at[0] !== 0 || at[1] !== 0);
const same = (a: Position, b: Position) => distance(a, b) < 1e-6;

/** « YAI (ABBOTSFORD) » → ident et nom */
function label(value: string): { ident: string; name: string } {
  const m = /^(\S+)\s*\((.*)\)/.exec(value.trim());
  return m ? { ident: m[1], name: m[2] } : { ident: value.trim(), name: value.trim() };
}

/**
 * Longitude ramenée à moins de 180° de la précédente : un tracé qui franchit l'antiméridien (Pacifique, Alaska)
 * continue au-delà de ±180° au lieu de traverser toute la carte
 */
function unwrap(at: Position, previous: Position | undefined): Position {
  if (!previous) return at;
  let lon = at[0];
  while (lon - previous[0] > 180) lon -= 360;
  while (lon - previous[0] < -180) lon += 360;
  return [lon, at[1]];
}

/**
 * Lignes « T;nom;lat;lon » regroupées en tracés : un nouveau tracé à chaque changement de nom, et quand le tracé
 * en cours s'est refermé (plusieurs contours consécutifs portent souvent le même nom, « CLASS D »…)
 */
function traces(rows: string[][]): { name: string; coords: Position[] }[] {
  const result: { name: string; coords: Position[] }[] = [];
  for (const f of rows) {
    if (f[0] !== 'T') continue;
    const at = position(f[2], f[3]);
    if (!valid(at)) continue;
    const last = result.at(-1);
    const closed = last && last.coords.length >= 3 && same(last.coords[0], last.coords.at(-1)!);
    if (last && last.name === f[1] && !closed) last.coords.push(unwrap(at, last.coords.at(-1)));
    else result.push({ name: f[1], coords: [at] });
  }
  return result.filter((t) => t.coords.length >= 2);
}

/** Polygone si le tracé se referme, ligne sinon */
function shape(coords: Position[]): { type: string; coordinates: unknown } {
  const closed = coords.length >= 4 && distance(coords[0], coords.at(-1)!) < 0.01;
  return closed ? { type: 'Polygon', coordinates: [[...coords.slice(0, -1), coords[0]]] } : { type: 'LineString', coordinates: coords };
}

type Rows = { file: string; rows: string[][] }[];

async function loadDivision(division: Division) {
  const get = (pattern: RegExp) => sectorFiles(division, pattern);
  const [vor, ndb, fixes, high, low, vfi, vrt, artcc, mva, ply, ap, rw, atc, prd, files] = await Promise.all([
    get(/\.vor$/i),
    get(/\.ndb$/i),
    get(/\.fix$/i),
    // Routes hautes / basses : K.awh, airways.high, SEFG_HIGH.AWY, SUEOhigh.awy, rjjj.highaw, WSJC.HAIRWAY…
    get(/(\.awh|airways\.high|high\.awy|\.highaw|\.hairway)$/i),
    get(/(\.awl|airways\.low|low\.awy|\.lowaw|\.lairway)$/i),
    get(/\.vfi$/i),
    get(/\.(vrt|vtr)$/i),
    // Limites : .artcc, .hartcc/.lartcc (Indonésie, Singapour), .acc/.acchigh/.acclow (Japon), .hairspace/.lairspace (Thaïlande)
    get(/\.(artcc|hartcc|lartcc|acc|acchigh|acclow|hairspace|lairspace)$/i),
    get(/\.mva$/i),
    get(/polygons\/online\.ply$/i),
    get(/(airports\.ap|\.apt|[^/]+\.ap)$/i),
    get(/(runways\.rw|\.rwy|[^/]+\.rw)$/i),
    get(/\.atc$/i),
    // Zones interdites, réglementées et dangereuses (Équateur)
    get(/\.prd$/i),
    repoFiles(division),
  ]);
  const procedures = new Set(files.flatMap((f) => /([^/]+)\.(sid|str)$/i.exec(f)?.[1]?.toUpperCase() ?? []));
  return { division, vor, ndb, fixes, high, low, vfi, vrt, artcc, mva, ply, ap, rw, atc, prd, procedures };
}

type Loaded = Awaited<ReturnType<typeof loadDivision>>;
const all = (loaded: Loaded[], key: keyof Loaded) => loaded.flatMap((d) => (d[key] as Rows).flatMap((f) => f.rows));

// ───────── Routes, balises et points ─────────

function buildAirways(loaded: Loaded[]) {
  // Un seul jeu de candidats pour toutes les divisions : les routes franchissent la frontière
  const candidates = new Map<string, Candidate[]>();
  const known = (ident: string, at: Position) => candidates.get(ident)?.some((c) => distance(c.at, at) < 0.01);
  const add = (ident: string, at: Position, kind: 'navaid' | 'fix') => {
    if (!valid(at) || known(ident, at)) return false;
    candidates.set(ident, [...(candidates.get(ident) ?? []), { at, kind }]);
    return true;
  };

  const navaids: Feature[] = [];
  for (const [value, mhz, lat, lon] of all(loaded, 'vor')) {
    const { ident, name } = label(value);
    const at = position(lat, lon);
    if (add(ident, at, 'navaid')) navaids.push(point(at, { ident, name, type: 'VOR', frequency: `${Number(mhz).toFixed(2)} MHz` }));
  }
  // Les fichiers NDB reprennent aussi des VOR (fréquence tronquée), écartés par add()
  for (const [value, khz, lat, lon] of all(loaded, 'ndb')) {
    const { ident, name } = label(value);
    const at = position(lat, lon);
    if (add(ident, at, 'navaid')) navaids.push(point(at, { ident, name, type: 'NDB', frequency: `${khz} kHz` }));
  }
  // Type 2 : points d'aérodrome (États-Unis) ; les autres types varient selon les divisions (0, 1, absent)
  for (const [ident, lat, lon, type] of all(loaded, 'fixes')) if (type !== '2') add(ident, position(lat, lon), 'fix');

  const airways: Feature[] = [];
  const segments = new Set<string>();
  const usedFixes = new Map<string, { ident: string; at: Position }>();
  let unresolved = 0;
  for (const [level, rows] of [['high', all(loaded, 'high')], ['low', all(loaded, 'low')]] as const) {
    let previous: { ident: string; at: Position } | null = null;
    let lastKind = '';
    let lastName = '';
    for (const [kind, name, ident] of rows) {
      // Un bloc de lignes « L » ouvre un nouveau tracé, comme un changement de route (fichiers sans lignes « L »)
      if ((kind === 'L' && lastKind !== 'L') || name !== lastName) previous = null;
      lastKind = kind;
      lastName = name;
      if (kind !== 'T') continue;
      const options = candidates.get(ident);
      if (!options) {
        unresolved++;
        previous = null;
        continue;
      }
      // Homonymes : le plus proche du point précédent, sinon une balise plutôt qu'un point
      const from = previous?.at;
      const best: Candidate = from
        ? options.reduce((a, b) => (distance(b.at, from) < distance(a.at, from) ? b : a))
        : (options.find((o) => o.kind === 'navaid') ?? options[0]);
      if (best.kind === 'fix') usedFixes.set(`${ident} ${best.at}`, { ident, at: best.at });
      // Les fichiers par FIR reprennent les tronçons des routes qui franchissent une limite de FIR
      const key = `${name} ${[String(from), String(best.at)].sort().join(' ')}`;
      const to = unwrap(best.at, from);
      if (from && distance(from, to) <= MAX_LEG && !segments.has(key)) {
        segments.add(key);
        airways.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [from, to] },
          properties: { name, ...LEVELS[level], from: previous!.ident, to: ident, ivao: true },
        });
      }
      previous = { ident, at: best.at };
    }
  }
  // Seuls les points utilisés par les routes : les dizaines de milliers de points en route alourdiraient trop la carte
  const waypoints = [...usedFixes.values()].map(({ ident, at }) => point(at, { ident, ivao: true }));
  return { airways, waypoints, navaids, unresolved };
}

// ───────── VFR ─────────

function buildVfr(loaded: Loaded[]): Feature[] {
  const features: Feature[] = [];
  const seen = new Set<string>();
  const byIdent = new Map<string, Position>();
  for (const [ident, name, lat, lon] of all(loaded, 'vfi')) {
    const at = position(lat, lon);
    if (!valid(at) || seen.has(`${ident} ${at}`)) continue;
    seen.add(`${ident} ${at}`);
    byIdent.set(ident, at);
    // Second champ : nom du point, ou altitude (Équateur)
    features.push(point(at, { kind: 'point', ident, name: name && !/^\d+$/.test(name) ? name : null }));
  }
  // Routes VFR : « nom;n;lat;lon » (États-Unis), « nom;lat;lon » (Uruguay, Équateur) ou « nom;POINT;POINT » (Équateur)
  const routes = new Map<string, Position[][]>();
  for (const f of all(loaded, 'vrt')) {
    const at = isCoordinate(f[1]) && isCoordinate(f[2]) ? position(f[1], f[2]) : isCoordinate(f[2]) ? position(f[2], f[3]) : byIdent.get(f[1]);
    if (!at || !valid(at)) continue;
    const list = routes.get(f[0]) ?? [[]];
    list.at(-1)!.push(at);
    routes.set(f[0], list);
  }
  for (const [name, lines] of routes) {
    for (const coords of lines) if (coords.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'route', name } });
  }
  return features;
}

// ───────── Espaces aériens ─────────

/** Type et classe d'un contour d'après son fichier et son nom */
function airspaceType(file: string, name: string): { type: string; class: string; name: string } | null {
  if (/dummy/i.test(name)) return null;
  // Rôle du fichier d'après son nom : artcc.artcc / SEFGARTCC.ARTCC (FIR), high.artcc / SUEOhigh.artcc, low.artcc…
  const base = file.split('/').at(-1)!.toLowerCase();
  const role = /high|\.hartcc$|\.hairspace$/.test(base) ? 'high' : /low|\.lartcc$|\.lairspace$/.test(base) ? 'low' : 'fir';
  if (role === 'fir') return { type: 'FIR', class: '', name: name.replace(/_\d+$/, '') };
  // Limites des organismes d'approche (TRACON)
  // Secteur d'un centre de contrôle (« VTBB_N_CTR »)
  if (/_CTR$/.test(name)) return { type: 'CTA', class: '', name };
  if (role === 'high') return { type: 'TMA', class: '', name: `${name} APP` };
  const cls = /CLASS ([A-G])/i.exec(name)?.[1]?.toUpperCase();
  if (cls) return { type: cls === 'D' ? 'CTR' : 'TMA', class: cls, name: `CLASS ${cls}` };
  if (/\bTCA\b/.test(name)) return { type: 'TMA', class: '', name };
  if (/\bCZ\b|\bCTR\b/.test(name)) return { type: 'CTR', class: '', name };
  if (/TMA/.test(name)) return { type: 'TMA', class: '', name };
  return { type: 'CTA', class: '', name };
}

function buildAirspaces(loaded: Loaded[]): Feature[] {
  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const { file, rows } of loaded.flatMap((d) => d.artcc)) {
    for (const t of traces(rows)) {
      const info = airspaceType(file, t.name);
      if (!info) continue;
      // Chaque FIR reprend les contours de ses voisines
      const key = `${info.type} ${info.name} ${t.coords[0]} ${t.coords.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ type: 'Feature', geometry: shape(t.coords), properties: { ...info, ivao: true } });
    }
    // Étiquettes : nom de l'ARTCC, limites verticales des classes B/C (« SFC\100 » : du sol à 10 000 ft)
    for (const f of rows) {
      if (f[0] !== 'L') continue;
      const at = position(f[2], f[3]);
      const text = f[1].replace('\\', '–');
      if (!valid(at) || seen.has(`${text} ${at}`)) continue;
      seen.add(`${text} ${at}`);
      features.push(point(at, { type: 'LABEL', text, ivao: true }));
    }
  }
  return features;
}

/** Zones interdites, réglementées et dangereuses : segments « lat;lon;lat;lon;TYPE » */
function buildRestricted(loaded: Loaded[]): Feature[] {
  const TYPES: [RegExp, string, string][] = [
    [/PROHIB/i, 'P', 'Zone interdite'],
    [/RESTRIC/i, 'R', 'Zone réglementée'],
    [/DANGER/i, 'D', 'Zone dangereuse'],
  ];
  const features: Feature[] = [];
  let current: { kind: string; coords: Position[] } | null = null;
  const flush = () => {
    if (current && current.coords.length >= 2) {
      const [, type, name] = TYPES.find(([re]) => re.test(current!.kind)) ?? [null, 'R', current.kind];
      features.push({ type: 'Feature', geometry: shape(current.coords), properties: { type, class: '', name, ivao: true } });
    }
    current = null;
  };
  for (const f of all(loaded, 'prd')) {
    if (![0, 1, 2, 3].every((i) => isCoordinate(f[i]))) continue;
    const a = position(f[0], f[1]);
    const b = position(f[2], f[3]);
    const c = current as { kind: string; coords: Position[] } | null;
    if (c && c.kind === f[4] && same(c.coords.at(-1)!, a)) c.coords.push(b);
    else {
      flush();
      current = { kind: f[4] ?? '', coords: [a, b] };
    }
  }
  flush();
  return features;
}

// ───────── Altitudes minimales radar ─────────

function buildMva(loaded: Loaded[]): Feature[] {
  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const { file, rows } of loaded.flatMap((d) => d.mva)) {
    const facility = file.split('/').at(-1)!.replace(/\.mva$/i, '');
    // Même fichier rangé à deux endroits (Uruguay)
    if (seen.has(facility)) continue;
    seen.add(facility);
    for (const t of traces(rows)) features.push({ type: 'Feature', geometry: shape(t.coords.map(coarse)), properties: { facility } });
    for (const f of rows) {
      const at = position(f[2], f[3]);
      // « 016 » : 1 600 ft, affiché en centaines de pieds comme sur les cartes MVA
      if (f[0] === 'L' && valid(at)) features.push(point(at, { facility, text: String(Number(f[1])) }));
    }
  }
  return features;
}

// ───────── Secteurs ATC ─────────

/**
 * Sommet placé au pôle (FIR océaniques de l'hémisphère sud) : la carte en Mercator ne va pas au-delà de ~85°, et le
 * côté suivant y serait tracé en diagonale. On longe plutôt le parallèle, de la longitude précédente à la suivante.
 */
function aroundPoles(coords: Position[]): Position[] {
  const LIMIT = 85;
  return coords.flatMap((at, i) => {
    if (Math.abs(at[1]) < 89.9) return [at];
    const lat = Math.sign(at[1]) * LIMIT;
    const before = coords[i - 1] ?? at;
    const after = coords[i + 1] ?? at;
    return [
      [before[0], lat],
      [after[0], lat],
    ] as Position[];
  });
}

function buildSectors(loaded: Loaded[]): Feature[] {
  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const { rows } of loaded.flatMap((d) => d.ply)) {
    let current: { callsign: string; coords: Position[] } | null = null;
    const flush = () => {
      if (current && current.callsign && current.coords.length >= 3) {
        const key = `${current.callsign} ${current.coords[0]}`;
        if (!seen.has(key)) {
          seen.add(key);
          const coords = aroundPoles(current.coords);
          const ring = same(coords[0], coords.at(-1)!) ? coords : [...coords, coords[0]];
          features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { callsign: current.callsign } });
        }
      }
      current = null;
    };
    for (const f of rows) {
      // En-tête : « POSITION;#couleur;… » (parfois sans indicatif : polygone écarté)
      if (f[1]?.startsWith('#')) {
        flush();
        current = { callsign: f[0], coords: [] };
      } else {
        const at = position(f[0], f[1]);
        const coords = (current as { coords: Position[] } | null)?.coords;
        if (valid(at)) coords?.push(coarse(unwrap(at, coords.at(-1))));
      }
    }
    flush();
  }
  return features;
}

// ───────── Aérodromes, pistes et fréquences ─────────

function buildAirports(loaded: Loaded[]) {
  const airports = new Map<string, SectorAirport>();
  for (const d of loaded) {
    for (const f of d.ap.flatMap((x) => x.rows)) {
      const [ident, elevation, transition, lat, lon, name] = f;
      if (airports.has(ident) || !lat || !lon) continue;
      airports.set(ident, {
        ident,
        country: d.division.country,
        continent: d.division.continent,
        name: name ?? ident,
        elevationFt: Number(elevation),
        transitionAltitudeFt: Number(transition) || null,
        lat: Number(lat),
        lon: Number(lon),
        procedures: d.procedures.has(ident),
      });
    }
  }
  const runways = new Map<string, SectorRunway>();
  for (const f of all(loaded, 'rw')) {
    const [airport, id1, id2, elev1, elev2, hdg1, hdg2, lat1, lon1, lat2, lon2] = f;
    const key = `${airport} ${id1}/${id2}`;
    if (runways.has(key) || !lat2) continue;
    runways.set(key, {
      airport,
      ends: [
        { ident: id1, elevationFt: Number(elev1), headingT: Number(hdg1), lat: Number(lat1), lon: Number(lon1) },
        { ident: id2, elevationFt: Number(elev2), headingT: Number(hdg2), lat: Number(lat2), lon: Number(lon2) },
      ],
    });
  }
  const atc = new Map<string, { airport: string; callsign: string; mhz: number }>();
  for (const [callsign, mhz] of all(loaded, 'atc')) {
    const airport = callsign.split('_')[0];
    if (airports.has(airport) && Number(mhz) && !atc.has(callsign)) atc.set(callsign, { airport, callsign, mhz: Number(mhz) });
  }
  return { airports: [...airports.values()], runways: [...runways.values()], atc: [...atc.values()] };
}

export async function buildIvao(): Promise<IvaoData> {
  const data = await Promise.all(
    DIVISIONS.map((d) =>
      loadDivision(d).catch((err) => {
        console.warn(`⚠ Sector files IVAO ${d.name} : ${(err as Error).message}`);
        return null;
      }),
    ),
  );
  const loaded = data.filter((d) => d !== null);
  const { airways, waypoints, navaids, unresolved } = buildAirways(loaded);
  const result: IvaoData = {
    divisions: loaded.map((d) => d.division.name),
    airways,
    waypoints,
    navaids,
    vfr: buildVfr(loaded),
    airspaces: [...buildAirspaces(loaded), ...buildRestricted(loaded)],
    mva: buildMva(loaded),
    sectors: buildSectors(loaded),
    ...buildAirports(loaded),
  };
  console.log(
    `  IVAO ${result.divisions.join(', ')} : ${airways.length} tronçons, ${waypoints.length} points, ${navaids.length} balises` +
      `${unresolved ? ` (${unresolved} points de route introuvables)` : ''}, ${result.airports.length} aérodromes, ` +
      `${result.runways.length} pistes, ${result.atc.length} fréquences ATC, ${result.vfr.length} éléments VFR, ` +
      `${result.airspaces.length} limites d'espaces, ${result.mva.length} éléments MVA, ${result.sectors.length} secteurs ATC`,
  );

  // Sector files au format du cache d'Aurora (dépôt GitHub cloné dans .cache/aurora)
  const aurora = await buildAurora().catch((err) => {
    console.warn(`⚠ Sector files Aurora locaux : ${(err as Error).message}`);
    return null;
  });
  if (aurora?.folders.length) {
    result.divisions.push(`Aurora (${aurora.folders.length} sector files)`);
    for (const k of ['airways', 'waypoints', 'navaids', 'airspaces', 'mva', 'sectors', 'airports', 'atc'] as const) (result[k] as unknown[]).push(...aurora[k]);
    const runways = new Set(result.runways.map((r) => `${r.airport} ${r.ends.map((e) => e.ident).join('/')}`));
    result.runways.push(...aurora.runways.filter((r) => !runways.has(`${r.airport} ${r.ends.map((e) => e.ident).join('/')}`)));
  }
  return result;
}
