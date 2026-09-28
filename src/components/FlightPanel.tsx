import { useEffect, useState } from 'react';
import type { IvaoFlightPlan, IvaoPilot } from '../lib/ivao.ts';
import { GROUP_OF, groupColor } from '../lib/chartGroups.ts';
import { fetchCharts } from '../lib/data.ts';
import type { FlightRoute, Procedure, RouteChange, RouteProgress, Terminal } from '../lib/route.ts';
import type { Chart } from '../lib/types.ts';
import { WeatherSection } from './Weather.tsx';

// En dev, SID et STAR viennent des tuiles autorouter (test local, voir route.ts)
const PROCEDURE_COVERAGE = import.meta.env.DEV
  ? 'Listes d’après autorouter, pistes selon l’eAIP pour les aérodromes français.'
  : 'Listes disponibles pour les aérodromes français.';
const PROCEDURE_SOURCE = import.meta.env.DEV ? 'autorouter' : 'les tableaux de codage de l’eAIP (France)';

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
  /** Changement de piste, de SID ou de STAR (la route texte est réécrite puis retracée) */
  onChange: (change: RouteChange) => void;
  ivao: IvaoLink;
}

interface IvaoLink {
  vid: string;
  onLink: (vid: string) => void;
  pilot: IvaoPilot | null;
  flightPlan: IvaoFlightPlan | null;
  loading: boolean;
  error: boolean;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  progress: RouteProgress | null;
}

/** Liaison avec un vol IVAO : le plan de vol déposé est importé automatiquement et l'avion est suivi */
function IvaoSection({ ivao }: { ivao: IvaoLink }) {
  const [draft, setDraft] = useState('');
  const { pilot, flightPlan, progress } = ivao;

  if (!ivao.vid) {
    return (
      <section className="ivao">
        <h3 className="list-heading">Vol IVAO</h3>
        <form
          className="ivao-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{3,8}$/.test(draft.trim())) ivao.onLink(draft.trim());
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
            placeholder="Votre VID IVAO"
            inputMode="numeric"
            aria-label="VID IVAO"
          />
          <button type="submit" disabled={!/^\d{3,8}$/.test(draft)}>
            Lier
          </button>
        </form>
        <p className="footnote">Votre plan de vol déposé sur IVAO sera importé et votre avion suivi sur la carte.</p>
      </section>
    );
  }

  return (
    <section className="ivao">
      <h3 className="list-heading">
        Vol IVAO · VID {ivao.vid}
        <button className="link-button" onClick={() => ivao.onLink('')}>
          Délier
        </button>
      </h3>
      {ivao.loading ? (
        <p className="placeholder">Recherche de votre session…</p>
      ) : ivao.error && !pilot ? (
        <p className="placeholder error">IVAO est injoignable pour le moment.</p>
      ) : !pilot ? (
        <p className="placeholder">Aucune session de pilote en cours pour ce VID. Le suivi démarrera dès votre connexion.</p>
      ) : (
        <div className="ivao-status">
          <div className="ivao-callsign">
            <span className="live-dot" aria-hidden />
            {pilot.callsign}
            {pilot.aircraft && <span className="chip">{pilot.aircraft}</span>}
            <span className="ivao-state">{pilot.onGround ? 'Au sol' : pilot.state}</span>
          </div>
          <dl className="facts">
            <div>
              <dt>Altitude</dt>
              <dd>{pilot.altitude >= 10_000 ? `FL${String(Math.round(pilot.altitude / 100)).padStart(3, '0')}` : `${Math.round(pilot.altitude)} ft`}</dd>
            </div>
            <div>
              <dt>Vitesse sol</dt>
              <dd>{pilot.groundSpeed} kt</dd>
            </div>
            {progress && (
              <div>
                <dt>Prochain point</dt>
                <dd>
                  {progress.next.ident} · {Math.round(progress.toNextNm)} NM
                </dd>
              </div>
            )}
            <div>
              <dt>Restant</dt>
              <dd>{progress ? `${Math.round(progress.remainingNm)} NM` : pilot.arrivalDistance !== null ? `${Math.round(pilot.arrivalDistance)} NM` : '—'}</dd>
            </div>
          </dl>
          <label className="switch-row ivao-follow">
            <span>Suivre l'avion sur la carte</span>
            <input type="checkbox" role="switch" checked={ivao.follow} onChange={(e) => ivao.onFollow(e.target.checked)} />
          </label>
          {!flightPlan && <p className="footnote">Aucun plan de vol déposé : la route ne peut pas être importée.</p>}
        </div>
      )}
    </section>
  );
}

