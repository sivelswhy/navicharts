// NOTAM d'un aérodrome, depuis SOFIA-Briefing (SIA / DGAC) : service public, sans compte, couvrant la France et
// l'étranger, avec traduction française. Données réutilisables sous Licence Ouverte Etalab 2.0 (source et date
// citées, contenu non altéré). On reproduit la requête « NOTAM aérodrome » du site, avec un cache pour le ménager.
const SOFIA = 'https://sofia-briefing.aviation-civile.gouv.fr';
const USER_AGENT = 'NaviCharts/0.1 (simulation de vol, usage personnel)';
const CACHE_MS = 10 * 60 * 1000;
// Après une erreur, nouvel essai possible plus tôt (sans solliciter le service en boucle)
const ERROR_CACHE_MS = 60 * 1000;
// Fenêtre du bulletin : 96 h, le maximum accepté (format HHMM)
const DURATION = '9600';

export interface Notam {
  id: string;
  /** Référence publiée, ex. « A1234/26 » */
  number: string;
  type: string;
  /** Rubrique du bulletin (aire de mouvement, procédures…) */
  category: string;
  start: string | null;
  /** null : permanent (PERM) */
  end: string | null;
  estimated: boolean;
  schedule: string | null;
  /** Texte original (champ E) et sa traduction française quand SOFIA la fournit */
  text: string;
  textFr: string | null;
  /** Limites verticales (champs F et G) */
  lower: string | null;
  upper: string | null;
}

export type NotamResult = { status: 'ok'; source: string; issued: string | null; notams: Notam[] } | { status: 'error'; message: string };

// Rubriques du bulletin SOFIA → libellés
const CATEGORIES: Record<string, string> = {
  aerodromes_services: 'Aérodrome et services',
  aire_mouvement: 'Aire de mouvement',
  aire_trafic: 'Aire de trafic',
  balisage: 'Balisage',
  aides_atter_instal_radionav_GNSS: 'Aides à l’atterrissage et radionavigation',
  procedures: 'Procédures',
  organisation_espace_services_circulation: 'Espace aérien et services ATS',
  meteorologie_equipements: 'Météorologie',
  reglementation_espace_aerien: 'Réglementation de l’espace aérien',
  avertissements_navigation: 'Avertissements à la navigation',
  obstacles: 'Obstacles',
  autres_info: 'Autres informations',
};

interface SofiaNotam {
  id: string;
  series: string;
  number: number;
  year: number;
  type: string;
  startValidity?: string;
  endValidity?: string;
  itemD?: string;
  itemE: string;
  itemF?: string;
  itemG?: string;
  multiLanguage?: { itemE?: string };
}

interface SofiaPib {
  dateProd?: string;
  issued?: string;
  listnotams: { AD: Record<string, unknown>[] };
}

// ───────── Session SOFIA ─────────

// Le service exige une session : on l'ouvre en chargeant la page de recherche, comme un navigateur
let session: Promise<string> | null = null;

function openSession(): Promise<string> {
  session ??= fetch(`${SOFIA}/sofia/pages/notamaero.html`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) })
    .then((res) => {
      if (!res.ok) throw new Error(`SOFIA : HTTP ${res.status}`);
      const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
      if (!cookies.length) throw new Error('SOFIA : session non ouverte');
      return cookies.join('; ');
    })
    .catch((err) => {
      session = null;
      throw err;
    });
  return session;
}

async function requestPib(icao: string, retry = true): Promise<SofiaPib> {
  const cookie = await openSession();
  const iso = new Date().toISOString();
  // Mêmes champs que le formulaire « NOTAM aérodrome » du site
  const res = await fetch(`${SOFIA}/sofia`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${SOFIA}/sofia/pages/notamsearchaero.html`,
      Cookie: cookie,
    },
    body: new URLSearchParams({
      ':operation': 'postAeroPibRequest',
      valid_from: iso.replace(/\.\d{3}Z$/, 'Z'),
      duration: DURATION,
      traffic: 'VI',
      'aero[]': icao,
      uuid: crypto.randomUUID(),
      isFromSofia: 'true',
      operation: 'postAeroPibRequest',
      target: '#aside-target',
      href: '/sofia/pages/notamaero.html',
      typeVol: 'A',
      departure_date: `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`,
      departure_time: iso.slice(11, 13) + iso.slice(14, 16),
      lang: 'fr',
      routeVal: 'false',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as { 'status.message'?: string } | null;
  let message: { cause?: string; message?: string } & Partial<SofiaPib> = {};
  try {
    message = JSON.parse(body?.['status.message'] ?? '{}');
  } catch {
    // message non JSON : traité comme une erreur ci-dessous
  }
  if (res.ok && message.listnotams) return message as SofiaPib;
  // Session expirée : on en rouvre une et on réessaie une fois
  if (retry && message.cause === 'refresh') {
    session = null;
    return requestPib(icao, false);
  }
  throw new Error(message.message ? `SOFIA : ${message.message}` : `SOFIA : HTTP ${res.status}`);
}

function toNotam(n: SofiaNotam, category: string): Notam {
  const end = n.endValidity ?? null;
  const iso = (v: string | null) => (v && /^\d{4}-/.test(v) ? v.replace(/EST$/i, '') : null);
  return {
    id: n.id,
    number: `${n.series}${String(n.number).padStart(4, '0')}/${String(n.year).padStart(2, '0')}`,
    type: n.type,
    category,
    start: iso(n.startValidity ?? null),
    end: end && /PERM/i.test(end) ? null : iso(end),
    estimated: Boolean(end && /EST/i.test(end)),
    schedule: n.itemD || null,
    text: n.itemE,
    textFr: n.multiLanguage?.itemE || null,
    lower: n.itemF || null,
    upper: n.itemG || null,
  };
}

const cache = new Map<string, { expires: number; result: NotamResult }>();

export async function getNotams(icao: string): Promise<NotamResult> {
  const hit = cache.get(icao);
  if (hit && Date.now() < hit.expires) return hit.result;
  let result: NotamResult;
  try {
    const pib = await requestPib(icao);
    const notams: Notam[] = [];
    for (const aerodrome of pib.listnotams.AD) {
      for (const [key, value] of Object.entries(aerodrome)) {
        if (!Array.isArray(value)) continue;
        for (const n of value as SofiaNotam[]) notams.push(toNotam(n, CATEGORIES[key] ?? 'Autres informations'));
      }
    }
    result = { status: 'ok', source: 'SIA – SOFIA-Briefing (Licence Ouverte Etalab 2.0)', issued: pib.issued ?? null, notams };
  } catch (err) {
    result = { status: 'error', message: err instanceof Error ? err.message : 'SOFIA indisponible' };
  }
  cache.set(icao, { expires: Date.now() + (result.status === 'ok' ? CACHE_MS : ERROR_CACHE_MS), result });
  return result;
}
