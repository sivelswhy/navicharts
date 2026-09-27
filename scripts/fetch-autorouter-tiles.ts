// Télécharge un jeu LIMITÉ de tuiles vectorielles autorouter pour des tests en local.
// Usage perso uniquement : les tuiles restent dans .cache (ignoré par git) et ne sont
// jamais servies publiquement ni committées.
//
//   node scripts/fetch-autorouter-tiles.ts [--bbox=ouest,sud,est,nord] [--zooms=6-10] [--kinds=airway,sid,star] [--max=3000]
//
// Exemple (région parisienne, zooms 8 à 11) :
//   node scripts/fetch-autorouter-tiles.ts --bbox=1.5,48.2,3.5,49.3 --zooms=8-11

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BASE = 'https://map.autorouter.aero/vectortiles';
const OUT_DIR = '.cache/autorouter-tiles';
const CONCURRENCY = 2;
const DELAY_MS = 250;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

// France métropolitaine par défaut
const [west, south, east, north] = (args.bbox ?? '-5.5,41.2,9.8,51.2').split(',').map(Number);
const [zMin, zMax] = (args.zooms ?? '6-10').split('-').map(Number);
const MAX_TILES = Number(args.max ?? 3000);
// Routes, SID et STAR ont chacune leur URL (voir autorouter-tiles.ts, qui lit le même cache)
const kinds = (args.kinds ?? 'airway,sid,star').split(',');

function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

type Tile = [kind: string, z: number, x: number, y: number];
const tiles: Tile[] = [];
for (const kind of kinds) {
  for (let z = zMin; z <= zMax; z++) {
    for (let x = lonToX(west, z); x <= lonToX(east, z); x++) {
      for (let y = latToY(north, z); y <= latToY(south, z); y++) tiles.push([kind, z, x, y]);
    }
  }
}

if (tiles.length > MAX_TILES) {
  console.error(`${tiles.length} tuiles demandées, limite ${MAX_TILES}. Réduis la zone ou les zooms (ou --max).`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => stat(p).then(() => true, () => false);

let done = 0;
let fetched = 0;
let empty = 0;

async function fetchTile([kind, z, x, y]: Tile): Promise<void> {
  const path = join(OUT_DIR, kind, String(z), String(x), `${y}.mvt`);
  if (await exists(path)) return;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}/${kind}/${z}/${x}/${y}.mvt`, {
      headers: { 'User-Agent': 'navicharts-local-test' },
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    if (res.status === 204 || res.status === 404) {
      // tuile vide : fichier vide pour ne pas la redemander
      await writeFile(path, new Uint8Array());
      empty++;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} pour ${kind} ${z}/${x}/${y}`);
    await writeFile(path, new Uint8Array(await res.arrayBuffer()));
    fetched++;
    return;
  }
  throw new Error(`Abandon après plusieurs 429/5xx sur ${kind} ${z}/${x}/${y} — on arrête là.`);
}

console.log(`${tiles.length} tuiles (${kinds.join(', ')}), zooms ${zMin}-${zMax}, bbox ${west},${south},${east},${north}`);

const queue = [...tiles];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      await fetchTile(t);
      done++;
      if (done % 50 === 0) console.log(`${done}/${tiles.length}`);
      await sleep(DELAY_MS);
    }
  }),
);

console.log(`Terminé : ${fetched} téléchargées, ${empty} vides, ${tiles.length - fetched - empty} déjà en cache → ${OUT_DIR}`);
