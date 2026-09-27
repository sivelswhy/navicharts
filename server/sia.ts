// Index des cartes publiées par le SIA (eAIP France + atlas VAC).
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
};

export function siaBase(cycle: AiracCycle): string {
  const d = cycle.effective;
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `https://${SIA_HOST}/media/dvd/eAIP_${day}_${MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`;
}

function eaipPage(cycle: AiracCycle, icao: string): string {
  const iso = cycle.effective.toISOString().slice(0, 10);
  return `${siaBase(cycle)}/FRANCE/AIRAC-${iso}/html/eAIP/FR-AD-2.${icao}-fr-FR.html`;
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
  const pageUrl = eaipPage(cycle, icao);
  const [html, vacList] = await Promise.all([fetchText(pageUrl), vacAerodromes(cycle)]);
  if (html === null && vacList.size === 0) return null; // cycle non publié

  const charts = html ? parseEaipCharts(html, icao, pageUrl) : [];
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
