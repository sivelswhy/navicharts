// Calage automatique des cartes SIA à partir des graduations en latitude/longitude imprimées sur le cadre.
//
// Les PDF du SIA utilisent des polices sans table Unicode, mais chaque glyphe porte un nom « MTnn » où nn est
// le code du caractère (Latin-1/CP1252). On retrouve donc le texte en relisant le code d'origine de chaque glyphe.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const R = 6378137;
const toMercX = (lon: number) => (R * lon * Math.PI) / 180;
const toMercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const fromMerc = (x: number, y: number): [number, number] => [
  (x / R) * (180 / Math.PI),
  (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI),
];

// Emprise plausible (Europe) pour filtrer les faux positifs
const LAT_RANGE = [34, 72];
const LON_RANGE = [-32, 45];

const CP1252: Record<number, string> = { 145: '‘', 146: '’', 147: '“', 148: '”', 150: '–', 151: '—', 176: '°' };

interface Glyph {
  originalCharCode: number;
  unicode: string;
  width: number;
  isSpace: boolean;
}

interface Line {
  text: string;
  /** Matrice de rendu du texte en espace page [a, b, c, d, e, f] au début de la ligne */
  transform: number[];
  /** Longueur de la ligne et taille du texte, en points */
  width: number;
  height: number;
}

export interface GeorefResult {
  /** Points de contrôle synthétiques (coins de la page) reproduisant la transformation calculée */
  points: { pdf: [number, number]; lngLat: [number, number] }[];
  rmsMeters: number;
  graduations: number;
}

// ───────── Lecture du texte ─────────

type FontLike = { differences?: (string | undefined)[] };
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** pdf.js transmet les matrices sous forme de tableau ou de Float32Array */
function asMatrix(v: unknown): Matrix | null {
  if ((Array.isArray(v) || ArrayBuffer.isView(v)) && (v as ArrayLike<number>).length === 6) {
    return Array.from(v as ArrayLike<number>) as Matrix;
  }
  return null;
}

/** Produit m × n au sens PDF (m appliquée d'abord) */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function decodeGlyph(font: FontLike | undefined, g: Glyph): string {
  const name = font?.differences?.[g.originalCharCode];
  const m = name && /^MT(\d+)$/.exec(name);
  if (m) {
    const code = Number(m[1]);
    return CP1252[code] ?? String.fromCharCode(code);
  }
  return g.unicode;
}

interface TextState {
  ctm: Matrix;
  font: FontLike | undefined;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
}

/** Segment de droite court (candidat trait de graduation), en espace page */
interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const TICK_MIN_PT = 1.5;
const TICK_MAX_PT = 30;

