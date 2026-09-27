// METAR et ATIS IVAO des aérodromes, et décodage du METAR en clair (français).
import { useEffect, useState } from 'react';

export interface Metar {
  icao: string;
  raw: string;
  observed: string;
  category: string | null;
}

export interface IvaoAtis {
  callsign: string;
  frequency: number;
  position: string;
  letter: string;
  lines: string[];
  timestamp: string;
}

const METAR_REFRESH_MS = 5 * 60 * 1000;
const ATIS_REFRESH_MS = 60 * 1000;

/** METAR des aérodromes demandés, rafraîchis toutes les 5 minutes */
export function useMetars(icaos: string[]): Record<string, Metar> {
  const [metars, setMetars] = useState<Record<string, Metar>>({});
  const key = icaos.filter(Boolean).join(',');
  useEffect(() => {
    if (!key) {
      setMetars({});
      return;
    }
    let cancelled = false;
    const load = () =>
      fetch(`/api/metar?ids=${key}`)
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then(
          (data: { metars: Metar[] }) => !cancelled && setMetars(Object.fromEntries(data.metars.map((m) => [m.icao, m]))),
          () => undefined,
        );
    load();
    const timer = setInterval(load, METAR_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);
  return metars;
}

/** ATIS diffusé sur IVAO pour l'aérodrome, s'il y a un contrôleur en ligne */
export function useIvaoAtis(icao: string | null): IvaoAtis | null {
  const [atis, setAtis] = useState<IvaoAtis | null>(null);
  useEffect(() => {
    setAtis(null);
    if (!icao) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/ivao/atis/${icao}`)
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then(
          (data: { atis: IvaoAtis | null }) => !cancelled && setAtis(data.atis),
          () => undefined,
        );
    load();
    const timer = setInterval(load, ATIS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [icao]);
  return atis;
}

// ───────── Décodage ─────────

export interface DecodedLine {
  label: string;
  value: string;
}

const COVER: Record<string, string> = {
  FEW: 'Quelques nuages',
  SCT: 'Épars',
  BKN: 'Fragmentés',
  OVC: 'Couvert',
};

const INTENSITY: Record<string, string> = { '-': 'faible', '+': 'fort', VC: 'au voisinage' };

const DESCRIPTOR: Record<string, string> = {
  MI: 'mince',
  BC: 'en bancs',
  PR: 'partiel',
  DR: 'chasse basse',
  BL: 'chasse haute',
  SH: 'averses',
  TS: 'orage',
  FZ: 'se congelant',
};

const PHENOMENON: Record<string, string> = {
  DZ: 'bruine',
  RA: 'pluie',
  SN: 'neige',
  SG: 'neige en grains',
  IC: 'cristaux de glace',
  PL: 'granules de glace',
  GR: 'grêle',
  GS: 'grésil',
  UP: 'précipitations inconnues',
  BR: 'brume',
  FG: 'brouillard',
  FU: 'fumée',
  VA: 'cendres volcaniques',
  DU: 'poussière',
  SA: 'sable',
  HZ: 'brume sèche',
  PY: 'embruns',
  PO: 'tourbillons de poussière',
  SQ: 'grains',
  FC: 'trombe',
  SS: 'tempête de sable',
  DS: 'tempête de poussière',
};

const WIND = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/;
const WIND_VARIATION = /^(\d{3})V(\d{3})$/;
const VISIBILITY = /^(\d{4})(NDV)?$/;
const VISIBILITY_SM = /^(P)?(\d+(?:\/\d+)?)SM$/;
const RVR = /^R(\d{2}[LRC]?)\/([PM])?(\d{4})(?:V([PM])?(\d{4}))?(?:FT)?([UDN])?$/;
const WEATHER = /^(-|\+|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)+|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)?$/;
const CLOUD = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU)?$/;
const VERTICAL_VISIBILITY = /^VV(\d{3}|\/\/\/)$/;
const TEMPERATURE = /^(M?\d{2})\/(M?\d{2})?$/;

const temperature = (t: string) => `${t.startsWith('M') ? '−' : ''}${Number(t.replace('M', ''))} °C`;
const feet = (hundreds: string) => (hundreds === '///' ? 'hauteur inconnue' : `${(Number(hundreds) * 100).toLocaleString('fr-FR')} ft`);

function describeWeather(m: RegExpExecArray): string {
  const phenomena = m[3] ? (m[3].match(/../g) ?? []).map((c) => PHENOMENON[c] ?? c) : [];
  const parts: string[] = [];
  if (m[2] === 'SH') parts.push(`averses de ${phenomena.join(' et ') || 'précipitations'}`);
  else if (m[2] === 'TS') parts.push(phenomena.length ? `orage avec ${phenomena.join(' et ')}` : 'orage');
  else {
    parts.push(phenomena.join(' et '));
    if (m[2]) parts.push(DESCRIPTOR[m[2]]);
  }
  if (m[1]) parts.push(INTENSITY[m[1]]);
  const text = parts.filter(Boolean).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Traduction en clair d'un METAR (groupes principaux ; les remarques RMK ne sont pas interprétées) */
export function decodeMetar(raw: string): DecodedLine[] {
  const tokens = raw.trim().split(/\s+/);
  const lines: DecodedLine[] = [];
  const add = (label: string, value: string) => {
    const existing = lines.find((l) => l.label === label);
    if (existing) existing.value += ` · ${value}`;
    else lines.push({ label, value });
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'RMK') break;
    if (t === 'METAR' || t === 'SPECI' || t === 'COR' || /^[A-Z]{4}$/.test(t) && i <= 2) continue;
    if (/^\d{6}Z$/.test(t)) {
      add('Observation', `le ${Number(t.slice(0, 2))} à ${t.slice(2, 4)}:${t.slice(4, 6)} UTC`);
      continue;
    }
    if (t === 'AUTO') {
      add('Observation', 'station automatique');
      continue;
    }
    if (t === 'NOSIG') {
      add('Tendance', 'pas d’évolution significative prévue');
      continue;
    }
    if (t === 'TEMPO' || t === 'BECMG') {
      // Évolution prévue : les groupes suivants jusqu'à la fin sont repris tels quels
      const rest = tokens.slice(i + 1, tokens.indexOf('RMK') > i ? tokens.indexOf('RMK') : undefined).join(' ');
      add('Tendance', `${t === 'TEMPO' ? 'temporairement' : 'devenant'} ${rest}`);
      break;
    }
    if (t === 'CAVOK') {
      add('Visibilité', 'CAVOK : 10 km ou plus, pas de nuage significatif, pas de phénomène');
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = WIND.exec(t))) {
      const unit = m[4] === 'KT' ? 'kt' : m[4] === 'MPS' ? 'm/s' : 'km/h';
      const speed = Number(m[2]);
      const value =
        speed === 0 && m[1] !== 'VRB'
          ? 'calme'
          : `${m[1] === 'VRB' ? 'direction variable' : `${m[1]}°`}, ${speed} ${unit}${m[3] ? `, rafales ${Number(m[3])} ${unit}` : ''}`;
      add('Vent', value);
      continue;
    }
    if ((m = WIND_VARIATION.exec(t))) {
      add('Vent', `variable entre ${m[1]}° et ${m[2]}°`);
      continue;
    }
    if ((m = VISIBILITY.exec(t))) {
      add('Visibilité', m[1] === '9999' ? '10 km ou plus' : `${Number(m[1]).toLocaleString('fr-FR')} m`);
      continue;
    }
    if ((m = VISIBILITY_SM.exec(t))) {
      add('Visibilité', `${m[1] ? 'plus de ' : ''}${m[2]} mi terrestres`);
      continue;
    }
    if ((m = RVR.exec(t))) {
      const bound = (p: string | undefined) => (p === 'P' ? 'plus de ' : p === 'M' ? 'moins de ' : '');
      const trend = { U: ', en hausse', D: ', en baisse', N: ', stable' }[m[6] ?? ''] ?? '';
      const range = m[5] ? ` à ${bound(m[4])}${Number(m[5])} m` : '';
      add('RVR', `piste ${m[1]} : ${bound(m[2])}${Number(m[3])} m${range}${trend}`);
      continue;
    }
    if ((m = CLOUD.exec(t))) {
      add('Nuages', `${COVER[m[1]]} à ${feet(m[2])}${m[3] === 'CB' ? ' (cumulonimbus)' : m[3] === 'TCU' ? ' (cumulus bourgeonnants)' : ''}`);
      continue;
    }
    if ((m = VERTICAL_VISIBILITY.exec(t))) {
      add('Nuages', `ciel invisible, visibilité verticale ${feet(m[1])}`);
      continue;
    }
    if (t === 'NSC' || t === 'NCD' || t === 'SKC' || t === 'CLR') {
      add('Nuages', 'aucun nuage significatif');
      continue;
    }
    if ((m = TEMPERATURE.exec(t))) {
      add('Température', `${temperature(m[1])}${m[2] ? `, point de rosée ${temperature(m[2])}` : ''}`);
      continue;
    }
    if ((m = /^Q(\d{4})$/.exec(t))) {
      add('QNH', `${Number(m[1])} hPa`);
      continue;
    }
    if ((m = /^A(\d{4})$/.exec(t))) {
      const inHg = Number(m[1]) / 100;
      add('QNH', `${inHg.toFixed(2)} inHg (${Math.round(inHg * 33.8639)} hPa)`);
      continue;
    }
    if (t.length >= 2 && (m = WEATHER.exec(t)) && (m[2] || m[3])) {
      add('Temps présent', describeWeather(m));
      continue;
    }
    if (/^RE[A-Z]+$/.test(t)) {
      add('Temps récent', t.slice(2));
    }
  }
  return lines;
}

/** Âge d'une observation, en clair */
export function ageOf(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}
