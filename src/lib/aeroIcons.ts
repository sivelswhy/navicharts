// Symboles aéronautiques inspirés des conventions OACI, dessinés en SVG puis chargés comme images MapLibre.
import type { Map as MapLibreMap } from 'maplibre-gl';

export const AERO_COLORS = {
  vor: '#1d5fa8',
  ndb: '#9c3f79',
  waypoint: '#2b4f73',
  ifr: '#1d5fa8',
  vfr: '#9c3f79',
  airway: '#7ea4c6',
  airwayLabel: '#35658f',
  airwayLower: '#2f6f9f',
  airwayUpper: '#7a4f9c',
  sid: '#1f7a4d',
  star: '#b4442c',
  approach: '#2d5fc4',
  restricted: '#c0392b',
  danger: '#d17a22',
  temporary: '#8a5bb0',
};

const SIZE = 32; // dessinés en 2x (affichés en 16 px)
const C = SIZE / 2;
const HOLDING = '#d0342c';

function svg(body: string, width = SIZE, height = SIZE): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function hexagon(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(C + r * Math.cos(a)).toFixed(2)},${(C + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

const dot = (color: string, r = 2) => `<circle cx="${C}" cy="${C}" r="${r}" fill="${color}"/>`;

// Trois blocs pleins sur un côté sur deux de l'hexagone (TACAN / VORTAC)
function tacanLobes(r: number, color: string): string {
  return [1, 3, 5]
    .map((i) => {
      const a1 = (Math.PI / 3) * i;
      const a2 = (Math.PI / 3) * (i + 1);
      const p = (a: number, k: number) => `${(C + k * Math.cos(a)).toFixed(2)},${(C + k * Math.sin(a)).toFixed(2)}`;
      return `<polygon points="${p(a1, r)} ${p(a2, r)} ${p(a2, r + 4)} ${p(a1, r + 4)}" fill="${color}"/>`;
    })
    .join('');
}

// Silhouette d'avion vue de dessus, nez vers le haut (orientée ensuite selon le cap)
const AIRCRAFT_PATH =
  'M16 2.5c1.1 0 1.8 1.2 1.8 2.6v7.3l10.2 6v2.6l-10.2-3.1v6.3l3.2 2.6v2.1L16 27.6l-5 1.3v-2.1l3.2-2.6v-6.3L4 21v-2.6l10.2-6V5.1c0-1.4.7-2.6 1.8-2.6z';

const ICONS: Record<string, string> = {
  // Trafic IVAO en bleu marine ; l'avion de l'utilisateur en jaune, pour le distinguer au premier coup d'œil
  aircraft: svg(`<path d="${AIRCRAFT_PATH}" fill="#1e3a8a" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`),
  'aircraft-ground': svg(`<path d="${AIRCRAFT_PATH}" fill="#7c8da6" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`),
  'aircraft-own': svg(`<path d="${AIRCRAFT_PATH}" fill="#f5b700" stroke="#1f1f1f" stroke-width="1.8" stroke-linejoin="round"/>`),
  atc: svg(
    `<circle cx="${C}" cy="${C}" r="9" fill="#fff" stroke="#0f766e" stroke-width="2.5"/>` +
      `<path d="M${C} 10v12M${C - 4} 22h8M${C - 5} 12a6 6 0 0 1 10 0" fill="none" stroke="#0f766e" stroke-width="2" stroke-linecap="round"/>`,
  ),
  vor: svg(`<polygon points="${hexagon(10)}" fill="#fff" stroke="${AERO_COLORS.vor}" stroke-width="2.5"/>${dot(AERO_COLORS.vor)}`),
  'vor-dme': svg(
    `<rect x="4" y="5" width="24" height="22" fill="#fff" stroke="${AERO_COLORS.vor}" stroke-width="2.2"/>` +
      `<polygon points="${hexagon(8.5)}" fill="none" stroke="${AERO_COLORS.vor}" stroke-width="2"/>${dot(AERO_COLORS.vor)}`,
  ),
  dme: svg(`<rect x="7" y="8" width="18" height="16" fill="#fff" stroke="${AERO_COLORS.vor}" stroke-width="2.5"/>${dot(AERO_COLORS.vor)}`),
  tacan: svg(
    `<polygon points="${hexagon(8.5)}" fill="#fff" stroke="${AERO_COLORS.vor}" stroke-width="2"/>${tacanLobes(8.5, AERO_COLORS.vor)}${dot(AERO_COLORS.vor)}`,
  ),
  ndb: svg(
    `<circle cx="${C}" cy="${C}" r="12.5" fill="none" stroke="${AERO_COLORS.ndb}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.1 3.6"/>` +
      `<circle cx="${C}" cy="${C}" r="8" fill="none" stroke="${AERO_COLORS.ndb}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.1 3.4"/>` +
      dot(AERO_COLORS.ndb, 3),
  ),
  waypoint: svg(`<polygon points="${C},7 26,25 6,25" fill="#fff" stroke="${AERO_COLORS.waypoint}" stroke-width="2.4" stroke-linejoin="round"/>`),
  'airport-ifr': svg(
    `<circle cx="${C}" cy="${C}" r="10" fill="#fff" stroke="${AERO_COLORS.ifr}" stroke-width="3.5"/>` +
      // Petites graduations autour du cercle, à la manière des symboles d'aérodromes équipés
      [0, 90, 180, 270]
        .map((d) => `<rect x="${C - 1.5}" y="1" width="3" height="5" fill="${AERO_COLORS.ifr}" transform="rotate(${d} ${C} ${C})"/>`)
        .join(''),
  ),
  'airport-vfr': svg(`<circle cx="${C}" cy="${C}" r="8.5" fill="#fff" stroke="${AERO_COLORS.vfr}" stroke-width="3"/>`),
  heliport: svg(
    `<circle cx="${C}" cy="${C}" r="10" fill="#fff" stroke="${AERO_COLORS.vfr}" stroke-width="2.5"/>` +
      `<text x="${C}" y="${C + 5}" font-family="Arial, sans-serif" font-weight="700" font-size="14" text-anchor="middle" fill="${AERO_COLORS.vfr}">H</text>`,
  ),
};

// Marquages de point d'attente, dessinés à l'horizontale (tournés sur la carte en travers du taxiway) :
// motif A (deux traits pleins, deux tirets) et motif B « échelle » des points d'attente ILS CAT II/III.
const HOLDING_W = 48;
const HOLDING_H = 16;
const HOLDING_ICONS: Record<string, string> = {
  holding: svg(
    `<rect x="2" y="2" width="44" height="2.5" fill="${HOLDING}"/><rect x="2" y="6" width="44" height="2.5" fill="${HOLDING}"/>` +
      `<line x1="2" y1="11" x2="46" y2="11" stroke="${HOLDING}" stroke-width="2.5" stroke-dasharray="5 3"/>` +
      `<line x1="2" y1="14.5" x2="46" y2="14.5" stroke="${HOLDING}" stroke-width="2.5" stroke-dasharray="5 3"/>`,
    HOLDING_W,
    HOLDING_H,
  ),
  'holding-ils': svg(
    `<rect x="2" y="3" width="44" height="2.5" fill="${HOLDING}"/><rect x="2" y="11" width="44" height="2.5" fill="${HOLDING}"/>` +
      Array.from({ length: 8 }, (_, i) => `<rect x="${3 + i * 5.7}" y="3" width="2.5" height="10" fill="${HOLDING}"/>`).join(''),
    HOLDING_W,
    HOLDING_H,
  ),
};

// Cartouches extensibles derrière les libellés (icon-text-fit) : panneau de taxiway, désignation de piste, nom de route
const LABEL_BOXES: Record<string, { fill: string; stroke: string }> = {
  'box-taxiway': { fill: '#f7c948', stroke: '#1f1f1f' },
  'box-runway': { fill: '#2b3440', stroke: '#2b3440' },
  'box-airway-lower': { fill: '#ffffff', stroke: '#2f6f9f' },
  'box-airway-upper': { fill: '#ffffff', stroke: '#7a4f9c' },
  'box-sid': { fill: '#ffffff', stroke: '#1f7a4d' },
  'box-star': { fill: '#ffffff', stroke: '#b4442c' },
};

// Rose des vents d'un VOR, nord magnétique en haut (orientée ensuite selon la déclinaison de la station) :
// graduations tous les 5°, caps tous les 30°, flèche vers le nord magnétique
export const VOR_ROSE = 'vor-rose';
const ROSE_SIZE = 512;
function roseSvg(): string {
  const c = ROSE_SIZE / 2;
  const r = 200;
  const color = AERO_COLORS.vor;
  const polar = (deg: number, k: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [(c + k * Math.cos(a)).toFixed(1), (c + k * Math.sin(a)).toFixed(1)];
  };
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const deg = i * 5;
    const len = deg % 30 === 0 ? 22 : deg % 10 === 0 ? 14 : 8;
    const [x1, y1] = polar(deg, r);
    const [x2, y2] = polar(deg, r - len);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${deg % 30 === 0 ? 3 : 2}"/>`;
  }).join('');
  // Caps en dizaines de degrés (03, 06…), le nord remplacé par la flèche
  const labels = Array.from({ length: 11 }, (_, i) => {
    const deg = (i + 1) * 30;
    const [x, y] = polar(deg, r - 42);
    return `<text x="${x}" y="${y}" transform="rotate(${deg} ${x} ${y})">${String(deg / 10).padStart(2, '0')}</text>`;
  }).join('');
  const [tipX, tipY] = polar(0, r + 46);
  const [baseY] = [(c - r + 4).toFixed(1)];
  return svg(
    `<g stroke="${color}" stroke-linecap="round" fill="none" opacity="0.85">` +
      `<circle cx="${c}" cy="${c}" r="${r}" stroke-width="2.5"/>${ticks}</g>` +
      `<g fill="${color}" opacity="0.85" font-family="Inter, Helvetica, Arial, sans-serif" font-size="22" font-weight="600" text-anchor="middle" dominant-baseline="central">${labels}</g>` +
      // Flèche du nord magnétique, depuis le cercle vers l'extérieur
      `<line x1="${c}" y1="${baseY}" x2="${c}" y2="${(c - r - 30).toFixed(1)}" stroke="${color}" stroke-width="4"/>` +
      `<polygon points="${tipX},${tipY} ${c - 13},${c - r - 18} ${c + 13},${c - r - 18}" fill="${color}"/>` +
      `<text x="${c}" y="${c - r + 42}" fill="${color}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="24" font-weight="700" text-anchor="middle" dominant-baseline="central">N</text>`,
    ROSE_SIZE,
    ROSE_SIZE,
  );
}

