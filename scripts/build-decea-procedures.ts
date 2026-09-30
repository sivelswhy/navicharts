// SID, STAR et approches du Brésil, d'après le jeu de données AIXM 5.1 complet que le DECEA publie gratuitement à
// chaque amendement AIRAC (https://aisweb.decea.gov.br/?i=publicacoes&p=aixm). Même forme que /api/procedures
// (server/procedures.ts) : un fichier par aérodrome dans public/data/procedures/, lu tel quel par l'application.
//
// Le fichier AIXM (~330 Mo) est lu en flux depuis le zip, ligne à ligne : il est indenté, chaque entité (procédure,
// branche, point…) commence à la même profondeur. Particularité du DECEA : le point auquel mène une branche est noté
// dans son `startPoint` (plus rarement `endPoint`).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { AirportProcedures, Approach, Hold, Procedure } from '../server/procedures.ts';

type LngLat = [number, number];

const AISWEB = 'https://aisweb.decea.gov.br';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'decea', 'aixm');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'procedures');

/** Jeu complet de l'amendement en vigueur : le plus récent dont la date est passée */
async function currentDataset(): Promise<{ amendment: string; url: string }> {
  const html = await (await fetch(`${AISWEB}/?i=publicacoes&p=aixm`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const text = html.replace(/<[^>]+>/g, ' ');
  const links = [...html.matchAll(/href="(download\/\?public=[^"]+&p=Completo)"/g)].map((m) => m[1]);
  // « AMDT 03/09/26 AMDT 2609A1 Completo » : dans l'ordre des liens « Completo »
  const entries = [...text.matchAll(/AMDT\s+(\d{2})\/(\d{2})\/(\d{2})\s+AMDT\s+(\w+)\s+Completo/g)].map((m, i) => ({
    date: new Date(`20${m[3]}-${m[2]}-${m[1]}T00:00:00Z`),
    amendment: m[4],
    url: `${AISWEB}/${links[i]?.replace(/&amp;/g, '&')}`,
  }));
  const current = entries.filter((e) => e.date.getTime() <= Date.now() && links.length).sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!current) throw new Error('aucun jeu AIXM complet en vigueur sur AISWEB');
  return current;
}

async function download(amendment: string, url: string): Promise<string> {
  const file = path.join(CACHE_DIR, `${amendment}.zip`);
  if (await stat(file).then((s) => s.size > 0, () => false)) return file;
  console.log(`↓ AIXM DECEA ${amendment}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok || !res.body) throw new Error(`AIXM ${amendment} : HTTP ${res.status}`);
  await mkdir(CACHE_DIR, { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  // Amendements précédents : inutiles
  for (const old of await readdir(CACHE_DIR)) if (old.endsWith('.zip') && old !== `${amendment}.zip`) await rm(path.join(CACHE_DIR, old));
  return file;
}

// ───────── Lecture en flux ─────────

interface Transition {
  id: string | null;
  type: string;
  runways: string[];
  legs: { seq: number; leg: string }[];
}
interface RawProcedure {
  kind: 'SID' | 'STAR' | 'APP';
  name: string;
  airport: string;
  transitions: Transition[];
}

const FEATURE = /^ {8}<aixm:(\w+) gml:id="uuid\.([^"]+)"/;
const PROCEDURES: Record<string, RawProcedure['kind']> = {
  StandardInstrumentDeparture: 'SID',
  StandardInstrumentArrival: 'STAR',
  InstrumentApproachProcedure: 'APP',
};
const LEG = /Leg$/;
const href = (line: string) => /xlink:href="urn:uuid:([^"]+)"/.exec(line)?.[1] ?? null;
const tag = (line: string, name: string) => new RegExp(`<aixm:${name}>([^<]*)</aixm:${name}>`).exec(line)?.[1];
// Blocs volumineux sans intérêt ici : métadonnées, tracés, surfaces de protection, textes
const SKIP = ['timeSliceMetadata', 'trajectory', 'designSurface', 'annotation', 'instruction', 'communicationFailureInstruction'];

async function readAixm(zip: string) {
  const airports = new Map<string, string>();
  const points = new Map<string, { ident: string; at: LngLat }>();
  const runwayDirections = new Map<string, string>();
  const centrelinePoints = new Map<string, string>();
  const legs = new Map<string, string | null>();
  // Branches d'attente (HM, HA, HF) : cap, sens du virage, durée ou longueur
  const holdLegs = new Map<string, { type: string; course: number; courseType: string; turn: string; minutes: number | null; nm: number | null }>();
  const magvar = new Map<string, number>();
  const procedures: RawProcedure[] = [];

  const unzip = spawn('unzip', ['-p', zip, 'BL_.xml']);
  const lines = createInterface({ input: unzip.stdout, crlfDelay: Infinity });
  let feature: { type: string; uuid: string } | null = null;
  let skipping: string | null = null;
  // Champs de l'entité en cours
  let designator: string | undefined;
  let pos: LngLat | undefined;
  let ref: string | null = null;
  let procedure: RawProcedure | null = null;
  let transition: Transition | null = null;
  let seq = 0;
  let where: 'start' | 'end' | null = null;
  let legPoint: { start: string | null; end: string | null } = { start: null, end: null };
  let leg: Record<string, string> = {};

  for await (const line of lines) {
    if (skipping) {
      if (line.includes(`</aixm:${skipping}>`)) skipping = null;
      continue;
    }
    const opening = !line.includes('/>') && SKIP.find((s) => line.includes(`<aixm:${s}>`) || line.includes(`<aixm:${s} `));
    if (opening && !line.includes(`</aixm:${opening}>`)) {
      skipping = opening;
      continue;
    }

    const start = FEATURE.exec(line);
    if (start) {
      feature = { type: start[1], uuid: start[2] };
      designator = pos = undefined;
      ref = null;
      transition = null;
      where = null;
      legPoint = { start: null, end: null };
      leg = {};
      procedure = PROCEDURES[feature.type] ? { kind: PROCEDURES[feature.type], name: '', airport: '', transitions: [] } : null;
      continue;
    }
    if (!feature) continue;

    if (line.startsWith(`        </aixm:${feature.type}>`)) {
      const { type, uuid } = feature;
      if (type === 'AirportHeliport' && designator) {
        airports.set(uuid, designator);
        if (leg.magneticVariation) magvar.set(designator, Number(leg.magneticVariation));
      }
      else if ((type === 'DesignatedPoint' || type === 'Navaid') && designator && pos) points.set(uuid, { ident: designator, at: pos });
      else if (type === 'RunwayDirection' && designator) runwayDirections.set(uuid, designator);
      else if (type === 'RunwayCentrelinePoint' && ref) centrelinePoints.set(uuid, ref);
      else if (LEG.test(type)) {
        legs.set(uuid, legPoint.start ?? legPoint.end);
        if (/^H[MAF]$/.test(leg.legTypeARINC ?? '') && leg.course) {
          holdLegs.set(uuid, {
            type: leg.legTypeARINC,
            course: Number(leg.course),
            courseType: leg.courseType ?? '',
            turn: leg.turnDirection ?? '',
            minutes: leg.duration && leg.durationUom === 'MIN' ? Number(leg.duration) : null,
            nm: leg.length && leg.lengthUom === 'NM' ? Number(leg.length) : null,
          });
        }
      }
      else if (procedure) procedures.push(procedure);
      feature = null;
      continue;
    }

    designator ??= tag(line, 'designator');
    const p = /<gml:pos>([-\d.]+) ([-\d.]+)<\/gml:pos>/.exec(line);
    if (p && !pos) pos = [Math.round(Number(p[2]) * 1e6) / 1e6, Math.round(Number(p[1]) * 1e6) / 1e6];

    if (feature.type === 'RunwayCentrelinePoint' && line.includes('<aixm:onRunway')) ref = href(line);

    // Champs simples utiles aux branches d'attente et à la déclinaison de l'aérodrome
    const field = /<aixm:(legTypeARINC|course|courseType|turnDirection|magneticVariation)>([^<]*)</.exec(line);
    if (field) leg[field[1]] ??= field[2];
    const measure = /<aixm:(duration|length) uom="([^"]+)">([^<]*)</.exec(line);
    if (measure) {
      leg[measure[1]] ??= measure[3];
      leg[`${measure[1]}Uom`] ??= measure[2];
    }
    if (LEG.test(feature.type)) {
      if (line.includes('<aixm:startPoint>')) where = 'start';
      else if (line.includes('<aixm:endPoint>')) where = 'end';
      else if (/<aixm:(startPoint|endPoint)\b/.test(line)) where = null;
      if (where && /<aixm:pointChoice_(fixDesignatedPoint|navaidSystem|runwayPoint)\b/.test(line)) {
        const id = href(line);
        // Seuil de piste : référencé par son point d'axe, noté « rwy: » pour le résoudre ensuite
        legPoint[where] ??= line.includes('runwayPoint') ? `rwy:${id}` : id;
      }
      continue;
    }

    if (procedure) {
      const name = tag(line, 'name');
      if (name !== undefined && !transition) procedure.name = name;
      if (line.includes('<aixm:airportHeliport ')) procedure.airport = href(line) ?? '';
      if (line.includes('<aixm:ProcedureTransition ')) {
        transition = { id: null, type: '', runways: [], legs: [] };
        procedure.transitions.push(transition);
      }
      if (transition) {
        const id = tag(line, 'transitionId');
        if (id !== undefined) transition.id = id;
        const type = tag(line, 'type');
        if (type !== undefined && !transition.type) transition.type = type;
        if (line.includes('<aixm:runway ')) transition.runways.push(href(line) ?? '');
        const n = tag(line, 'seqNumberARINC');
        if (n !== undefined) seq = Number(n);
        if (line.includes('<aixm:theSegmentLeg ')) transition.legs.push({ seq, leg: href(line) ?? '' });
      }
    }
  }
  const code = await new Promise<number | null>((resolve) => unzip.on('close', resolve));
  if (code) throw new Error(`lecture du zip AIXM impossible (unzip : ${code})`);
  return { airports, points, runwayDirections, centrelinePoints, legs, holdLegs, magvar, procedures };
}

// ───────── Mise en forme ─────────

const flightPlanIdent = (fix: string, suffix: string) => fix.slice(0, 6 - suffix.length) + suffix;
const unique = (list: string[]) => list.filter((f, i) => f !== list[i - 1]);

export async function buildDeceaProcedures(): Promise<{ amendment: string; airports: string[]; procedures: number; approaches: number }> {
  const { amendment, url } = await currentDataset();
  const zip = await download(amendment, url);
  const data = await readAixm(zip);

  /** Points d'une transition, dans l'ordre, et leurs coordonnées */
  const waypointsOf = new Map<string, Record<string, LngLat>>();
  const fixesOf = (t: Transition, airport: string) => {
    const wp = waypointsOf.get(airport) ?? {};
    waypointsOf.set(airport, wp);
    const fixes: string[] = [];
    for (const { leg } of [...t.legs].sort((a, b) => a.seq - b.seq)) {
      const id = data.legs.get(leg);
      if (!id) continue;
      if (id.startsWith('rwy:')) {
        const rwy = data.runwayDirections.get(data.centrelinePoints.get(id.slice(4)) ?? '');
        if (rwy) fixes.push(`RW${rwy}`);
        continue;
      }
      const point = data.points.get(id);
      if (!point) continue;
      fixes.push(point.ident);
      wp[point.ident] ??= point.at;
    }
    return unique(fixes);
  };
  const runwaysOf = (t: Transition) => t.runways.map((r) => data.runwayDirections.get(r)).filter((r): r is string => Boolean(r));

  const byAirport = new Map<string, AirportProcedures>();
  const get = (icao: string) => {
    let entry = byAirport.get(icao);
    if (!entry) {
      entry = { icao, procedures: [], approaches: [], waypoints: {} };
      byAirport.set(icao, entry);
    }
    return entry;
  };

  for (const p of data.procedures) {
    const icao = data.airports.get(p.airport);
    if (!icao) continue;
    const entry = get(icao);
    // « RWY 28R/28L » dans le nom, faute de pistes associées aux transitions
    const namedRunways = [...(/RWY\s*([\dLRC/\s]+)/.exec(p.name)?.[1].matchAll(/\d{2}[LRC]?/g) ?? [])].map((m) => m[0]);

    if (p.kind === 'APP') {
      const runway = namedRunways[0] ?? '';
      const final = p.transitions.filter((t) => t.type === 'FINAL').flatMap((t) => fixesOf(t, icao));
      const missed = p.transitions.filter((t) => t.type === 'MISSED').flatMap((t) => fixesOf(t, icao));
      if (!final.length) continue;
      if (!final.some((f) => f.startsWith('RW'))) final.push(`RW${runway}`);
      const initial = p.transitions
        .filter((t) => t.type === 'APPROACH')
        .map((t) => fixesOf(t, icao))
        .filter((f) => f.length > 1)
        .map((fixes) => ({ iaf: fixes[0], fixes: fixes.at(-1) === final[0] ? fixes : [...fixes, final[0]] }));
      const approach: Approach = {
        name: p.name.replace(/\s*RWY.*$/, '').trim(),
        runway,
        initial,
        final: unique(final),
        missed: missed.filter((f) => !f.startsWith('RW')),
      };
      // Attentes : branches HM/HA/HF de l'approche (cap magnétique converti avec la déclinaison de l'aérodrome)
      const holds: Hold[] = [];
      for (const t of p.transitions) {
        for (const { leg } of t.legs) {
          const h = data.holdLegs.get(leg);
          const point = data.points.get(data.legs.get(leg) ?? '');
          if (!h || !point || !/^(LEFT|RIGHT)$/.test(h.turn) || holds.some((x) => x.fix === point.ident)) continue;
          const course = /MAG/.test(h.courseType) ? h.course + (data.magvar.get(icao) ?? 0) : h.course;
          holds.push({
            fix: point.ident,
            kind: h.type as Hold['kind'],
            lngLat: point.at,
            courseT: Math.round(((course + 360) % 360) * 10) / 10,
            turn: h.turn === 'LEFT' ? 'L' : 'R',
            ...(h.nm ? { legNm: h.nm } : { legMin: h.minutes ?? 1 }),
          });
        }
      }
      if (holds.length) approach.holds = holds;
      entry.approaches!.push(approach);
      continue;
    }

    // SID : transition de piste, tronc commun, puis transition en route ; STAR : l'inverse
    const rwy = p.transitions.filter((t) => t.type === 'RWY');
    const common = p.transitions.filter((t) => t.type === 'COMMON').flatMap((t) => fixesOf(t, icao));
    const enRoute = p.transitions.filter((t) => t.type === 'EN_ROUTE');
    const runwayParts = rwy.length
      ? rwy.map((t) => ({ runways: runwaysOf(t).length ? runwaysOf(t) : namedRunways, fixes: fixesOf(t, icao) }))
      : [{ runways: [...new Set(p.transitions.flatMap(runwaysOf))].length ? [...new Set(p.transitions.flatMap(runwaysOf))] : namedRunways, fixes: [] as string[] }];
    const routes = enRoute.length ? enRoute.map((t) => ({ id: t.id, fixes: fixesOf(t, icao) })) : [{ id: null, fixes: [] as string[] }];
    // Une chaîne peut porter plusieurs procédures (« NIBRU 3A - UREMI 3A ») : celle dont le point de transition correspond
    const names = [...p.name.matchAll(/\b([A-Z]{2,5})\s?(\d[A-Z])\b/g)].map((m) => ({ fix: m[1], suffix: m[2] }));
    for (const part of runwayParts) {
      for (const route of routes) {
        const fixes = unique(p.kind === 'SID' ? [...part.fixes, ...common, ...route.fixes] : [...route.fixes, ...common, ...part.fixes]).filter(
          (f) => !f.startsWith('RW'),
        );
        if (!fixes.length) continue;
        const transitionFix = p.kind === 'SID' ? fixes.at(-1) : fixes[0];
        const n = names.find((x) => x.fix === transitionFix || x.fix === route.id) ?? names[0];
        const procedure: Procedure = {
          type: p.kind,
          name: n ? `${n.fix} ${n.suffix}` : p.name,
          ident: n ? flightPlanIdent(n.fix, n.suffix) : p.name,
          runways: part.runways,
          fixes,
        };
        if (!entry.procedures.some((q) => q.type === procedure.type && q.ident === procedure.ident && q.fixes.join() === fixes.join())) {
          entry.procedures.push(procedure);
        }
      }
    }
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  let procedures = 0;
  let approaches = 0;
  for (const [icao, entry] of byAirport) {
    entry.waypoints = waypointsOf.get(icao) ?? {};
    entry.procedures.sort((a, b) => a.type.localeCompare(b.type) || a.ident.localeCompare(b.ident));
    procedures += entry.procedures.length;
    approaches += entry.approaches!.length;
    await writeFile(path.join(OUT_DIR, `${icao}.json`), JSON.stringify(entry));
  }
  console.log(`  AIXM DECEA ${amendment} : ${procedures} SID/STAR et ${approaches} approches pour ${byAirport.size} aérodromes`);
  return { amendment, airports: [...byAirport.keys()], procedures, approaches };
}
