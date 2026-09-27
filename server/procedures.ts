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

export interface AirportProcedures {
  icao: string;
  procedures: Procedure[];
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
const DMS = /(\d{2,3})°(\d{2})'(\d{2}(?:[.,]\d+)?)''\s*([NSEW])/g;

/** Texte d'une page PDF, regroupé en rangées selon l'orientation dominante du texte (pages en paysage comprises) */
async function pdfRows(url: string): Promise<string[]> {
  const res = await fetch(url, { headers: USER_AGENT });
  if (!res.ok) return [];
  const task = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), fontExtraProperties: true });
  try {
    const doc = await task.promise;
    const rows: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const { lines } = await readPage(await doc.getPage(p));
      rows.push(...groupRows(lines));
    }
    return rows;
  } finally {
    await task.destroy();
  }
}

function groupRows(lines: Line[]): string[] {
  // Orientation majoritaire du texte (pondérée par la longueur), prise exactement : une moyenne serait faussée
  // par les quelques textes d'orientation différente (titres, en-têtes)
  const weight = new Map<number, number>();
  for (const l of lines) {
    const angle = Math.round((Math.atan2(l.transform[1], l.transform[0]) * 180) / Math.PI);
    weight.set(angle, (weight.get(angle) ?? 0) + l.text.length);
  }
  const angle = ([...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0) * (Math.PI / 180);
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
  for (const row of rows) {
    const ident = /^([A-Z][A-Z0-9]{1,4})\s*\|/.exec(row)?.[1];
    const coords = [...row.matchAll(DMS)];
    if (!ident || coords.length < 2) continue;
    const lat = coords.find((c) => c[4] === 'N' || c[4] === 'S');
    const lon = coords.find((c) => c[4] === 'E' || c[4] === 'W');
    if (lat && lon) into[ident] = [parseDms(lon[3], lon[4], lon[1], lon[2]), parseDms(lat[3], lat[4], lat[1], lat[2])];
  }
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
      const waypoints: Record<string, [number, number]> = {};
      const procedures: Procedure[] = [];
      await Promise.all([
        ...waypointDocs.map(async (c) => parseWaypoints(await pdfRows(c.url), waypoints)),
        ...procedureDocs.map(async (c) => {
          const type = /_DATA_SID_/.test(c.id) ? 'SID' : 'STAR';
          procedures.push(...parseProcedures(await pdfRows(c.url), type, runwaysFromId(c.id)));
        }),
      ]);
      return { icao, procedures, waypoints };
    })();
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}
