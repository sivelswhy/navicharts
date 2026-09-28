// Tracks de l'Atlantique Nord (NAT OTS) en vigueur ou à venir, placés sur la carte.
import { useEffect, useMemo, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import type { LngLat } from './georef.ts';
import { searchNav } from './navSearch.ts';

type NatPoint = { ident: string } | { lngLat: LngLat; token: string };

interface NatMessageTrack {
  letter: string;
  points: NatPoint[];
  eastLevels: number[];
  westLevels: number[];
  nar: string[];
  validFrom: string;
  validTo: string;
  message: string;
  source: string;
  tmi: string | null;
  remarks: string[];
}

/** Point de report d'un track, situé (null : point nommé introuvable) */
export interface NatFix {
  /** Nom du point (RESNO) ou coordonnées telles qu'écrites dans le message (56/20) */
  label: string;
  named: boolean;
  lngLat: LngLat | null;
}

export interface NatTrack extends Omit<NatMessageTrack, 'points'> {
  id: string;
  fixes: NatFix[];
  direction: 'east' | 'west' | 'both';
  active: boolean;
}

const REFRESH_MS = 15 * 60 * 1000;

export const hhmm = (iso: string) => `${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;

/** « FL340–400 » ; niveaux non consécutifs listés */
export function levelText(levels: number[]): string {
  if (!levels.length) return '';
  const consecutive = levels.every((l, i) => i === 0 || l - levels[i - 1] === 10);
  return consecutive && levels.length > 2 ? `FL${levels[0]}–${levels.at(-1)}` : `FL${levels.join(' ')}`;
}

/** Point nommé : celui de ce nom le plus proche du point voisin du track */
async function locate(ident: string, near: LngLat | undefined): Promise<LngLat | null> {
  const found = await searchNav(ident, near).catch(() => []);
  return found.find((r) => r.ident === ident)?.lngLat ?? null;
}

async function resolve(t: NatMessageTrack): Promise<NatTrack> {
  const known = t.points.flatMap((p) => ('lngLat' in p ? [p.lngLat] : []));
  const fixes: NatFix[] = [];
  for (const [i, p] of t.points.entries()) {
    if ('lngLat' in p) fixes.push({ label: p.token, named: false, lngLat: p.lngLat });
    else fixes.push({ label: p.ident, named: true, lngLat: await locate(p.ident, i === 0 ? known[0] : known.at(-1)) });
  }
  const { points: _points, ...rest } = t;
  return {
    ...rest,
    id: `${t.message} ${t.validFrom} ${t.letter}`,
    fixes,
    direction: t.westLevels.length && !t.eastLevels.length ? 'west' : t.eastLevels.length && !t.westLevels.length ? 'east' : 'both',
    active: new Date(t.validFrom).getTime() <= Date.now(),
  };
}

function toGeoJson(tracks: NatTrack[], selected: string | null): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  for (const t of tracks) {
    const coords = t.fixes.flatMap((f) => (f.lngLat ? [f.lngLat] : []));
    if (coords.length < 2) continue;
    const levels = levelText(t.direction === 'east' ? t.eastLevels : t.westLevels.length ? t.westLevels : t.eastLevels);
    const properties = {
      id: t.id,
      letter: t.letter,
      label: `NAT ${t.letter}  ${levels}  ${t.direction === 'west' ? '←' : t.direction === 'east' ? '→' : '↔'}`,
      validity: `${hhmm(t.validFrom)}–${hhmm(t.validTo)}`,
      active: t.active,
      selected: t.id === selected,
    };
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties });
    // Points de report ; la lettre du track aux extrémités
    const located = t.fixes.filter((f) => f.lngLat);
    located.forEach((f, i) => {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: f.lngLat! },
        properties: { ...properties, kind: i === 0 || i === located.length - 1 ? 'end' : 'fix', fix: f.label },
      });
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Tracks NAT, rafraîchis tous les quarts d'heure (aucun si désactivés), et leur GeoJSON (track choisi mis en avant) */
export function useNatTracks(enabled: boolean, selected: string | null): { tracks: NatTrack[]; geojson: FeatureCollection } {
  const [tracks, setTracks] = useState<NatTrack[]>([]);
  useEffect(() => {
    if (!enabled) {
      setTracks([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetch('/api/nat')
        .then((res) => (res.ok ? (res.json() as Promise<{ tracks: NatMessageTrack[] }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((d) => Promise.all(d.tracks.map(resolve)))
        .then(
          (list) => !cancelled && setTracks(list),
          () => undefined,
        );
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  const geojson = useMemo(() => toGeoJson(tracks, selected), [tracks, selected]);
  return { tracks, geojson };
}
