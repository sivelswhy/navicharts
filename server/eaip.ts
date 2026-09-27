// Cartes d'aérodrome publiées dans les eAIP européens au format Eurocontrol.
// Pour chaque pays : on localise l'eAIP en vigueur, on cherche la page AD 2 de l'aérodrome dans le menu,
// puis on relève les liens PDF de la section AD 2.24 (cartes relatives à l'aérodrome).
// Seuls les liens vers les documents officiels sont conservés ; les PDF ne sont jamais stockés.
import { currentCycle, previousCycle } from './airac.ts';
import type { AirportCharts, Chart, ChartCategory } from './charts.ts';

const USER_AGENT = 'Mozilla/5.0 (compatible; NaviCharts/0.1; usage personnel)';

export interface EaipCountry {
  country: string;
  /** Préfixes OACI couverts */
  prefixes: string[];
  /** Hôte des documents (autorisé par le relais PDF) */
  host: string;
  /** URL du menu de l'eAIP en vigueur */
  menuUrl: () => Promise<string>;
}

async function fetchText(url: string): Promise<{ url: string; text: string } | null> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).hostname} : HTTP ${res.status}`);
  return { url: res.url || url, text: await res.text() };
}

// ───────── Localisation de l'eAIP en vigueur ─────────

/** eAIP publiée dans un dossier nommé d'après la date AIRAC (AAAA-MM-JJ) : cycle en vigueur, sinon précédent */
function byAiracDate(template: (iso: string) => string): () => Promise<string> {
  return async () => {
    const cycle = currentCycle();
    for (const c of [cycle, previousCycle(cycle)]) {
      const url = template(c.effective.toISOString().slice(0, 10));
      if (await fetchText(url)) return url;
    }
    throw new Error('eAIP en vigueur introuvable');
  };
}

/**
 * Page listant les éditions dans des dossiers datés (…_AAAA_MM_JJ/) : on retient la plus récente déjà en vigueur.
 * `menuPath` est le chemin du menu à l'intérieur du dossier.
 */
function byListing(listingUrl: string, menuPath: string): () => Promise<string> {
  return async () => {
    const page = await fetchText(listingUrl);
    if (!page) throw new Error('Liste des éditions introuvable');
    const today = new Date().toISOString().slice(0, 10);
    const editions = [...page.text.matchAll(/href=["']\s*([^"']*?(\d{4})_(\d{2})_(\d{2})[^"']*?)["']/g)]
      .map((m) => ({ href: m[1].trim(), date: `${m[2]}-${m[3]}-${m[4]}` }))
      .filter((e) => e.date <= today)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!editions.length) throw new Error('Aucune édition en vigueur');
    // Le lien peut viser un index.html : on garde le dossier
    const folder = new URL(editions[0].href.replace(/\\/g, '/').replace(/[^/]*\.html?$/, ''), page.url);
    if (!folder.pathname.endsWith('/')) folder.pathname += '/';
    return new URL(menuPath, folder).href;
  };
}

/** Adresse racine qui redirige vers l'édition en vigueur */
function byRedirect(rootUrl: string, menuPath: string): () => Promise<string> {
  return async () => {
    const page = await fetchText(rootUrl);
    if (!page) throw new Error('eAIP introuvable');
    return new URL(menuPath, page.url.endsWith('/') ? page.url : `${page.url}/`).href;
  };
}

export const EAIP_COUNTRIES: EaipCountry[] = [
  {
    country: 'Royaume-Uni',
    prefixes: ['EG'],
    host: 'www.aurora.nats.co.uk',
    menuUrl: byAiracDate((iso) => `https://www.aurora.nats.co.uk/htmlAIP/Publications/${iso}-AIRAC/html/eAIP/EG-menu-en-GB.html`),
  },
  {
    country: 'Estonie',
    prefixes: ['EE'],
    host: 'eaip.eans.ee',
    menuUrl: byRedirect('https://eaip.eans.ee/', 'eAIP/EE-menu-en-GB.html'),
  },
  {
    country: 'Finlande',
    prefixes: ['EF'],
    host: 'www.ais.fi',
    menuUrl: byListing('https://www.ais.fi/eaip/', 'eAIP/menu.html'),
  },
  {
    country: 'Islande',
    prefixes: ['BI'],
    host: 'eaip.isavia.is',
    menuUrl: byListing('https://eaip.avians.is/', 'eAIP/menu.html'),
  },
];

export function eaipCountryFor(icao: string): EaipCountry | undefined {
  return EAIP_COUNTRIES.find((c) => c.prefixes.some((p) => icao.startsWith(p)));
}

