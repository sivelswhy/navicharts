// Sector files Aurora des divisions IVAO qui les publient sur GitHub (Amériques, Asie) :
//   États-Unis : https://github.com/IVAO-US/SectorFiles (navdata « Keyvan Aviation »), à chaque cycle AIRAC
//   Canada :     https://github.com/IVAO-Canada/SectorFiles (GPL-3.0), à chaque cycle AIRAC
//   Équateur :   https://github.com/IVAO-Ecuador/IVAO-SectorFile (mis à jour début 2024)
//   Uruguay :    https://github.com/Miguel22247/Aurora-Sector-File (2024)
//   Japon :      https://github.com/NightFalconS/RJJJ-AuroraSectorFile
//   Singapour :  https://github.com/NightFalconS/WSJCAuroraSectorFile
//   Indonésie :  https://github.com/IVAOID/ID-Sectorfile (GPL-3.0)
//   Thaïlande :  https://github.com/ivaoth/sector-file
// Les autres divisions d'Amérique du Sud (Brésil, Argentine, Chili, Pérou, Colombie…) ne publient pas les leurs.
// Selon la division, les fichiers sont rangés et nommés différemment (.ap / .apt, .awh / .awy…) et les coordonnées
// sont décimales ou en degrés-minutes-secondes (« S000.26.41.800 »).
// Les fichiers sont repérés d'après l'arborescence de chaque dépôt (API GitHub) et mis en cache sur disque.
// Ce module sert aussi bien au script de génération des données (scripts/build-ivao.ts) qu'au serveur, qui y lit à la
// demande les procédures (SID, STAR, approches) et le plan au sol d'un aérodrome.
//
// Formats (champs séparés par « ; ») :
//   procédures (.sid / .str) : en-tête « aérodrome;piste(s) séparées par « : »;NOM[.TRANSITION];aérodrome;aérodrome;type »
//     (type 3 : approche, 5 : approche interrompue « (GA) », vide ou 1 : SID ou STAR), suivi des points :
//     « POINT;POINT;<br> » lève le crayon, « POINT;POINT;contrainte » trace jusqu'au point, « lat;lon » point sans nom
//   plan au sol : .tfl polygones (« STATIC;TYPE;… » puis « lat;lon »), .geo segments (« lat;lon;lat;lon;TYPE »),
//     .txi étiquettes de taxiway et .gts postes (« texte;aérodrome;lat;lon »)
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GroundFeature } from './ground.ts';
import type { Approach, AirportProcedures, Procedure } from './procedures.ts';

type LngLat = [number, number];

export interface Division {
  name: string;
  /** Code pays ISO des aérodromes de la division */
  country: string;
  /** Continent OurAirports des aérodromes de la division (NA, SA, AS) */
  continent: string;
  repo: string;
  branch: string;
  /** Dossier local (sector file copié depuis Aurora) : remplace le dépôt GitHub */
  local?: string;
}

export const DIVISIONS: Division[] = [
  { name: 'États-Unis', country: 'US', continent: 'NA', repo: 'IVAO-US/SectorFiles', branch: 'master' },
  { name: 'Canada', country: 'CA', continent: 'NA', repo: 'IVAO-Canada/SectorFiles', branch: 'main' },
  { name: 'Équateur', country: 'EC', continent: 'SA', repo: 'IVAO-Ecuador/IVAO-SectorFile', branch: 'master' },
  { name: 'Uruguay', country: 'UY', continent: 'SA', repo: 'Miguel22247/Aurora-Sector-File', branch: 'main' },
  { name: 'Japon', country: 'JP', continent: 'AS', repo: 'NightFalconS/RJJJ-AuroraSectorFile', branch: 'main' },
  { name: 'Singapour', country: 'SG', continent: 'AS', repo: 'NightFalconS/WSJCAuroraSectorFile', branch: 'main' },
  { name: 'Indonésie', country: 'ID', continent: 'AS', repo: 'IVAOID/ID-Sectorfile', branch: 'main' },
  { name: 'Thaïlande', country: 'TH', continent: 'AS', repo: 'ivaoth/sector-file', branch: 'main' },
  ...localDivisions(),
];

