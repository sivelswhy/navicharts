// Télécharge les données OurAirports (domaine public) pour l'Europe, les données de navigation de l'eAIP France et
// les sector files IVAO d'Amérique du Nord, et génère les fichiers statiques utilisés par l'application.
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildAip } from './build-aip.ts';
import { buildEaipEnr } from './build-eaip-enr.ts';
import { buildDecea } from './build-decea.ts';
import { buildDeceaProcedures } from './build-decea-procedures.ts';
import { buildIvao, type IvaoData } from './build-ivao.ts';

const SOURCE = 'https://davidmegginson.github.io/ourairports-data';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;

const CONTINENT = 'EU';
const AIRPORT_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport', 'heliport', 'seaplane_base']);
// Outre-mer français (eAIP du SIA) : Guadeloupe, Martinique, Guyane, Réunion, Mayotte, Saint-Pierre-et-Miquelon,
// Saint-Martin, Saint-Barthélemy, Polynésie, Nouvelle-Calédonie, Wallis-et-Futuna, Terres australes
const FRENCH_OVERSEAS = new Set(['GP', 'MQ', 'GF', 'RE', 'YT', 'PM', 'MF', 'BL', 'PF', 'NC', 'WF', 'TF']);
// Asie : pays dont l'eAIP est lue (voir server/eaip.ts) : Corée du Sud, Taïwan, Thaïlande, Israël
const ASIA = new Set(['KR', 'TW', 'TH', 'IL']);

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

/** « ST-ANDRE-AVELLIN » → « St-Andre-Avellin » */
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());

/** Longueur en pieds entre deux seuils */
function lengthFt(a: [number, number], b: [number, number]): number {
  const kx = Math.cos((a[1] * Math.PI) / 180);
  return Math.round(Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]) * 60 * 6076.12);
}

/**
 * Aérodromes des sector files IVAO (États-Unis, Canada), sous la forme des lignes OurAirports : la fiche OurAirports
 * de l'aérodrome quand elle existe (type, noms, fréquences), sinon une fiche reconstituée depuis le sector file.
 * Les pistes du sector file complètent celles d'OurAirports, et ses fréquences ATC celles de chaque aérodrome.
 */
