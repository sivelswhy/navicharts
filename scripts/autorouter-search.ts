// Recherche des points nommés et balises autorouter par identifiant ou nom, pour la barre de recherche en LOCAL
// uniquement (servie par le serveur de dev Vite, voir vite.config.ts).
//
// Les tuiles du zoom 5 contiennent déjà tous les points des zooms supérieurs : celles de l'Europe sont indexées
// une fois, à la première recherche (puis lues depuis le cache disque).

import { decodeTile, type Props } from './autorouter-mvt.ts';
import { loadAutorouterTile } from './autorouter-tiles.ts';

const ZOOM = 5;
// De l'Islande à l'Oural, du Maghreb au cap Nord
const TILES_X = [13, 20];
const TILES_Y = [7, 11];
const LIMIT = 8;

export interface NavSearchResult {
  ident: string;
  kind: 'waypoint' | 'navaid';
  /** « VOR-DME », « NDB »… pour une balise */
  type?: string;
  name?: string;
  lngLat: [number, number];
}

let index: Promise<NavSearchResult[]> | null = null;

const navaidType = (p: Props) => ['vor', 'dme', 'tacan', 'ndb'].filter((t) => p[t]).map((t) => t.toUpperCase()).join('-');

async function buildIndex(): Promise<NavSearchResult[]> {
  // Un même point figure parfois deux fois, à quelques centaines de mètres près (précision du zoom 5)
  const out = new Map<string, NavSearchResult>();
  const add = (r: NavSearchResult) => out.set(`${r.kind} ${r.ident} ${r.lngLat.map((n) => n.toFixed(1))}`, r);
  for (let x = TILES_X[0]; x <= TILES_X[1]; x++) {
    for (let y = TILES_Y[0]; y <= TILES_Y[1]; y++) {
      const [navaids, fixes] = await Promise.all(
        (['navaid', 'designatedpoint'] as const).map((kind) =>
          loadAutorouterTile(kind, String(ZOOM), String(x), String(y)).then((buf) => (buf.length ? decodeTile(buf, ZOOM, x, y) : [])),
        ),
      );
      // Les points débordent un peu sur les tuiles voisines : on ne garde que ceux de la tuile
      for (const { props, lines } of navaids) {
        const v = lines[0]?.[0];
        if (!v?.inside || !props.ident) continue;
        const name = String(props.c1name ?? props.c0name ?? '');
        add({ ident: String(props.ident), kind: 'navaid', type: navaidType(props), name: name || undefined, lngLat: v.lngLat });
      }
      for (const { props, lines } of fixes) {
        const v = lines[0]?.[0];
        if (v?.inside && props.ident) add({ ident: String(props.ident), kind: 'waypoint', lngLat: v.lngLat });
      }
    }
  }
  return [...out.values()];
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

/** Identifiant exact, puis début d'identifiant, puis nom de balise ; balises d'abord, les plus proches de `near` ensuite */
export async function searchAutorouterNav(query: string, near?: [number, number]): Promise<NavSearchResult[]> {
  const q = normalize(query.trim());
  if (q.length < 2) return [];
  index ??= buildIndex().catch((err) => {
    index = null;
    throw err;
  });
  const scored: { r: NavSearchResult; score: number; d: number }[] = [];
  for (const r of await index) {
    let score = 0;
    if (r.ident === q) score = 100;
    else if (r.ident.startsWith(q)) score = 60;
    else if (r.name && normalize(r.name).includes(q)) score = 30;
    if (!score) continue;
    if (r.kind === 'navaid') score += 5;
    const d = near ? (r.lngLat[0] - near[0]) ** 2 + (r.lngLat[1] - near[1]) ** 2 : 0;
    scored.push({ r, score, d });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.d - b.d || a.r.ident.localeCompare(b.r.ident))
    .slice(0, LIMIT)
    .map((s) => s.r);
}

/** Détail d'une balise autorouter (fréquences, canal DME, déclinaison…) : celle de cet identifiant la plus proche */
export async function getAutorouterNavaid(ident: string, [lon, lat]: [number, number]): Promise<{ props: Props; lngLat: [number, number] } | null> {
  const z = 6;
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  const buf = await loadAutorouterTile('navaid', String(z), String(x), String(y));
  let best: { props: Props; lngLat: [number, number] } | null = null;
  let bestDist = Infinity;
  for (const { props, lines } of buf.length ? decodeTile(buf, z, x, y) : []) {
    const v = lines[0]?.[0];
    if (!v || props.ident !== ident) continue;
    const d = (v.lngLat[0] - lon) ** 2 + (v.lngLat[1] - lat) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = { props, lngLat: v.lngLat };
    }
  }
  // Au-delà de ~20 km, c'est un homonyme
  return bestDist < 0.04 ? best : null;
}