// Codes des commandes de tracé transmises par pdf.js (DrawOPS)
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUAD_TO = 3;
const CLOSE_PATH = 4;

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Rejoue les opérateurs de la page pour obtenir chaque fragment de texte avec son code de glyphe d'origine
 * et sa position exacte (l'extraction de texte de pdf.js confond certains codes avec des espaces),
 * ainsi que les segments courts susceptibles d'être des traits de graduation.
 */
async function readPage(page: pdfjs.PDFPageProxy): Promise<{ lines: Line[]; segments: Segment[] }> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const fragments: Line[] = [];
  const segments: Segment[] = [];
  const stack: TextState[] = [];
  let st: TextState = { ctm: IDENTITY, font: undefined, size: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0 };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;

  const renderMatrix = (): Matrix => mul(mul([st.size * st.hScale, 0, 0, st.size, 0, st.rise], tm), st.ctm);
  const moveText = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };

  const addPath = (path: ArrayLike<number>) => {
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    const segment = (x: number, y: number) => {
      const [x1, y1] = apply(st.ctm, cx, cy);
      const [x2, y2] = apply(st.ctm, x, y);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len >= TICK_MIN_PT && len <= TICK_MAX_PT) segments.push({ x1, y1, x2, y2 });
    };
    for (let i = 0; i < path.length; ) {
      switch (path[i]) {
        case MOVE_TO:
          cx = sx = path[i + 1];
          cy = sy = path[i + 2];
          i += 3;
          break;
        case LINE_TO:
          segment(path[i + 1], path[i + 2]);
          cx = path[i + 1];
          cy = path[i + 2];
          i += 3;
          break;
        case CURVE_TO:
          cx = path[i + 5];
          cy = path[i + 6];
          i += 7;
          break;
        case QUAD_TO:
          cx = path[i + 3];
          cy = path[i + 4];
          i += 5;
          break;
        case CLOSE_PATH:
          cx = sx;
          cy = sy;
          i += 1;
          break;
        default:
          return; // format inattendu : on ignore le reste du tracé
      }
    }
  };

  const show = (items: (Glyph | number)[]) => {
    let start = renderMatrix();
    let text = '';
    const flush = () => {
      if (text) {
        const end = renderMatrix();
        const [ux, uy] = direction(start);
        fragments.push({
          text,
          transform: start,
          width: (end[4] - start[4]) * ux + (end[5] - start[5]) * uy,
          height: Math.hypot(start[2], start[3]),
        });
      }
      text = '';
    };
    for (const g of items) {
      if (typeof g === 'number') {
        // Un grand décalage sépare des libellés distincts dessinés par une même instruction
        if (-g > 800) flush();
        tm = mul([1, 0, 0, 1, (-g / 1000) * st.size * st.hScale, 0], tm);
        if (!text) start = renderMatrix();
        continue;
      }
      if (!g) continue;
      text += decodeGlyph(st.font, g);
      const tx = ((g.width / 1000) * st.size + st.charSpacing + (g.isSpace ? st.wordSpacing : 0)) * st.hScale;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
    flush();
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as any[];
    switch (fn) {
      case OPS.save:
        stack.push({ ...st });
        break;
      case OPS.restore:
        st = stack.pop() ?? st;
        break;
      case OPS.transform: {
        const m = asMatrix(args);
        if (m) st.ctm = mul(m, st.ctm);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...st });
        const form = asMatrix(args[0]);
        if (form) st.ctm = mul(form, st.ctm);
        break;
      }
      case OPS.paintFormXObjectEnd:
        st = stack.pop() ?? st;
        break;
      case OPS.beginText:
        tm = tlm = IDENTITY;
        break;
      case OPS.setFont:
        st.font = page.commonObjs.has(args[0]) ? (page.commonObjs.get(args[0]) as FontLike) : undefined;
        st.size = args[1];
        break;
      case OPS.setTextMatrix: {
        const m = asMatrix(args[0]) ?? asMatrix(args);
        if (m) tm = tlm = m;
        break;
      }
      case OPS.moveText:
        moveText(args[0], args[1]);
        break;
      case OPS.setLeadingMoveText:
        st.leading = -args[1];
        moveText(args[0], args[1]);
        break;
      case OPS.nextLine:
        moveText(0, -st.leading);
        break;
      case OPS.setLeading:
        st.leading = args[0];
        break;
      case OPS.setCharSpacing:
        st.charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = args[0];
        break;
      case OPS.setHScale:
        st.hScale = args[0] / 100;
        break;
      case OPS.setTextRise:
        st.rise = args[0];
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        show(args[0]);
        break;
      case OPS.constructPath:
        for (const path of (args[1] ?? []) as unknown[]) {
          if (path && (Array.isArray(path) || ArrayBuffer.isView(path))) addPath(path as ArrayLike<number>);
        }
        break;
      case OPS.nextLineShowText:
        moveText(0, -st.leading);
        show(args[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        st.wordSpacing = args[0];
        st.charSpacing = args[1];
        moveText(0, -st.leading);
        show(args[2]);
        break;
    }
  }

  // Regroupement des fragments consécutifs sur une même ligne (ex. « 002° » puis « 30’ »)
  const lines: Line[] = [];
  for (const f of fragments) {
    const prev = lines.at(-1);
    if (prev && sameLine(prev, f)) {
      prev.text += f.text;
      prev.width = advance(prev, f);
    } else {
      lines.push({ ...f });
    }
  }
  return { lines, segments };
}