/**
 * Sector files copiés à la main depuis Aurora (usage personnel, jamais versionnés : `sector files/` est ignoré par git),
 * un dossier par sector file dans `sector files/aurora/<nom>/` (le .isc et son dossier Include). Le pays des aérodromes
 * vient d'OurAirports ; ceux qu'il ne connaît pas sont ignorés.
 */
function localDivisions(): Division[] {
  const root = path.resolve(import.meta.dirname, '..', 'sector files', 'aurora');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    // Les dossiers au format du cache d'Aurora (global.json) sont lus par aurora.ts
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !existsSync(path.join(root, d.name, 'global.json')))
    .map((d) => ({ name: d.name, country: '', continent: '', repo: `local/${d.name}`, branch: '', local: path.join(root, d.name) }));
}

/** Fichiers d'un dossier local, chemins relatifs avec « / » */
async function listLocal(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listLocal(dir, path.posix.join(prefix, e.name)) : Promise.resolve([path.posix.join(prefix, e.name)]))),
  );
  return nested.flat();
}

const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache', 'sectorfiles');
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const USER_AGENT = { 'User-Agent': 'NaviCharts/0.1 (simulation de vol, usage personnel)' };

async function cached(file: string, load: () => Promise<string>): Promise<string> {
  const fresh = await stat(file).then((s) => Date.now() - s.mtimeMs < CACHE_MAX_AGE_MS, () => false);
  if (fresh) return readFile(file, 'utf8');
  try {
    const text = await load();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return text;
  } catch (err) {
    // Hors ligne ou GitHub indisponible : la dernière copie, même périmée, vaut mieux que rien
    return readFile(file, 'utf8').catch(() => Promise.reject(err));
  }
}

const trees = new Map<string, Promise<string[]>>();

/** Chemins de tous les fichiers du dépôt */
export function repoFiles(division: Division): Promise<string[]> {
  if (division.local) return listLocal(division.local);
  let entry = trees.get(division.repo);
  if (!entry) {
    entry = cached(path.join(CACHE_DIR, division.repo, 'tree.json'), async () => {
      const res = await fetch(`https://api.github.com/repos/${division.repo}/git/trees/${division.branch}?recursive=1`, {
        headers: USER_AGENT,
      });
      if (!res.ok) throw new Error(`arborescence de ${division.repo} : HTTP ${res.status}`);
      const tree = (await res.json()).tree as { path: string; type: string }[];
      return JSON.stringify(tree.filter((t) => t.type === 'blob').map((t) => t.path));
    }).then((text) => JSON.parse(text) as string[]);
    entry.catch(() => trees.delete(division.repo));
    trees.set(division.repo, entry);
  }
  return entry;
}

/** Contenu d'un fichier du dépôt */
export function sectorText(division: Division, file: string): Promise<string> {
  // Fichiers d'Aurora : UTF-8 ou Windows-1252 selon la division
  if (division.local) {
    return readFile(path.join(division.local, file)).then((buf) => {
      const utf8 = buf.toString('utf8');
      return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
    });
  }
  return cached(path.join(CACHE_DIR, division.repo, file), async () => {
    const res = await fetch(`https://raw.githubusercontent.com/${division.repo}/${division.branch}/${file}`, { headers: USER_AGENT });
    if (!res.ok) throw new Error(`${file} : HTTP ${res.status}`);
    return res.text();
  });
}

/** Lignes non vides, hors commentaires, découpées en champs */
export function sectorRows(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('//'))
    .map((l) => l.split(';').map((f) => f.trim()));
}

