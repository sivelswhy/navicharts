// Tracks de l'Atlantique Nord (NAT OTS), d'après les messages publiés par la FAA (NMS), avec un cache court.
const API = 'https://nms.aim.faa.gov/datanat/nat.json';
const CACHE_MS = 15 * 60 * 1000;
const USER_AGENT = 'NaviCharts/0.1 (simulation de vol, usage personnel)';

/** Point d'un track : point nommé (à situer côté client) ou coordonnées, avec leur écriture dans le message (56/20) */
export type NatPoint = { ident: string } | { lngLat: [number, number]; token: string };

export interface NatTrack {
  /** Lettre du track (A, B… à l'ouest, Z, Y… à l'est) */
  letter: string;
  points: NatPoint[];
  /** Niveaux de vol ouverts vers l'est et vers l'ouest (340, 350…) */
  eastLevels: number[];
  westLevels: number[];
  /** Routes de raccordement nord-américaines (NAR) */
  nar: string[];
  validFrom: string;
  validTo: string;
  /** Identifiant du message (EGGX0928/26) et centre émetteur (EGGX Shanwick, CZQX Gander) */
  message: string;
  source: string;
  /** Numéro du TMI (Track Message Identification) */
  tmi: string | null;
  /** Remarques du message, communes à tous ses tracks */
  remarks: string[];
}

interface Row {
  notam_number_formatted: string;
  icao_id: string;
  condition_message: string;
  start_datetime: string;
  end_datetime: string;
  part_no: number;
  transaction_type: string;
}

let cache: { at: number; tracks: NatTrack[] } | null = null;

/** « 56/20 » → 56° N 20° W, « 5530/20 » → 55° 30′ N 20° W */
function coordinate(token: string): [number, number] | null {
  const m = token.match(/^(\d{2})(\d{2})?\/(\d{2,3})(\d{2})?$/);
  if (!m) return null;
  const lat = Number(m[1]) + Number(m[2] ?? 0) / 60;
  const lon = Number(m[3]) + Number(m[4] ?? 0) / 60;
  return [-lon, lat];
}

const levels = (line: string | undefined) =>
  (line ?? '')
    .replace(/^(EAST|WEST) LVLS\s*/, '')
    .split(/\s+/)
    .filter((t) => /^\d{3}$/.test(t))
    .map(Number);

function parseMessage(text: string, row: Row): NatTrack[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/-$/, ''));
  const tmi = text.match(/TMI IS (\d+)/)?.[1] ?? null;
  // Remarques numérotées, après « REMARKS. » et hors marques de découpage du message
  const remarks: string[] = [];
  const start = lines.findIndex((l) => /^REMARKS\.?$/.test(l));
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (!l || /^END OF PART|^PART .* PARTS$|^NAT-\d/.test(l)) continue;
      if (/^\d+\. /.test(l) || !remarks.length) remarks.push(l);
      else remarks[remarks.length - 1] += ` ${l}`;
    }
  }
  const tracks: NatTrack[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Z]) ((?:[A-Z]{2,5}|\d{2,4}\/\d{2,5})(?: (?:[A-Z]{2,5}|\d{2,4}\/\d{2,5}))+)$/);
    if (!m || !lines[i + 1]?.startsWith('EAST LVLS')) continue;
    const points: NatPoint[] = m[2].split(' ').map((t) => {
      const c = coordinate(t);
      return c ? { lngLat: c, token: t } : { ident: t };
    });
    const after = lines.slice(i + 1, i + 6);
    tracks.push({
      letter: m[1],
      points,
      eastLevels: levels(after.find((l) => l.startsWith('EAST LVLS'))),
      westLevels: levels(after.find((l) => l.startsWith('WEST LVLS'))),
      nar: (after.find((l) => l.startsWith('NAR'))?.replace(/^NAR\s*/, '') ?? '').split(/\s+/).filter((t) => t && t !== 'NIL'),
      validFrom: row.start_datetime,
      validTo: row.end_datetime,
      message: row.notam_number_formatted,
      source: row.icao_id,
      tmi,
      remarks,
    });
  }
  return tracks;
}

/** Tracks en vigueur ou à venir */
export async function getNatTracks(): Promise<NatTrack[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tracks;
  const res = await fetch(API, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`NAT : HTTP ${res.status}`);
  const rows = ((await res.json()) as Row[]).filter((r) => r.transaction_type === 'NAT_TRACK');

  // Un message est publié en plusieurs parties : on les recolle dans l'ordre
  const messages = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.notam_number_formatted} ${r.start_datetime}`;
    messages.set(key, [...(messages.get(key) ?? []), r]);
  }
  const now = Date.now();
  const tracks = [...messages.values()].flatMap((parts) => {
    parts.sort((a, b) => a.part_no - b.part_no);
    if (new Date(parts[0].end_datetime).getTime() < now) return [];
    return parseMessage(parts.map((p) => p.condition_message).join('\n'), parts[0]);
  });
  cache = { at: Date.now(), tracks };
  return tracks;
}