function direction(t: number[]): [number, number] {
  const n = Math.hypot(t[0], t[1]) || 1;
  return [t[0] / n, t[1] / n];
}

function sameLine(a: Line, b: Line): boolean {
  const [ux, uy] = direction(a.transform);
  const [vx, vy] = direction(b.transform);
  if (ux * vx + uy * vy < 0.999) return false;
  const size = Math.max(a.height, b.height, 1);
  // Décalage de b par rapport à la fin de a, le long de la ligne et perpendiculairement
  const dx = b.transform[4] - (a.transform[4] + ux * a.width);
  const dy = b.transform[5] - (a.transform[5] + uy * a.width);
  const along = dx * ux + dy * uy;
  const across = -dx * uy + dy * ux;
  return Math.abs(across) < size * 0.3 && along > -size * 0.5 && along < size * 0.8;
}

function advance(a: Line, b: Line): number {
  const [ux, uy] = direction(a.transform);
  return (b.transform[4] - a.transform[4]) * ux + (b.transform[5] - a.transform[5]) * uy + b.width;
}

// ───────── Graduations ─────────

interface Graduation {
  kind: 'lat' | 'lon';
  value: number;
  /** Centre du libellé en espace PDF et taille du texte */
  x: number;
  y: number;
  size: number;
  /** Longitude sans lettre E/W : le signe reste à déterminer */
  unsigned?: boolean;
}

