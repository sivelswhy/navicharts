// Trafic IVAO en direct et suivi du vol d'un membre (VID), via le relais du serveur (/api/ivao).
import { useEffect, useState } from 'react';
import type { FeatureCollection } from 'geojson';

export interface IvaoPilot {
  sessionId: number;
  vid: number;
  callsign: string;
  lat: number;
  lon: number;
  altitude: number;
  groundSpeed: number;
  heading: number;
  onGround: boolean;
  state: string;
  aircraft: string | null;
  departure: string | null;
  arrival: string | null;
  arrivalDistance: number | null;
}

export interface IvaoFlightPlan {
  id: number;
  revision: number;
  departure: string | null;
  arrival: string | null;
  route: string | null;
  speed: string | null;
  level: string | null;
  rules: string;
  aircraft: string;
}

export interface IvaoAtc {
  callsign: string;
  lat: number;
  lon: number;
  frequency: number;
  position: string;
}

interface Traffic {
  updatedAt: string;
  pilots: IvaoPilot[];
  atcs: IvaoAtc[];
}

// Les données IVAO sont rafraîchies toutes les 15 s environ
const TRAFFIC_REFRESH_MS = 20_000;
const PILOT_REFRESH_MS = 15_000;

/** Interroge une adresse à intervalle régulier tant que `enabled` est vrai */
function usePolling<T>(url: string | null, intervalMs: number): { data: T | null; error: boolean } {
  const [state, setState] = useState<{ data: T | null; error: boolean }>({ data: null, error: false });
  useEffect(() => {
    if (!url) {
      setState({ data: null, error: false });
      return;
    }
    let cancelled = false;
    const load = () =>
      fetch(url)
        .then((res) => (res.ok ? (res.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then(
          (data) => !cancelled && setState({ data, error: false }),
          () => !cancelled && setState((prev) => ({ data: prev.data, error: true })),
        );
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, intervalMs]);
  return state;
}

export function useIvaoTraffic(enabled: boolean) {
  return usePolling<Traffic>(enabled ? '/api/ivao' : null, TRAFFIC_REFRESH_MS);
}

export function useIvaoPilot(vid: string | null) {
  return usePolling<{ updatedAt: string; pilot: IvaoPilot | null; flightPlan: IvaoFlightPlan | null }>(
    vid ? `/api/ivao/pilot/${encodeURIComponent(vid)}` : null,
    PILOT_REFRESH_MS,
  );
}

/** Route texte au format plan de vol à partir du plan déposé sur IVAO */
export function flightPlanText(fp: IvaoFlightPlan): string {
  return [fp.departure, fp.speed && fp.level ? `${fp.speed}${fp.level}` : null, fp.route, fp.arrival]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trafficGeoJson(traffic: Traffic | null, ownVid: number | null): { pilots: FeatureCollection; atcs: FeatureCollection } {
  return {
    pilots: {
      type: 'FeatureCollection',
      features: (traffic?.pilots ?? [])
        // Le vol suivi est dessiné à part, avec son propre symbole
        .filter((p) => p.vid !== ownVid)
        .map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: {
            callsign: p.callsign,
            heading: p.heading,
            onGround: p.onGround,
            info: [p.aircraft, p.departure && p.arrival ? `${p.departure}–${p.arrival}` : null, `FL${String(Math.round(p.altitude / 100)).padStart(3, '0')}`]
              .filter(Boolean)
              .join(' '),
          },
        })),
    },
    atcs: {
      type: 'FeatureCollection',
      features: (traffic?.atcs ?? []).map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { callsign: a.callsign, frequency: a.frequency.toFixed(3), position: a.position },
      })),
    },
  };
}
