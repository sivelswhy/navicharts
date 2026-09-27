// Extrait de l'eAIP France (cycle AIRAC en vigueur) les données de navigation affichées sur la carte :
// balises (ENR 4.1), points significatifs (ENR 4.4), routes RNAV (ENR 3.2) et espaces aériens (ENR 2.1).
// Les pages HTML du SIA sont annotées avec les champs AIXM (ex. DESIGNATED_POINT.GEO_LAT), ce qui permet
// de les lire sans dépendre de la mise en page.
import { currentCycle, previousCycle, type AiracCycle } from '../server/airac.ts';
import { siaBase } from '../server/sia.ts';

type Position = [number, number];
type Feature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };

const USER_AGENT = { 'User-Agent': 'NaviCharts (usage personnel)' };

function enrUrl(cycle: AiracCycle, section: string): string {
  const iso = cycle.effective.toISOString().slice(0, 10);
  return `${siaBase(cycle)}/FRANCE/AIRAC-${iso}/html/eAIP/FR-ENR-${section}-fr-FR.html`;
}

async function fetchEnr(section: string): Promise<{ html: string; cycle: AiracCycle }> {
  const cycle = currentCycle();
  // Si le cycle en vigueur n'est pas encore en ligne, on prend le précédent
  for (const c of [cycle, previousCycle(cycle)]) {
    const res = await fetch(enrUrl(c, section), { headers: USER_AGENT });
    if (res.ok) return { html: await res.text(), cycle: c };
    if (res.status !== 404) throw new Error(`SIA ENR ${section} : HTTP ${res.status}`);
  }
  throw new Error(`SIA ENR ${section} introuvable`);
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Valeur du premier élément dont l'identifiant AIXM se termine par `field` (ex. "VOR.GEO_LAT") */
function field(html: string, fieldName: string): string | null {
  const re = new RegExp(`id="gaixm--[^"]*?--${fieldName.replace('.', '\\.')}(?:--[^"]*)?"[^>]*>([^<]*)<`);
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** « 46°45'00"N » ou « 50°08'06.5"N » → degrés décimaux */
function parseDms(value: string | null): number | null {
  const m = value && /(\d{2,3})°(\d{2})'(\d{2}(?:[.,]\d+)?)"\s*([NSEW])/.exec(value);
  if (!m) return null;
  const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3].replace(',', '.')) / 3600;
  return m[4] === 'S' || m[4] === 'W' ? -v : v;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const point = (coordinates: Position, properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [round(coordinates[0]), round(coordinates[1])] },
  properties,
});

// ───────── ENR 4.1 : balises ─────────

