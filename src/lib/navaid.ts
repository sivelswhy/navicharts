// Balise choisie sur la carte ou dans la recherche, et son détail autorouter (test local, voir scripts/autorouter-search.ts).
import type { LngLat } from './georef.ts';

export interface NavaidInfo {
  ident: string;
  name?: string;
  /** « VOR-DME », « NDB »… */
  type?: string;
  /** « 114.8 MHz »… */
  frequency?: string;
  lngLat: LngLat;
}

export interface NavaidComponent {
  /** VOR, DME, TACAN, NDB… */
  type: string;
  /** Fréquence en MHz (VOR, DME appairé) ou en kHz (NDB) */
  frequency?: string;
  /** Canal DME / TACAN (53Y…) */
  channel?: string;
  operational: boolean;
}

export interface NavaidDetails {
  name?: string;
  components: NavaidComponent[];
  /** Déclinaison magnétique de la station, en degrés (positive vers l'est) */
  declination?: number;
  elevationFt?: number;
  lngLat: LngLat;
}

const formatFrequency = (hz: number) =>
  hz >= 1e6 ? `${(hz / 1e6).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} MHz` : `${(hz / 1e3).toLocaleString('fr-FR')} kHz`;

/** Détail autorouter de la balise (null hors dev ou si autorouter ne la connaît pas) */
export async function fetchNavaidDetails(n: NavaidInfo): Promise<NavaidDetails | null> {
  if (!import.meta.env.DEV) return null;
  const res = await fetch(`/dev/autorouter/navaid/${encodeURIComponent(n.ident)}?lon=${n.lngLat[0]}&lat=${n.lngLat[1]}`);
  const p = res.ok ? ((await res.json()) as Record<string, unknown> | null) : null;
  if (!p) return null;
  const components: NavaidComponent[] = [];
  let name: string | undefined;
  for (let i = 0; p[`c${i}type`] !== undefined; i++) {
    const c = (key: string) => p[`c${i}${key}`];
    const hz = Number(c('frequency') ?? c('pairedfreq') ?? 0);
    components.push({
      type: String(c('vortype') ?? c('type')).toUpperCase(),
      frequency: hz ? formatFrequency(hz) : undefined,
      channel: c('channel') !== undefined ? `${c('channel')}${c('channelsuffix') ?? ''}` : undefined,
      operational: c('oprstat') !== undefined ? c('oprstat') === 'operational' : true,
    });
    name ??= c('name') ? String(c('name')) : undefined;
  }
  // VOR d'abord, puis TACAN, DME, NDB
  const order = ['VOR', 'DVOR', 'TACAN', 'DME', 'NDB'];
  components.sort((a, b) => (order.indexOf(a.type) + 1 || 9) - (order.indexOf(b.type) + 1 || 9));
  return {
    name,
    components,
    declination: typeof p.decl === 'number' ? p.decl : undefined,
    elevationFt: typeof p.elev === 'number' ? p.elev : undefined,
    lngLat: p.lngLat as LngLat,
  };
}