/** Type de balise (eAIP ou OurAirports) → nom d'icône */
export const NAVAID_ICON = [
  'match',
  ['get', 'type'],
  ['VOR'], 'vor',
  ['VOR-DME', 'VORDME'], 'vor-dme',
  ['DME'], 'dme',
  ['TACAN', 'VORTAC'], 'tacan',
  ['NDB', 'NDB-DME'], 'ndb',
  'vor',
] as const;

export type AeroIcon = keyof typeof ICONS;

/** URL de données d'un symbole (légende) */
export function aeroIconUrl(name: AeroIcon): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ICONS[name])}`;
}

async function loadSvg(markup: string, width: number, height: number): Promise<HTMLImageElement> {
  const img = new Image(width, height);
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await img.decode();
  return img;
}

export async function loadAeroIcons(map: MapLibreMap): Promise<void> {
  await Promise.all([
    (async () => {
      if (!map.hasImage(VOR_ROSE)) map.addImage(VOR_ROSE, await loadSvg(roseSvg(), ROSE_SIZE, ROSE_SIZE), { pixelRatio: 2 });
    })(),
    ...(Object.keys(ICONS) as AeroIcon[]).map(async (name) => {
      if (!map.hasImage(name)) map.addImage(name, await loadSvg(ICONS[name], SIZE, SIZE), { pixelRatio: 2 });
    }),
    ...Object.entries(HOLDING_ICONS).map(async ([name, markup]) => {
      if (!map.hasImage(name)) map.addImage(name, await loadSvg(markup, HOLDING_W, HOLDING_H), { pixelRatio: 2 });
    }),
    ...Object.entries(LABEL_BOXES).map(async ([name, { fill, stroke }]) => {
      const markup = svg(`<rect x="1.5" y="1.5" width="29" height="29" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      if (!map.hasImage(name)) {
        map.addImage(name, await loadSvg(markup, SIZE, SIZE), {
          pixelRatio: 2,
          stretchX: [[8, 24]],
          stretchY: [[8, 24]],
          content: [6, 5, 26, 27],
        });
      }
    }),
  ]);
}
