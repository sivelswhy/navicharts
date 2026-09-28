// SID et STAR d'un aérodrome français, d'après les tableaux de codage de l'eAIP (documents « DATA … CODE ») :
// suite des branches ARINC 424 de chaque procédure, et coordonnées des points (pages « DATA nn »).
// Les points notés « REF ENR 4.4 / 4.1 » renvoient aux points en route et balises, résolus côté client.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { currentCycle } from './airac.ts';
import { readPage, type Line } from './georef.ts';
import { getSiaCharts } from './sia.ts';

export interface Procedure {
  type: 'SID' | 'STAR';
  /** Désignation publiée (« AGOPA 6A ») et forme plan de vol, limitée à 6 caractères (« AGOP6A ») */
  name: string;
  ident: string;
  runways: string[];
  /** Points dans l'ordre de vol (les branches sans point, comme « CA », sont ignorées) */
  fixes: string[];
}

/** Approche aux instruments d'une piste : branches initiales depuis chaque IAF, finale, puis approche interrompue */
export interface Approach {
  /** « RNP », « ILS Z LOC Z »… */
  name: string;
  runway: string;
  /** Branches initiales (tableau INA de la piste) : de l'IAF au point de début de la finale */
  initial: { iaf: string; fixes: string[] }[];
  /** Finale, du point de début jusqu'au seuil (RW14L) */
  final: string[];
  /** Approche interrompue, après le seuil */
  missed: string[];
}

export interface AirportProcedures {
  icao: string;
  procedures: Procedure[];
  /** Approches (tableaux de codage INA et FNA de l'eAIP France) */
  approaches?: Approach[];
  /** Coordonnées [lon, lat] des points terminaux publiés dans les pages DATA */
  waypoints: Record<string, [number, number]>;
}

const USER_AGENT = { 'User-Agent': 'NaviCharts (usage personnel)' };

// Terminaisons de branche ARINC 424 suivies d'un point
const PATH_TERMINATORS = 'IF|TF|CF|DF|RF|AF|HF|HA|HM|FA|FC|FD|FM|CD|CI|CR|VD|VI|VM|VR|CA|VA|PI';
const LEG = new RegExp(`(?:^|\\|)\\s*(${PATH_TERMINATORS})\\s*\\|\\s*([A-Z][A-Z0-9]{1,4})\\b`);
// En-tête de procédure : « AGOPA 6A », « MAGEC 2S », « LFPO 1B »…
const HEADER = /^([A-Z]{2,5})\s?(\d[A-Z])$/;
const RUNWAY = /RWY\s?(\d{2}[LRC]?)/g;
// Degrés, minutes, secondes : apostrophes droites ou typographiques, espaces éventuels (47° 37’ 03,49’’N)
const DMS = /(\d{2,3})°\s*(\d{2})\s*['’]\s*(\d{2}(?:[.,]\d+)?)\s*(?:''|’’|"|”)\s*([NSEW])/g;

/** Texte d'une page PDF, regroupé en rangées selon l'orientation dominante du texte (pages en paysage comprises) */
async function pdfRows(url: string, turn = 0): Promise<string[]> {
  const res = await fetch(url, { headers: USER_AGENT });
  if (!res.ok) return [];
  const task = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), fontExtraProperties: true });
  try {
    const doc = await task.promise;
    const rows: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const { lines } = await readPage(await doc.getPage(p));
      rows.push(...groupRows(lines, turn));
    }
    return rows;
  } finally {
    await task.destroy();
  }
}

