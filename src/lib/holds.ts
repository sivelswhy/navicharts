// Circuits d'attente : tracé en hippodrome à partir du point, du cap d'entrée, du sens du virage et de la longueur des
// branches (ou tracé fourni tel quel par la source).
import type { LngLat } from './georef.ts';

export interface Hold {
  fix: string;
  kind?: 'HM' | 'HA' | 'HF';
  lngLat?: LngLat;
  /** Cap d'entrée vrai, vers le point */
  courseT?: number;
  turn?: 'L' | 'R';
  legNm?: number;
  legMin?: number;
  path?: LngLat[];
}

// Vitesse d'attente usuelle et virage au taux standard (3°/s) : rayon V / (60 π) ≈ 1,1 NM
const SPEED_KT = 210;
const RADIUS_NM = SPEED_KT / (60 * Math.PI);

/** Hippodrome : branche d'entrée jusqu'au point, virage de 180°, branche d'éloignement, virage de retour */
export function holdPath(hold: Hold, at: LngLat): LngLat[] | null {
  if (hold.path?.length) return hold.path;
  if (hold.courseT === undefined || !hold.turn) return null;
  const c = (hold.courseT * Math.PI) / 180;
  const leg = hold.legNm ?? (hold.legMin ?? 1) * (SPEED_KT / 60);
  const u = [Math.sin(c), Math.cos(c)]; // sens de la branche d'entrée (est, nord)
  const side = hold.turn === 'R' ? 1 : -1;
  const n = [side * Math.cos(c), -side * Math.sin(c)]; // côté de l'attente
  const r = RADIUS_NM;
  const pts: [number, number][] = [];
  // Virage au-dessus du point, autour du centre n·r
  for (let i = 0; i <= 12; i++) {
    const θ = (Math.PI * i) / 12;
    pts.push([n[0] * r + r * (-n[0] * Math.cos(θ) + u[0] * Math.sin(θ)), n[1] * r + r * (-n[1] * Math.cos(θ) + u[1] * Math.sin(θ))]);
  }
  // Branche d'éloignement, puis virage de retour vers la branche d'entrée
  for (let i = 0; i <= 12; i++) {
    const θ = (Math.PI * i) / 12;
    const cx = n[0] * r - u[0] * leg;
    const cy = n[1] * r - u[1] * leg;
    pts.push([cx + r * (n[0] * Math.cos(θ) - u[0] * Math.sin(θ)), cy + r * (n[1] * Math.cos(θ) - u[1] * Math.sin(θ))]);
  }
  pts.push([0, 0]);
  const kx = 60 * Math.cos((at[1] * Math.PI) / 180);
  return pts.map(([x, y]) => [at[0] + x / kx, at[1] + y / 60]);
}
