// METAR des aérodromes, d'après le service public de la NOAA (aviationweather.gov), avec un cache court.
const API = 'https://aviationweather.gov/api/data/metar';
const CACHE_MS = 5 * 60 * 1000;
const USER_AGENT = 'NaviCharts/0.1 (simulation de vol, usage personnel)';

export interface Metar {
  icao: string;
  raw: string;
  observed: string;
  /** Catégorie de vol calculée par la NOAA : VFR, MVFR, IFR, LIFR */
  category: string | null;
}

const cache = new Map<string, { at: number; metar: Metar | null }>();

export async function getMetars(icaos: string[]): Promise<Metar[]> {
  const missing = icaos.filter((i) => {
    const hit = cache.get(i);
    return !hit || Date.now() - hit.at > CACHE_MS;
  });
  if (missing.length) {
    const res = await fetch(`${API}?ids=${missing.join(',')}&format=json`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Météo : HTTP ${res.status}`);
    const text = await res.text();
    const rows = text.trim() ? (JSON.parse(text) as { icaoId: string; rawOb: string; reportTime: string; fltCat?: string }[]) : [];
    for (const icao of missing) {
      const row = rows.find((r) => r.icaoId === icao);
      cache.set(icao, {
        at: Date.now(),
        metar: row ? { icao, raw: row.rawOb, observed: row.reportTime, category: row.fltCat ?? null } : null,
      });
    }
  }
  return icaos.map((i) => cache.get(i)?.metar).filter((m): m is Metar => Boolean(m));
}

export interface NearbyMetar {
  metar: Metar;
  /** Nom de la station (NOAA) */
  name: string | null;
  /** Distance au point demandé, en milles nautiques */
  distanceNm: number;
}

// Rayons de recherche successifs, en degrés de latitude (~60 NM par degré)
const SEARCH_RADII = [0.75, 1.5, 3];
const nearbyCache = new Map<string, { at: number; nearby: NearbyMetar | null }>();

function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

/** METAR de la station la plus proche du point (hors `exclude`), dans un rayon d'environ 180 NM */
export async function getNearestMetar(lat: number, lon: number, exclude?: string): Promise<NearbyMetar | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${exclude ?? ''}`;
  const hit = nearbyCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.nearby;

  let nearby: NearbyMetar | null = null;
  for (const r of SEARCH_RADII) {
    const dLon = r / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
    const bbox = [lat - r, lon - dLon, lat + r, lon + dLon].map((n) => n.toFixed(3)).join(',');
    const res = await fetch(`${API}?bbox=${bbox}&format=json`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Météo : HTTP ${res.status}`);
    const text = await res.text();
    const rows = text.trim()
      ? (JSON.parse(text) as { icaoId: string; rawOb: string; reportTime: string; fltCat?: string; lat: number; lon: number; name?: string }[])
      : [];
    for (const row of rows) {
      if (row.icaoId === exclude || !/^[A-Z0-9]{4}$/.test(row.icaoId)) continue;
      const d = distanceNm(lat, lon, row.lat, row.lon);
      if (!nearby || d < nearby.distanceNm) {
        nearby = {
          metar: { icao: row.icaoId, raw: row.rawOb, observed: row.reportTime, category: row.fltCat ?? null },
          name: row.name ?? null,
          distanceNm: d,
        };
      }
    }
    if (nearby) break;
  }
  nearbyCache.set(key, { at: Date.now(), nearby });
  return nearby;
}
