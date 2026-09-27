import { useEffect, useState } from 'react';
import { CATEGORY_LABELS, CHART_GROUPS, GROUP_LABELS, GROUP_OF, groupColor, type ChartGroup } from '../lib/chartGroups.ts';
import { fetchCharts, loadDetails } from '../lib/data.ts';
import type { Airport, AirportCharts, AirportDetails, Chart, ChartCategory } from '../lib/types.ts';
import { IconClose, IconExternal, IconOverlay, IconPin } from './icons.tsx';

const TYPE_LABELS: Record<Airport['type'], string> = {
  large_airport: 'Grand aéroport',
  medium_airport: 'Aéroport',
  small_airport: 'Aérodrome',
  heliport: 'Hélistation',
  seaplane_base: 'Hydrobase',
};

// Ordre des catégories à l'intérieur d'un groupe
const CATEGORY_ORDER: ChartCategory[] = ['VAC', 'GROUND', 'SID', 'STAR', 'APPROACH', 'OTHER', 'DATA'];

type Tab = ChartGroup | 'INFO';

interface Props {
  airport: Airport;
  openChart: Chart | null;
  onOpenChart: (chart: Chart) => void;
  isPinned: (id: string) => boolean;
  onTogglePin: (chart: Chart) => void;
  /** Carte actuellement superposée sur la map */
  isOverlaid: (id: string) => boolean;
  /** Carte déjà calée (superposable) */
  hasGeoref: (id: string) => boolean;
  onClose: () => void;
}

type ChartsState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: AirportCharts };

