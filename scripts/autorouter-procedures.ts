// SID et STAR d'un aérodrome reconstituées depuis les tuiles autorouter, pour des tests en LOCAL uniquement
// (servies par le serveur de dev Vite, voir vite.config.ts). Même forme que /api/procedures (server/procedures.ts).
//
// Chaque entité de la couche MVT `airway` est un tronçon « sident → eident » ; ses propriétés a{i}ident,
// a{i}object (« sid » ou « star ») et a{i}forward/a{i}backward indiquent les procédures qui l'empruntent et
// dans quel sens. On enchaîne les tronçons de chaque procédure depuis (SID) ou jusqu'à (STAR) l'aérodrome.

import type { AirportProcedures, Procedure } from '../server/procedures.ts';
import { decodeTile } from './autorouter-mvt.ts';
import { loadAutorouterTile } from './autorouter-tiles.ts';

// Au zoom 8, une tuile couvre ~100 km et contient tous les tronçons du zoom 10 : 3 × 3 tuiles suffisent
const ZOOM = 8;

// ───────── Reconstitution des procédures ─────────

/** Forme plan de vol, limitée à 6 caractères : OLZOM6J → OLZO6J (comme l'eAIP : AGOPA 6A → AGOP6A) */
function flightPlanIdent(ident: string): string {
  const m = ident.match(/^([A-Z]+)(\d[A-Z]?)$/);
  if (!m || ident.length <= 6) return ident;
  return m[1].slice(0, 6 - m[2].length) + m[2];
}

const displayName = (ident: string) => ident.replace(/^([A-Z]+)(\d[A-Z]?)$/, '$1 $2');

export async function getAutorouterProcedures(icao: string, lon: number, lat: number): Promise<AirportProcedures> {
  const cx = Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
  const r = (lat * Math.PI) / 180;
  const cy = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM);

  const procedures: Procedure[] = [];
  const positions = new Map<string, [number, number][]>();

  for (const kind of ['sid', 'star'] as const) {
    // Tronçons orientés dans le sens du vol, par procédure
    const edges = new Map<string, Set<string>>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const [x, y] = [cx + dx, cy + dy];
        const buf = await loadAutorouterTile(kind, String(ZOOM), String(x), String(y));
        if (!buf.length) continue;
        for (const { props, lines } of decodeTile(buf, ZOOM, x, y)) {
          const from = String(props.sident ?? '');
          const to = String(props.eident ?? '');
          // Extrémités réelles du tronçon (hors découpe au bord de la tuile) → position des points
          const first = lines[0]?.[0];
          const last = lines.at(-1)?.at(-1);
          if (from && first?.inside) positions.set(from, [...(positions.get(from) ?? []), first.lngLat]);
          if (to && last?.inside) positions.set(to, [...(positions.get(to) ?? []), last.lngLat]);

          for (let i = 0; i < Number(props.airways ?? 0); i++) {
            if (props[`a${i}object`] !== kind) continue;
            const ident = String(props[`a${i}ident`]);
            const edge = props[`a${i}forward`] || !props[`a${i}backward`] ? `${from}>${to}` : `${to}>${from}`;
            if (!edges.has(ident)) edges.set(ident, new Set());
            edges.get(ident)!.add(edge);
          }
        }
      }
    }

    for (const [ident, set] of edges) {
      const pairs = [...set].map((e) => e.split('>') as [string, string]);
      // SID : on suit les tronçons depuis l'aérodrome ; STAR : on remonte depuis l'aérodrome
      const next = new Map<string, string[]>();
      for (const [a, b] of pairs) {
        const [k, v] = kind === 'sid' ? [a, b] : [b, a];
        next.set(k, [...(next.get(k) ?? []), v]);
      }
      if (!next.has(icao)) continue; // procédure d'un autre aérodrome de la zone
      const path = [icao];
      const seen = new Set(path);
      for (let cur = icao; ; ) {
        const n = next.get(cur)?.find((p) => !seen.has(p));
        if (n === undefined) break;
        path.push(n);
        seen.add(n);
        cur = n;
      }
      if (kind === 'star') path.reverse();
      const fixes = path.filter((p) => p && p !== icao);
      if (!fixes.length) continue;
      procedures.push({ type: kind === 'sid' ? 'SID' : 'STAR', name: displayName(ident), ident: flightPlanIdent(ident), runways: [], fixes });
    }
  }

  // Position moyenne de chaque point utilisé
  const waypoints: Record<string, [number, number]> = {};
  for (const fix of new Set(procedures.flatMap((p) => p.fixes))) {
    const seen = positions.get(fix);
    if (!seen?.length) continue;
    waypoints[fix] = [seen.reduce((s, p) => s + p[0], 0) / seen.length, seen.reduce((s, p) => s + p[1], 0) / seen.length];
  }

  procedures.sort((a, b) => a.type.localeCompare(b.type) || a.ident.localeCompare(b.ident));
  return { icao, procedures, waypoints };
}