function groupRows(lines: Line[], turn = 0): string[] {
  // Orientation majoritaire du texte (pondérée par la longueur), prise exactement : une moyenne serait faussée
  // par les quelques textes d'orientation différente (titres, en-têtes)
  const weight = new Map<number, number>();
  for (const l of lines) {
    const angle = Math.round((Math.atan2(l.transform[1], l.transform[0]) * 180) / Math.PI);
    weight.set(angle, (weight.get(angle) ?? 0) + l.text.length);
  }
  const angle = (([...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0) + turn) * (Math.PI / 180);
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const rows = new Map<number, { u: number; text: string }[]>();
  for (const l of lines) {
    const [x, y] = [l.transform[4], l.transform[5]];
    const v = Math.round(-x * uy + y * ux); // position perpendiculaire à la lecture
    const u = x * ux + y * uy; // position le long de la lecture
    rows.set(v, [...(rows.get(v) ?? []), { u, text: l.text.trim() }]);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, cells]) =>
      cells
        .sort((a, b) => a.u - b.u)
        .map((c) => c.text)
        .filter(Boolean)
        .join(' | '),
    );
}

function parseDms(value: string, hemisphere: string, deg: string, min: string): number {
  const v = Number(deg) + Number(min) / 60 + Number(value.replace(',', '.')) / 3600;
  return hemisphere === 'S' || hemisphere === 'W' ? -v : v;
}

/** Pages « DATA nn » : identifiant | latitude | longitude */
function parseWaypoints(rows: string[], into: Record<string, [number, number]>) {
  const position = (row: string): [number, number] | null => {
    const coords = [...row.matchAll(DMS)];
    const lat = coords.find((c) => c[4] === 'N' || c[4] === 'S');
    const lon = coords.find((c) => c[4] === 'E' || c[4] === 'W');
    return lat && lon ? [parseDms(lon[3], lon[4], lon[1], lon[2]), parseDms(lat[3], lat[4], lat[1], lat[2])] : null;
  };
  const IDENT = /^([A-Z][A-Z0-9]{1,4})\s*(?:\||$)/;
  // Flèche d'entrée ou de sortie devant le nom (→ | ML632 | …)
  const identOf = (row: string | undefined) => (row ? IDENT.exec(row.replace(/^[\s←→|]+/, ''))?.[1] : undefined);
  // Coordonnées seules sur leur ligne, pas encore attribuées
  const free = new Set(rows.flatMap((row, i) => (!identOf(row) && position(row) ? [i] : [])));
  rows.forEach((row, i) => {
    const ident = identOf(row);
    if (!ident) return;
    const at = position(row);
    if (at) {
      into[ident] ??= at;
      return;
    }
    // Identifiant sans coordonnées (cellule sur deux lignes) : elles sont sur la ligne voisine, en général au-dessus
    for (const j of [i - 1, i + 1]) {
      if (!free.has(j)) continue;
      free.delete(j);
      into[ident] ??= position(rows[j])!;
      return;
    }
  });
}

/** « AGOPA 6A » → « AGOP6A » : désignation plan de vol de 6 caractères au plus */
function flightPlanIdent(fix: string, suffix: string): string {
  return fix.slice(0, 6 - suffix.length) + suffix;
}

/** Tableau de codage : en-tête de procédure, pistes concernées, puis une branche par rangée */
function parseProcedures(rows: string[], type: 'SID' | 'STAR', defaultRunways: string[]): Procedure[] {
  const procedures: Procedure[] = [];
  let current: Procedure | null = null;
  for (const row of rows) {
    const header = HEADER.exec(row.trim());
    if (header) {
      current = { type, name: `${header[1]} ${header[2]}`, ident: flightPlanIdent(header[1], header[2]), runways: [], fixes: [] };
      procedures.push(current);
      continue;
    }
    if (!current) continue;
    for (const m of row.matchAll(RUNWAY)) if (!current.runways.includes(m[1])) current.runways.push(m[1]);
    const leg = LEG.exec(row);
    if (leg && current.fixes.at(-1) !== leg[2]) current.fixes.push(leg[2]);
  }
  for (const p of procedures) if (!p.runways.length) p.runways = defaultRunways;
  return procedures.filter((p) => p.fixes.length > 0);
}

const TERMINATOR_NAMES = new Set(PATH_TERMINATORS.split('|'));

const ORPHAN_LEG = /^-\s*\|\s*([A-Z][A-Z0-9]{1,4})\s*\|/;

