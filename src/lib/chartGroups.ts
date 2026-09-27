// Regroupement des cartes SIA en grandes familles, chacune repérée par une couleur dans toute l'interface.
import type { ChartCategory } from './types.ts';

export type ChartGroup = 'APT' | 'DEP' | 'ARR' | 'APP' | 'REF';

export const CHART_GROUPS: ChartGroup[] = ['APT', 'DEP', 'ARR', 'APP', 'REF'];

export const GROUP_OF: Record<ChartCategory, ChartGroup> = {
  VAC: 'APT',
  GROUND: 'APT',
  SID: 'DEP',
  STAR: 'ARR',
  APPROACH: 'APP',
  OTHER: 'REF',
  DATA: 'REF',
};

export const GROUP_LABELS: Record<ChartGroup, string> = {
  APT: 'Aérodrome',
  DEP: 'Départs',
  ARR: 'Arrivées',
  APP: 'Approches',
  REF: 'Référence',
};

/** Sous-titres dans un groupe réunissant plusieurs catégories */
export const CATEGORY_LABELS: Record<ChartCategory, string> = {
  VAC: 'VAC',
  GROUND: 'Aérodrome et sol',
  SID: 'SID',
  STAR: 'STAR',
  APPROACH: 'IAC',
  OTHER: 'Autres cartes',
  DATA: 'Données de codage',
};

export function groupColor(group: ChartGroup): string {
  return `var(--chart-${group.toLowerCase()})`;
}
