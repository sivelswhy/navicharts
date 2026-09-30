// Sector files au format du cache d'Aurora (client ATC d'IVAO), publiés dans le dépôt
// https://github.com/sivelswhy/navicharts-sector-files et clonés dans `.cache/aurora` (voir syncAurora). Un dossier par
// sector file :
//   global.json          aérodromes (pistes, postes), points et balises, routes hautes et basses, positions ATC
//   section_NNN_X_Y.json tuiles (niveau de zoom, x, y) : contours, surfaces au sol, taxiways, postes, espaces, MVA ;
//                        niveaux 0 à 6 seulement, les suivants étant remplacés par ground_<OACI>.json à l'import
//   proc_<OACI>.json     procédures d'un aérodrome, telles qu'Aurora les dessine
//   ground_<OACI>.json   plan au sol d'un aérodrome, précalculé par scripts/import-aurora.ts
// Les positions (`mapPosition`, `mapPoints`) sont en Web Mercator normalisé [0, 1] ; `geoPosition` : x = lat, y = lon.
// Les procédures ne nomment pas leurs points : chaque sommet est rapproché du point nommé situé exactement au même endroit.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { GroundFeature } from './ground.ts';
import type { AirportProcedures, Approach, Hold, Procedure } from './procedures.ts';
import { approachName } from './sectorfiles.ts';

type LngLat = [number, number];
export interface MapPoint {
  x: number;
  y: number;
}

export const AURORA_REPO = 'https://github.com/sivelswhy/navicharts-sector-files.git';
export const AURORA_ROOT = path.resolve(import.meta.dirname, '..', '.cache', 'aurora');
const SYNC_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Clone du dépôt des sector files (superficiel : dernière version seulement), mis à jour au plus une fois par jour.
 * En cas d'échec (hors ligne), la copie existante reste utilisée.
 */
export async function syncAurora(): Promise<void> {
  const git = (...args: string[]) => promisify(execFile)('git', args, { maxBuffer: 16 * 1024 * 1024 });
  if (!existsSync(path.join(AURORA_ROOT, '.git'))) {
    console.log('↓ sector files Aurora (clone du dépôt GitHub)');
    await git('clone', '--depth', '1', '--quiet', AURORA_REPO, AURORA_ROOT);
    return;
  }
  const last = await stat(path.join(AURORA_ROOT, '.git', 'FETCH_HEAD')).then((s) => s.mtimeMs, () => 0);
  if (Date.now() - last < SYNC_MAX_AGE_MS) return;
  try {
    await git('-C', AURORA_ROOT, 'fetch', '--depth', '1', '--quiet', 'origin', 'main');
    await git('-C', AURORA_ROOT, 'reset', '--hard', '--quiet', 'FETCH_HEAD');
  } catch (err) {
    console.warn(`⚠ Mise à jour des sector files Aurora impossible (${(err as Error).message.split('\n')[0]}) : copie existante utilisée`);
  }
}

/** Dossiers au format Aurora (ceux qui contiennent un global.json) */
export function auroraFolders(): string[] {
  if (!existsSync(AURORA_ROOT)) return [];
  return readdirSync(AURORA_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(AURORA_ROOT, d.name, 'global.json')))
    .map((d) => d.name);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Web Mercator normalisé → [lon, lat] */
export function fromMap(p: MapPoint): LngLat {
  const lon = p.x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * p.y))) * 180) / Math.PI;
  return [round(lon), round(lat)];
}