/** Piste et procédure d'un terminal, modifiables */
function ProcedurePicker({
  label,
  terminal,
  runways,
  options,
  used,
  requested,
  transition,
  onRunway,
  onProcedure,
}: {
  label: string;
  terminal: Terminal;
  runways: string[];
  options: Procedure[];
  used: Procedure | null;
  requested: string | null;
  transition: string | null;
  onRunway: (runway: string) => void;
  onProcedure: (ident: string | null) => void;
}) {
  const kind = label === 'SID' ? 'SID' : 'STAR';
  const current = used?.ident ?? requested ?? '';
  // La procédure demandée reste listée même si elle n'est pas disponible pour cette piste
  const listed = current && !options.some((o) => o.ident === current);
  return (
    <div className="picker">
      <span className="picker-airport">{terminal.airport.icao}</span>
      <label className="picker-field">
        <span>Piste</span>
        <select value={terminal.runway ?? ''} onChange={(e) => onRunway(e.target.value)} disabled={!runways.length}>
          {!terminal.runway && <option value="">—</option>}
          {runways.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="picker-field grow">
        <span>{label}</span>
        <select value={current} onChange={(e) => onProcedure(e.target.value || null)} disabled={!options.length && !current}>
          <option value="">{options.length ? `Aucune (direct)` : `Pas de ${kind} disponible`}</option>
          {listed && <option value={current}>{current}</option>}
          {options.map((o) => {
            const to = kind === 'SID' ? o.fixes.at(-1) : o.fixes[0];
            return (
              <option key={o.ident} value={o.ident}>
                {o.ident} · {kind === 'SID' ? `→ ${to}` : `${to} →`}
                {to === transition ? ' ✓' : ''}
              </option>
            );
          })}
        </select>
      </label>
    </div>
  );
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
export function FlightPanel({ text, onText, route, status, onShow, onClear, onSelectAirport, onOpenChart, openChart, onChange, ivao }: Props) {
  let cumulative = 0;
  return (
    <div className="flight">
      <div className="flight-form">
        <h2>Plan de vol</h2>
        <IvaoSection ivao={ivao} />
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

          <WeatherSection departure={route.departure?.airport.icao || null} arrival={route.arrival?.airport.icao || null} />

          {(route.departure || route.arrival) && (
            <section className="pickers">
              <h3 className="list-heading">Procédures</h3>
              {route.departure && (
                <ProcedurePicker
                  label="SID"
                  terminal={route.departure}
                  runways={route.departureRunways}
                  options={route.sidOptions}
                  used={route.sidUsed}
                  requested={route.sid}
                  transition={route.sidFix}
                  onRunway={(departureRunway) => onChange({ departureRunway })}
                  onProcedure={(sid) => onChange({ sid })}
                />
              )}
              {route.arrival && (
                <ProcedurePicker
                  label="STAR"
                  terminal={route.arrival}
                  runways={route.arrivalRunways}
                  options={route.starOptions}
                  used={route.starUsed}
                  requested={route.star}
                  transition={route.starFix}
                  onRunway={(arrivalRunway) => onChange({ arrivalRunway })}
                  onProcedure={(star) => onChange({ star })}
                />
              )}
              <p className="footnote picker-note">✓ : dessert le premier (ou dernier) point de votre route. {PROCEDURE_COVERAGE}</p>
            </section>
          )}
          {route.notes.map((note) => (
            <p key={note} className="notice">
              {note}
            </p>
          ))}
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
          <ul className="route-legend" aria-label="Légende du tracé">
            <li className="departure">SID</li>
            <li className="enroute">Route</li>
            <li className="arrival">STAR et approche</li>
          </ul>
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
                  <tr key={i} className={leg.phase}>
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
            Routes vraies (Rv) et distances orthodromiques. SID et STAR d’après {PROCEDURE_SOURCE} ;
            branches sans point (montée jusqu’à une altitude…) et fin d’approche simplifiées : suivez la carte officielle.
          </p>
        </div>
      )}
    </div>
  );
}