// Notations de graduation « degrés + minutes » rencontrées dans les AIP européennes (sans secondes : les
// coordonnées complètes des tableaux et des points sont exclues) :
//   49°30'  002°30'E  N49°30'   (symbole degré, hémisphère facultatif avant ou après)
//   5130N   000 30W   6355'     (forme compacte : hémisphère ou symbole minute obligatoire)
//   40'                          (minutes seules : degrés repris d'une graduation voisine)
const WITH_DEGREE = /^([NSEW])?\s*(\d{2,3})\s*°\s*(\d{1,2})\s*['’′]?\s*([NSEW])?$/;
const COMPACT = /^([NSEW])?\s*(\d{2,3})\s?(\d{2})\s*(['’′])?\s*([NSEW])?$/;
const MINUTES_ALONE = /^(\d{2})\s*['’′]$/;
const DEGREES_ONLY = /^\d{2,3}\s*°$/;
const MINUTES_ONLY = /^\d{1,2}\s*['’′]\s*[NSEW]?$/;

interface Label {
  text: string;
  x: number;
  y: number;
  size: number;
  /** Direction du texte (vecteur unitaire) */
  dir: [number, number];
}

/** Centre d'une ligne de texte, en tenant compte de son orientation */
function center(line: Line): { x: number; y: number } {
  const [ux, uy] = direction(line.transform);
  const h = line.height / 2;
  return {
    x: line.transform[4] + ux * (line.width / 2) - uy * h,
    y: line.transform[5] + uy * (line.width / 2) + ux * h,
  };
}

/** Libellés candidats, en réunissant les graduations écrites sur deux lignes (« 49° » au-dessus de « 00’ ») */
function labels(lines: Line[]): Label[] {
  const result: Label[] = [];
  const used = new Set<Line>();
  for (const line of lines) {
    if (used.has(line)) continue;
    const text = line.text.replace(/\s+/g, ' ').trim();
    const c = center(line);
    if (DEGREES_ONLY.test(text)) {
      const [ux, uy] = direction(line.transform);
      const below = lines.find((o) => {
        if (o === line || used.has(o) || !MINUTES_ONLY.test(o.text.trim())) return false;
        const oc = center(o);
        const dx = oc.x - c.x;
        const dy = oc.y - c.y;
        const along = dx * ux + dy * uy;
        const down = dx * uy - dy * ux; // positif vers le bas du texte
        return Math.abs(along) < line.height * 1.5 && down > line.height * 0.5 && down < line.height * 2;
      });
      if (below) {
        used.add(below);
        const bc = center(below);
        result.push({
          text: `${text} ${below.text.trim()}`,
          x: (c.x + bc.x) / 2,
          y: (c.y + bc.y) / 2,
          size: line.height * 2,
          dir: direction(line.transform),
        });
        continue;
      }
    }
    result.push({ text, ...c, size: line.height, dir: direction(line.transform) });
  }
  return result;
}

const plausible = (kind: 'lat' | 'lon', magnitude: number) =>
  kind === 'lat' ? magnitude >= LAT_RANGE[0] && magnitude <= LAT_RANGE[1] : magnitude <= Math.max(-LON_RANGE[0], LON_RANGE[1]);

/**
 * Graduations candidates pour un libellé. Quand la notation est ambiguë (latitude ou longitude ?), toutes les
 * hypothèses plausibles sont proposées : l'ajustement par consensus ne retient que celles qui s'accordent.
 */
function parseGraduations(label: Label): Graduation[] {
  const text = label.text.replace(/\s+/g, ' ').trim();
  const m = WITH_DEGREE.exec(text) ?? COMPACT.exec(text);
  if (!m) return [];
  const isCompact = !WITH_DEGREE.test(text);
  const hemisphere = m[1] ?? (isCompact ? m[5] : m[4]);
  // La forme compacte sans hémisphère ni symbole minute se confond avec une altitude ou une distance
  if (isCompact && !hemisphere && !m[4]) return [];
  const degrees = Number(m[2]);
  const minutes = Number(m[3]);
  if (minutes >= 60) return [];
  const magnitude = degrees + minutes / 60;

  let kinds: ('lat' | 'lon')[];
  if (hemisphere) kinds = [hemisphere === 'N' || hemisphere === 'S' ? 'lat' : 'lon'];
  else if (m[2].length === 3) kinds = ['lon'];
  else kinds = (['lat', 'lon'] as const).filter((k) => plausible(k, magnitude));

  return kinds.map((kind) => ({
    kind,
    value: hemisphere === 'S' || hemisphere === 'W' ? -magnitude : magnitude,
    x: label.x,
    y: label.y,
    size: label.size,
    unsigned: kind === 'lon' && !hemisphere,
  }));
}

/**
 * Minutes seules (« 40' ») : les degrés sont ceux de la graduation complète la plus proche écrite dans le même
 * sens, ou le degré voisin quand la série franchit un degré entier (les deux sont proposés).
 */
function parseMinutesOnly(label: Label, full: { label: Label; grads: Graduation[] }[]): Graduation[] {
  const m = MINUTES_ALONE.exec(label.text.trim());
  if (!m) return [];
  const minutes = Number(m[1]);
  const sameWay = full.filter(({ label: l }) => l.dir[0] * label.dir[0] + l.dir[1] * label.dir[1] > 0.95);
  const nearest = sameWay.sort(
    (a, b) => Math.hypot(a.label.x - label.x, a.label.y - label.y) - Math.hypot(b.label.x - label.x, b.label.y - label.y),
  )[0];
  if (!nearest) return [];
  return nearest.grads.flatMap((g) => {
    const degrees = Math.trunc(Math.abs(g.value) + 1e-9);
    return [degrees - 1, degrees, degrees + 1].map((d) => ({
      ...g,
      value: Math.sign(g.value || 1) * (d + minutes / 60),
      x: label.x,
      y: label.y,
      size: label.size,
    }));
  });
}

function inRange(g: Graduation): boolean {
  const [min, max] = g.kind === 'lat' ? LAT_RANGE : LON_RANGE;
  return g.value >= min && g.value <= max;
}

/** Libellés dessinés plusieurs fois (halo blanc sous le texte) : on n'en garde qu'un */
function dedupe(grads: Graduation[]): Graduation[] {
  const result: Graduation[] = [];
  for (const g of grads) {
    if (!result.some((o) => o.kind === g.kind && o.value === g.value && Math.hypot(o.x - g.x, o.y - g.y) < 2)) result.push(g);
  }
  return result;
}

interface Candidate {
  grad: Graduation;
  /** Traits de graduation possibles à proximité du libellé */
  ticks: { x: number; y: number }[];
}

/** Traits candidats : verticaux pour une longitude (méridien), horizontaux pour une latitude, proches du libellé. */
function tickCandidates(g: Graduation, segments: Segment[]): { x: number; y: number }[] {
  const ticks: { x: number; y: number }[] = [];
  for (const s of segments) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const vertical = Math.abs(dy) > Math.abs(dx) * 3;
    const horizontal = Math.abs(dx) > Math.abs(dy) * 3;
    if (g.kind === 'lon' ? !vertical : !horizontal) continue;
    const t = Math.max(0, Math.min(1, ((g.x - s.x1) * dx + (g.y - s.y1) * dy) / (dx * dx + dy * dy)));
    if (Math.hypot(s.x1 + t * dx - g.x, s.y1 + t * dy - g.y) > g.size * 3) continue;
    const x = (s.x1 + s.x2) / 2;
    const y = (s.y1 + s.y2) / 2;
    const offset = g.kind === 'lon' ? Math.abs(x - g.x) : Math.abs(y - g.y);
    if (offset <= g.size * 2.5 && !ticks.some((o) => Math.hypot(o.x - x, o.y - y) < 0.5)) ticks.push({ x, y });
  }
  return ticks;
}

// ───────── Ajustement ─────────

// Similitude w = a·z + b en Mercator, inconnues p = [aRe, aIm, bRe, bIm].
// Une graduation de longitude contraint Re(w) = aRe·x − aIm·y + bRe, une de latitude Im(w) = aIm·x + aRe·y + bIm.
function row(g: Graduation, x = g.x, y = g.y): { coef: number[]; target: number } {
  return g.kind === 'lon'
    ? { coef: [x, -y, 1, 0], target: toMercX(g.value) }
    : { coef: [y, x, 0, 1], target: toMercY(g.value) };
}

/** Moindres carrés : équations normales (AᵀA)p = Aᵀt résolues par élimination de Gauss */
function leastSquares(rows: { coef: number[]; target: number }[]): number[] | null {
  const n = rows[0].coef.length;
  const M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const { coef, target } of rows) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] += coef[i] * coef[j];
      M[i][n] += coef[i] * target;
    }
  }
  const scale = Math.max(...M.map((r, i) => Math.abs(r[i])), 1);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-9 * scale) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < n + 1; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * La rotation n'est observable que si les méridiens sont repérés à des hauteurs différentes ou les parallèles
 * à des abscisses différentes. Sinon la carte est supposée orientée au nord.
 */
