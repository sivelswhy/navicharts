// Données aéronautiques officielles du Brésil, publiées par le DECEA (Departamento de Controle do Espaço Aéreo) sur
// son serveur cartographique public GeoAISWEB (https://geoaisweb.decea.mil.br), à jour de l'amendement AIRAC en vigueur :
// routes aériennes hautes et basses, points, VOR, NDB et DME, FIR, CTA, TMA, CTR, ATZ, zones P, R et D.
// Les couches sont lues en GeoJSON (WFS) et mises en cache une journée.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Position = [number, number];
type Feature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };
type Props = Record<string, string | number | null>;

const WFS = 'https://geoaisweb.decea.mil.br/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json';
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache', 'decea');
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;

async function layer(name: string): Promise<{ geometry: { type: string; coordinates: unknown }; properties: Props }[]> {
  const file = path.join(CACHE_DIR, `${name}.json`);
  const fresh = await stat(file).then((s) => Date.now() - s.mtimeMs < CACHE_MAX_AGE_MS, () => false);
  if (!fresh) {
    console.log(`↓ DECEA ${name}`);
    const res = await fetch(`${WFS}&typeNames=ICA:${name}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${name} : HTTP ${res.status}`);
    await writeFile(file, await res.text());
  }
  return JSON.parse(await readFile(file, 'utf8')).features.filter((f: { geometry: unknown }) => f.geometry);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const point = (at: Position, properties: Record<string, unknown>): Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties });

/** Premier point d'une géométrie Point ou MultiPoint */
function firstPoint(geometry: { type: string; coordinates: unknown }): Position {
  const c = geometry.type === 'MultiPoint' ? (geometry.coordinates as Position[])[0] : (geometry.coordinates as Position);
  return [round(c[0]), round(c[1])];
}

/** Valeur et unité → niveau de vol (« FL », pieds convertis en centaines) */
const toFl = (value: unknown, uom: unknown) => (value === null || value === undefined ? null : uom === 'FL' ? Number(value) : Math.round(Number(value) / 100));

/** Limite verticale lisible, comme celles de l'eAIP France : « FL 195 », « 3500 FT », « SFC », « UNL » */
function limit(value: unknown, uom: unknown, reference?: unknown): string {
  const v = Number(value);
  if (uom === 'FL') return v >= 999 ? 'UNL' : `FL ${v}`;
  if (v === 0 && (reference === 'SFC' || reference === undefined || reference === null)) return 'SFC';
  return `${v} FT${reference === 'SFC' ? ' ASFC' : ''}`;
}

export async function buildDecea(): Promise<{ airways: Feature[]; waypoints: Feature[]; navaids: Feature[]; airspaces: Feature[]; amendment: string | null }> {
  await mkdir(CACHE_DIR, { recursive: true });
  const [high, low, waypoints, vor, ndb, dme, fir, cta, tma, ctr, atz, p, r, d] = await Promise.all(
    ['vw_aerovia_alta_v2', 'vw_aerovia_baixa_v2', 'waypoint', 'vor', 'ndb', 'dme', 'fir', 'CTA', 'TMA', 'CTR', 'ATZ', 'eac_p', 'eac_r', 'eac_d'].map(layer),
  );

  // Routes : un tronçon par entité, avec ses points d'extrémité et ses limites verticales
  const airways: Feature[] = [...high, ...low].map((f) => ({
    type: 'Feature',
    geometry: f.geometry,
    properties: {
      name: f.properties.text_designator,
      lowerFl: toFl(f.properties.lower_limit, f.properties.uom_lower_limit),
      upperFl: toFl(f.properties.upper_limit, f.properties.uom_upper_limit),
      from: f.properties.from_fix_ident,
      to: f.properties.to_fix_ident,
      source: 'DECEA',
    },
  }));

  // Balises : un DME associé à un VOR du même nom en fait un VOR-DME
  const dmeAt = new Map(dme.map((f) => [f.properties.codeid, firstPoint(f.geometry)]));
  const near = (a: Position, b: Position | undefined) => b && Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
  const paired = new Set<unknown>();
  const navaids: Feature[] = [
    ...vor.map((f) => {
      const at = firstPoint(f.geometry);
      const withDme = near(at, dmeAt.get(f.properties.ident));
      if (withDme) paired.add(f.properties.ident);
      return point(at, {
        ident: f.properties.ident,
        name: f.properties.txtname,
        type: withDme ? 'VOR-DME' : 'VOR',
        frequency: `${Number(f.properties.frequency).toFixed(2)} MHz`,
        source: 'DECEA',
      });
    }),
    ...ndb.map((f) =>
      point(firstPoint(f.geometry), { ident: f.properties.codeid, name: f.properties.txtname, type: 'NDB', frequency: `${f.properties.valfreq} kHz`, source: 'DECEA' }),
    ),
    ...dme
      .filter((f) => !paired.has(f.properties.codeid))
      .map((f) =>
        point(firstPoint(f.geometry), {
          ident: f.properties.codeid,
          name: f.properties.txtname,
          type: 'DME',
          frequency: `CH ${f.properties.valchannel}${f.properties.codechanne ?? ''}`,
          source: 'DECEA',
        }),
      ),
  ];

  const points = waypoints.map((f) => point(firstPoint(f.geometry), { ident: f.properties.ident, source: 'DECEA' }));

  // Espaces aériens : les champs du DECEA sont décalés (`lowerlimit` = unité du plancher, `lowerlimi1` = sa valeur)
  const controlled = [...fir, ...cta, ...tma, ...ctr, ...atz].map((f) => ({
    type: 'Feature' as const,
    geometry: f.geometry,
    properties: {
      name: `${f.properties.nam} (${f.properties.ident})`,
      // ATZ dessinées comme des CTR ; « CTA_P » (portion de CTA) comme une CTA
      type: f.properties.typ === 'ATZ' ? 'CTR' : String(f.properties.typ).replace(/_.*$/, ''),
      class: '',
      upper: limit(f.properties.upperlimit, f.properties.uplimituni, f.properties.codedistve),
      lower: limit(f.properties.lowerlimi1, f.properties.lowerlimit, f.properties.codedistv1),
      source: 'DECEA',
    },
  }));
  const restricted = [...p, ...r, ...d].map((f) => ({
    type: 'Feature' as const,
    geometry: f.geometry,
    properties: {
      name: `${f.properties.id} ${f.properties.nome}`,
      type: f.properties.tipo,
      class: '',
      upper: limit(f.properties.upperlimit, f.properties.uom_ulimit),
      lower: limit(f.properties.lowerlimit, f.properties.uom_llimit),
      source: 'DECEA',
    },
  }));

  const amendment = String(high[0]?.properties.emenda ?? '').replace(/Z$/, '') || null;
  console.log(
    `  DECEA Brésil (amendement ${amendment ?? '?'}) : ${airways.length} tronçons, ${points.length} points, ${navaids.length} balises, ` +
      `${controlled.length + restricted.length} espaces aériens`,
  );
  return { airways, waypoints: points, navaids, airspaces: [...controlled, ...restricted], amendment };
}