// ───────── Lecture des pages ─────────

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const text = (html: string) =>
  decodeEntities(html.replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const menuCache = new Map<string, Promise<string>>();

async function menu(url: string): Promise<string> {
  let entry = menuCache.get(url);
  if (!entry) {
    entry = fetchText(url).then((page) => {
      if (!page) throw new Error('Menu eAIP introuvable');
      return page.text;
    });
    entry.catch(() => menuCache.delete(url));
    menuCache.set(url, entry);
  }
  return entry;
}

/** Page AD 2 de l'aérodrome d'après le menu (version anglaise de préférence) */
function findAd2Page(menuHtml: string, menuUrl: string, icao: string): string | null {
  const hrefs = [...menuHtml.matchAll(/href=(["'])(.*?)\1/g)]
    .map((m) => decodeEntities(m[2]).split('#')[0])
    .filter((h) => h.includes(icao) && /AD[ -_.]?2?[ .-]/.test(h) && /\.html?$/i.test(h) && !h.includes('javascript'));
  if (!hrefs.length) return null;
  const best = hrefs.find((h) => /en-GB/i.test(h)) ?? hrefs[0];
  return new URL(best, menuUrl).href;
}

// Catégorie déduite de l'intitulé de la carte
// L'ordre compte : « RNAV HOLD CODING TABLES » est un tableau de codage, pas une approche
const CATEGORY_RULES: [RegExp, ChartCategory][] = [
  [/CODING|DATA TABLE|TABULAR|\bFAS ?DB\b|\bFASDB\b/, 'DATA'],
  [/VISUAL APPROACH|\bVAC\b|\bVFR\b/, 'VAC'],
  [/STANDARD DEPARTURE|\bSID\b|DEPARTURE CHART/, 'SID'],
  [/STANDARD ARRIVAL|\bSTAR\b|ARRIVAL CHART|INITIAL APPROACH/, 'STAR'],
  [/INSTRUMENT APPROACH|\bIAC\b|\bILS\b|\bLOC\b|\bRNP\b|\bRNAV\b|\bVOR\b|\bNDB\b|\bGNSS\b|APPROACH CHART/, 'APPROACH'],
  [/AERODROME CHART|\bADC\b|\bAPDC\b|\bA?GMC\b|\bAMG\b|\bMARK\b|GROUND MOVEMENT|PARKING|DOCKING|TAXI|APRON|HOT ?SPOT/, 'GROUND'],
];

/** « EF_AD_2_EFHK_APDC.pdf » → « APDC » : code de carte normalisé contenu dans le nom du fichier */
function fileCode(url: string, icao: string): string {
  const name = decodeURIComponent(url.split('/').pop() ?? '').replace(/\.pdf$/i, '');
  const afterIcao = name.split(new RegExp(`[_ -]${icao}[_ -]`, 'i'))[1] ?? name;
  return afterIcao.replace(/_en$/i, '').replace(/[_-]+/g, ' ').trim();
}

// Intitulés sans information (en-tête de colonne, rubrique)
const GENERIC_TITLE = /^(charts? pages?|charts?|pages?)$/i;

function categorize(title: string): ChartCategory {
  const t = title.toUpperCase();
  return CATEGORY_RULES.find(([re]) => re.test(t))?.[1] ?? 'OTHER';
}

/** Liens PDF de la section AD 2.24, avec leur intitulé (dans la ligne du tableau ou la précédente) */
export function parseAd2Charts(html: string, pageUrl: string, icao: string): Chart[] {
  const start = html.search(/AD[ -]?2[. -]24\b|AD 2\.24/);
  const end = start >= 0 ? html.slice(start + 10).search(/AD[ -]?2[. -]25\b/) : -1;
  const section = start >= 0 ? html.slice(start, end >= 0 ? start + 10 + end : undefined) : html;

  const charts: Chart[] = [];
  const seen = new Set<string>();
  let heading = '';
  for (const row of section.split(/<tr\b[^>]*>/i)) {
    const links = [...row.matchAll(/<a[^>]+href=(["'])([^"']+\.pdf)\1[^>]*>([\s\S]*?)<\/a>/gi)];
    const rowText = text(row.replace(/<a[^>]+href=(["'])[^"']+\.pdf\1[^>]*>[\s\S]*?<\/a>/gi, ' '));
    if (!links.length) {
      if (rowText) heading = rowText;
      continue;
    }
    for (const [, , href, inner] of links) {
      const url = new URL(decodeEntities(href), pageUrl).href;
      if (seen.has(url)) continue;
      seen.add(url);
      const label = text(inner);
      const code = fileCode(url, icao);
      const candidate = rowText.length > 3 ? rowText : heading;
      const base = candidate && !GENERIC_TITLE.test(candidate) ? candidate : code;
      // Plusieurs cartes sous un même intitulé : la référence du lien les distingue
      const title = [base, label && label !== base ? label : ''].filter(Boolean).join(' – ') || label || code;
      charts.push({
        id: `${icao}_${charts.length}_${url.split('/').pop()}`,
        title: title.slice(0, 160),
        // Le code du fichier (ADC, APDC, SID…) complète l'intitulé pour le classement
        category: categorize(`${title} ${code}`),
        url,
      });
    }
  }
  return charts;
}

const chartsCache = new Map<string, Promise<AirportCharts>>();

export function getEaipCharts(country: EaipCountry, icao: string): Promise<AirportCharts> {
  const key = `${currentCycle().ident}:${icao}`;
  let entry = chartsCache.get(key);
  if (!entry) {
    entry = (async () => {
      const menuUrl = await country.menuUrl();
      const page = findAd2Page(await menu(menuUrl), menuUrl, icao);
      const html = page ? await fetchText(page) : null;
      const cycle = currentCycle();
      return {
        icao,
        airac: cycle.ident,
        effective: cycle.effective.toISOString().slice(0, 10),
        charts: html ? parseAd2Charts(html.text, html.url, icao) : [],
        sourceUrl: page,
        provider: `eAIP ${country.country}`,
      };
    })();
    entry.catch(() => chartsCache.delete(key));
    chartsCache.set(key, entry);
  }
  return entry;
}
