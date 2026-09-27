// Cartes d'aérodrome : types communs et choix du fournisseur selon le préfixe OACI.
import { EAIP_COUNTRIES, eaipCountryFor, getEaipCharts } from './eaip.ts';
import { getSiaCharts, SIA_HOST } from './sia.ts';

export type ChartCategory = 'VAC' | 'GROUND' | 'SID' | 'STAR' | 'APPROACH' | 'OTHER' | 'DATA';

export interface Chart {
  id: string;
  title: string;
  category: ChartCategory;
  url: string;
}

export interface AirportCharts {
  icao: string;
  airac: string;
  effective: string;
  charts: Chart[];
  sourceUrl: string | null;
  /** Source des cartes (« SIA », « eAIP Royaume-Uni »…), null si le pays n'est pas couvert */
  provider: string | null;
}

/** Hôtes dont le relais PDF accepte de servir les documents */
export const CHART_HOSTS = new Set([SIA_HOST, ...EAIP_COUNTRIES.map((c) => c.host)]);

export function getCharts(icao: string): Promise<AirportCharts> {
  if (icao.startsWith('LF')) return getSiaCharts(icao);
  const country = eaipCountryFor(icao);
  if (country) return getEaipCharts(country, icao);
  return Promise.resolve({ icao, airac: '', effective: '', charts: [], sourceUrl: null, provider: null });
}
