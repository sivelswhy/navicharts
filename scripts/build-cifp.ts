// Circuits d'attente des approches aux États-Unis, d'après le CIFP de la FAA (procédures aux instruments au format
// ARINC 424, domaine public, publié à chaque cycle AIRAC : https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/).
// Les sector files IVAO américains donnent les points des approches mais pas leurs attentes (cap, sens, longueur).
//
// Enregistrements lus (colonnes ARINC 424, à partir de 1) :
//   aérodrome (section P, sous-section A)   7-10 OACI, 52-56 déclinaison magnétique (« E0120 » : 12,0° E)
//   branche d'approche (P / F)             7-10 OACI, 14-19 approche (« L25L »), 30-34 point, 44 sens du virage,
//                                          48-49 type de branche (HM, HA, HF), 71-74 cap magnétique (dixièmes),
//                                          75-78 longueur (dixièmes de NM) ou durée (« T010 » : 1,0 min)
//   points et balises (P / C, EA, D, DB, P / N)  14-18 identifiant, 33-51 coordonnées (56-74 pour un DME seul)
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { approachName } from '../server/sectorfiles.ts';
import type { Hold } from '../server/procedures.ts';

type LngLat = [number, number];

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'cifp');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'holds');
const LISTING = 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/';

/** Édition en vigueur : la plus récente dont la date (CIFP_AAMMJJ) est passée */
async function currentEdition(): Promise<{ name: string; url: string }> {
  const html = await (await fetch(LISTING, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const today = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const editions = [...new Set([...html.matchAll(/href="([^"]*CIFP_(\d{6})\.zip)"/g)].map((m) => `${m[2]} ${m[1]}`))]
    .map((e) => e.split(' '))
    .filter(([date]) => date <= today)
    .sort((a, b) => b[0].localeCompare(a[0]));
  if (!editions.length) throw new Error('aucune édition du CIFP en vigueur');
  return { name: `CIFP_${editions[0][0]}`, url: editions[0][1] };
}

async function download(name: string, url: string): Promise<string> {
  const file = path.join(CACHE_DIR, `${name}.zip`);
  if (await stat(file).then((s) => s.size > 0, () => false)) return file;
  console.log(`↓ ${name}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok || !res.body) throw new Error(`${name} : HTTP ${res.status}`);
  await mkdir(CACHE_DIR, { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  // Éditions précédentes : inutiles
  for (const old of await readdir(CACHE_DIR)) if (/^CIFP_\d{6}\.zip$/.test(old) && old !== `${name}.zip`) await rm(path.join(CACHE_DIR, old));
  return file;
}

/** « N33465536W118364610 » → [lon, lat] */
function coordinates(value: string): LngLat | null {
  const m = /^([NS])(\d{2})(\d{2})(\d{4})([EW])(\d{3})(\d{2})(\d{4})$/.exec(value);
  if (!m) return null;
  const lat = (Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 360000) * (m[1] === 'S' ? -1 : 1);
  const lon = (Number(m[6]) + Number(m[7]) / 60 + Number(m[8]) / 360000) * (m[5] === 'W' ? -1 : 1);
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

/** « E0120 » → +12,0 ; « W0094 » → −9,4 */
const variation = (value: string) => (/^[EW]\d{4}$/.test(value) ? (value[0] === 'W' ? -1 : 1) * (Number(value.slice(1)) / 10) : 0);

export async function buildCifp(): Promise<{ edition: string; airports: number; holds: number }> {
  const { name, url } = await currentEdition();
  const zip = await download(name, url);

  const magvar = new Map<string, number>();
  const fixes = new Map<string, LngLat[]>();
  const legs: { airport: string; approach: string; fix: string; turn: string; type: string; course: string; length: string }[] = [];

  const unzip = spawn('unzip', ['-p', zip, 'FAACIFP18']);
  for await (const line of createInterface({ input: unzip.stdout, crlfDelay: Infinity })) {
    const section = line.slice(4, 6);
    const sub = line[12];
    if (section === 'P ' && sub === 'A') {
      magvar.set(line.slice(6, 10).trim(), variation(line.slice(51, 56)));
    } else if (section === 'P ' && sub === 'F' && line[47] === 'H') {
      legs.push({
        airport: line.slice(6, 10).trim(),
        approach: line.slice(13, 19).trim(),
        fix: line.slice(29, 34).trim(),
        turn: line[43],
        type: line.slice(47, 49),
        course: line.slice(70, 74),
        length: line.slice(74, 78),
      });
    } else if ((section === 'P ' && (sub === 'C' || sub === 'N')) || section === 'EA' || section === 'D ' || section === 'DB') {
      const ident = line.slice(13, 18).trim();
      const at = coordinates(line.slice(32, 51)) ?? coordinates(line.slice(55, 74));
      if (ident && at) fixes.set(ident, [...(fixes.get(ident) ?? []), at]);
    }
  }
  const code = await new Promise<number | null>((resolve) => unzip.on('close', resolve));
  if (code) throw new Error(`lecture du CIFP impossible (unzip : ${code})`);

  // Attentes par aérodrome, indexées par approche (« LOC 25L », comme dans les sector files) et par code (« L25L »)
  const byAirport = new Map<string, Record<string, Hold[]>>();
  let count = 0;
  for (const l of legs) {
    const course = Number(l.course) / 10;
    if (!l.fix || !Number.isFinite(course) || !/^[LR]$/.test(l.turn)) continue;
    // Point le plus proche de l'aérodrome parmi les homonymes
    const options = fixes.get(l.fix) ?? [];
    const airport = fixes.get(l.airport)?.[0];
    const at = airport && options.length > 1 ? options.reduce((a, b) => (Math.hypot(b[0] - airport[0], b[1] - airport[1]) < Math.hypot(a[0] - airport[0], a[1] - airport[1]) ? b : a)) : options[0];
    const hold: Hold = {
      fix: l.fix,
      kind: l.type as Hold['kind'],
      // Cap d'entrée publié en magnétique : converti en vrai avec la déclinaison de l'aérodrome
      courseT: Math.round(((course + (magvar.get(l.airport) ?? 0) + 360) % 360) * 10) / 10,
      turn: l.turn as 'L' | 'R',
      ...(l.length.startsWith('T') ? { legMin: Number(l.length.slice(1)) / 10 } : Number(l.length) ? { legNm: Number(l.length) / 10 } : {}),
      ...(at ? { lngLat: at } : {}),
    };
    const runway = /\d{2}[LRC]?/.exec(l.approach)?.[0] ?? '';
    const keys = [...new Set([l.approach, `${approachName(l.approach) ?? l.approach} ${runway}`.trim()])];
    const entry = byAirport.get(l.airport) ?? {};
    for (const k of keys) {
      entry[k] ??= [];
      if (!entry[k].some((h) => h.fix === hold.fix && h.kind === hold.kind)) entry[k].push(hold);
    }
    byAirport.set(l.airport, entry);
    count++;
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  for (const [icao, entry] of byAirport) await writeFile(path.join(OUT_DIR, `${icao}.json`), JSON.stringify(entry));
  console.log(`  CIFP ${name} : ${count} branches d'attente pour ${byAirport.size} aérodromes`);
  return { edition: name, airports: byAirport.size, holds: count };
}
