import { useCallback, useState } from 'react';
import type { Chart } from './types.ts';

const KEY = 'navicharts:pins';

export interface Pin {
  icao: string;
  chart: Chart;
}

function read(): Pin[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function write(pins: Pin[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Stockage indisponible (navigation privée…) : les épingles restent en mémoire.
  }
}

/** Cartes épinglées (pinboard), conservées d'une session à l'autre */
export function usePins() {
  const [pins, setPins] = useState<Pin[]>(read);

  const update = useCallback((next: (prev: Pin[]) => Pin[]) => {
    setPins((prev) => {
      const value = next(prev);
      write(value);
      return value;
    });
  }, []);

  const toggle = useCallback(
    (icao: string, chart: Chart) =>
      update((prev) => (prev.some((p) => p.chart.id === chart.id) ? prev.filter((p) => p.chart.id !== chart.id) : [...prev, { icao, chart }])),
    [update],
  );
  const remove = useCallback((id: string) => update((prev) => prev.filter((p) => p.chart.id !== id)), [update]);

  return { pins, isPinned: (id: string) => pins.some((p) => p.chart.id === id), toggle, remove };
}
