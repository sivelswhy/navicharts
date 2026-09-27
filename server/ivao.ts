// Trafic IVAO en direct (API publique « whazzup », mise à jour toutes les 15 s environ).
// L'API n'autorise pas les appels directs depuis le navigateur : on la relaie, avec un cache partagé pour ne pas
// l'interroger plus souvent que nécessaire, et une version allégée des données.
const WHAZZUP_URL = 'https://api.ivao.aero/v2/tracker/whazzup';
const MIN_INTERVAL_MS = 15_000;
const USER_AGENT = 'NaviCharts/0.1 (simulation de vol, usage personnel)';

interface WhazzupTrack {
  latitude: number;
  longitude: number;
  altitude: number;
  groundSpeed: number;
  heading: number;
  onGround: boolean;
  state: string;
  arrivalDistance: number | null;
}

interface WhazzupClient {
  id: number;
  userId: number;
  callsign: string;
  lastTrack?: WhazzupTrack;
  flightPlan?: {
    id: number;
    revision: number;
    aircraftId: string;
    departureId: string | null;
    arrivalId: string | null;
    route: string | null;
    speed: string | null;
    level: string | null;
    flightRules: string;
  } | null;
  atcSession?: { frequency: number; position: string };
  atis?: { lines: string[]; revision: string; timestamp: string } | null;
}

interface Whazzup {
  updatedAt: string;
  clients: { pilots: WhazzupClient[]; atcs: WhazzupClient[] };
}

export interface IvaoPilot {
  sessionId: number;
  vid: number;
  callsign: string;
  lat: number;
  lon: number;
  altitude: number;
  groundSpeed: number;
  heading: number;
  onGround: boolean;
  state: string;
  aircraft: string | null;
  departure: string | null;
  arrival: string | null;
  arrivalDistance: number | null;
}

export interface IvaoFlightPlan {
  id: number;
  revision: number;
  departure: string | null;
  arrival: string | null;
  route: string | null;
  speed: string | null;
  level: string | null;
  rules: string;
  aircraft: string;
}

export interface IvaoAtc {
  callsign: string;
  lat: number;
  lon: number;
  frequency: number;
  position: string;
}

let last: { at: number; data: Whazzup } | null = null;
let pending: Promise<Whazzup> | null = null;

async function whazzup(): Promise<Whazzup> {
  if (last && Date.now() - last.at < MIN_INTERVAL_MS) return last.data;
  pending ??= fetch(WHAZZUP_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`IVAO : HTTP ${res.status}`);
      const data = (await res.json()) as Whazzup;
      last = { at: Date.now(), data };
      return data;
    })
    .catch((err) => {
      // En cas d'indisponibilité, on garde les dernières données connues
      if (last) return last.data;
      throw err;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

function pilot(c: WhazzupClient): IvaoPilot | null {
  const t = c.lastTrack;
  if (!t) return null;
  return {
    sessionId: c.id,
    vid: c.userId,
    callsign: c.callsign,
    lat: t.latitude,
    lon: t.longitude,
    altitude: t.altitude,
    groundSpeed: t.groundSpeed,
    heading: t.heading,
    onGround: t.onGround,
    state: t.state,
    aircraft: c.flightPlan?.aircraftId ?? null,
    departure: c.flightPlan?.departureId ?? null,
    arrival: c.flightPlan?.arrivalId ?? null,
    arrivalDistance: t.arrivalDistance,
  };
}

/** Pilotes et contrôleurs connectés (données allégées pour l'affichage sur la carte) */
export async function getTraffic(): Promise<{ updatedAt: string; pilots: IvaoPilot[]; atcs: IvaoAtc[] }> {
  const data = await whazzup();
  return {
    updatedAt: data.updatedAt,
    pilots: data.clients.pilots.map(pilot).filter((p): p is IvaoPilot => p !== null),
    atcs: data.clients.atcs
      .filter((c) => c.lastTrack && c.atcSession)
      .map((c) => ({
        callsign: c.callsign,
        lat: c.lastTrack!.latitude,
        lon: c.lastTrack!.longitude,
        frequency: c.atcSession!.frequency,
        position: c.atcSession!.position,
      })),
  };
}

export interface IvaoAtis {
  callsign: string;
  frequency: number;
  position: string;
  letter: string;
  /** Texte de l'ATIS (sans la ligne technique du serveur vocal) */
  lines: string[];
  timestamp: string;
}

// Position dont on préfère l'ATIS quand plusieurs contrôleurs couvrent l'aérodrome
const ATIS_PRIORITY = ['TWR', 'APP', 'GND', 'DEL'];

/** ATIS diffusé par un contrôleur IVAO de l'aérodrome (callsign « LFPG_TWR »…), s'il y en a un */
export async function getAtis(icao: string): Promise<IvaoAtis | null> {
  const data = await whazzup();
  const stations = data.clients.atcs
    .filter((c) => c.callsign.startsWith(`${icao}_`) && c.atcSession && (c.atis?.lines.length ?? 0) > 1)
    .sort((a, b) => {
      const rank = (c: WhazzupClient) => {
        const i = ATIS_PRIORITY.indexOf(c.atcSession!.position);
        return i < 0 ? ATIS_PRIORITY.length : i;
      };
      return rank(a) - rank(b);
    });
  const c = stations[0];
  if (!c) return null;
  return {
    callsign: c.callsign,
    frequency: c.atcSession!.frequency,
    position: c.atcSession!.position,
    letter: c.atis!.revision,
    lines: c.atis!.lines.slice(1).map((l) => l.trim()).filter(Boolean),
    timestamp: c.atis!.timestamp,
  };
}

/** Session de vol en cours d'un membre (VID), avec son plan de vol déposé */
export async function getPilot(vid: number): Promise<{ updatedAt: string; pilot: IvaoPilot | null; flightPlan: IvaoFlightPlan | null }> {
  const data = await whazzup();
  const client = data.clients.pilots.find((c) => c.userId === vid);
  const fp = client?.flightPlan;
  return {
    updatedAt: data.updatedAt,
    pilot: client ? pilot(client) : null,
    flightPlan: fp
      ? {
          id: fp.id,
          revision: fp.revision,
          departure: fp.departureId,
          arrival: fp.arrivalId,
          route: fp.route,
          speed: fp.speed,
          level: fp.level,
          rules: fp.flightRules,
          aircraft: fp.aircraftId,
        }
      : null,
  };
}
