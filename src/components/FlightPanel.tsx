import { useEffect, useState } from 'react';
import { GROUP_OF, groupColor } from '../lib/chartGroups.ts';
import { fetchCharts } from '../lib/data.ts';
import type { FlightRoute, Terminal } from '../lib/route.ts';
import type { Chart } from '../lib/types.ts';

export const EXAMPLE_ROUTE =
  'LFPG/27L N0481F350 AGOP6A AGOPA DCT ARKIP DCT ARMAL DCT ARTAX DCT BEBIX DCT LMG DCT UVELI DCT OSMOB DCT VAVIX DCT MAGEC MAGE2S LFBZ/27';

interface Props {
  text: string;
  onText: (text: string) => void;
  route: FlightRoute | null;
  status: 'idle' | 'loading' | 'error';
  onShow: () => void;
  onClear: () => void;
  onSelectAirport: (ident: string) => void;
  onOpenChart: (chart: Chart) => void;
  openChart: Chart | null;
}

function formatSpeed(speed: string | null): string | null {
  if (!speed) return null;
  const value = Number(speed.slice(1));
  if (speed[0] === 'N') return `${value} kt`;
  if (speed[0] === 'K') return `${value} km/h`;
  return `Mach ${(value / 100).toFixed(2)}`;
}

function formatLevel(level: string | null): string | null {
  if (!level) return null;
  if (level[0] === 'F') return `FL${level.slice(1)}`;
  if (level[0] === 'A') return `${Number(level.slice(1)) * 100} ft`;
  return level;
}

const runwayMatch = (title: string, runway: string | null) => !runway || new RegExp(`\\b${runway}\\b`).test(title);

/** Cartes utiles pour un terminal : procédure citant le point de transition (ou la piste), approches, carte d'aérodrome */
function suggestions(charts: Chart[], terminal: Terminal, procedureCategory: 'SID' | 'STAR', fix: string | null): Chart[] {
  const procedures = charts.filter((c) => c.category === procedureCategory);
  const byFix = fix ? procedures.filter((c) => c.title.includes(fix)) : [];
  const pool = byFix.length ? byFix : procedures;
  const byRunway = pool.filter((c) => runwayMatch(c.title, terminal.runway));
  const picked = (byRunway.length ? byRunway : pool).slice(0, 3);
  const approaches =
    procedureCategory === 'STAR' ? charts.filter((c) => c.category === 'APPROACH' && terminal.runway && runwayMatch(c.title, terminal.runway)).slice(0, 4) : [];
  // Carte d'aérodrome (roulage) de préférence, VAC à défaut
  const ground = [charts.find((c) => c.category === 'GROUND') ?? charts.find((c) => c.category === 'VAC')].filter((c): c is Chart => Boolean(c));
  return [...picked, ...approaches, ...ground];
}

