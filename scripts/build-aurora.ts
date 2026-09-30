// Données statiques des sector files au format du cache d'Aurora, clonés depuis GitHub (voir server/aurora.ts) :
// routes hautes et basses, points et balises, aérodromes, pistes, fréquences ATC, espaces aériens, zones P/R/D,
// MVA et secteurs des positions ATC. Même forme que build-ivao.ts, dont le résultat les reçoit.
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AURORA_ROOT,
  auroraFolders,
  auroraGlobal,
  auroraSections,
  fromMap,
  syncAurora,
  type AuroraGlobal,
  type AuroraSection,
  type MapPoint,
} from '../server/aurora.ts';
import type { IvaoData, SectorAirport, SectorRunway } from './build-ivao.ts';

type Position = [number, number];
type Feature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };

// Au-delà (en degrés, ~1000 NM), un tronçon relie deux points sans rapport
const MAX_LEG = 1000 / 60;
const LEVELS = { high: { lowerFl: 180, upperFl: 450 }, low: { lowerFl: null, upperFl: 180 } };

const key = (p: MapPoint) => `${p.x.toFixed(7)},${p.y.toFixed(7)}`;
const point = (at: Position, properties: Record<string, unknown>): Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties });

/** Longitudes ramenées à moins de 180° les unes des autres (tracés qui franchissent l'antiméridien) */
function unwrap(coords: Position[]): Position[] {
  return coords.map((c, i, all) => {
    if (!i) return c;
    let lon = c[0];
    const prev = all[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    return [lon, c[1]];
  });
}

// Espaces de travail laissés dans certains sector files (Italie, Moyen-Orient)
const PLACEHOLDER = /^(dummy|temp)$/i;

/** Polygone si le tracé se referme, ligne sinon ; aucun tracé s'il passe par 0° N 0° E (coordonnées par défaut) */
function shape(points: (MapPoint | null)[]): { type: string; coordinates: unknown } | null {
  const coords = unwrap(points.filter((p): p is MapPoint => Boolean(p)).map(fromMap));
  if (coords.length < 2 || coords.some(([lon, lat]) => Math.abs(lon) < 0.01 && Math.abs(lat) < 0.01)) return null;
  const [first, last] = [coords[0], coords.at(-1)!];
  const closed = coords.length >= 4 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.01;
  return closed ? { type: 'Polygon', coordinates: [[...coords.slice(0, -1), first]] } : { type: 'LineString', coordinates: coords };
}

/** Type d'un espace d'après sa catégorie Aurora et son nom */
function airspaceType(category: 'fir' | 'low' | 'high', name: string): string {
  if (category === 'fir') return 'FIR';
  if (/\bCTR\b|_CTR$|\bCZ\b|\bATZ\b/.test(name) && category === 'low') return 'CTR';
  if (/TMA|\bTCA\b|APP/.test(name)) return 'TMA';
  return 'CTA';
}

export async function buildAurora(): Promise<Omit<IvaoData, 'divisions' | 'vfr'> & { folders: string[] }> {
  const result = {
    folders: [] as string[],
    airways: [] as Feature[],
    waypoints: [] as Feature[],
    navaids: [] as Feature[],
    airspaces: [] as Feature[],
    mva: [] as Feature[],
    sectors: [] as Feature[],
    airports: [] as SectorAirport[],
    runways: [] as SectorRunway[],
    atc: [] as { airport: string; callsign: string; mhz: number }[],
  };
  const seen = new Set<string>();
  const once = (k: string) => !seen.has(k) && Boolean(seen.add(k));

  await syncAurora();
  for (const folder of auroraFolders()) {
    let global: AuroraGlobal;
    try {
      global = await auroraGlobal(folder);
    } catch (err) {
      console.warn(`⚠ Sector file Aurora ${folder} : ${(err as Error).message}`);
      continue;
    }
    result.folders.push(folder);
    // Brésil (dossiers « SB… ») : routes, points, balises et espaces marqués, le DECEA restant la référence (build-data.ts)
    const brazil = folder.startsWith('SB');
    const before = { airways: result.airways.length, waypoints: result.waypoints.length, navaids: result.navaids.length, airspaces: result.airspaces.length };

    // Points et balises
    const named = new Map<string, { ident: string; kind: string }>();
    for (const list of Object.values(global.points ?? {})) {
      for (const p of list) {
        if (!named.has(key(p.mapPosition))) named.set(key(p.mapPosition), { ident: p.identifier, kind: p.kind });
        const at = fromMap(p.mapPosition);
        // Fréquences : VOR en kHz (116400 → 116,40 MHz), NDB en Hz (272000 → 272 kHz) ; balises sans fréquence (marqueurs) ignorées
        if ((p.kind === 'VOR' || p.kind === 'NDB') && p.frequency && once(`nav ${p.identifier} ${at}`)) {
          const frequency = p.kind === 'VOR' ? `${(p.frequency / 1000).toFixed(2)} MHz` : `${Math.round(p.frequency / 1000)} kHz`;
          result.navaids.push(point(at, { ident: p.identifier, name: p.identifier, type: p.kind, frequency, ivao: true }));
        }
      }
    }

    // Routes : points d'extrémité nommés d'après les points situés exactement au même endroit
    for (const [level, routes] of [['high', global.airwaysHigh ?? {}], ['low', global.airwaysLow ?? {}]] as const) {
      for (const [name, parts] of Object.entries(routes)) {
        for (const part of parts) {
          const pts = part.mapPoints.filter(Boolean);
          for (let i = 1; i < pts.length; i++) {
            const [a, b] = unwrap([fromMap(pts[i - 1]), fromMap(pts[i])]);
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) > MAX_LEG || !once(`awy ${name} ${[String(a), String(b)].sort()}`)) continue;
            const from = named.get(key(pts[i - 1]))?.ident ?? null;
            const to = named.get(key(pts[i]))?.ident ?? null;
            result.airways.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { name, ...LEVELS[level], from, to, ivao: true } });
            for (const [ident, p] of [[from, pts[i - 1]], [to, pts[i]]] as const) {
              if (ident && named.get(key(p))?.kind === 'Fix' && once(`wpt ${ident} ${key(p)}`)) result.waypoints.push(point(fromMap(p), { ident, ivao: true }));
            }
          }
        }
      }
    }

    // Aérodromes et pistes ; le pays est laissé à OurAirports
    for (const ap of Object.values(global.airports ?? {})) {
      if (!once(`ad ${ap.identifier}`)) continue;
      result.airports.push({
        ident: ap.identifier,
        country: '',
        continent: '',
        name: ap.name,
        elevationFt: ap.elevation,
        transitionAltitudeFt: ap.transitionAltitude,
        lat: ap.geoPosition.x,
        lon: ap.geoPosition.y,
        procedures: existsSync(path.join(AURORA_ROOT, folder, `proc_${ap.identifier}.json`)),
      });
      for (const r of ap.runways ?? []) {
        const [lon1, lat1] = fromMap(r.primaryMapPoint);
        const [lon2, lat2] = fromMap(r.oppositeMapPoint);
        result.runways.push({
          airport: ap.identifier,
          ends: [
            { ident: r.primaryId, elevationFt: r.primaryElevation, headingT: r.primaryCourse, lat: lat1, lon: lon1 },
            { ident: r.oppositeId, elevationFt: r.oppositeElevation, headingT: r.oppositeCourse, lat: lat2, lon: lon2 },
          ],
        });
      }
    }

    // Positions ATC : fréquence (« 22150 » → 122,150 MHz) et secteur dessiné
    for (const pos of Object.values(global.atcPositions ?? {})) {
      const airport = pos.callsign.split('_')[0];
      if (pos.frequency && global.airports?.[airport]) result.atc.push({ airport, callsign: pos.callsign, mhz: 100 + pos.frequency / 1000 });
      const geometry = pos.mapPoints?.length >= 3 ? shape(pos.mapPoints) : null;
      if (geometry?.type === 'Polygon' && once(`sector ${pos.callsign} ${JSON.stringify(geometry.coordinates).slice(0, 60)}`)) {
        result.sectors.push({ type: 'Feature', geometry, properties: { callsign: pos.callsign } });
      }
    }

    // Espaces, zones P/R/D et MVA : dans les tuiles, à chaque niveau de zoom. Au niveau 0, chaque espace est entier mais
    // très simplifié ; aux niveaux élevés, il est découpé tuile par tuile. On garde, pour chaque espace, le niveau le plus
    // détaillé où il tient dans une seule tuile ; zones P/R/D et MVA (sans identifiant) : le niveau 4
    let sections: AuroraSection[] = [];
    try {
      sections = await auroraSections(folder, (level) => level <= 6);
    } catch {
      sections = [];
    }
    const occurrences = new Map<string, { level: number; category: 'fir' | 'low' | 'high'; identifier: string; points: MapPoint[] }[]>();
    for (const s of sections) {
      for (const [category, list] of [['fir', s.airspaces], ['low', s.airspacesLow], ['high', s.airspacesHigh]] as const) {
        for (const a of list ?? []) {
          if (PLACEHOLDER.test(a.identifier)) continue;
          const k = `${category} ${a.identifier}`;
          occurrences.set(k, [...(occurrences.get(k) ?? []), { level: s.level, category, identifier: a.identifier, points: a.mapPoints }]);
        }
      }
    }
    for (const list of occurrences.values()) {
      const counts = new Map<number, number>();
      for (const o of list) counts.set(o.level, (counts.get(o.level) ?? 0) + 1);
      const level = Math.max(...[...counts].filter(([, n]) => n === 1).map(([l]) => l), Math.min(...counts.keys()));
      for (const o of list.filter((x) => x.level === level)) {
        const geometry = shape(o.points);
        if (!geometry || !once(`as ${o.category} ${o.identifier} ${JSON.stringify(geometry.coordinates).slice(0, 80)}`)) continue;
        result.airspaces.push({
          type: 'Feature',
          geometry,
          properties: { name: o.identifier.replace(/_/g, ' '), type: airspaceType(o.category, o.identifier), class: '', ivao: true },
        });
      }
    }
    const detail = Math.min(4, Math.max(...sections.map((x) => x.level), 0));
    for (const s of sections.filter((x) => x.level === detail)) {
      for (const sh of s.shapes ?? []) {
        const type = { PROHIBITED: 'P', RESTRICTED: 'R', DANGER: 'D' }[sh.geoArea ?? ''];
        if (!type) continue;
        const geometry = shape(sh.mapPoints);
        if (!geometry || !once(`prd ${JSON.stringify(geometry.coordinates).slice(0, 80)}`)) continue;
        result.airspaces.push({ type: 'Feature', geometry, properties: { name: { P: 'Zone interdite', R: 'Zone réglementée', D: 'Zone dangereuse' }[type], type, class: '', ivao: true } });
      }
      for (const m of s.mvas ?? []) {
        const geometry = shape(m.mapPoints ?? []);
        if (geometry && once(`mva ${m.airport} ${JSON.stringify(geometry.coordinates).slice(0, 80)}`)) result.mva.push({ type: 'Feature', geometry, properties: { facility: m.airport } });
        for (const l of m.labels ?? []) {
          if (once(`mval ${m.identifier} ${key(l.mapPosition)}`)) result.mva.push(point(fromMap(l.mapPosition), { facility: m.airport, text: String(Number(m.identifier)) }));
        }
      }
    }
    if (brazil) {
      for (const k of ['airways', 'waypoints', 'navaids', 'airspaces'] as const) for (const f of result[k].slice(before[k])) f.properties.brazil = true;
    }
  }
  console.log(
    `  Aurora (${result.folders.length} sector files) : ${result.airways.length} tronçons, ${result.waypoints.length} points, ` +
      `${result.navaids.length} balises, ${result.airports.length} aérodromes, ${result.airspaces.length} espaces, ${result.mva.length} éléments MVA, ` +
      `${result.sectors.length} secteurs ATC`,
  );
  return result;
}
