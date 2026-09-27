export type AirportType = 'large_airport' | 'medium_airport' | 'small_airport' | 'heliport' | 'seaplane_base';

export interface Airport {
  ident: string;
  icao: string;
  iata: string;
  name: string;
  type: AirportType;
  city: string;
  /** Code pays ISO (FR, GB…) */
  country: string;
  lon: number;
  lat: number;
}

export interface RunwayEnd {
  ident: string;
  headingT: number | null;
  lat: number | null;
  lon: number | null;
}

export interface Runway {
  ident: string;
  lengthFt: number | null;
  widthFt: number | null;
  surface: string;
  lighted: boolean;
  ends: RunwayEnd[];
}

export interface Frequency {
  type: string;
  description: string;
  mhz: number;
}

export interface AirportDetails {
  elevationFt: number | null;
  region: string;
  scheduled: boolean;
  website: string;
  wikipedia: string;
  runways: Runway[];
  frequencies: Frequency[];
}

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