function rotationObservable(points: { g: Graduation; x: number; y: number }[]): boolean {
  const spread = (values: number[]) => (values.length ? Math.max(...values) - Math.min(...values) : 0);
  const lonY = spread(points.filter((p) => p.g.kind === 'lon').map((p) => p.y));
  const latX = spread(points.filter((p) => p.g.kind === 'lat').map((p) => p.x));
  return lonY > 100 || latX > 100;
}

function solve(points: { g: Graduation; x: number; y: number }[], withRotation: boolean): number[] | null {
  const rows = points.map((p) => row(p.g, p.x, p.y));
  if (withRotation) return leastSquares(rows);
  // aIm = 0 : inconnues [aRe, bRe, bIm]
  const p = leastSquares(rows.map(({ coef, target }) => ({ coef: [coef[0], coef[2], coef[3]], target })));
  return p && [p[0], 0, p[1], p[2]];
}

/** Écart (en points PDF) entre une graduation placée en (x, y) et la position prédite par le modèle */
function residualPt(p: number[], g: Graduation, x: number, y: number): number {
  const { coef, target } = row(g, x, y);
  return Math.abs(coef.reduce((s, c, i) => s + c * p[i], 0) - target) / Math.hypot(p[0], p[1]);
}

function hasBothAxes(points: { g: Graduation }[]): boolean {
  // Deux graduations distinctes par axe, à des positions différentes (et non deux hypothèses pour un même libellé)
  const ok = (kind: 'lat' | 'lon') => {
    const list = points.filter((p) => p.g.kind === kind);
    const values = new Set(list.map((p) => p.g.value));
    const positions = new Set(list.map((p) => `${Math.round(p.g.x)},${Math.round(p.g.y)}`));
    return values.size >= 2 && positions.size >= 2;
  };
  return ok('lat') && ok('lon');
}

