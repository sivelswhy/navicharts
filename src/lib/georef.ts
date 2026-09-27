// Géoréférencement d'une carte PDF par points de calage.
// Transformation de similitude (translation + rotation + échelle uniforme) calculée en Web Mercator,
// la projection de la carte affichée : la superposition est donc exacte pour une carte conforme.
import { useCallback, useState } from 'react';

/** Point dans l'espace PDF (points typographiques, origine en bas à gauche, y vers le haut) */
export type PdfPoint = [number, number];
export type LngLat = [number, number];

export interface ControlPoint {
  pdf: PdfPoint;
  lngLat: LngLat;
}

export interface Georef {
  chartId: string;
  points: ControlPoint[];
  updatedAt: string;
}

const R = 6378137;

function toMercator([lon, lat]: LngLat): [number, number] {
  return [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

function fromMercator([x, y]: [number, number]): LngLat {
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
}

// Nombres complexes : une similitude s'écrit w = a·z + b
type C = [number, number];
const add = (p: C, q: C): C => [p[0] + q[0], p[1] + q[1]];
const sub = (p: C, q: C): C => [p[0] - q[0], p[1] - q[1]];
const mul = (p: C, q: C): C => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]];
const scale = (p: C, k: number): C => [p[0] * k, p[1] * k];

export interface Transform {
  a: C;
  b: C;
  /** Écart moyen entre les points de calage et leur position calculée, en mètres au sol */
  rmsMeters: number;
}

/** Similitude aux moindres carrés ; nécessite au moins 2 points distincts. */
export function fitTransform(points: ControlPoint[]): Transform | null {
  if (points.length < 2) return null;
  const z = points.map((p) => p.pdf as C);
  const w = points.map((p) => toMercator(p.lngLat) as C);
  const n = points.length;
  const zc = scale(z.reduce(add), 1 / n);
  const wc = scale(w.reduce(add), 1 / n);

  // a = Σ (w_i - wc)·conj(z_i - zc) / Σ |z_i - zc|²
  let num: C = [0, 0];
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dz = sub(z[i], zc);
    const dw = sub(w[i], wc);
    num = add(num, mul(dw, [dz[0], -dz[1]]));
    den += dz[0] ** 2 + dz[1] ** 2;
  }
  if (den < 1e-6) return null;
  const a = scale(num, 1 / den);
  const b = sub(wc, mul(a, zc));

  // Erreur résiduelle, ramenée de mètres Mercator à mètres au sol
  const lat = fromMercator(wc)[1];
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const e = sub(add(mul(a, z[i]), b), w[i]);
    sq += e[0] ** 2 + e[1] ** 2;
  }
  return { a, b, rmsMeters: Math.sqrt(sq / n) * Math.cos((lat * Math.PI) / 180) };
}

export function pdfToLngLat(t: Transform, p: PdfPoint): LngLat {
  return fromMercator(add(mul(t.a, p), t.b));
}

/**
 * Coins de la page (view = [x0, y0, x1, y1] en espace PDF) dans l'ordre attendu par MapLibre :
 * haut-gauche, haut-droit, bas-droit, bas-gauche.
 */
export function pageCorners(t: Transform, view: number[]): [LngLat, LngLat, LngLat, LngLat] {
  const [x0, y0, x1, y1] = view;
  return [pdfToLngLat(t, [x0, y1]), pdfToLngLat(t, [x1, y1]), pdfToLngLat(t, [x1, y0]), pdfToLngLat(t, [x0, y0])];
}

// ───────── Persistance locale des calages ─────────

const KEY = 'navicharts:georefs';

function read(): Record<string, Georef> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function useGeorefs() {
  const [georefs, setGeorefs] = useState<Record<string, Georef>>(read);

  const save = useCallback((chartId: string, points: ControlPoint[] | null) => {
    setGeorefs((prev) => {
      const next = { ...prev };
      if (points) next[chartId] = { chartId, points, updatedAt: new Date().toISOString() };
      else delete next[chartId];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Stockage indisponible : le calage reste valable pour la session.
      }
      return next;
    });
  }, []);

  return { georefs, save };
}