/** Lignes de tous les fichiers du dépôt dont le chemin correspond, téléchargés quelques-uns à la fois */
export async function sectorFiles(division: Division, pattern: RegExp): Promise<{ file: string; rows: string[][] }[]> {
  const files = (await repoFiles(division)).filter((f) => pattern.test(f));
  const result: { file: string; rows: string[][] }[] = [];
  for (let i = 0; i < files.length; i += 16) {
    const batch = files.slice(i, i + 16);
    const texts = await Promise.all(batch.map((f) => sectorText(division, f)));
    batch.forEach((file, j) => result.push({ file, rows: sectorRows(texts[j]) }));
  }
  return result;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
// « S000.26.41.800 » : hémisphère, degrés, minutes, secondes
const DMS = /^([NSEW])(\d{1,3})\.(\d{1,2})\.(\d{1,2}(?:\.\d+)?)$/i;

/** Coordonnée décimale (« -34.83 ») ou en degrés-minutes-secondes (« S034.49.57.800 ») */
function coordinate(value: string | undefined): number {
  if (value === undefined) return NaN;
  const m = DMS.exec(value.trim());
  if (!m) return Number(value);
  const v = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  return /[SW]/i.test(m[1]) ? -v : v;
}
export const position = (lat: string | undefined, lon: string | undefined): LngLat => [round(coordinate(lon)), round(coordinate(lat))];
/** Champ de coordonnée (décimale ou degrés-minutes-secondes) */
export const isCoordinate = (v: string | undefined) => v !== undefined && (/^-?\d+(\.\d+)?$/.test(v) || DMS.test(v.trim()));

/** Distance approximative en degrés, suffisante pour départager des homonymes */
export function distance(a: LngLat, b: LngLat): number {
  // Écart de longitude le plus court, antiméridien compris
  const dLon = Math.abs(a[0] - b[0]) % 360;
  return Math.hypot(Math.min(dLon, 360 - dLon) * Math.cos((a[1] * Math.PI) / 180), a[1] - b[1]);
}

// ───────── Aérodrome → division et fichiers ─────────

/** Fichier `<nom>.<ext>` du dépôt, où qu'il soit rangé (procedures/KIAD.sid, EC/AIRPORTS/SEQU/SEQU.STR…) */
const findFile = (files: string[], name: string, ext: string) => {
  const suffix = `${name}.${ext}`.toLowerCase();
  return files.find((f) => f.split('/').at(-1)!.toLowerCase() === suffix);
};

/** Division et nom de fichier (KIAD, 05U…) d'un aérodrome dont le dépôt a un fichier d'une des extensions */
async function locate(ident: string, exts: string[]): Promise<{ division: Division; name: string } | null> {
  // Les petits aérodromes américains sont nommés par leur indicatif FAA (K05U → 05U)
  const names = [ident, ...(/^K[A-Z0-9]{3}$/.test(ident) ? [ident.slice(1)] : [])];
  for (const division of DIVISIONS) {
    const files = await repoFiles(division).catch(() => []);
    for (const name of names) {
      if (exts.some((ext) => findFile(files, name, ext))) return { division, name };
    }
  }
  return null;
}

const fileOf = async (division: Division, name: string, ext: string) => {
  const file = findFile(await repoFiles(division), name, ext);
  return file ? sectorRows(await sectorText(division, file)) : [];
};

// ───────── Points et balises, pour situer les points des procédures ─────────

let navIndex: Promise<Map<string, LngLat[]>> | null = null;

function loadNavIndex(): Promise<Map<string, LngLat[]>> {
  navIndex ??= (async () => {
    const index = new Map<string, LngLat[]>();
    for (const division of DIVISIONS) {
      const files = await sectorFiles(division, /\.(fix|vor|ndb)$/i).catch(() => []);
      for (const { file, rows } of files) {
        const navaid = !/\.fix$/i.test(file);
        for (const f of rows) {
          const ident = f[0].split(' ')[0];
          const at = navaid ? position(f[2], f[3]) : position(f[1], f[2]);
          if (!Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
          index.set(ident, [...(index.get(ident) ?? []), at]);
        }
      }
    }
    return index;
  })();
  navIndex.catch(() => (navIndex = null));
  // Rechargé chaque jour, avec les fichiers
  setTimeout(() => (navIndex = null), CACHE_MAX_AGE_MS).unref();
  return navIndex;
}

async function airportPosition(division: Division, name: string): Promise<LngLat | null> {
  for (const { rows } of await sectorFiles(division, /\.(ap|apt)$/i)) {
    const row = rows.find((f) => f[0] === name);
    if (row) return position(row[3], row[4]);
  }
  return null;
}

// ───────── Procédures ─────────

interface Point {
  ident: string | null;
  at?: LngLat;
  /** Début d'un nouveau tracé */
  start: boolean;
}

interface Block {
  runways: string[];
  name: string;
  kind: string;
  segments: Point[][];
}

function parseBlocks(rows: string[][], airport: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const f of rows) {
    // En-tête : aérodrome puis piste(s) (les points sont « POINT;POINT;… », l'aérodrome lui-même « KIAD;KIAD;… »)
    if (f.length >= 5 && f[0] === airport && f[1] !== airport) {
      current = { runways: f[1].split(':').filter(Boolean), name: f[2], kind: f[5] ?? '', segments: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    let point: Point;
    if (isCoordinate(f[0]) && isCoordinate(f[1])) point = { ident: null, at: position(f[0], f[1]), start: false };
    else {
      // « KIAD/RW01C » ou « CYUL/06L » → seuil RW01C ; l'aérodrome lui-même n'est pas un point de la procédure
      const threshold = f[0].includes('/') ? f[0].split('/')[1] : null;
      const ident = threshold ? `RW${threshold.replace(/^RW/, '')}` : f[0] === airport ? null : f[0];
      point = { ident, start: f[2] === '<br>' };
    }
    if (point.start || !current.segments.length) current.segments.push([]);
    const segment = current.segments.at(-1)!;
    // Le point de départ d'un tracé est souvent répété sur la ligne suivante
    if (point.ident && segment.at(-1)?.ident === point.ident) continue;
    segment.push(point);
  }
  return blocks;
}

const named = (segment: Point[]) => segment.flatMap((p) => (p.ident ? [p.ident] : []));
const isThreshold = (ident: string) => /^RW\d{2}[LRC]?$/.test(ident);
const PROCEDURE_NAME = /^[A-Z]{2,5}\d[A-Z]?$/;

/** Forme plan de vol, limitée à 6 caractères, et nom affiché (« BUNZZ 3 ») */
const flightPlanIdent = (ident: string) => {
  const m = /^([A-Z]+)(\d[A-Z]?)$/.exec(ident);
  return m && ident.length > 6 ? m[1].slice(0, 6 - m[2].length) + m[2] : ident;
};
const displayName = (ident: string) => ident.replace(/^([A-Z]+)(\d[A-Z]?)$/, '$1 $2');

/** Chemins d'une SID ou d'une STAR : les tracés forment un graphe (transitions, tronc commun, transitions de piste) */
function paths(segments: Point[][]): string[][] {
  const next = new Map<string, string[]>();
  const incoming = new Set<string>();
  const nodes = new Set<string>();
  for (const segment of segments) {
    const idents = named(segment).filter((i) => !isThreshold(i));
    idents.forEach((i) => nodes.add(i));
    for (let i = 1; i < idents.length; i++) {
      if (idents[i] === idents[i - 1]) continue;
      next.set(idents[i - 1], [...new Set([...(next.get(idents[i - 1]) ?? []), idents[i]])]);
      incoming.add(idents[i]);
    }
  }
  const result: string[][] = [];
  const walk = (path: string[]) => {
    if (result.length >= 60) return;
    const options = (next.get(path.at(-1)!) ?? []).filter((n) => !path.includes(n));
    if (!options.length) return void result.push(path);
    for (const n of options) walk([...path, n]);
  };
  for (const start of nodes) if (!incoming.has(start)) walk([start]);
  return result;
}

const APPROACH_TYPES: Record<string, string> = {
  I: 'ILS',
  L: 'LOC',
  R: 'RNAV',
  H: 'RNP',
  V: 'VOR',
  D: 'VOR/DME',
  S: 'VOR',
  N: 'NDB',
  Q: 'NDB/DME',
  B: 'LOC BC',
  X: 'LDA',
  U: 'SDF',
  P: 'GPS',
  G: 'IGS',
  J: 'GLS',
  T: 'TACAN',
};

// Codes canadiens : type en toutes lettres (« ILS06L », « RNV06LX »)
const APPROACH_WORDS: Record<string, string> = { ILS: 'ILS', LOC: 'LOC', RNV: 'RNAV', RNP: 'RNP', VOR: 'VOR', NDB: 'NDB', GPS: 'GPS', LDA: 'LDA', BC: 'LOC BC' };

/** « I01C » → ILS, « R01CY » → RNAV Y, « RNV06LX » → RNAV X, « ILS Z » → ILS Z ; null si ce n'est pas une approche */
export function approachName(code: string): string | null {
  const m = /^([A-Z]{1,3})(\d{2}[LRC]?)-?([A-Z])?$/.exec(code);
  const type = m && (m[1].length === 1 ? APPROACH_TYPES[m[1]] : APPROACH_WORDS[m[1]]);
  if (type) return [type, m[3]].filter(Boolean).join(' ');
  // Nom en toutes lettres, piste dans un champ à part (Équateur)
  const words = /^(ILS|LOC|RNAV|RNP|VOR|NDB|GPS|LDA|VOR\/DME|NDB\/DME)(?:[\s-]+\(?([A-Z])\)?)?$/.exec(code);
  return words ? [words[1], words[2]].filter(Boolean).join(' ') : null;
}

function buildApproaches(blocks: Block[]): Approach[] {
  const approaches = new Map<string, Approach>();
  // Dernier tracé de chaque approche, faute de seuil de piste nommé (finales codées en coordonnées)
  const lastSegment = new Map<Approach, string[]>();
  const get = (code: string, runway: string) => {
    const key = `${code} ${runway}`;
    let approach = approaches.get(key);
    if (!approach) {
      approach = { name: approachName(code) ?? code, runway, initial: [], final: [], missed: [] };
      approaches.set(key, approach);
    }
    return approach;
  };
  for (const b of blocks) {
    if (b.kind !== '3' && b.kind !== '5') continue;
    const runway = b.runways[0] ?? '';
    const raw = b.name.replace(/\s*\(GA\)$/, '');
    const [transition, code] = raw.includes('.') ? raw.split('.') : [null, raw];
    const approach = get(code, runway);
    const segments = b.segments.map(named).filter((s) => s.length);
    if (b.kind === '5') {
      // Approche interrompue : après le seuil
      for (const s of segments) {
        const end = s.findIndex(isThreshold);
        if (end >= 0 && !approach.missed.length) approach.missed = s.slice(end + 1);
      }
      continue;
    }
    if (!transition && segments.length) lastSegment.set(approach, segments.at(-1)!);
    for (const s of segments) {
      const end = s.findIndex(isThreshold);
      if (end >= 0 && !transition && !approach.final.length) approach.final = s.slice(0, end + 1);
      else if (s.length > 1 && end < 0 && !approach.initial.some((i) => i.fixes.join() === s.join())) {
        approach.initial.push({ iaf: s[0], fixes: s });
      } else if (end >= 0 && transition && s.length > 1) {
        // Transition qui rejoint la finale : branche initiale jusqu'au début de la finale
        const fixes = s.slice(0, end);
        if (fixes.length > 1 && !approach.initial.some((i) => i.fixes.join() === fixes.join())) approach.initial.push({ iaf: fixes[0], fixes });
      }
    }
  }
  // Branches initiales : jusqu'au premier point commun avec la finale ; celles qui partent de la finale n'en sont pas
  for (const a of approaches.values()) {
    const last = lastSegment.get(a);
    if (!a.final.length && last) {
      a.final = [...last, `RW${a.runway}`];
      a.initial = a.initial.filter((b) => b.fixes.join() !== last.join());
    }
    const branches = a.initial
      .filter((b) => !a.final.includes(b.iaf))
      .map((b) => {
        const join = b.fixes.findIndex((f, i) => i > 0 && a.final.includes(f));
        return join > 0 ? { iaf: b.iaf, fixes: b.fixes.slice(0, join + 1) } : b;
      });
    a.initial = [...new Map(branches.map((b) => [b.fixes.join(' '), b])).values()];
  }
  return [...approaches.values()].filter((a) => a.final.length);
}

function buildProcedures(blocks: Block[], type: 'SID' | 'STAR'): Procedure[] {
  const byKey = new Map<string, Procedure>();
  for (const b of blocks) {
    if (b.kind !== '' && b.kind !== '1') continue;
    const base = b.name.split('.').find((p) => PROCEDURE_NAME.test(p)) ?? b.name.split('.')[0];
    for (const fixes of paths(b.segments)) {
      const key = `${base} ${fixes.join(' ')}`;
      const existing = byKey.get(key);
      if (existing) existing.runways = [...new Set([...existing.runways, ...b.runways])];
      else byKey.set(key, { type, name: displayName(base), ident: flightPlanIdent(base), runways: [...b.runways], fixes });
    }
  }
  return [...byKey.values()].sort((a, b) => a.ident.localeCompare(b.ident));
}

// Au-delà, un point du même nom n'appartient pas aux procédures de l'aérodrome
const MAX_PROCEDURE_DISTANCE = 400 / 60;

export async function getSectorProcedures(ident: string): Promise<AirportProcedures | null> {
  const found = await locate(ident, ['sid', 'str']);
  if (!found) return null;
  const { division, name } = found;
  const [sid, str, at, index] = await Promise.all([
    fileOf(division, name, 'sid'),
    fileOf(division, name, 'str'),
    airportPosition(division, name),
    loadNavIndex(),
  ]);
  const sidBlocks = parseBlocks(sid, name);
  const strBlocks = parseBlocks(str, name);
  const procedures = [...buildProcedures(sidBlocks, 'SID'), ...buildProcedures(strBlocks, 'STAR')];
  const approaches = buildApproaches([...strBlocks, ...sidBlocks]);

  // Coordonnées des points : balise ou point le plus proche de l'aérodrome
  const waypoints: Record<string, LngLat> = {};
  const idents = new Set([
    ...procedures.flatMap((p) => p.fixes),
    ...approaches.flatMap((a) => [...a.initial.flatMap((b) => b.fixes), ...a.final, ...a.missed]),
  ]);
  for (const i of idents) {
    if (isThreshold(i)) continue;
    const options = index.get(i);
    if (!options?.length) continue;
    const best = at ? options.reduce((a, b) => (distance(b, at) < distance(a, at) ? b : a)) : options[0];
    if (!at || distance(best, at) <= MAX_PROCEDURE_DISTANCE) waypoints[i] = best;
  }
  return { icao: ident, procedures, approaches, waypoints };
}

// ───────── Plan au sol ─────────

function bearingDeg([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const θ = Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
  return ((θ * 180) / Math.PI + 360) % 360;
}

/** Distance d'un point à une ligne brisée, en degrés */
function distanceToLine(p: LngLat, line: LngLat[]): number {
  const kx = Math.cos((p[1] * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const dx = (line[i][0] - ax) * kx;
    const dy = line[i][1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * kx * dx + (p[1] - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot((p[0] - ax) * kx - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

/** Couleur grise (« #848484 ») : surface revêtue */
function isGray(color: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.slice(-7));
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

/** Segments « lat;lon;lat;lon;TYPE » enchaînés en lignes, par type */
function chainSegments(rows: string[][]): Map<string, LngLat[][]> {
  const lines = new Map<string, LngLat[][]>();
  for (const f of rows) {
    if (![0, 1, 2, 3].every((i) => isCoordinate(f[i]))) continue;
    const a = position(f[0], f[1]);
    const b = position(f[2], f[3]);
    const list = lines.get(f[4]) ?? [];
    const last = list.at(-1);
    if (last && last.at(-1)![0] === a[0] && last.at(-1)![1] === a[1]) last.push(b);
    else list.push([a, b]);
    lines.set(f[4], list);
  }
  return lines;
}

export async function getSectorGround(ident: string): Promise<GroundFeature[] | null> {
  const found = await locate(ident, ['geo', 'tfl']);
  if (!found) return null;
  const { division, name } = found;
  const [geo, tfl, txi, gts] = await Promise.all([
    fileOf(division, name, 'geo'),
    fileOf(division, name, 'tfl'),
    fileOf(division, name, 'txi'),
    fileOf(division, name, 'gts'),
  ]);
  const features: GroundFeature[] = [];

  // Surfaces : aires de trafic et taxiways revêtus, bâtiments (les pistes sont déjà dessinées)
  let ring: { kind: 'apron' | 'building'; coords: LngLat[] } | null = null;
  const closeRing = () => {
    if (ring && ring.coords.length >= 3) {
      const [first, last] = [ring.coords[0], ring.coords.at(-1)!];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.coords.push(first);
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring.coords] }, properties: { kind: ring.kind, ref: null } });
    }
    ring = null;
  };
  for (const f of tfl) {
    if (!isCoordinate(f[0])) {
      closeRing();
      // « STATIC;APRON;… » (États-Unis, Canada) ou « STATIC;#couleur;… » (Équateur : gris = revêtu, vert = herbe)
      const kind = f[1]?.startsWith('#') ? (isGray(f[1]) ? 'apron' : null) : /APRON|TAXIWAY/.test(f[1] ?? '') ? 'apron' : f[1] === 'BUILDING' ? 'building' : null;
      if (kind) ring = { kind, coords: [] };
      continue;
    }
    (ring as { coords: LngLat[] } | null)?.coords.push(position(f[0], f[1]));
  }
  closeRing();

  const lines = chainSegments(geo);
  // Axes de taxiway, nommés d'après l'étiquette la plus proche (à moins de ~80 m)
  const taxiways = (lines.get('TAXI_CENTER') ?? []).map((coords) => ({ coords, ref: null as string | null }));
  for (const [label, , lat, lon] of txi) {
    const at = position(lat, lon);
    let best: { d: number; t: (typeof taxiways)[number] } | null = null;
    for (const t of taxiways) {
      if (t.ref) continue;
      const d = distanceToLine(at, t.coords);
      if (!best || d < best.d) best = { d, t };
    }
    if (best && best.d < 0.0008) best.t.ref = label;
  }
  for (const t of taxiways) {
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.coords }, properties: { kind: 'taxiway', ref: t.ref } });
  }
  // Passerelles, et contours de bâtiments dessinés en lignes (Équateur)
  for (const coords of [...(lines.get('PIER') ?? []), ...(lines.get('BUILDING') ?? [])]) {
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'pier', ref: null } });
  }
  // Barres d'arrêt : point d'attente au milieu, orienté selon le marquage
  for (const coords of [...(lines.get('STOPLINE') ?? []), ...(lines.get('STOPBAR') ?? [])]) {
    const mid: LngLat = [(coords[0][0] + coords.at(-1)![0]) / 2, (coords[0][1] + coords.at(-1)![1]) / 2];
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round(mid[0]), round(mid[1])] },
      properties: { kind: 'holding', ref: null, holdingType: 'runway', bearing: bearingDeg(coords[0], coords.at(-1)!) },
    });
  }
  // Postes de stationnement et zones (fret, hélisurfaces…)
  for (const [label, , lat, lon] of gts) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: position(lat, lon) }, properties: { kind: 'stand', ref: label } });
  }
  return features;
}
