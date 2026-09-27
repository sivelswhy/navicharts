// Télécharge les données OurAirports (domaine public) pour l'Europe et les données de navigation de l'eAIP France,
// et génère les fichiers statiques utilisés par l'application.
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildAip } from './build-aip.ts';

const SOURCE = 'https://davidmegginson.github.io/ourairports-data';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;

const CONTINENT = 'EU';
const AIRPORT_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport', 'heliport', 'seaplane_base']);

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows;
  return data
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function loadCsv(name: string): Promise<Row[]> {
  const file = path.join(CACHE_DIR, `${name}.csv`);
  const fresh = await stat(file).then((s) => Date.now() - s.mtimeMs < CACHE_MAX_AGE_MS, () => false);
  if (!fresh) {
    console.log(`↓ ${name}.csv`);
    const res = await fetch(`${SOURCE}/${name}.csv`);
    if (!res.ok) throw new Error(`Téléchargement de ${name}.csv impossible : HTTP ${res.status}`);
    await writeFile(file, await res.text());
  }
  return parseCsv(await readFile(file, 'utf8'));
}

const num = (v: string) => (v === '' ? null : Number(v));

/** Point situé `meters` au-delà de `to`, dans le prolongement du segment from → to */
function beyond(from: [number, number], to: [number, number], meters: number): [number, number] {
  const kx = Math.cos((to[1] * Math.PI) / 180);
  const dx = (to[0] - from[0]) * kx;
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const d = meters / 111_320;
  return [round(to[0] + ((dx / len) * d) / kx), round(to[1] + (dy / len) * d)];
}
const round = (v: number, digits = 5) => Math.round(v * 10 ** digits) / 10 ** digits;

