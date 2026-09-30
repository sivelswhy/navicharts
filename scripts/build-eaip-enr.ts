// Routes ATS (ENR 3.1 à 3.3) et points significatifs (ENR 4.4) des eAIP au format Eurocontrol
// (Royaume-Uni, Estonie, Corée du Sud, Taïwan, Thaïlande, Israël…). La lecture s'appuie sur la structure standard des tableaux de ces eAIP :
// désignateur de route (classe « Route-designator »), lignes de points (Table-row-type-2) et lignes de
// tronçons (Table-row-type-3, avec limites supérieure et inférieure).
import { EAIP_COUNTRIES } from '../server/eaip.ts';

type Position = [number, number];
type Feature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };

const USER_AGENT = { 'User-Agent': 'Mozilla/5.0 (compatible; NaviCharts/0.1; usage personnel)' };
// Sections lues : routes conventionnelles, ATS et RNAV, puis points significatifs
// « KR-ENR-3.1-en-GB.html », ou une page par route : « RC-ENR 3.1 A1-en-GB.html » (Taïwan)
const ENR_PAGE = /ENR[- ](3\.[123]|4\.4)( [^/]*)?-en-GB\.html$/;
const WAYPOINT_PAGE = /ENR[- ]4\.4/;

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

// Les champs AIXM cachés (sdParams, display:none) sont retirés avant de lire le texte
const text = (html: string) =>
  decodeEntities(html.replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// « 503011.88N 0032833.64W » ou « 592724N 0280558E »
const COORDINATES = /(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])/;

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function coordinates(value: string): Position | null {
  const m = COORDINATES.exec(value);
  if (!m) return null;
  const lat = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  const lon = Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600;
  return [round(m[8] === 'W' ? -lon : lon), round(m[4] === 'S' ? -lat : lat)];
}

/** « FL 460 », « 5000 FT ALT », « UNL »… → niveau de vol approximatif */
function flightLevel(value: string | undefined): number | null {
  if (!value) return null;
  if (/UNL/i.test(value)) return 999;
  const fl = /FL\s*(\d+)/i.exec(value);
  if (fl) return Number(fl[1]);
  const ft = /(\d+)\s*ft/i.exec(value);
  return ft ? Math.round(Number(ft[1]) / 100) : null;
}

/** Découpe en lignes de tableau de la classe donnée (les tableaux imbriqués restent dans la ligne) */
function rows(html: string, rowClass: RegExp): { type: string; html: string }[] {
  const result: { type: string; html: string }[] = [];
  let current: { type: string; html: string } | null = null;
  for (const part of html.split(/<tr\b/).slice(1)) {
    const cls = /^[^>]*class="([^"]*)"/.exec(part)?.[1] ?? '';
    if (/Table-row-type/.test(cls)) {
      const m = rowClass.exec(cls);
      current = m ? { type: m[1] ?? m[0], html: part } : null;
      if (current) result.push(current);
    } else if (current) {
      // Ligne d'un tableau imbriqué : rattachée à la ligne englobante
      current.html += `<tr${part}`;
    }
  }
  return result;
}

/** Identifiant d'un point de route : code entre parenthèses (balise) ou nom-code à 5 lettres */
function pointIdent(label: string): string | null {
  const code = /\(\s*([A-Z0-9]{2,5})\s*\)/.exec(label)?.[1];
  if (code) return code;
  const words = label.split(' ').filter((w) => /^[A-Z0-9]{2,5}$/.test(w));
  return words.at(-1) ?? null;
}

interface RoutePoint {
  ident: string | null;
  at: Position;
}