// Branche IF dont le texte est collé au point (« IFIO14L-----3000 »)
const GLUED_IF = /^IF([A-Z][A-Z0-9]{1,4})-/;

/**
 * Rangées d'un tableau de codage ; certains sont mis en page de biais (une colonne par branche) : relus tournés
 * d'un quart de tour quand aucune branche n'apparaît à l'endroit
 */
async function legRows(url: string): Promise<string[]> {
  const rows = await pdfRows(url);
  if (parseLegSequences(rows).length) return rows;
  const turned = await pdfRows(url, 90);
  return parseLegSequences(turned).length ? turned : rows;
}

/** Suites de points d'un tableau d'approche : une nouvelle suite à chaque IF (point de départ d'une branche) */
function parseLegSequences(rows: string[]): string[][] {
  const sequences: string[][] = [];
  for (const row of rows) {
    const leg = LEG.exec(row);
    const glued = leg ? null : GLUED_IF.exec(row.trim());
    // Branche dont le type est passé sur une autre ligne (« - | RG303 | Yes | … ») : suite de la branche en cours
    const orphan = leg || glued || !sequences.length ? null : ORPHAN_LEG.exec(row.trim());
    const [terminator, fix] = leg ? [leg[1], leg[2]] : glued ? ['IF', glued[1]] : orphan ? ['TF', orphan[1]] : [null, null];
    // Tableaux de biais lus à l'endroit : « IF | IF | IF » n'est pas une branche vers le point « IF »
    if (!terminator || !fix || TERMINATOR_NAMES.has(fix)) continue;
    if (terminator === 'IF' || !sequences.length) sequences.push([fix]);
    else if (sequences.at(-1)!.at(-1) !== fix) sequences.at(-1)!.push(fix);
  }
  return sequences;
}

const THRESHOLD = /^RW\d{2}[LRC]?$/;

/** Tableau de codage d'approche : pistes concernées, nom de l'approche, tableau INA seul ou non, rangées */
interface ApproachTable {
  runways: string[];
  name: string;
  initialOnly: boolean;
  rows: string[];
}

/**
 * « AD_2_LFML_DATA_RWY13L_FNA_RNP_Z_CODE » → pistes [13L], « RNP Z » ; « …_RWY17L_17R_INA_RNAV_CODE » → [17L, 17R],
 * INA ; « …_RWY04L-04R_RNP_A_CODE » → [04L, 04R], « RNP A ». null pour un document qui n'est pas un tableau de codage
 * d'approche (SID, STAR, FASDB, pages de points…)
 */
export function approachTableOf(id: string): Omit<ApproachTable, 'rows'> | null {
  const m = /_DATA_RWY_?(.+)$/.exec(id);
  if (!m || !/(^|_)CODE(_|$)/.test(m[1]) || /FASDB|(^|_)(SID|STAR)(_|$)/.test(m[1])) return null;
  const tokens = m[1].split('_').filter(Boolean);
  const runways: string[] = [];
  while (tokens.length && /^\d{2}[LRC]?(-\d{2}[LRC]?)*$/.test(tokens[0])) runways.push(...tokens.shift()!.split('-'));
  if (!runways.length) return null;
  const initialOnly = tokens.includes('INA');
  const name = tokens.filter((t) => !/^(FNA|INA|CODE|\d{1,2})$/.test(t)).join(' ');
  return { runways, name, initialOnly };
}

/** Une piste d'approche (13L) est desservie par un tableau INA de la piste (13L) ou du doublet (13) */
const servesRunway = (tableRunways: string[], runway: string) => tableRunways.some((r) => r === runway || r === runway.replace(/[LRC]$/, ''));

/**
 * Approches d'après les tableaux de codage : un tableau d'approche donne la finale (la suite de points qui atteint le
 * seuil, puis l'approche interrompue) et parfois les branches initiales ; les tableaux INA de la piste en ajoutent
 */