export interface AuroraPoint {
  identifier: string;
  mapPosition: MapPoint;
  kind: string;
  fixKind: string;
  frequency: number;
}
export interface AuroraRunway {
  airport: string;
  primaryId: string;
  oppositeId: string;
  primaryCourse: number;
  oppositeCourse: number;
  primaryMapPoint: MapPoint;
  oppositeMapPoint: MapPoint;
  primaryElevation: number;
  oppositeElevation: number;
}
export interface AuroraAirport {
  identifier: string;
  name: string;
  elevation: number;
  transitionAltitude: number | null;
  geoPosition: MapPoint;
  mapPosition: MapPoint;
  runways: AuroraRunway[];
  gates: { identifier: string; mapPosition: MapPoint }[];
}
export interface AuroraGlobal {
  airports: Record<string, AuroraAirport>;
  points: Record<string, AuroraPoint[]>;
  airwaysLow: Record<string, { identifier: string; mapPoints: MapPoint[] }[]>;
  airwaysHigh: Record<string, { identifier: string; mapPoints: MapPoint[] }[]>;
  atcPositions: Record<string, { callsign: string; frequency: number; mapPoints: MapPoint[] }>;
}
export interface AuroraShape {
  geoArea: string | null;
  fillColour: string | null;
  mapPoints: MapPoint[];
}
export interface AuroraSection {
  level: number;
  mapBounds: { minX: number; minY: number; maxX: number; maxY: number };
  shapes: AuroraShape[];
  taxiways: { airport: string; text: string; mapPosition: MapPoint }[];
  gates: { airport: string; identifier: string; mapPosition: MapPoint }[];
  mvas: { identifier: string; airport: string; mapPoints: MapPoint[]; labels: { mapPosition: MapPoint }[] }[];
  airspaces: { identifier: string; mapPoints: MapPoint[] }[];
  airspacesLow?: { identifier: string; mapPoints: MapPoint[] }[];
  airspacesHigh?: { identifier: string; mapPoints: MapPoint[] }[];
}

const globals = new Map<string, Promise<AuroraGlobal>>();

export function auroraGlobal(folder: string): Promise<AuroraGlobal> {
  let entry = globals.get(folder);
  if (!entry) {
    entry = readFile(path.join(AURORA_ROOT, folder, 'global.json'), 'utf8').then((t) => JSON.parse(t) as AuroraGlobal);
    entry.catch(() => globals.delete(folder));
    globals.set(folder, entry);
  }
  return entry;
}

/** Sections (tuiles) d'un dossier, avec leur niveau de zoom lu dans le nom du fichier */
export async function auroraSections(folder: string, filter: (level: number) => boolean = () => true): Promise<AuroraSection[]> {
  const files = (await readdir(path.join(AURORA_ROOT, folder))).filter((f) => /^section_\d+_\d+_\d+\.json$/.test(f) && filter(Number(f.slice(8, 11))));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(AURORA_ROOT, folder, f), 'utf8')) as AuroraSection));
}

/** Premier dossier qui répond au critère (contient les procédures ou la fiche de l'aérodrome) */
async function folderOf(file: (folder: string) => Promise<boolean>): Promise<string | null> {
  for (const folder of auroraFolders()) if (await file(folder)) return folder;
  return null;
}

// ───────── Procédures ─────────

const key = (p: MapPoint) => `${p.x.toFixed(7)},${p.y.toFixed(7)}`;

interface AuroraProcedure {
  airport: string;
  runways: string[];
  identifier: { text: string };
  mapPoints: (MapPoint | null)[];
  procType: number;
}

/** « BOTPU8XD », « ANVI5G », « GUPTA1G/E/EGURI » → désignation (premier élément) et nom affiché (« BOTPU 8XD ») */
function procedureName(text: string): { ident: string; name: string } {
  // « AC7A.07L » (Viêt Nam) : procédure puis piste
  const first = text.trim().split(/[\s/.]/)[0];
  const m = /^([A-Z]{2,5})(\d{1,2}[A-Z]{0,2})$/.exec(first);
  if (!m) return { ident: first, name: first };
  // Forme plan de vol limitée à 6 caractères quand le suffixe est court (« AGOPA6A » → « AGOP6A »)
  const ident = first.length > 6 && m[2].length <= 2 ? m[1].slice(0, 6 - m[2].length) + m[2] : first;
  return { ident, name: `${m[1]} ${m[2]}` };
}
const unique = (list: string[]) => list.filter((f, i) => f !== list[i - 1]);
const RUNWAY = /^\d{2}[LRC]?$/;

