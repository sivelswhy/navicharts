// Index des cartes publiées par le SIA : eAIP France métropolitaine, eAIP d'outre-mer (Antilles-Guyane-Saint-Pierre-et-
// Miquelon, Réunion-Mayotte, Nouvelle-Calédonie-Wallis-et-Futuna, Polynésie française) et atlas VAC (métropole).
// Seuls les liens vers les documents officiels sont conservés ; les PDF ne sont jamais stockés.
import { currentCycle, previousCycle, type AiracCycle } from './airac.ts';
import type { AirportCharts, Chart, ChartCategory } from './charts.ts';

export const SIA_HOST = 'www.sia.aviation-civile.gouv.fr';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Code du fichier SIA → catégorie affichée
const CATEGORY_BY_CODE: Record<string, ChartCategory> = {
  ADC: 'GROUND',
  APDC: 'GROUND',
  GMC: 'GROUND',
  AMG: 'GROUND',
  HOT: 'GROUND',
  SID: 'SID',
  STAR: 'STAR',
  IAC: 'APPROACH',
  DATA: 'DATA',
  // Outre-mer : carte d'approche et d'atterrissage à vue, publiée dans l'eAIP (pas d'atlas VAC)
  ATT: 'VAC',
};

const LABEL_BY_CODE: Record<string, string> = {
  ADC: "Carte d'aérodrome",
  APDC: 'Stationnement',
  GMC: 'Mouvements au sol',
  AMG: 'Mouvements au sol',
  HOT: 'Points chauds',
  AOC: "Obstacles d'aérodrome",
  PATC: 'Terrain de précision',
  COM: 'Communications',
  ENV: 'Environnement',
  ARC: 'Carte régionale',
  MSA: 'Altitudes minimales',
  DATA: 'Données de codage',
  ATT: 'Carte VAC (atterrissage à vue)',
  MVA: 'Altitudes minimales de guidage radar',
};

export function siaBase(cycle: AiracCycle): string {
  const d = cycle.effective;
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `https://${SIA_HOST}/media/dvd/eAIP_${day}_${MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`;
}

/** eAIP publiées par le SIA : même format de pages, chacune dans son dossier du « DVD » eAIP */
export interface SiaRegion {
  folder: string;
  name: string;
}
export const SIA_REGIONS: SiaRegion[] = [
  { folder: 'FRANCE', name: 'France métropolitaine' },
  { folder: 'CAR-SAM-NAM', name: 'Antilles, Guyane, Saint-Pierre-et-Miquelon' },
  { folder: 'RUN', name: 'Réunion, Mayotte et îles Éparses' },
  { folder: 'PAC-N', name: 'Nouvelle-Calédonie, Wallis-et-Futuna' },
  { folder: 'PAC-P', name: 'Polynésie française' },
];

/** Préfixes OACI des aérodromes publiés par le SIA (métropole et outre-mer) */
export const SIA_ICAO = /^(LF|TF|SO|FM|NW|NL|NT)[A-Z]{2}$/;

const regionDates = new Map<string, Promise<string | null>>();

/**
 * Racine d'une eAIP pour le cycle : la métropole suit chaque cycle AIRAC, l'outre-mer est publié moins souvent
 * (date lue dans sa page d'accueil : « init('RUN','2026','08','06',… ) »). null si l'eAIP n'est pas en ligne.
 */