function parseRoutes(html: string): { airways: Feature[]; points: RoutePoint[] } {
  const airways: Feature[] = [];
  const points: RoutePoint[] = [];
  for (const chunk of html.split(/class="Route-designator/).slice(1)) {
    const name = text(chunk.slice(chunk.indexOf('>') + 1, chunk.indexOf('</p>'))).split(' ')[0];
    if (!/^[A-Z]{1,2}\d{1,4}[A-Z]?$/.test(name)) continue;
    let previous: RoutePoint | null = null;
    let lower: number | null = null;
    let upper: number | null = null;
    for (const row of rows(chunk, /Table-row-type-([23])/)) {
      if (row.type === '3') {
        // Première valeur « Upper »/« Lower » exprimée en niveau ou altitude (les autres sont des routes magnétiques)
        const level = (cls: string) =>
          [...row.html.matchAll(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</td>`, 'g'))]
            .map((m) => text(m[1]))
            .find((v) => /FL|FT|UNL|GND|SFC/i.test(v));
        upper = flightLevel(level('Upper')) ?? upper;
        lower = flightLevel(level('Lower')) ?? lower;
        continue;
      }
      const label = text(row.html);
      const at = coordinates(label);
      if (!at) continue;
      const here: RoutePoint = { ident: pointIdent(label.slice(0, COORDINATES.exec(label)!.index)), at };
      points.push(here);
      if (previous) {
        airways.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [previous.at, here.at] },
          properties: { name, lowerFl: lower, upperFl: upper, from: previous.ident, to: here.ident },
        });
      }
      previous = here;
      lower = upper = null;
    }
  }
  return { airways, points };
}

function parseWaypoints(html: string): Feature[] {
  const features: Feature[] = [];
  for (const part of html.split(/<tr\b/).slice(1)) {
    const ident = /^[^>]*id="SP-([A-Z0-9]{2,5})"/.exec(part)?.[1];
    const at = ident ? coordinates(text(part)) : null;
    if (ident && at) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { ident } });
  }
  return features;
}

/**
 * Mise en page sans les classes Eurocontrol (Taïwan) : une page par route, nommée d'après elle (« RC-ENR 3.1 A1 »),
 * dont les lignes de points portent l'identifiant du point (« BULANrow2 ») ; en ENR 4.4, « ABSOLENR44 »
 */
function parsePlainRoute(html: string, url: string): { airways: Feature[]; points: RoutePoint[] } {
  const name = /ENR[- ]3\.[123] ([A-Z]{1,2}\d{1,4}[A-Z]?)\b/.exec(decodeURIComponent(url))?.[1];
  const airways: Feature[] = [];
  const points: RoutePoint[] = [];
  if (!name) return { airways, points };
  let previous: RoutePoint | null = null;
  for (const [, ident, row] of html.matchAll(/<tr\b[^>]*\bid="([A-Z0-9]{2,5})row\d+"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const at = coordinates(text(row));
    if (!at) continue;
    const here: RoutePoint = { ident, at };
    points.push(here);
    if (previous) {
      airways.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [previous.at, at] }, properties: { name, lowerFl: null, upperFl: null, from: previous.ident, to: ident } });
    }
    previous = here;
  }
  return { airways, points };
}

function parsePlainWaypoints(html: string): Feature[] {
  const features: Feature[] = [];
  for (const [, ident, row] of html.matchAll(/<tr\b[^>]*\bid="([A-Z0-9]{2,5})ENR44"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const at = coordinates(text(row));
    if (at) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { ident } });
  }
  return features;
}

async function country(menuUrl: string): Promise<{ airways: Feature[]; waypoints: Feature[] }> {
  const menu = await (await fetch(menuUrl, { headers: USER_AGENT })).text();
  // Paramètre de version (« ?ver=20250728 », Corée) retiré
  const pages = [...new Set([...menu.matchAll(/href=["']([^"'#?]+)/g)].map((m) => new URL(m[1], menuUrl).href))].filter((u) =>
    ENR_PAGE.test(decodeURIComponent(u)),
  );
  const airways: Feature[] = [];
  const waypoints: Feature[] = [];
  const routePoints: RoutePoint[] = [];
  for (const url of pages) {
    const res = await fetch(url, { headers: USER_AGENT });
    if (!res.ok) continue;
    const html = await res.text();
    const plain = !html.includes('Route-designator') && !html.includes('id="SP-');
    if (WAYPOINT_PAGE.test(decodeURIComponent(url))) waypoints.push(...(plain ? parsePlainWaypoints(html) : parseWaypoints(html)));
    else {
      const routes = plain ? parsePlainRoute(html, url) : parseRoutes(html);
      airways.push(...routes.airways);
      routePoints.push(...routes.points);
    }
  }
  // Points à 5 lettres des routes absents d'ENR 4.4 (ex. points frontière)
  const known = new Set(waypoints.map((f) => f.properties.ident));
  for (const p of routePoints) {
    if (!p.ident || p.ident.length !== 5 || known.has(p.ident)) continue;
    known.add(p.ident);
    waypoints.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.at }, properties: { ident: p.ident } });
  }
  return { airways, waypoints };
}

/** Routes et points des eAIP au format Eurocontrol (hors France, lue à part) */
export async function buildEaipEnr(): Promise<{ airways: Feature[]; waypoints: Feature[]; countries: string[] }> {
  const results = await Promise.all(
    EAIP_COUNTRIES.map(async (c) => {
      try {
        const data = await country(await c.menuUrl());
        // Hors d'Europe : marqué pour rester affiché en dev, où autorouter remplace nos données européennes
        if (c.outsideEurope) for (const f of [...data.airways, ...data.waypoints]) f.properties.source = 'eAIP hors Europe';
        return { name: c.country, ...data };
      } catch (err) {
        console.warn(`⚠ eAIP ${c.country} : ${(err as Error).message}`);
        return { name: c.country, airways: [], waypoints: [] };
      }
    }),
  );
  const found = results.filter((r) => r.airways.length || r.waypoints.length);
  for (const r of found) console.log(`  eAIP ${r.name} : ${r.airways.length} tronçons, ${r.waypoints.length} points`);
  return {
    airways: found.flatMap((r) => r.airways),
    waypoints: found.flatMap((r) => r.waypoints),
    countries: found.map((r) => r.name),
  };
}
