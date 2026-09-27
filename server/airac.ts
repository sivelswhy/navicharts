// Cycles AIRAC : tous les 28 jours à partir d'une date de référence connue.
const REFERENCE = Date.UTC(2026, 0, 22); // AIRAC 2601
const CYCLE_MS = 28 * 24 * 3600 * 1000;

export interface AiracCycle {
  /** Identifiant OACI, ex. "2609" */
  ident: string;
  /** Date d'entrée en vigueur (00:00 UTC) */
  effective: Date;
  /** Date de fin (entrée en vigueur du cycle suivant) */
  expires: Date;
}

function cycleAt(effectiveMs: number): AiracCycle {
  const effective = new Date(effectiveMs);
  const year = effective.getUTCFullYear();
  const firstOfYear = Math.ceil((Date.UTC(year, 0, 1) - REFERENCE) / CYCLE_MS) * CYCLE_MS + REFERENCE;
  const index = Math.round((effectiveMs - firstOfYear) / CYCLE_MS) + 1;
  return {
    ident: `${String(year % 100).padStart(2, '0')}${String(index).padStart(2, '0')}`,
    effective,
    expires: new Date(effectiveMs + CYCLE_MS),
  };
}

export function currentCycle(now = Date.now()): AiracCycle {
  return cycleAt(Math.floor((now - REFERENCE) / CYCLE_MS) * CYCLE_MS + REFERENCE);
}

export function previousCycle(cycle: AiracCycle): AiracCycle {
  return cycleAt(cycle.effective.getTime() - CYCLE_MS);
}
