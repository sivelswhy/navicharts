import { useMemo, useState } from 'react';
import { searchAirports } from '../lib/data.ts';
import type { Airport } from '../lib/types.ts';
import { IconSearch } from './icons.tsx';

interface Props {
  airports: Airport[];
  onSelect: (ident: string) => void;
}

export function SearchBox({ airports, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchAirports(airports, query), [airports, query]);

  const choose = (a: Airport) => {
    onSelect(a.ident);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="search">
      <IconSearch size={17} className="search-icon" />
      <input
        type="search"
        placeholder="OACI, IATA, nom ou ville…"
        value={query}
        autoFocus
        aria-label="Rechercher un aérodrome"
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
          {results.map((a, i) => (
            <li
              key={a.ident}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(a);
              }}
            >
              <span className="code">{a.icao || a.ident}</span>
              <span className="name">{a.name}</span>
              {a.city && <span className="city">{a.city}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
