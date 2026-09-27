// Tuiles vectorielles autorouter, pour des tests en LOCAL uniquement : récupérées à la demande
// (zone affichée seulement) et gardées dans .cache, jamais servies publiquement ni déployées.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BASE = 'https://map.autorouter.aero/vectortiles';
const TILES_DIR = '.cache/autorouter-tiles';

/** Contenus séparés par autorouter, chacun à sa propre URL (couche MVT `airway` pour routes, SID et STAR) */
export const AUTOROUTER_KINDS = ['airway', 'sid', 'star', 'airport', 'navaid', 'designatedpoint'] as const;
export type AutorouterKind = (typeof AUTOROUTER_KINDS)[number];

export const AUTOROUTER_MINZOOM = 5;
export const AUTOROUTER_MAXZOOM = 10;

const pending = new Map<string, Promise<Uint8Array>>();

/** Tuile z/x/y depuis le cache, sinon depuis autorouter (tableau vide = tuile vide) */
export async function loadAutorouterTile(kind: AutorouterKind, z: string, x: string, y: string): Promise<Uint8Array> {
  const path = join(TILES_DIR, kind, z, x, `${y}.mvt`);
  try {
    return await readFile(path);
  } catch {}
  let p = pending.get(path);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${BASE}/${kind}/${z}/${x}/${y}.mvt`, {
        headers: { 'User-Agent': 'navicharts-local-test' },
      });
      if (res.status === 204 || res.status === 404) return new Uint8Array();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return data;
    })().finally(() => pending.delete(path));
    pending.set(path, p);
  }
  return p;
}
