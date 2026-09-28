import { useEffect, useMemo, useState } from 'react';
import { scoreAirports } from '../lib/data.ts';
import { navScore, searchNav, type NavResult } from '../lib/navSearch.ts';
import type { Airport } from '../lib/types.ts';
import { IconSearch } from './icons.tsx';

interface Props {
  airports: Airport[];
  onSelect: (ident: string) => void;
  /** Point de report ou balise choisi */
  onSelectPoint: (point: NavResult) => void;
}

type Result = { kind: 'airport'; airport: Airport } | { kind: 'nav'; point: NavResult };

const MAX_RESULTS = 10;
const DEBOUNCE_MS = 150;

const pointLabel = (p: NavResult) => (p.kind === 'navaid' ? p.type || 'Balise' : 'Point de report');
const coords = ([lon, lat]: [number, number]) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

export function SearchBox({ airports, onSelect, onSelectPoint }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [points, setPoints] = useState<{ query: string; list: NavResult[] }>({ query: '', list: [] });

  // Points et balises : recherche asynchrone, après une courte pause dans la frappe
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      searchNav(q, undefined, ctrl.signal).then(
        (list) => setPoints({ query, list }),
        () => {},
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const results = useMemo<Result[]>(() => {
    // Aérodromes, balises et points mêlés, du plus pertinent au moins pertinent (ordre d'origine à égalité)
    const found = scoreAirports(airports, query).map(({ a, score }) => ({ result: { kind: 'airport', airport: a } as Result, score }));
    const nav = (points.query === query ? points.list : []).map((point) => ({ result: { kind: 'nav', point } as Result, score: navScore(point, query) }));
    return [...found, ...nav]
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_RESULTS)
      .map((s) => s.result);
  }, [airports, query, points]);

  const choose = (r: Result) => {
    if (r.kind === 'airport') onSelect(r.airport.ident);
    else onSelectPoint(r.point);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="search">
      <IconSearch size={17} className="search-icon" />
      <input
        type="search"
        placeholder="Aérodrome, balise, point de report…"
        value={query}
        autoFocus
        aria-label="Rechercher un aérodrome, une balise ou un point de report"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && results[active]) {
            choose(results[active]);
          } else if (e.key === 'Escape') {
            setQuery('');
          }
        }}
      />
      {results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.kind === 'airport' ? `a ${r.airport.ident}` : `p ${r.point.kind} ${r.point.ident} ${r.point.lngLat}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
            >
              {r.kind === 'airport' ? (
                <>
                  <span className="code">{r.airport.icao || r.airport.ident}</span>
                  <span className="name">{r.airport.name}</span>
                  {r.airport.city && <span className="city">{r.airport.city}</span>}
                </>
              ) : (
                <>
                  <span className={`code ${r.point.kind}`}>{r.point.ident}</span>
                  <span className="name">{r.point.name || pointLabel(r.point)}</span>
                  <span className="city">
                    {r.point.name ? `${pointLabel(r.point)} · ` : ''}
                    {coords(r.point.lngLat)}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