async function navaids(): Promise<Feature[]> {
  const { html } = await fetchEnr('4.1');
  const features: Feature[] = [];
  for (const [, id, row] of html.matchAll(/<tr id="NAV-([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const kind = id.split('-').slice(1).join('-'); // DME, VOR, VORDME, NDB, TACAN…
    const prefix = kind === 'VORDME' ? 'VOR' : kind;
    const lat = parseDms(field(row, `${prefix}.GEO_LAT`));
    const lon = parseDms(field(row, `${prefix}.GEO_LONG`));
    if (lat === null || lon === null) continue;
    const freq = field(row, `${prefix}.VAL_FREQ`) ?? field(row, `${prefix}.VAL_GHOST_FREQ`);
    const unit = field(row, `${prefix}.UOM_FREQ`) ?? field(row, `${prefix}.UOM_GHOST_FREQ`);
    features.push(
      point([lon, lat], {
        ident: field(row, `${prefix}.CODE_NAV_ID`),
        name: field(row, `${prefix}.STATION`) ?? field(row, 'ADHP.TXT_NAME'),
        type: { VORDME: 'VOR-DME' }[kind] ?? kind,
        frequency: freq ? `${freq} ${unit ?? ''}`.trim() : field(row, `${prefix}.CODE_CHANNEL`),
      }),
    );
  }
  return features;
}

// ───────── ENR 4.4 : points significatifs ─────────

async function waypoints(): Promise<Feature[]> {
  const { html } = await fetchEnr('4.4');
  const features: Feature[] = [];
  for (const [, row] of html.matchAll(/<tr id="SP-[^"]+"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const ident = field(row, 'DESIGNATED_POINT.CODE_IDENT');
    const lat = parseDms(field(row, 'DESIGNATED_POINT.GEO_LAT'));
    const lon = parseDms(field(row, 'DESIGNATED_POINT.GEO_LONG'));
    if (ident && lat !== null && lon !== null) features.push(point([lon, lat], { ident }));
  }
  return features;
}

// ───────── ENR 3.2 : routes RNAV ─────────

/** « FL 195 », « 5000 ft AMSL », « UNL »… → niveau de vol approximatif (pour distinguer routes hautes et basses) */
function flightLevel(value: string | null): number | null {
  if (!value) return null;
  if (/UNL/i.test(value)) return 999;
  const fl = /FL\s*(\d+)/i.exec(value);
  if (fl) return Number(fl[1]);
  const ft = /(\d+)\s*ft/i.exec(value);
  return ft ? Math.round(Number(ft[1]) / 100) : Number(value) || null;
}

async function airways(): Promise<Feature[]> {
  const { html } = await fetchEnr('3.2');
  const features: Feature[] = [];
  // Chaque route commence par un tableau id="RTE-…" (qui contient lui-même des tableaux imbriqués) :
  // on découpe la page route par route, puis on lit les champs AIXM dans l'ordre du document.
  const chunks = html.split(/<table[^>]*id="RTE-/).slice(1);
  const token = /\.GEO_LAT"[^>]*>([^<]*)<[\s\S]*?\.GEO_LONG"[^>]*>([^<]*)<|RTE_SEG\.VAL_DIST_VER_(UPPER|LOWER)[^"]*"[^>]*>([^<]*)</g;
  for (const chunk of chunks) {
    const name = field(chunk, 'RTE.TXT_DESIG');
    if (!name) continue;
    let previous: Position | null = null;
    let lower: number | null = null;
    let upper: number | null = null;
    for (const m of chunk.matchAll(token)) {
      if (m[3] === 'UPPER') upper = flightLevel(m[4]);
      else if (m[3] === 'LOWER') lower = flightLevel(m[4]);
      else {
        const lat = parseDms(m[1]);
        const lon = parseDms(m[2]);
        if (lat === null || lon === null) continue;
        const here: Position = [round(lon), round(lat)];
        if (previous) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [previous, here] },
            properties: { name, lowerFl: lower, upperFl: upper },
          });
        }
        previous = here;
        lower = upper = null;
      }
    }
  }
  return features;
}

// ───────── ENR 2.1 : espaces aériens ─────────

const EARTH_NM = 3440.065;

/** Point à `distanceNm` de `center` dans la direction `bearing` (radians, depuis le nord) */
function destination([lon, lat]: Position, bearing: number, distanceNm: number): Position {
  const d = distanceNm / EARTH_NM;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(bearing));
  const λ2 = λ1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [round((λ2 * 180) / Math.PI), round((φ2 * 180) / Math.PI)];
}

function bearing([lon1, lat1]: Position, [lon2, lat2]: Position): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  return Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
}

/** Points intermédiaires d'un arc de `from` à `to` autour de `center` */
function arc(center: Position, radiusNm: number, from: Position, to: Position, clockwise: boolean): Position[] {
  const start = bearing(center, from);
  let sweep = bearing(center, to) - start;
  if (clockwise && sweep <= 0) sweep += 2 * Math.PI;
  if (!clockwise && sweep >= 0) sweep -= 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  const points: Position[] = [];
  for (let i = 1; i < steps; i++) points.push(destination(center, start + (sweep * i) / steps, radiusNm));
  return points;
}

type Token =
  | { kind: 'vertex'; at: Position }
  | { kind: 'arc'; clockwise: boolean; radiusNm: number; center: Position }
  | { kind: 'circle'; radiusNm: number; center: Position };

