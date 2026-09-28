// Tuiles vectorielles autorouter, pour des tests en LOCAL uniquement : récupérées à la demande
// (zone affichée seulement) et gardées dans .cache, jamais servies publiquement ni déployées.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mergeChildTiles } from './autorouter-mvt.ts';

const BASE = 'https://map.autorouter.aero/vectortiles';
const TILES_DIR = '.cache/autorouter-tiles';

/** Contenus séparés par autorouter, chacun à sa propre URL (couche MVT `airway` pour routes, SID et STAR) */
export const AUTOROUTER_KINDS = ['airway', 'sid', 'star', 'airport', 'navaid', 'designatedpoint', 'airspace'] as const;
/** Chemin chez autorouter quand il diffère du nom (espaces aériens issus de l'EAD) */
const UPSTREAM: Partial<Record<AutorouterKind, string>> = { airspace: 'ead/airspace' };
export type AutorouterKind = (typeof AUTOROUTER_KINDS)[number];

export const AUTOROUTER_MINZOOM = 5;
export const AUTOROUTER_MAXZOOM = 10;
/** En dessous de AUTOROUTER_MINZOOM (tuiles vides chez autorouter), vues d'ensemble assemblées ici */
export const AUTOROUTER_OVERVIEW_MINZOOM = 3;

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
      const zoom = Number(z);
      if (zoom < AUTOROUTER_MINZOOM) {
        if (zoom < AUTOROUTER_OVERVIEW_MINZOOM) return new Uint8Array();
        const k = AUTOROUTER_MINZOOM - zoom;
        const n = 2 ** k;
        const children = await Promise.all(
          Array.from({ length: n * n }, (_, i) =>
            loadAutorouterTile(kind, String(AUTOROUTER_MINZOOM), String(Number(x) * n + (i % n)), String(Number(y) * n + Math.floor(i / n))),
          ),
        );
        const data = children.some((c) => c.length) ? mergeChildTiles(children, k) : new Uint8Array();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
        return data;
      }
      const res = await fetch(`${BASE}/${UPSTREAM[kind] ?? kind}/${z}/${x}/${y}.mvt`, {
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