export async function regionBase(cycle: AiracCycle, region: SiaRegion): Promise<string | null> {
  const base = `${siaBase(cycle)}/${region.folder}`;
  if (region.folder === 'FRANCE') return `${base}/AIRAC-${cycle.effective.toISOString().slice(0, 10)}`;
  const key = `${cycle.ident}:${region.folder}`;
  let date = regionDates.get(key);
  if (!date) {
    date = fetchText(`${base}/home.html`).then((html) => {
      const m = html && /init\('[^']*',\s*'(\d{4})',\s*'(\d{2})',\s*'(\d{2})'/.exec(html);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    });
    date.catch(() => regionDates.delete(key));
    regionDates.set(key, date);
  }
  const iso = await date;
  return iso ? `${base}/AIRAC-${iso}` : null;
}

const regionAerodromes = new Map<string, Promise<Set<string>>>();

/** Aérodromes publiés en AD 2 dans une eAIP (d'après son menu) */
export function aerodromesOf(cycle: AiracCycle, region: SiaRegion): Promise<Set<string>> {
  const key = `${cycle.ident}:${region.folder}`;
  let list = regionAerodromes.get(key);
  if (!list) {
    list = regionBase(cycle, region).then(async (base) => {
      const html = base ? await fetchText(`${base}/html/eAIP/FR-menu-fr-FR.html`) : null;
      return new Set(html?.match(/FR-AD-2\.[A-Z]{4}-fr-FR/g)?.map((m) => m.slice(8, 12)) ?? []);
    });
    list.catch(() => regionAerodromes.delete(key));
    regionAerodromes.set(key, list);
  }
  return list;
}

/** eAIP qui publie l'aérodrome (Saint-Pierre-et-Miquelon, LFVP, relève des Antilles) ; la métropole par défaut */
async function regionOf(cycle: AiracCycle, icao: string): Promise<SiaRegion> {
  for (const region of SIA_REGIONS.slice(1)) {
    if ((await aerodromesOf(cycle, region).catch(() => new Set<string>())).has(icao)) return region;
  }
  return SIA_REGIONS[0];
}

async function eaipPage(cycle: AiracCycle, icao: string): Promise<string | null> {
  const base = await regionBase(cycle, await regionOf(cycle, icao));
  return base && `${base}/html/eAIP/FR-AD-2.${icao}-fr-FR.html`;
}

function vacUrl(cycle: AiracCycle, icao: string): string {
  return `${siaBase(cycle)}/Atlas-VAC/PDF_AIPparSSection/VAC/AD/AD-2.${icao}.pdf`;
}

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { 'User-Agent': 'NaviCharts (usage personnel)' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SIA : HTTP ${res.status} pour ${url}`);
  return res.text();
}

/** "RWY08L_ILS_CAT123" → "RWY 08L ILS CAT123" */
function humanize(rest: string): string {
  return rest
    .replace(/_/g, ' ')
    .replace(/\bRWY ?(\d{2}[LRC]?)/g, 'RWY $1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseEaipCharts(html: string, icao: string, pageUrl: string): Chart[] {
  const seen = new Set<string>();
  const charts: Chart[] = [];
  const re = new RegExp(`href="(Cartes/${icao}/(AD_2_${icao}_([A-Z]+)_?([^"]*))\\.pdf)"`, 'g');
  for (const m of html.matchAll(re)) {
    const [, href, id, code, rest] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    const category = CATEGORY_BY_CODE[code] ?? 'OTHER';
    const label = LABEL_BY_CODE[code];
    const detail = humanize(rest);
    const title = label ? [label, detail].filter(Boolean).join(' – ') : [code, detail].filter(Boolean).join(' ');
    charts.push({ id, title, category, url: new URL(href, pageUrl).href });
  }
  return charts;
}

const vacListCache = new Map<string, Promise<Set<string>>>();

function vacAerodromes(cycle: AiracCycle): Promise<Set<string>> {
  let list = vacListCache.get(cycle.ident);
  if (!list) {
    list = fetchText(`${siaBase(cycle)}/Atlas-VAC/Javascript/AeroArraysVac.js`).then(
      (js) => new Set(js?.match(/LF[A-Z]{2}/g) ?? []),
    );
    list.catch(() => vacListCache.delete(cycle.ident));
    vacListCache.set(cycle.ident, list);
  }
  return list;
}

const ORDER: ChartCategory[] = ['VAC', 'GROUND', 'SID', 'STAR', 'APPROACH', 'OTHER', 'DATA'];

async function loadCharts(cycle: AiracCycle, icao: string): Promise<AirportCharts | null> {
  const pageUrl = await eaipPage(cycle, icao);
  const [html, vacList] = await Promise.all([pageUrl ? fetchText(pageUrl) : null, vacAerodromes(cycle)]);
  if (html === null && vacList.size === 0) return null; // cycle non publié

  const charts = html && pageUrl ? parseEaipCharts(html, icao, pageUrl) : [];
  if (vacList.has(icao)) {
    charts.unshift({ id: `VAC_${icao}`, title: 'Carte VAC (atlas VFR)', category: 'VAC', url: vacUrl(cycle, icao) });
  }
  charts.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));

  return {
    icao,
    airac: cycle.ident,
    effective: cycle.effective.toISOString().slice(0, 10),
    charts,
    sourceUrl: html ? pageUrl : null,
    provider: 'SIA',
  };
}

const chartsCache = new Map<string, Promise<AirportCharts>>();

export function getSiaCharts(icao: string): Promise<AirportCharts> {
  const cycle = currentCycle();
  const key = `${cycle.ident}:${icao}`;
  let entry = chartsCache.get(key);
  if (!entry) {
    // Si le SIA n'a pas encore mis en ligne le cycle en vigueur, on se rabat sur le précédent.
    entry = loadCharts(cycle, icao)
      .then((r) => r ?? loadCharts(previousCycle(cycle), icao))
      .then((r) => r ?? { icao, airac: cycle.ident, effective: '', charts: [], sourceUrl: null, provider: 'SIA' });
    entry.catch(() => chartsCache.delete(key));
    chartsCache.set(key, entry);
  }
  return entry;
}