export async function getAuroraProcedures(icao: string): Promise<AirportProcedures | null> {
  const folder = await folderOf(async (f) => existsSync(path.join(AURORA_ROOT, f, `proc_${icao}.json`)));
  if (!folder) return null;
  const [global, procs] = await Promise.all([
    auroraGlobal(folder),
    readFile(path.join(AURORA_ROOT, folder, `proc_${icao}.json`), 'utf8').then((t) => JSON.parse(t) as AuroraProcedure[]),
  ]);

  // Points nommés et seuils de piste de l'aérodrome, repérés par leur position exacte
  const named = new Map<string, string>();
  for (const r of global.airports[icao]?.runways ?? []) {
    named.set(key(r.primaryMapPoint), `RW${r.primaryId}`);
    named.set(key(r.oppositeMapPoint), `RW${r.oppositeId}`);
  }
  for (const list of Object.values(global.points)) for (const p of list) if (!named.has(key(p.mapPosition))) named.set(key(p.mapPosition), p.identifier);
  const waypoints: Record<string, LngLat> = {};
  /** Branches d'un tracé (les sommets « null » lèvent le crayon), en points nommés ; l'aérodrome lui-même est omis */
  const segmentsOf = (p: AuroraProcedure) => {
    const segments: string[][] = [[]];
    for (const m of p.mapPoints) {
      if (!m) {
        if (segments.at(-1)!.length) segments.push([]);
        continue;
      }
      let ident = named.get(key(m));
      if (!ident || ident === icao) continue;
      // Point portant un numéro de piste (« 07C ») : le seuil
      if (RUNWAY.test(ident)) ident = `RW${ident}`;
      if (!ident.startsWith('RW')) waypoints[ident] ??= fromMap(m);
      segments.at(-1)!.push(ident);
    }
    return segments.map(unique).filter((s) => s.length);
  };
  const fixesOf = (p: AuroraProcedure) => unique(segmentsOf(p).flat());

  const procedures: Procedure[] = [];
  const approaches = new Map<string, Approach>();
  // Branches initiales et approches interrompues qui ne nomment que la piste (Malaisie) : rattachées ensuite
  const byRunway: { runway: string; kind: 'initial' | 'missed'; fixes: string[] }[] = [];

  const approachOf = (name: string, runway: string) => {
    const k = `${name} ${runway}`;
    let a = approaches.get(k);
    if (!a) {
      a = { name, runway, initial: [], final: [], missed: [] };
      approaches.set(k, a);
    }
    return a;
  };

  // Circuits d'attente dessinés (« LIMES HOLD ») : rattachés ensuite aux approches qui passent par leur point
  const holds: Hold[] = [];
  for (const p of procs) {
    const text = p.identifier.text.trim();
    if (p.procType === 2) {
      const fix = text.split(/\s+/)[0];
      const path = p.mapPoints.filter((m): m is MapPoint => Boolean(m)).map(fromMap);
      if (fix && path.length >= 3 && !holds.some((h) => h.fix === fix)) holds.push({ fix, path });
      continue;
    }
    const fixes = fixesOf(p);
    if (p.procType === -2 || p.procType === -1) {
      // Les seuils ne font pas partie des points d'une SID ou d'une STAR
      const points = fixes.filter((f) => !f.startsWith('RW'));
      if (!points.length || !text) continue;
      const type = p.procType === -2 ? 'SID' : 'STAR';
      const { ident, name } = procedureName(text);
      const existing = procedures.find((q) => q.type === type && q.ident === ident && q.fixes.join() === points.join());
      if (existing) existing.runways = [...new Set([...existing.runways, ...p.runways])];
      else procedures.push({ type, name, ident, runways: [...p.runways], fixes: points });
      continue;
    }
    if (![3, 4, 5].includes(p.procType)) continue;

    // Formes rencontrées : « I12L (GA) », « RNAV ILSZ16L GA », « 14L/GO-AROUND » (approche interrompue) ;
    // « … FAP », « ILS/FF14R », « 05L ILS Z FA » (finale) ; « … IAP », « REREK.I12L », « ILS34R-LAGMA »,
    // « 05L ILS Z ATA IA » (branche initiale depuis ATA), « MESUP » (IAF seul)
    const upper = text.toUpperCase();
    const missed = p.procType === 5 || /\(GA\)|GO-AROUND|\sGA$/.test(upper);
    const finalLeg = !missed && (p.procType === 4 || /\s(FAP|FA)$/.test(upper) || /\/FF/.test(upper));
    let transition: string | null = null;
    let code = upper.replace(/\s*\(GA\)$|\/GO-AROUND$|\s+(IAP|FAP|GA|FA)$/g, '').trim();
    if (code.includes('.')) [transition, code] = code.split('.', 2);
    const dash = /^(.*\d{2}[LRC]?)-([A-Z0-9]{2,5})$/.exec(code);
    if (dash) [, code, transition] = dash;
    const ia = /^(.*)\s([A-Z0-9]{2,5})\sIA$/.exec(code);
    if (ia) [, code, transition] = ia;
    const runway = p.runways[0] ?? /\d{2}[LRC]?/.exec(code)?.[0] ?? '';
    const name =
      approachName(code) ??
      code
        .replace(/\/FF/, '')
        .replace(/\bRWY\b|\bAPP\b/g, ' ')
        .replace(new RegExp(`\\b${runway}\\b|${runway}$`, 'g'), ' ')
        .replace(/[/\s-]+/g, ' ')
        .trim();
    const segments = segmentsOf(p);
    const points = unique(segments.flat()).filter((f) => !f.startsWith('RW'));

    // Code réduit à la piste ou au nom d'un point (IAF seul) : pas de nom d'approche
    const onlyFix = !finalLeg && !transition && !approachName(code) && [...named.values()].includes(code);
    if (!name || RUNWAY.test(name) || onlyFix) {
      if (points.length) byRunway.push({ runway, kind: missed ? 'missed' : 'initial', fixes: points });
      continue;
    }
    const approach = approachOf(name, runway);
    if (missed) {
      if (!approach.missed.length) approach.missed = points;
    } else if (transition) {
      for (const seg of segments) {
        const fixes = seg.filter((f) => !f.startsWith('RW'));
        if (fixes.length > 1 && !approach.initial.some((i) => i.fixes.join() === fixes.join())) approach.initial.push({ iaf: fixes[0], fixes });
      }
    } else {
      // La branche qui atteint le seuil est la finale (seuil ajouté s'il n'est pas tracé) ; les autres sont des branches initiales
      const threshold = `RW${runway}`;
      const finalSeg = segments.find((seg) => seg.includes(threshold)) ?? segments.at(-1) ?? [];
      const end = finalSeg.indexOf(threshold);
      const final = unique([...(end >= 0 ? finalSeg.slice(0, end) : finalSeg).filter((f) => !f.startsWith('RW')), threshold]);
      if (finalLeg || !approach.final.length) approach.final = final;
      for (const seg of segments) {
        if (seg === finalSeg) continue;
        const fixes = seg.filter((f) => !f.startsWith('RW'));
        if (fixes.length > 1 && !approach.initial.some((i) => i.fixes.join() === fixes.join())) approach.initial.push({ iaf: fixes[0], fixes });
      }
    }
  }
  for (const b of byRunway) {
    for (const a of approaches.values()) {
      if (a.runway !== b.runway) continue;
      if (b.kind === 'missed' && !a.missed.length) a.missed = b.fixes;
      else if (b.kind === 'initial' && b.fixes.length > 1 && !a.initial.some((i) => i.fixes.join() === b.fixes.join())) a.initial.push({ iaf: b.fixes[0], fixes: b.fixes });
    }
  }
  // Sans finale publiée (Doha : transitions seules, jusqu'au point d'approche finale) : la fin commune des branches
  // initiales (au moins leur dernier point), jusqu'au seuil
  for (const a of approaches.values()) {
    const branches = a.initial.map((b) => b.fixes);
    if (a.final.length || !branches.length) continue;
    let common = 1;
    while (common < Math.min(...branches.map((b) => b.length)) && branches.every((b) => b.at(-common - 1) === branches[0].at(-common - 1))) common++;
    a.final = [...branches[0].slice(-common), `RW${a.runway}`];
  }
  // Branches initiales : jusqu'au premier point commun avec la finale
  for (const a of approaches.values()) {
    a.initial = a.initial
      .filter((b) => !a.final.includes(b.iaf))
      .map((b) => {
        const join = b.fixes.findIndex((f, i) => i > 0 && a.final.includes(f));
        return join > 0 ? { iaf: b.iaf, fixes: b.fixes.slice(0, join + 1) } : b;
      });
  }
  for (const a of approaches.values()) {
    // Attente au bout de l'approche interrompue, sinon sur un point de l'approche (IAF…)
    const points = new Set([...a.missed, ...a.initial.flatMap((b) => b.fixes), ...a.final]);
    const own = holds.filter((h) => h.fix === a.missed.at(-1) || points.has(h.fix));
    if (own.length) a.holds = own;
  }
  return {
    icao,
    procedures: procedures.sort((a, b) => a.type.localeCompare(b.type) || a.ident.localeCompare(b.ident)),
    approaches: [...approaches.values()].filter((a) => a.final.length > 1),
    waypoints,
  };
}