function TerminalCharts({
  terminal,
  kind,
  procedure,
  fix,
  onOpenChart,
  openChart,
}: {
  terminal: Terminal;
  kind: 'SID' | 'STAR';
  procedure: string | null;
  fix: string | null;
  onOpenChart: (chart: Chart) => void;
  openChart: Chart | null;
}) {
  const [charts, setCharts] = useState<Chart[] | null>(null);
  const icao = terminal.airport.icao;

  useEffect(() => {
    let cancelled = false;
    setCharts(null);
    if (!icao) return;
    fetchCharts(icao).then(
      (r) => !cancelled && setCharts(suggestions(r.charts, terminal, kind, fix)),
      () => !cancelled && setCharts([]),
    );
    return () => {
      cancelled = true;
    };
  }, [icao, terminal, kind, fix]);

  return (
    <section>
      <h3 className="list-heading">
        {kind === 'SID' ? 'Départ' : 'Arrivée'} {icao} {procedure ? `· ${procedure}` : ''}
      </h3>
      {charts === null ? (
        <p className="placeholder">Recherche des cartes…</p>
      ) : charts.length === 0 ? (
        <p className="placeholder">Aucune carte officielle disponible pour ce terrain.</p>
      ) : (
        <ul className="chart-list">
          {charts.map((c) => (
            <li
              key={c.id}
              className={openChart?.id === c.id ? 'chart-row active' : 'chart-row'}
              style={{ '--type': groupColor(GROUP_OF[c.category]) } as React.CSSProperties}
            >
              <button className="chart-row-main" onClick={() => onOpenChart(c)} title={c.title}>
                <span className="chart-row-title">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Saisie d'une route au format plan de vol OACI, résumé du vol et cartes associées */
export function FlightPanel({ text, onText, route, status, onShow, onClear, onSelectAirport, onOpenChart, openChart }: Props) {
  let cumulative = 0;
  return (
    <div className="flight">
      <div className="flight-form">
        <h2>Plan de vol</h2>
        <label className="flight-label" htmlFor="route-input">
          Route (format plan de vol OACI)
        </label>
        <textarea
          id="route-input"
          className="route-input"
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="Ex. : LFPG DCT LMG DCT LFBZ"
          rows={4}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onShow();
          }}
        />
        <div className="flight-actions">
          <button className="primary" onClick={onShow} disabled={!text.trim() || status === 'loading'}>
            {status === 'loading' ? 'Analyse…' : 'Afficher le trajet'}
          </button>
          {!text.trim() && (
            <button onClick={() => onText(EXAMPLE_ROUTE)} title="Remplir avec une route d'exemple">
              Exemple
            </button>
          )}
          {route && <button onClick={onClear}>Effacer</button>}
        </div>
        {status === 'error' && <p className="footnote error">Impossible d’analyser cette route.</p>}
      </div>

      {route && (
        <div className="flight-body">
          <div className="flight-summary">
            <div className="flight-terminals">
              {route.departure ? (
                <button onClick={() => onSelectAirport(route.departure!.airport.ident)} title={route.departure.airport.name}>
                  {route.departure.airport.icao}
                  {route.departure.runway && <span className="chip">{route.departure.runway}</span>}
                </button>
              ) : (
                <span>—</span>
              )}
              <span className="flight-arrow" aria-hidden>
                →
              </span>
              {route.arrival ? (
                <button onClick={() => onSelectAirport(route.arrival!.airport.ident)} title={route.arrival.airport.name}>
                  {route.arrival.airport.icao}
                  {route.arrival.runway && <span className="chip">{route.arrival.runway}</span>}
                </button>
              ) : (
                <span>—</span>
              )}
            </div>
            <dl className="facts">
              <div>
                <dt>Distance</dt>
                <dd>{Math.round(route.totalNm)} NM</dd>
              </div>
              <div>
                <dt>Croisière</dt>
                <dd>{[formatLevel(route.level), formatSpeed(route.speed)].filter(Boolean).join(' · ') || '—'}</dd>
              </div>
            </dl>
          </div>

          {route.unresolved.length > 0 && (
            <p className="notice">
              Éléments non localisés (tracés en direct entre leurs voisins) : {route.unresolved.join(', ')}. Les points de
              report ne sont connus que pour la France.
            </p>
          )}

          {route.departure && (
            <TerminalCharts terminal={route.departure} kind="SID" procedure={route.sid} fix={route.sidFix} onOpenChart={onOpenChart} openChart={openChart} />
          )}
          {route.arrival && (
            <TerminalCharts terminal={route.arrival} kind="STAR" procedure={route.star} fix={route.starFix} onOpenChart={onOpenChart} openChart={openChart} />
          )}

          <h3 className="list-heading">Branches</h3>
          <table className="table legs">
            <thead>
              <tr>
                <th>Vers</th>
                <th>Via</th>
                <th className="right">Rv</th>
                <th className="right">NM</th>
                <th className="right">Cumul</th>
              </tr>
            </thead>
            <tbody>
              {route.legs.map((leg, i) => {
                cumulative += leg.distanceNm;
                return (
                  <tr key={i} className={leg.procedure ? 'procedure' : ''}>
                    <td className="mono strong" title={leg.to.name}>
                      {leg.to.ident}
                    </td>
                    <td className="mono">{leg.via}</td>
                    <td className="mono right">{String(Math.round(leg.courseT) % 360).padStart(3, '0')}°</td>
                    <td className="mono right">{leg.distanceNm.toFixed(0)}</td>
                    <td className="mono right">{cumulative.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="footnote">
            Routes vraies (Rv) et distances orthodromiques. SID et STAR représentées par un segment direct : suivez la carte
            officielle.
          </p>
        </div>
      )}
    </div>
  );
}