interface Fit {
  p: number[];
  points: { g: Graduation; x: number; y: number }[];
  /** Écart quadratique moyen, en points PDF */
  rmsPt: number;
  /** Nombre d'inconnues du modèle (3 à rotation fixée, 4 sinon) */
  unknowns: number;
}

function finalize(points: Fit['points']): Fit | null {
  if (!hasBothAxes(points)) return null;
  const withRotation = rotationObservable(points);
  const p = solve(points, withRotation);
  if (!p) return null;
  const errors = points.map((q) => residualPt(p, q.g, q.x, q.y));
  return { p, points, rmsPt: Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length), unknowns: withRotation ? 4 : 3 };
}

/** Il faut au moins une graduation de plus que d'inconnues pour pouvoir vérifier la cohérence du calage */
const verifiable = (fit: Fit | null): fit is Fit => fit !== null && fit.points.length > fit.unknowns;

const TICK_TOLERANCE_PT = 1.5;
const RANSAC_ITERATIONS = 400;

/**
 * Consensus aléatoire (RANSAC) : on tire des associations graduation ↔ trait, on en déduit un modèle, et on garde
 * celui avec lequel le plus de graduations tombent précisément sur un de leurs traits candidats.
 */
function fitOnTicks(candidates: Candidate[]): Fit | null {
  const usable = candidates.filter((c) => c.ticks.length > 0);
  const lon = usable.filter((c) => c.grad.kind === 'lon');
  const lat = usable.filter((c) => c.grad.kind === 'lat');
  if (!hasBothAxes(usable.map((c) => ({ g: c.grad })))) return null;

  // Générateur pseudo-aléatoire mulberry32 : tirages reproductibles d'une exécution à l'autre
  let seed = 12345;
  const random = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0;
  };
  const pick = (list: Candidate[]) => {
    const c = list[random(list.length)];
    const t = c.ticks[random(c.ticks.length)];
    return { g: c.grad, x: t.x, y: t.y };
  };

  let best: { inliers: Fit['points']; distance: number; rotation: number } | null = null;
  for (let i = 0; i < RANSAC_ITERATIONS; i++) {
    const sample = [pick(lon), pick(lon), pick(lat), pick(lat)];
    if (!hasBothAxes(sample)) continue;
    for (const withRotation of [false, true]) {
      const p = solve(sample, withRotation);
      if (!p || !(Math.hypot(p[0], p[1]) > 0)) continue;
      const rotation = Math.abs((Math.atan2(p[1], p[0]) * 180) / Math.PI);
      if (rotation > MAX_ROTATION_DEG) continue;
      const inliers: Fit['points'] = [];
      let distance = 0;
      for (const c of usable) {
        let bestTick: { x: number; y: number; e: number } | null = null;
        for (const t of c.ticks) {
          const e = residualPt(p, c.grad, t.x, t.y);
          if (e < TICK_TOLERANCE_PT && (!bestTick || e < bestTick.e)) bestTick = { ...t, e };
        }
        if (bestTick) {
          inliers.push({ g: c.grad, x: bestTick.x, y: bestTick.y });
          distance += Math.hypot(bestTick.x - c.grad.x, bestTick.y - c.grad.y);
        }
      }
      // Critères : nombre de graduations sur un trait, puis rotation la plus faible (les cartes SIA sont
      // orientées au nord, aux effets de projection près), puis traits les plus proches de leurs libellés
      const better =
        !best ||
        inliers.length > best.inliers.length ||
        (inliers.length === best.inliers.length &&
          (rotation < best.rotation - 0.5 || (Math.abs(rotation - best.rotation) <= 0.5 && distance < best.distance)));
      if (better) best = { inliers, distance, rotation };
    }
  }
  return best ? finalize(best.inliers) : null;
}