function parseApproaches(tables: ApproachTable[]): Approach[] {
  const inaBranches = tables
    .filter((t) => t.initialOnly)
    .map((t) => ({ runways: t.runways, branches: parseLegSequences(t.rows).filter((b) => b.length > 1) }));
  return tables
    .filter((t) => !t.initialOnly)
    .flatMap((t) => {
      const sequences = parseLegSequences(t.rows).filter((q) => q.length);
      if (!sequences.length) return [];
      const finalSeq = sequences.find((q) => q.some((f) => THRESHOLD.test(f))) ?? sequences.at(-1)!;
      const runway = t.runways.join('-');
      const initial = [
        // Suites qui partent du début de la finale : pas des branches initiales
        ...sequences.filter((q) => q !== finalSeq && q.length > 1 && q[0] !== finalSeq[0]),
        ...inaBranches.filter((b) => t.runways.some((r) => servesRunway(b.runways, r))).flatMap((b) => b.branches),
      ];
      // Branches en double (même IAF, mêmes points) entre plusieurs tableaux
      const unique = [...new Map(initial.filter((b) => b[0] !== finalSeq[0]).map((b) => [b.join(' '), b])).values()].map((fixes) => ({
        iaf: fixes[0],
        fixes,
      }));
      const end = finalSeq.findIndex((f) => THRESHOLD.test(f));
      // Finale ILS non codée (« See chart ») : de l'IF au seuil, les branches suivantes sont l'approche interrompue
      if (end < 0) return [{ name: t.name, runway, initial: unique, final: [finalSeq[0], `RW${t.runways[0]}`], missed: finalSeq.slice(1) }];
      return [{ name: t.name, runway, initial: unique, final: finalSeq.slice(0, end + 1), missed: finalSeq.slice(end + 1) }];
    });
}

/** « …_SID_RWY26L-26R_RNAV_CODE_01 » → [26L, 26R] */
function runwaysFromId(id: string): string[] {
  const m = /RWY([0-9LRC-]+)/.exec(id);
  return m ? m[1].split('-').filter(Boolean) : [];
}

const cache = new Map<string, Promise<AirportProcedures>>();

export function getProcedures(icao: string): Promise<AirportProcedures> {
  const key = `${currentCycle().ident}:${icao}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = (async () => {
      const { charts } = await getSiaCharts(icao);
      const waypointDocs = charts.filter((c) => /_DATA_\d+$/.test(c.id));
      const procedureDocs = charts.filter((c) => /_DATA_(SID|STAR)_.*CODE/.test(c.id));
      // Tableaux de codage des approches ; une même approche peut s'étendre sur plusieurs documents (…_CODE_01, _02)
      const approachDocs = new Map<string, { table: Omit<ApproachTable, 'rows'>; charts: typeof charts }>();
      for (const c of [...charts].sort((a, b) => a.id.localeCompare(b.id))) {
        const table = approachTableOf(c.id);
        if (!table) continue;
        const key = `${table.runways.join('-')} ${table.name} ${table.initialOnly}`;
        const entry = approachDocs.get(key) ?? { table, charts: [] };
        entry.charts.push(c);
        approachDocs.set(key, entry);
      }
      const waypoints: Record<string, [number, number]> = {};
      const procedures: Procedure[] = [];
      const approachTables = Promise.all(
        [...approachDocs.values()].map(async ({ table, charts: docs }) => ({ ...table, rows: (await Promise.all(docs.map((d) => legRows(d.url)))).flat() })),
      );
      await Promise.all([
        ...waypointDocs.map(async (c) => parseWaypoints(await pdfRows(c.url), waypoints)),
        ...procedureDocs.map(async (c) => {
          const type = /_DATA_SID_/.test(c.id) ? 'SID' : 'STAR';
          procedures.push(...parseProcedures(await pdfRows(c.url), type, runwaysFromId(c.id)));
        }),
      ]);
      return { icao, procedures, waypoints, approaches: parseApproaches(await approachTables) };
    })();
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}