// ───────── Plan au sol ─────────

function bearingDeg([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const θ = Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
  return ((θ * 180) / Math.PI + 360) % 360;
}

/** Couleur grise (« #494949 ») : surface revêtue ; les autres couleurs sont l'herbe, l'eau ou des marquages */
function isGray(color: string | null): boolean {
  const m = color && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24 && r > 40 && r < 200;
}

/** Premier niveau de tuiles lu pour le plan au sol ; le script d'import retire les tuiles plus détaillées que la carte */
export const GROUND_LEVEL = 8;

/**
 * Plan au sol d'un aérodrome, assemblé tuile par tuile (`add`) à partir des tuiles les plus détaillées situées à moins de
 * ~6 km ; les postes (dans global.json) n'en font pas partie. Sert au script d'import, qui l'enregistre dans
 * `ground_<OACI>.json`, et au serveur pour un dossier qui n'est pas passé par l'import.
 */
export function groundCollector(icao: string, airport: AuroraAirport) {
  const at = airport.mapPosition;
  const margin = 6 / 40075 / Math.cos((airport.geoPosition.x * Math.PI) / 180);
  const inside = (p: MapPoint) => Math.abs(p.x - at.x) < margin && Math.abs(p.y - at.y) < margin;
  const features: GroundFeature[] = [];
  const seen = new Set<string>();
  const once = (k: string) => !seen.has(k) && Boolean(seen.add(k));
  const add = (s: AuroraSection) => {
    const b = s.mapBounds;
    if (b.minX > at.x + margin || b.maxX < at.x - margin || b.minY > at.y + margin || b.maxY < at.y - margin) return;
    for (const shape of s.shapes ?? []) {
      const points = shape.mapPoints.filter(Boolean);
      if (points.length < 2 || !points.some(inside)) continue;
      const coords = points.map(fromMap);
      if (!once(`${shape.geoArea} ${coords[0]} ${coords.length}`)) continue;
      if (shape.geoArea === 'PIER') {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'pier', ref: null } });
      } else if (shape.geoArea === 'STOPLINE') {
        const mid: LngLat = [round((coords[0][0] + coords.at(-1)![0]) / 2), round((coords[0][1] + coords.at(-1)![1]) / 2)];
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: mid },
          properties: { kind: 'holding', ref: null, holdingType: 'runway', bearing: bearingDeg(coords[0], coords.at(-1)!) },
        });
      } else if (shape.geoArea === null && isGray(shape.fillColour) && coords.length >= 3) {
        const ring = coords[0][0] === coords.at(-1)![0] && coords[0][1] === coords.at(-1)![1] ? coords : [...coords, coords[0]];
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'apron', ref: null } });
      }
    }
    // Pas d'axes de taxiway dans ce format : seulement leurs étiquettes
    for (const t of s.taxiways ?? []) {
      if (t.airport !== icao || !once(`twy ${t.text} ${key(t.mapPosition)}`)) continue;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: fromMap(t.mapPosition) }, properties: { kind: 'taxiway-label', ref: t.text } });
    }
  };
  return { add, features };
}

export async function getAuroraGround(icao: string): Promise<GroundFeature[] | null> {
  // Plusieurs sector files citent l'aérodrome (FIR voisines) : celui qui en contient le plan au sol d'abord
  const folder =
    (await folderOf(async (f) => existsSync(path.join(AURORA_ROOT, f, `ground_${icao}.json`)))) ??
    (await folderOf(async (f) => Boolean((await auroraGlobal(f).catch(() => null))?.airports?.[icao])));
  if (!folder) return null;
  const airport = (await auroraGlobal(folder)).airports[icao];
  const packed = path.join(AURORA_ROOT, folder, `ground_${icao}.json`);
  let features: GroundFeature[];
  if (existsSync(packed)) {
    features = JSON.parse(await readFile(packed, 'utf8')) as GroundFeature[];
  } else {
    const ground = groundCollector(icao, airport);
    for (const s of await auroraSections(folder, (level) => level >= GROUND_LEVEL)) ground.add(s);
    features = ground.features;
  }
  const stands: GroundFeature[] = (airport.gates ?? []).map((g) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: fromMap(g.mapPosition) },
    properties: { kind: 'stand', ref: g.identifier },
  }));
  return [...features, ...stands];
}
