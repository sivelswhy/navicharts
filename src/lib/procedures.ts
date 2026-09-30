// SID, STAR et approches d'un aérodrome placées sur la carte (choisies dans la fiche de l'aérodrome).
import type { FeatureCollection } from 'geojson';
import { loadDetails } from './data.ts';
import type { LngLat } from './georef.ts';
import { searchNav } from './navSearch.ts';
import { fetchProcedures, type Approach, type Procedure } from './route.ts';
import type { Airport } from './types.ts';
import { holdPath } from './holds.ts';

// Au-delà, un point du même nom n'appartient pas aux procédures de l'aérodrome
const MAX_DISTANCE_NM = 120;

function distanceNm([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

export interface ProcedurePoint {
  ident: string;
  lngLat: LngLat;
}

export interface PlacedProcedure {
  procedure: Procedure;
  /** Points situés, dans l'ordre de vol (les points introuvables sont omis) */
  points: ProcedurePoint[];
  /** Points de la procédure qu'on n'a pas pu situer */
  missing: string[];
}

export interface PlacedApproach {
  approach: Approach;
  /** Branches initiales, de chaque IAF au début de la finale */
  initial: { iaf: string; points: ProcedurePoint[] }[];
  final: ProcedurePoint[];
  missed: ProcedurePoint[];
  /** Circuits d'attente, tracés */
  holds: { fix: string; path: LngLat[] }[];
  missing: string[];
}

export interface AirportProcedureSet {
  procedures: PlacedProcedure[];
  approaches: PlacedApproach[];
}

/**
 * SID, STAR et approches de l'aérodrome, points situés d'après la procédure elle-même, les seuils de piste,
 * puis les points et balises connus
 */
export async function loadPlacedProcedures(airport: Airport): Promise<AirportProcedureSet> {
  const [data, details] = await Promise.all([fetchProcedures(airport), loadDetails(airport).catch(() => null)]);
  if (!data) return { procedures: [], approaches: [] };
  const near: LngLat = [airport.lon, airport.lat];
  const found = new Map<string, LngLat | null>(Object.entries(data.waypoints));
  // Seuils de piste (RW14L) : extrémités de piste de l'aérodrome
  for (const end of details?.runways.flatMap((r) => r.ends) ?? []) {
    if (end.lat !== null && end.lon !== null) found.set(`RW${end.ident.padStart(2, '0')}`, [end.lon, end.lat]);
  }
  const approaches = data.approaches ?? [];
  const idents = new Set([
    ...data.procedures.flatMap((p) => p.fixes),
    ...approaches.flatMap((a) => [...a.initial.flatMap((b) => b.fixes), ...a.final, ...a.missed]),
  ]);
  // Une recherche par point encore inconnu, pas par procédure
  await Promise.all(
    [...idents]
      .filter((ident) => !found.has(ident))
      .map(async (ident) => {
        const results = await searchNav(ident, near).catch(() => []);
        // Homonyme lointain : ce n'est pas le point de la procédure
        const at = results.find((r) => r.ident === ident && distanceNm(r.lngLat, near) <= MAX_DISTANCE_NM)?.lngLat;
        found.set(ident, at ?? null);
      }),
  );
  const place = (fixes: string[], missing: string[]) =>
    fixes.flatMap((ident) => {
      const at = found.get(ident);
      if (!at) missing.push(ident);
      return at ? [{ ident, lngLat: at }] : [];
    });

  return {
    procedures: data.procedures.map((procedure) => {
      const missing: string[] = [];
      return { procedure, points: place(procedure.fixes, missing), missing };
    }),
    approaches: approaches.map((approach) => {
      const missing: string[] = [];
      return {
        approach,
        initial: approach.initial.map((b) => ({ iaf: b.iaf, points: place(b.fixes, missing) })),
        final: place(approach.final, missing),
        missed: place(approach.missed, missing),
        holds: (approach.holds ?? []).flatMap((h) => {
          const at = h.lngLat ?? found.get(h.fix) ?? h.path?.[0];
          const path = at ? holdPath(h, at) : null;
          return path ? [{ fix: h.fix, path }] : [];
        }),
        missing: [...new Set(missing)],
      };
    }),
  };
}

export const procedureKey = (p: Procedure) => `${p.type} ${p.ident}`;
export const approachKey = (a: Approach) => `APP ${a.runway} ${a.name}`;
export const approachLabel = (a: Approach) => `${a.name} ${a.runway}`;

/**
 * Tracés des procédures et approches choisies ; une SID part de l'aérodrome, une STAR s'arrête à son dernier
 * point publié, une approche part de chacun de ses IAF
 */
export function proceduresGeoJson(airport: Airport, procedures: PlacedProcedure[], approaches: PlacedApproach[]): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  const seen = new Set<string>();
  const line = (coords: LngLat[], properties: Record<string, unknown>) => {
    if (coords.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties });
  };
  // Un point partagé par plusieurs tracés n'est dessiné qu'une fois
  const fixes = (type: string, points: ProcedurePoint[], role?: string) => {
    for (const p of points) {
      const id = `${type} ${p.ident}`;
      if (seen.has(id)) continue;
      seen.add(id);
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.lngLat }, properties: { type, fix: role ? `${p.ident} ${role}` : p.ident } });
    }
  };

  for (const { procedure, points } of procedures) {
    const coords = points.map((p) => p.lngLat);
    if (procedure.type === 'SID') coords.unshift([airport.lon, airport.lat]);
    line(coords, { type: procedure.type, kind: 'procedure', name: procedure.name, ident: procedure.ident });
    fixes(procedure.type, points);
  }
  for (const a of approaches) {
    const ident = approachLabel(a.approach);
    for (const b of a.initial) line(b.points.map((p) => p.lngLat), { type: 'APP', kind: 'initial', ident: `${b.iaf} → ${ident}` });
    line(a.final.map((p) => p.lngLat), { type: 'APP', kind: 'final', ident });
    // Approche interrompue : depuis le seuil
    const threshold = a.final.at(-1);
    line([...(threshold ? [threshold.lngLat] : []), ...a.missed.map((p) => p.lngLat)], { type: 'APP', kind: 'missed', ident: `API ${ident}` });
    // IAF : premier point de chaque branche, s'il a pu être situé
    fixes('APP', a.initial.flatMap((b) => (b.points[0]?.ident === b.iaf ? [b.points[0]] : [])), 'IAF');
    fixes('APP', [...a.initial.flatMap((b) => b.points), ...a.final, ...a.missed]);
    for (const h of a.holds) line(h.path, { type: 'APP', kind: 'hold', ident: `Attente ${h.fix}` });
  }
  return { type: 'FeatureCollection', features };
}
