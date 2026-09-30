// Import des sector files Aurora dans le dépôt de données (navicharts-sector-files, cloné dans `sector files/aurora/`) :
//   1. chaque archive <nom>.zip exportée du cache d'Aurora est extraite dans <nom>/ (dossier déjà présent : ignorée) ;
//      une archive illisible (export interrompu) est signalée et laissée de côté
//   2. le plan au sol de chaque aérodrome est calculé depuis les tuiles les plus détaillées et enregistré dans
//      ground_<OACI>.json (voir groundCollector, server/aurora.ts) ; les tuiles au-delà du niveau 6, que rien d'autre ne
//      lit, sont ensuite supprimées : le clone de chaque utilisateur (.cache/aurora) passe de ~15 Go à ~3 Go
// Les archives restent sur place (ignorées par git) ; il reste à commiter et pousser le dépôt de données.
// Usage : node scripts/import-aurora.ts [dossier]    (par défaut : « sector files/aurora »)
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GROUND_LEVEL, groundCollector, type AuroraGlobal, type AuroraSection } from '../server/aurora.ts';

// Niveaux de tuiles lus par build-aurora.ts (espaces, zones P/R/D, MVA)
const KEEP_MAX_LEVEL = 6;
// Canada : déjà couvert par le dépôt IVAO-Canada (server/sectorfiles.ts), ses exports Aurora font ~3 Go chacun
const IGNORED = /^CA_/;

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'sector files', 'aurora'));
const run = promisify(execFile);
const levelOf = (file: string) => Number(/^section_(\d+)_\d+_\d+\.json$/.exec(file)?.[1] ?? -1);

async function extract(): Promise<void> {
  for (const zip of (await readdir(root)).filter((f) => f.endsWith('.zip')).sort()) {
    const name = zip.slice(0, -4);
    const dir = path.join(root, name);
    if (IGNORED.test(name) || existsSync(dir)) continue;
    try {
      await run('unzip', ['-q', '-o', path.join(root, zip), '-d', dir], { maxBuffer: 16 * 1024 * 1024 });
      JSON.parse(await readFile(path.join(dir, 'global.json'), 'utf8'));
      console.log(`↧ ${name}`);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      console.warn(`⚠ ${zip} illisible, ignoré (${(err as Error).message.split('\n')[0]})`);
    }
  }
}

async function pack(folder: string): Promise<void> {
  const dir = path.join(root, folder);
  const files = await readdir(dir);
  const detailed = files.filter((f) => levelOf(f) > KEEP_MAX_LEVEL);
  if (!detailed.length) return;
  const global = JSON.parse(await readFile(path.join(dir, 'global.json'), 'utf8')) as AuroraGlobal;
  const collectors = Object.entries(global.airports ?? {}).map(([icao, airport]) => ({ icao, ground: groundCollector(icao, airport) }));
  // Une tuile à la fois : certains dossiers dépassent le gigaoctet
  for (const f of detailed.filter((f) => levelOf(f) >= GROUND_LEVEL)) {
    const section = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as AuroraSection;
    for (const c of collectors) c.ground.add(section);
  }
  let written = 0;
  for (const { icao, ground } of collectors) {
    if (!ground.features.length) continue;
    await writeFile(path.join(dir, `ground_${icao}.json`), JSON.stringify(ground.features));
    written++;
  }
  await Promise.all(detailed.map((f) => rm(path.join(dir, f))));
  console.log(`✓ ${folder} : ${written} plans au sol, ${detailed.length} tuiles retirées`);
}

if (!existsSync(root)) throw new Error(`dossier introuvable : ${root}`);
await extract();
for (const d of (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
  if (existsSync(path.join(root, d.name, 'global.json'))) await pack(d.name);
}
console.log(`Terminé. Reste à commiter et pousser : git -C "${root}" add -A && git -C "${root}" commit -m "…" && git -C "${root}" push`);
