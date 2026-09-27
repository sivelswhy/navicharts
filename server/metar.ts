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