function sectorAirports(ivao: IvaoData | null, airports: Row[], runways: Row[], frequencies: Row[]) {
  const result = { airports: [] as Row[], runways: [] as Row[], frequencies: [] as Row[], withProcedures: new Set<string>() };
  if (!ivao) return result;
  // Indicatif du sector file → fiche OurAirports : identifiant, puis code GPS ou OACI, puis code local
  const byCode = new Map<string, Row>();
  for (const key of ['ident', 'gps_code', 'icao_code', 'local_code'] as const) {
    for (const a of airports) {
      // Codes locaux : seulement aux États-Unis et au Canada, où les sector files les emploient (05U…)
      if (a[key] && a.type !== 'closed' && (key !== 'local_code' || a.continent === 'NA') && !byCode.has(a[key])) byCode.set(a[key], a);
    }
  }
  const identOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of ivao.airports) {
    const row = byCode.get(s.ident);
    if (row && !taken.has(row.ident)) {
      taken.add(row.ident);
      identOf.set(s.ident, row.ident);
      result.airports.push(row.type === 'balloonport' ? { ...row, type: 'small_airport' } : row);
    } else if (!row && s.country) {
      // Sector file local : pays inconnu, l'aérodrome n'est repris que s'il figure dans OurAirports
      identOf.set(s.ident, s.ident);
      result.airports.push({
        ident: s.ident,
        type: 'small_airport',
        name: titleCase(s.name),
        latitude_deg: String(s.lat),
        longitude_deg: String(s.lon),
        elevation_ft: String(s.elevationFt),
        continent: s.continent,
        iso_country: s.country,
        iso_region: '',
        municipality: '',
        scheduled_service: 'no',
        icao_code: /^[A-Z]{4}$/.test(s.ident) ? s.ident : '',
        gps_code: s.ident,
        iata_code: '',
        home_link: '',
        wikipedia_link: '',
      });
    }
    if (s.procedures && identOf.has(s.ident)) result.withProcedures.add(identOf.get(s.ident)!);
  }

  const withRunways = new Set(runways.map((r) => r.airport_ident));
  for (const r of ivao.runways) {
    const ident = identOf.get(r.airport);
    if (!ident || withRunways.has(ident)) continue;
    const [le, he] = r.ends;
    result.runways.push({
      airport_ident: ident,
      le_ident: le.ident,
      he_ident: he.ident,
      length_ft: String(lengthFt([le.lon, le.lat], [he.lon, he.lat])),
      width_ft: '',
      surface: '',
      lighted: '',
      closed: '0',
      le_heading_degT: String(le.headingT),
      he_heading_degT: String(he.headingT),
      le_latitude_deg: String(le.lat),
      le_longitude_deg: String(le.lon),
      he_latitude_deg: String(he.lat),
      he_longitude_deg: String(he.lon),
    });
  }

  const known = new Set(frequencies.map((f) => `${f.airport_ident} ${Number(f.frequency_mhz).toFixed(3)}`));
  for (const a of ivao.atc) {
    const ident = identOf.get(a.airport);
    if (!ident || known.has(`${ident} ${a.mhz.toFixed(3)}`)) continue;
    result.frequencies.push({
      airport_ident: ident,
      type: a.callsign.split('_').at(-1)!,
      description: `${a.callsign} (IVAO)`,
      frequency_mhz: String(a.mhz),
    });
  }
  return result;
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const [airports, ourRunways, ourFrequencies, navaids, aip, enr, ivao, decea, deceaProcedures] = await Promise.all([
    loadCsv('airports'),
    loadCsv('runways'),
    loadCsv('airport-frequencies'),
    loadCsv('navaids'),
    buildAip().catch((err) => {
      console.warn(`⚠ eAIP indisponible (${err.message}) : routes, points et espaces aériens non générés`);
      return null;
    }),
    buildEaipEnr().catch((err) => {
      console.warn(`⚠ eAIP européens indisponibles (${err.message}) : routes hors France non générées`);
      return { airways: [], waypoints: [], countries: [] };
    }),
    buildIvao().catch((err) => {
      console.warn(`⚠ Sector files IVAO indisponibles (${err.message}) : Amériques non générées`);
      return null;
    }),
    buildDecea().catch((err) => {
      console.warn(`⚠ GeoAISWEB (DECEA) indisponible (${err.message}) : Brésil non généré`);
      return null;
    }),
    buildDeceaProcedures().catch((err) => {
      console.warn(`⚠ AIXM du DECEA indisponible (${err.message}) : procédures du Brésil non générées`);
      return null;
    }),
  ]);
  const ifrAerodromes = new Set(aip?.aerodromes ?? []);
  const deceaProcedureAirports = new Set(deceaProcedures?.airports ?? []);

  const europe = airports.filter((a) => a.continent === CONTINENT && AIRPORT_TYPES.has(a.type));
  const northAmerica = sectorAirports(ivao, airports, ourRunways, ourFrequencies);
  // Brésil : aérodromes OurAirports (le DECEA fournit routes, balises et espaces, voir build-decea.ts)
  const brazil = decea ? airports.filter((a) => a.iso_country === 'BR' && AIRPORT_TYPES.has(a.type) && a.type !== 'heliport') : [];
  const overseas = airports.filter((a) => FRENCH_OVERSEAS.has(a.iso_country) && AIRPORT_TYPES.has(a.type));
  // Hors héliports, très nombreux (plus d'un millier en Corée du Sud)
  const asia = airports.filter((a) => ASIA.has(a.iso_country) && AIRPORT_TYPES.has(a.type) && a.type !== 'heliport');
  // Un aérodrome peut venir de deux sources (eAIP et sector files IVAO en Thaïlande) : une seule fiche
  const selected = [...new Map([...europe, ...overseas, ...asia, ...northAmerica.airports, ...brazil].map((a) => [a.ident, a])).values()];
  const runways = [...ourRunways, ...northAmerica.runways];
  const frequencies = [...ourFrequencies, ...northAmerica.frequencies];
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
      // En Amérique du Nord, les aérodromes dotés de procédures dans les sector files IVAO.
      ifr:
        a.iso_country === 'FR' || FRENCH_OVERSEAS.has(a.iso_country)
          ? ifrAerodromes.has(a.ident)
          : northAmerica.withProcedures.has(a.ident) ||
            (a.iso_country === 'BR' && deceaProcedureAirports.has(a.ident)) ||
            (Boolean(a.icao_code) && (a.type === 'large_airport' || a.type === 'medium_airport')),
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
    .filter((n) => countries.has(n.iso_country) && (ASIA.has(n.iso_country) || inEurope(Number(n.latitude_deg), Number(n.longitude_deg))))
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
  // Brésil : le DECEA fait foi pour les routes, points, balises et espaces ; les sector files Aurora ne s'ajoutent qu'à défaut
  const notBrazil = (f: { properties: Record<string, unknown> }) => !decea || !f.properties.brazil;
  const navaidFeatures = [...aipNavaids, ...ourNavaids, ...(ivao?.navaids.filter(notBrazil) ?? []), ...(decea?.navaids ?? [])];
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
  const waypointFeatures = [...(aip?.waypoints ?? []), ...enr.waypoints, ...(ivao?.waypoints.filter(notBrazil) ?? []), ...(decea?.waypoints ?? [])];
  const airwayFeatures = [...(aip?.airways ?? []), ...enr.airways, ...(ivao?.airways.filter(notBrazil) ?? []), ...(decea?.airways ?? [])];
  await writeFile(path.join(OUT_DIR, 'waypoints.geojson'), collection(waypointFeatures));
  await writeFile(path.join(OUT_DIR, 'airways.geojson'), collection(airwayFeatures));
  await writeFile(path.join(OUT_DIR, 'airspaces.geojson'), collection([...(aip?.airspaces ?? []), ...(ivao?.airspaces.filter(notBrazil) ?? []), ...(decea?.airspaces ?? [])]));
  await writeFile(path.join(OUT_DIR, 'vfr.geojson'), collection(ivao?.vfr ?? []));
  await writeFile(path.join(OUT_DIR, 'mva.geojson'), collection(ivao?.mva ?? []));
  await writeFile(path.join(OUT_DIR, 'ivao-sectors.geojson'), collection(ivao?.sectors ?? []));
  await writeFile(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      airac: aip?.cycle ?? null,
      sources: [
        'OurAirports (domaine public)',
        'eAIP France et outre-mer, SIA',
        ...enr.countries.map((c) => `eAIP ${c}`),
        ...(ivao?.divisions ?? []).map((d) => `Sector files IVAO ${d}`),
        ...(decea ? ['DECEA (GeoAISWEB), Brésil'] : []),
        ...(deceaProcedures ? [`DECEA (AIXM ${deceaProcedures.amendment}), procédures du Brésil`] : []),
      ],
    }),
  );

  console.log(
    `✓ ${features.length} aérodromes (${features.filter((f) => f.properties.ifr).length} IFR), ${navaidFeatures.length} balises, ` +
      `${waypointFeatures.length} points, ${airwayFeatures.length} tronçons de routes, ` +
      `${(aip?.airspaces.length ?? 0) + (ivao?.airspaces.length ?? 0) + (decea?.airspaces.length ?? 0)} espaces aériens → public/data`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