export function AirportPanel({ airport, openChart, onOpenChart, isPinned, onTogglePin, isOverlaid, hasGeoref, onClose }: Props) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [details, setDetails] = useState<AirportDetails | null>(null);
  const [charts, setCharts] = useState<ChartsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setTab(null);
    loadDetails(airport).then((d) => !cancelled && setDetails(d));

    if (!airport.icao) {
      setCharts({ status: 'ok', data: { icao: '', airac: '', effective: '', charts: [], sourceUrl: null, provider: null } });
    } else {
      setCharts({ status: 'loading' });
      fetchCharts(airport.icao).then(
        (data) => !cancelled && setCharts({ status: 'ok', data }),
        (err: Error) => !cancelled && setCharts({ status: 'error', message: err.message }),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [airport]);

  const list = charts.status === 'ok' ? charts.data.charts : [];
  const countOf = (g: ChartGroup) => list.filter((c) => GROUP_OF[c.category] === g).length;
  // Onglet par défaut : le premier groupe qui contient des cartes, sinon les informations
  const activeTab: Tab = tab ?? (charts.status === 'ok' ? (CHART_GROUPS.find((g) => countOf(g) > 0) ?? 'INFO') : 'APT');

  const renderChart = (chart: Chart) => {
    const pinned = isPinned(chart.id);
    return (
      <li
        key={chart.id}
        className={openChart?.id === chart.id ? 'chart-row active' : 'chart-row'}
        style={{ '--type': groupColor(GROUP_OF[chart.category]) } as React.CSSProperties}
      >
        <button className="chart-row-main" onClick={() => onOpenChart(chart)} title={chart.title}>
          <span className="chart-row-title">{chart.title}</span>
        </button>
        {hasGeoref(chart.id) && (
          <span className={isOverlaid(chart.id) ? 'chart-row-flag on' : 'chart-row-flag'} title="Carte calée : superposable sur la map">
            <IconOverlay size={15} />
          </span>
        )}
        <button
          className={pinned ? 'chart-row-pin on' : 'chart-row-pin'}
          onClick={() => onTogglePin(chart)}
          aria-label={pinned ? 'Retirer du pinboard' : 'Épingler'}
          title={pinned ? 'Retirer du pinboard' : 'Épingler'}
        >
          <IconPin size={16} filled={pinned} />
        </button>
      </li>
    );
  };

  const renderGroup = (group: ChartGroup) => {
    if (charts.status === 'loading') return <p className="placeholder">Chargement des cartes officielles…</p>;
    if (charts.status === 'error') return <p className="placeholder error">Impossible de charger les cartes : {charts.message}</p>;
    const items = list.filter((c) => GROUP_OF[c.category] === group);
    if (items.length === 0) {
      let message = `Aucune carte « ${GROUP_LABELS[group]} » pour ce terrain.`;
      if (list.length === 0) {
        if (!airport.icao) message = 'Ce terrain n’a pas d’indicatif OACI : aucune carte officielle.';
        else if (charts.data.provider) message = `Aucune carte publiée pour ce terrain (source : ${charts.data.provider}).`;
        else message = 'Les cartes de ce pays ne sont pas encore disponibles : aucune source officielle gratuite n’est prise en charge pour l’instant.';
      }
      return <p className="placeholder">{message}</p>;
    }
    const categories = CATEGORY_ORDER.filter((cat) => items.some((c) => c.category === cat));
    return categories.map((cat) => (
      <section key={cat}>
        {categories.length > 1 && <h3 className="list-heading">{CATEGORY_LABELS[cat]}</h3>}
        <ul className="chart-list">{items.filter((c) => c.category === cat).map(renderChart)}</ul>
      </section>
    ));
  };

  const renderInfo = () => {
    if (!details) return <p className="placeholder">Chargement…</p>;
    return (
      <div className="info">
        <dl className="facts">
          <div>
            <dt>Type</dt>
            <dd>{TYPE_LABELS[airport.type]}</dd>
          </div>
          {details.elevationFt !== null && (
            <div>
              <dt>Altitude</dt>
              <dd>{details.elevationFt} ft</dd>
            </div>
          )}
          <div>
            <dt>Position</dt>
            <dd className="mono">
              {airport.lat.toFixed(4)}° {airport.lon.toFixed(4)}°
            </dd>
          </div>
          {airport.iata && (
            <div>
              <dt>IATA</dt>
              <dd>{airport.iata}</dd>
            </div>
          )}
        </dl>

        {details.runways.length > 0 && (
          <>
            <h3 className="list-heading">Pistes</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Piste</th>
                  <th>Longueur</th>
                  <th>Revêtement</th>
                  <th>QFU</th>
                </tr>
              </thead>
              <tbody>
                {details.runways.map((r) => (
                  <tr key={r.ident}>
                    <td className="mono strong">{r.ident}</td>
                    <td>{r.lengthFt ? `${Math.round(r.lengthFt * 0.3048)} m` : '—'}</td>
                    <td>{r.surface || '—'}</td>
                    <td className="mono">
                      {r.ends
                        .map((e) => (e.headingT !== null ? `${String(Math.round(e.headingT)).padStart(3, '0')}°` : '—'))
                        .join(' / ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {details.frequencies.length > 0 && (
          <>
            <h3 className="list-heading">Fréquences</h3>
            <table className="table">
              <tbody>
                {details.frequencies.map((f, i) => (
                  <tr key={i}>
                    <td className="mono strong">{f.type}</td>
                    <td>{f.description}</td>
                    <td className="mono right">{f.mhz.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <p className="footnote">Pistes et fréquences : OurAirports (communautaire). Référez-vous toujours aux cartes officielles.</p>
      </div>
    );
  };

  return (
    <div className="airport">
      <header className="airport-header">
        <div className="airport-ident">
          <h2>{airport.icao || airport.ident}</h2>
          {airport.iata && <span className="chip">{airport.iata}</span>}
          <button className="icon-button" onClick={onClose} aria-label="Fermer" title="Fermer">
            <IconClose size={18} />
          </button>
        </div>
        <div className="airport-name">{airport.name}</div>
        {airport.city && <div className="airport-city">{airport.city}</div>}
      </header>

      <nav className="group-tabs" role="tablist">
        {CHART_GROUPS.map((g) => {
          const count = countOf(g);
          return (
            <button
              key={g}
              role="tab"
              aria-selected={activeTab === g}
              className={activeTab === g ? 'group-tab on' : 'group-tab'}
              style={{ '--type': groupColor(g) } as React.CSSProperties}
              onClick={() => setTab(g)}
              disabled={charts.status === 'ok' && count === 0}
              title={GROUP_LABELS[g]}
            >
              {g}
              <span className="group-count">{charts.status === 'ok' ? count : '·'}</span>
            </button>
          );
        })}
        <button
          role="tab"
          aria-selected={activeTab === 'INFO'}
          className={activeTab === 'INFO' ? 'group-tab on' : 'group-tab'}
          style={{ '--type': 'var(--gray-400)' } as React.CSSProperties}
          onClick={() => setTab('INFO')}
          title="Informations"
        >
          INFO
        </button>
      </nav>

      <div className="airport-body">
        {charts.status === 'ok' && !charts.data.provider && airport.icao && (
          <p className="notice">
            Cartes officielles pas encore disponibles pour ce pays : aucune source gratuite n’est prise en charge. Les
            informations et le plan au sol restent consultables.
          </p>
        )}
        {activeTab === 'INFO' ? renderInfo() : renderGroup(activeTab)}
        {activeTab !== 'INFO' && charts.status === 'ok' && charts.data.charts.length > 0 && (
          <footer className="airport-footer">
            <span>
              {charts.data.provider} · AIRAC {charts.data.airac}
            </span>
            {charts.data.sourceUrl && (
              <a href={charts.data.sourceUrl} target="_blank" rel="noreferrer">
                Page AD 2 <IconExternal size={13} />
              </a>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