// Emprise européenne, pour les balises (OurAirports ne leur attribue pas de continent)
const inEurope = (lat: number, lon: number) => lat > 34 && lat < 72 && lon > -32 && lon < 60;

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const [airports, runways, frequencies, navaids, aip] = await Promise.all([
    loadCsv('airports'),
    loadCsv('runways'),
    loadCsv('airport-frequencies'),
    loadCsv('navaids'),
    buildAip().catch((err) => {
      console.warn(`⚠ eAIP indisponible (${err.message}) : routes, points et espaces aériens non générés`);
      return null;
    }),
  ]);
  const ifrAerodromes = new Set(aip?.aerodromes ?? []);

  const selected = airports.filter((a) => a.continent === CONTINENT && AIRPORT_TYPES.has(a.type));
  const idents = new Set(selected.map((a) => a.ident));
  const countries = new Set(selected.map((a) => a.iso_country));

  const runwaysByAirport = new Map<string, unknown[]>();
  for (const r of runways) {
    if (!idents.has(r.airport_ident) || r.closed === '1') continue;
    const list = runwaysByAirport.get(r.airport_ident) ?? [];
    list.push({
      ident: [r.le_ident, r.he_ident].filter(Boolean).join('/'),
      lengthFt: num(r.length_ft),
      widthFt: num(r.width_ft),
      surface: r.surface,
      lighted: r.lighted === '1',
      ends: [
        { ident: r.le_ident, headingT: num(r.le_heading_degT), lat: num(r.le_latitude_deg), lon: num(r.le_longitude_deg) },
        { ident: r.he_ident, headingT: num(r.he_heading_degT), lat: num(r.he_latitude_deg), lon: num(r.he_longitude_deg) },
      ].filter((e) => e.ident),
    });
    runwaysByAirport.set(r.airport_ident, list);
  }

  const freqsByAirport = new Map<string, unknown[]>();
  for (const f of frequencies) {
    if (!idents.has(f.airport_ident)) continue;
    const list = freqsByAirport.get(f.airport_ident) ?? [];
    list.push({ type: f.type, description: f.description, mhz: Number(f.frequency_mhz) });
    freqsByAirport.set(f.airport_ident, list);
  }

  const features = selected.map((a) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [round(Number(a.longitude_deg)), round(Number(a.latitude_deg))] },
    properties: {
      ident: a.ident,
      icao: a.icao_code || (/^[A-Z]{4}$/.test(a.ident) && a.gps_code === a.ident ? a.ident : ''),
      iata: a.iata_code,
      name: a.name,
      type: a.type,
      city: a.municipality,
      country: a.iso_country,
      // Terrain doté de procédures IFR : symbole distinct sur la carte. En France, la liste AD 2 de l'eAIP fait foi ;
      // ailleurs, on retient les aéroports (moyens et grands) dotés d'un indicatif OACI.
      ifr:
        a.iso_country === 'FR'
          ? ifrAerodromes.has(a.ident)
          : Boolean(a.icao_code) && (a.type === 'large_airport' || a.type === 'medium_airport'),
    },
  }));

  // Pistes en lignes, dessinées à fort zoom
  const HARD_SURFACES = /^(ASP|CON|BIT|PEM|ASPH|CONC|TAR)/i;
  const openRunways = runways.filter(
    (r) => idents.has(r.airport_ident) && r.closed !== '1' && r.le_latitude_deg && r.he_latitude_deg,
  );
  const runwayFeatures = openRunways.map((r) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [round(Number(r.le_longitude_deg)), round(Number(r.le_latitude_deg))],
        [round(Number(r.he_longitude_deg)), round(Number(r.he_latitude_deg))],
      ],
    },
    properties: { airport: r.airport_ident, hard: HARD_SURFACES.test(r.surface), widthFt: num(r.width_ft) },
  }));

  // Désignation de chaque extrémité de piste (« 08L », « 26R »), placée un peu au-delà du seuil dans l'axe
  const runwayEndFeatures = runwayFeatures.flatMap((f, i) => {
    const r = openRunways[i];
    const [le, he] = f.geometry.coordinates as [number, number][];
    return [
      { ident: r.le_ident, at: le, from: he },
      { ident: r.he_ident, at: he, from: le },
    ]
      .filter((e) => e.ident)
      .map((e) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: beyond(e.from, e.at, 150) },
        properties: { ident: e.ident, airport: r.airport_ident },
      }));
  });

  // Fiches détaillées, découpées par pays et chargées à la demande
  const detailsByCountry = new Map<string, Record<string, unknown>>();
  for (const a of selected) {
    const bucket = detailsByCountry.get(a.iso_country) ?? {};
    bucket[a.ident] = {
      elevationFt: num(a.elevation_ft),
      region: a.iso_region,
      scheduled: a.scheduled_service === 'yes',
      website: a.home_link,
      wikipedia: a.wikipedia_link,
      runways: runwaysByAirport.get(a.ident) ?? [],
      frequencies: freqsByAirport.get(a.ident) ?? [],
    };
    detailsByCountry.set(a.iso_country, bucket);
  }

  // Balises : celles de l'eAIP (ENR 4.1) font foi ; OurAirports complète avec les balises d'aérodrome
  const aipNavaids = aip?.navaids ?? [];
  const nearAip = (ident: string, lon: number, lat: number) =>
    aipNavaids.some((f) => {
      const [x, y] = f.geometry.coordinates as [number, number];
      return f.properties.ident === ident && Math.abs(x - lon) < 0.03 && Math.abs(y - lat) < 0.03;
    });
  const ourNavaids = navaids
    .filter((n) => countries.has(n.iso_country) && inEurope(Number(n.latitude_deg), Number(n.longitude_deg)))
    .filter((n) => !nearAip(n.ident, Number(n.longitude_deg), Number(n.latitude_deg)))
    .map((n) => {
      const khz = num(n.frequency_khz);
      const isNdb = n.type.startsWith('NDB');
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [round(Number(n.longitude_deg)), round(Number(n.latitude_deg))] },
        properties: {
          ident: n.ident,
          name: n.name,
          type: n.type,
          frequency: khz === null ? n.dme_channel : isNdb ? `${khz} kHz` : `${(khz / 1000).toFixed(2)} MHz`,
        },
      };
    });
  const navaidFeatures = [...aipNavaids, ...ourNavaids];
  const collection = (list: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features: list });

  await writeFile(path.join(OUT_DIR, 'airports.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  await rm(path.join(OUT_DIR, 'airport-details.json'), { force: true });
  await rm(path.join(OUT_DIR, 'details'), { recursive: true, force: true });
  await mkdir(path.join(OUT_DIR, 'details'), { recursive: true });
  for (const [country, bucket] of detailsByCountry) {
    await writeFile(path.join(OUT_DIR, 'details', `${country}.json`), JSON.stringify(bucket));
  }
  await writeFile(path.join(OUT_DIR, 'navaids.geojson'), collection(navaidFeatures));
  await writeFile(path.join(OUT_DIR, 'runways.geojson'), collection(runwayFeatures));
  await writeFile(path.join(OUT_DIR, 'runway-ends.geojson'), collection(runwayEndFeatures));
  await writeFile(path.join(OUT_DIR, 'waypoints.geojson'), collection(aip?.waypoints ?? []));
  await writeFile(path.join(OUT_DIR, 'airways.geojson'), collection(aip?.airways ?? []));
  await writeFile(path.join(OUT_DIR, 'airspaces.geojson'), collection(aip?.airspaces ?? []));
  await writeFile(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      airac: aip?.cycle ?? null,
      sources: ['OurAirports (domaine public)', 'eAIP France, SIA'],
    }),
  );

  console.log(
    `✓ ${features.length} aérodromes (${features.filter((f) => f.properties.ifr).length} IFR), ${navaidFeatures.length} balises, ` +
      `${aip?.waypoints.length ?? 0} points, ${aip?.airways.length ?? 0} tronçons de routes, ` +
      `${aip?.airspaces.length ?? 0} espaces aériens → public/data`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