/** Repli sans traits : centres des libellés, avec rejet itératif des valeurs aberrantes */
function fitOnLabels(grads: Graduation[]): Fit | null {
  let points = grads.map((g) => ({ g, x: g.x, y: g.y }));
  for (;;) {
    const fit = finalize(points);
    if (!fit || points.length <= fit.unknowns + 1) return fit;
    const errors = points.map((q) => residualPt(fit.p, q.g, q.x, q.y));
    const worst = errors.indexOf(Math.max(...errors));
    if (errors[worst] < Math.max(3 * fit.rmsPt, 2)) return fit;
    points = points.filter((_, i) => i !== worst);
  }
}

/** Vrai si la position (lon, lat) tombe sur la page une fois calée : z = (w − b) / a */
function contains(p: number[], view: number[], [lon, lat]: [number, number]): boolean {
  const [aRe, aIm, bRe, bIm] = p;
  const wx = toMercX(lon) - bRe;
  const wy = toMercY(lat) - bIm;
  const d = aRe * aRe + aIm * aIm;
  const px = (wx * aRe + wy * aIm) / d;
  const py = (wy * aRe - wx * aIm) / d;
  return px >= view[0] && px <= view[2] && py >= view[1] && py <= view[3];
}

// Garde-fous contre les faux calages (cartes schématiques « hors échelle », libellés mal interprétés)
const MAX_RESIDUAL_PT = 4;
// Convergence des méridiens en projection conique conforme sur la France : quelques degrés au plus
const MAX_ROTATION_DEG = 5;

/**
 * Calcule le calage d'une carte à partir de ses graduations.
 * `expected` (position de l'aérodrome) doit tomber sur la carte calée, sinon le calage est rejeté.
 */
export async function computeGeoref(pdfData: Uint8Array, expected?: [number, number]): Promise<GeorefResult | null> {
  const task = pdfjs.getDocument({ data: pdfData, fontExtraProperties: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const { lines, segments } = await readPage(page);
    const all = labels(lines);
    const full = all.map((label) => ({ label, grads: parseGraduations(label) })).filter((f) => f.grads.length > 0);
    const parsed = dedupe([...full.flatMap((f) => f.grads), ...all.flatMap((label) => parseMinutesOnly(label, full))]);
    const [x0, y0, x1, y1] = page.view;

    // Les VAC omettent souvent la lettre E/W : on essaie l'est puis l'ouest. La mauvaise hypothèse
    // donne une carte en miroir (rotation de 180°), rejetée par les contrôles.
    let result: Fit | null = null;
    for (const sign of [1, -1]) {
      const grads = parsed.map((g) => (g.unsigned ? { ...g, value: g.value * sign } : g)).filter(inRange);
      const onTicks = fitOnTicks(grads.map((grad) => ({ grad, ticks: tickCandidates(grad, segments) })));
      const fit = verifiable(onTicks) ? onTicks : fitOnLabels(grads);
      if (verifiable(fit) && fit.rmsPt <= MAX_RESIDUAL_PT && Math.abs(Math.atan2(fit.p[1], fit.p[0])) <= (MAX_ROTATION_DEG * Math.PI) / 180) {
        if (!expected || contains(fit.p, page.view, expected)) {
          result = fit;
          break;
        }
      }
      if (!parsed.some((g) => g.unsigned)) break;
    }
    if (!result) return null;

    const [aRe, aIm, bRe, bIm] = result.p;
    const toLngLat = (x: number, y: number) => fromMerc(aRe * x - aIm * y + bRe, aIm * x + aRe * y + bIm);

    const corners: [number, number][] = [
      [x0, y1],
      [x1, y1],
      [x1, y0],
      [x0, y0],
    ];
    const metersPerPt = Math.hypot(aRe, aIm) * Math.cos((toLngLat((x0 + x1) / 2, (y0 + y1) / 2)[1] * Math.PI) / 180);
    return {
      points: corners.map(([x, y]) => ({ pdf: [x, y], lngLat: toLngLat(x, y) })),
      rmsMeters: result.rmsPt * metersPerPt,
      graduations: result.points.length,
    };
  } finally {
    await task.destroy();
  }
}