/** Lit la description des limites latérales : sommets, arcs, cercles (les tronçons de frontière sont tracés en ligne droite) */
function lateralLimits(cell: string): Position[] | null {
  const tokens: Token[] = [];
  const re =
    /AIRSPACE_VERTEX\.GEO_LAT(?:--END)?"[^>]*>([^<]*)<[\s\S]*?AIRSPACE_VERTEX\.GEO_LONG(?:--END)?"[^>]*>([^<]*)<|(anti-horaire|horaire|cercle)[\s\S]*?VAL_RADIUS_ARC"[^>]*>([^<]*)<[\s\S]*?UOM_RADIUS_ARC"[^>]*>([^<]*)<[\s\S]*?GEO_LAT_ARC"[^>]*>([^<]*)<[\s\S]*?GEO_LONG_ARC"[^>]*>([^<]*)</g;
  for (const m of cell.matchAll(re)) {
    if (m[1] !== undefined) {
      const lat = parseDms(m[1]);
      const lon = parseDms(m[2]);
      if (lat !== null && lon !== null) tokens.push({ kind: 'vertex', at: [round(lon), round(lat)] });
      continue;
    }
    const lat = parseDms(m[6]);
    const lon = parseDms(m[7]);
    if (lat === null || lon === null) continue;
    const radius = Number(m[4].replace(',', '.'));
    const radiusNm = /km/i.test(m[5]) ? radius / 1.852 : /m$/i.test(m[5].trim()) ? radius / 1852 : radius;
    if (m[3] === 'cercle') tokens.push({ kind: 'circle', radiusNm, center: [lon, lat] });
    else tokens.push({ kind: 'arc', clockwise: m[3] === 'horaire', radiusNm, center: [lon, lat] });
  }

  const circle = tokens.find((t) => t.kind === 'circle');
  if (circle && circle.kind === 'circle') {
    const ring = Array.from({ length: 72 }, (_, i) => destination(circle.center, (i / 72) * 2 * Math.PI, circle.radiusNm));
    return [...ring, ring[0]];
  }

  const ring: Position[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'vertex') ring.push(t.at);
    else if (t.kind === 'arc') {
      const from = ring.at(-1);
      const next = tokens.slice(i + 1).find((n) => n.kind === 'vertex');
      const to = next?.kind === 'vertex' ? next.at : ring[0];
      if (from && to) ring.push(...arc(t.center, t.radiusNm, from, to, t.clockwise));
    }
  }
  if (ring.length < 3) return null;
  const [first, last] = [ring[0], ring.at(-1)!];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return ring;
}

async function airspaces(): Promise<Feature[]> {
  const { html } = await fetchEnr('2.1');
  const features: Feature[] = [];
  let name = '';
  for (const [, id, row] of html.matchAll(/<tr[^>]*id="mid--([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (id.includes('TXT_NAME') && !row.includes('AIRSPACE_VERTEX')) {
      // « TMA AJACCIO TA : 5000 ft » → « TMA AJACCIO » (l'altitude de transition n'est pas utile sur la carte)
      name = stripTags(row).replace(/\s*TA\s*:.*$/, '');
      continue;
    }
    if (!row.includes('AIRSPACE_VERTEX.GEO_LAT') || !name) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    const ring = lateralLimits(cells[0] ?? row);
    if (!ring) continue;
    const type = /^(FIR|UIR|CTA|UTA|TMA|CTR|LTA)\b/.exec(name)?.[1] ?? 'OTHER';
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        name,
        type,
        class: field(row, 'AIRSPACE.CODE_CLASS'),
        upper: stripTags(/AIRSPACE\.VAL_DIST_VER_UPPER[^"]*"[^>]*>([^<]*)</.exec(row)?.[1] ?? ''),
        lower: stripTags(/AIRSPACE\.VAL_DIST_VER_LOWER[^"]*"[^>]*>([^<]*)</.exec(row)?.[1] ?? ''),
      },
    });
  }
  return features;
}

/** Aérodromes publiés en AD 2 dans l'eAIP (terrains dotés de procédures IFR, affichés différemment) */
async function aipAerodromes(): Promise<string[]> {
  const cycle = currentCycle();
  const iso = cycle.effective.toISOString().slice(0, 10);
  const res = await fetch(`${siaBase(cycle)}/FRANCE/AIRAC-${iso}/html/eAIP/FR-menu-fr-FR.html`, { headers: USER_AGENT });
  if (!res.ok) return [];
  return [...new Set((await res.text()).match(/FR-AD-2\.(LF[A-Z]{2})-fr-FR/g)?.map((m) => m.slice(8, 12)) ?? [])];
}

export async function buildAip() {
  const [nav, points, routes, spaces, aerodromes] = await Promise.all([
    navaids(),
    waypoints(),
    airways(),
    airspaces(),
    aipAerodromes(),
  ]);
  return { navaids: nav, waypoints: points, airways: routes, airspaces: spaces, aerodromes, cycle: currentCycle().ident };
}
