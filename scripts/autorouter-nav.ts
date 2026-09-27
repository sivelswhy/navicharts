// Points (points nommés, balises, aérodromes) et routes aériennes autorouter d'une zone, pour l'analyse des plans
// de vol en LOCAL uniquement (servis par le serveur de dev Vite, voir vite.config.ts).
//
// Au zoom 6, une tuile couvre ~600 km et contient déjà tous les points et tous les tronçons des zooms supérieurs :
// seules les tuiles couvrant la zone du vol sont chargées.

import { decodeTile, type Props } from './autorouter-mvt.ts';
import { loadAutorouterTile } from './autorouter-tiles.ts';

const ZOOM = 6;
// Garde-fou : au-delà, la zone dépasse largement la couverture d'autorouter (Europe)
const MAX_TILES = 48;

type LngLat = [number, number];

export interface NavPoint {
  ident: string;
  kind: 'waypoint' | 'navaid' | 'airport';
  lngLat: LngLat;
  name?: string;
}

export interface NavSegment {
  /** Nom de la route (UN859…) */
  name: string;
  from: LngLat;
  to: LngLat;
  fromIdent: string;
  toIdent: string;
}

export interface AutorouterNav {
  points: NavPoint[];
  airways: NavSegment[];
}

const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
const tileY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM);
};

/** « VOR-DME LEON », « NDB XXX »… d'après les composants de la balise */
function navaidName(p: Props): string {
  const types = ['vor', 'dme', 'tacan', 'ndb'].filter((t) => p[t]).map((t) => t.toUpperCase());
  const name = String(p.c1name ?? p.c0name ?? '');
  return [types.join('-'), name].filter(Boolean).join(' ');
}

const dist2 = (a: LngLat, b: LngLat) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

export async function getAutorouterNav([west, south, east, north]: number[]): Promise<AutorouterNav> {
  const tiles: [number, number][] = [];
  for (let x = tileX(west); x <= tileX(east); x++) {
    for (let y = tileY(Math.min(north, 85)); y <= tileY(Math.max(south, -85)); y++) tiles.push([x, y]);
  }
  if (tiles.length > MAX_TILES) throw new Error(`zone trop grande (${tiles.length} tuiles)`);

  const points = new Map<string, NavPoint>();
  const add = (p: NavPoint) => points.set(`${p.kind} ${p.ident} ${p.lngLat.map((n) => n.toFixed(3))}`, p);
  const segments = new Map<string, { name: string; fromIdent: string; toIdent: string; start: LngLat; end: LngLat }>();

  for (const [x, y] of tiles) {
    const [airports, navaids, fixes, airways] = await Promise.all(
      (['airport', 'navaid', 'designatedpoint', 'airway'] as const).map((kind) =>
        loadAutorouterTile(kind, String(ZOOM), String(x), String(y)).then((buf) => (buf.length ? decodeTile(buf, ZOOM, x, y) : [])),
      ),
    );
    // Les points débordent un peu sur les tuiles voisines : on ne garde que ceux de la tuile
    const inside = (f: (typeof fixes)[number]) => f.lines[0]?.[0]?.inside;
    for (const f of airports.filter(inside)) {
      add({ ident: String(f.props.ident), kind: 'airport', lngLat: f.lines[0][0].lngLat, name: String(f.props.name ?? '') });
    }
    for (const f of navaids.filter(inside)) add({ ident: String(f.props.ident), kind: 'navaid', lngLat: f.lines[0][0].lngLat, name: navaidName(f.props) });
    for (const f of fixes.filter(inside)) add({ ident: String(f.props.ident), kind: 'waypoint', lngLat: f.lines[0][0].lngLat });

    for (const { props, lines } of airways) {
      const fromIdent = String(props.sident ?? '');
      const toIdent = String(props.eident ?? '');
      const start = lines[0]?.[0]?.lngLat;
      const end = lines.at(-1)?.at(-1)?.lngLat;
      if (!fromIdent || !toIdent || !start || !end) continue;
      for (let i = 0; i < Number(props.airways ?? 0); i++) {
        if (props[`a${i}object`] !== 'airway') continue;
        const name = String(props[`a${i}ident`]);
        const id = `${name} ${fromIdent} ${toIdent}`;
        // Tronçon coupé entre plusieurs tuiles : un morceau suffit à situer ses extrémités
        if (!segments.has(id)) segments.set(id, { name, fromIdent, toIdent, start, end });
      }
    }
  }

  // Extrémités des tronçons : le point de ce nom le plus proche (les homonymes sont très éloignés)
  const byIdent = new Map<string, NavPoint[]>();
  for (const p of points.values()) byIdent.set(p.ident, [...(byIdent.get(p.ident) ?? []), p]);
  const locate = (ident: string, near: LngLat): LngLat | null => {
    const candidates = byIdent.get(ident) ?? [];
    return candidates.length ? candidates.reduce((a, b) => (dist2(a.lngLat, near) <= dist2(b.lngLat, near) ? a : b)).lngLat : null;
  };
  const airways: NavSegment[] = [];
  for (const s of segments.values()) {
    const from = locate(s.fromIdent, s.start);
    const to = locate(s.toIdent, s.end);
    if (from && to) airways.push({ name: s.name, from, to, fromIdent: s.fromIdent, toIdent: s.toIdent });
  }

  return { points: [...points.values()], airways };
}
