import { useEffect, useState } from 'react';
import { CATEGORY_LABELS, CHART_GROUPS, GROUP_LABELS, GROUP_OF, groupColor, type ChartGroup } from '../lib/chartGroups.ts';
import { fetchCharts, fetchNotams, loadDetails, type Notam, type NotamResult } from '../lib/data.ts';
import { useAirportMetar, useIvaoAtis } from '../lib/metar.ts';
import type { Airport, AirportCharts, AirportDetails, Chart, ChartCategory } from '../lib/types.ts';
import { IconClose, IconExternal, IconOverlay, IconPin } from './icons.tsx';
import { ProcedurePicker, type PickerItem } from './ProcedurePicker.tsx';
import {
  approachKey,
  loadPlacedProcedures,
  procedureKey,
  proceduresGeoJson,
  type AirportProcedureSet,
} from '../lib/procedures.ts';
import type { FeatureCollection } from 'geojson';
import { AirportWeather, CATEGORY_LABEL, formatNm } from './Weather.tsx';

const TYPE_LABELS: Record<Airport['type'], string> = {
  large_airport: 'Grand aéroport',
  medium_airport: 'Aéroport',
  small_airport: 'Aérodrome',
  heliport: 'Hélistation',
  seaplane_base: 'Hydrobase',
};

// Ordre des catégories à l'intérieur d'un groupe
const CATEGORY_ORDER: ChartCategory[] = ['VAC', 'GROUND', 'SID', 'STAR', 'APPROACH', 'OTHER', 'DATA'];

type Tab = ChartGroup | 'INFO' | 'NOTAM';

const utc = (iso: string) =>
  `${new Date(iso).toLocaleString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} UTC`;

/** Texte du NOTAM : traduction française quand elle existe, avec accès au texte original */
function NotamText({ notam }: { notam: Notam }) {
  const [original, setOriginal] = useState(false);
  const text = notam.textFr && !original ? notam.textFr : notam.text;
  return (
    <>
      <p className="notam-text">{text}</p>
      {notam.textFr && (
        <button className="link-button notam-toggle" onClick={() => setOriginal((o) => !o)}>
          {original ? 'Voir la traduction française' : 'Voir le texte original'}
        </button>
      )}
    </>
  );
}

/** NOTAM encore valables : ceux en vigueur d'abord, puis à venir par date de début */
function currentNotams(notams: Notam[], now = Date.now()): { notam: Notam; active: boolean }[] {
  return notams
    .filter((n) => !n.end || new Date(n.end).getTime() > now)
    .map((notam) => ({ notam, active: !notam.start || new Date(notam.start).getTime() <= now }))
    .sort((a, b) => Number(b.active) - Number(a.active) || (a.notam.start ?? '').localeCompare(b.notam.start ?? ''));
}

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
  /** SID et STAR choisies, à tracer sur la carte (null : aucune) */
  onShowProcedures: (features: FeatureCollection | null) => void;
}

type ChartsState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: AirportCharts };

export function AirportPanel({ airport, openChart, onOpenChart, isPinned, onTogglePin, isOverlaid, hasGeoref, onClose, onShowProcedures }: Props) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [details, setDetails] = useState<AirportDetails | null>(null);
  const [charts, setCharts] = useState<ChartsState>({ status: 'loading' });
  const [notams, setNotams] = useState<NotamResult | 'loading' | null>(null);
  const weather = useAirportMetar(airport.icao || null, airport.lat, airport.lon);
  const metar = weather.status === 'ok' ? weather.metar : undefined;
  const nearby = weather.status === 'ok' ? weather.nearby : undefined;
  const atis = useIvaoAtis(airport.icao || null);
  const [procedures, setProcedures] = useState<AirportProcedureSet | 'loading' | 'error'>('loading');
  const [shownProcedures, setShownProcedures] = useState<Set<string>>(new Set());

  // SID et STAR de l'aérodrome ; aucune affichée au changement d'aérodrome
  useEffect(() => {
    let cancelled = false;
    setShownProcedures(new Set());
    if (!airport.icao) {
      setProcedures({ procedures: [], approaches: [] });
      return;
    }
    setProcedures('loading');
    loadPlacedProcedures(airport).then(
      (list) => !cancelled && setProcedures(list),
      () => !cancelled && setProcedures('error'),
    );
    return () => {
      cancelled = true;
    };
  }, [airport]);

  useEffect(() => {
    const set = typeof procedures === 'object' ? procedures : { procedures: [], approaches: [] };
    const list = set.procedures.filter((p) => shownProcedures.has(procedureKey(p.procedure)));
    const approaches = set.approaches.filter((a) => shownProcedures.has(approachKey(a.approach)));
    onShowProcedures(list.length || approaches.length ? proceduresGeoJson(airport, list, approaches) : null);
  }, [airport, procedures, shownProcedures, onShowProcedures]);
  // Fiche fermée : plus de procédure sur la carte
  useEffect(() => () => onShowProcedures(null), [onShowProcedures]);

  const toggleProcedure = (key: string) =>
    setShownProcedures((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const showProcedures = (keys: string[], show: boolean) =>
    setShownProcedures((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (show) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  // Pastilles des SID, STAR et approches qu'on sait tracer (au moins deux points situés)
  const pickerItems = (kind: 'SID' | 'STAR' | 'APP'): PickerItem[] | 'loading' => {
    if (procedures === 'loading') return 'loading';
    if (procedures === 'error') return [];
    if (kind === 'APP') {
      return procedures.approaches
        .filter((a) => a.final.length + a.initial.length > 0)
        .map(({ approach, missing }) => ({
          key: approachKey(approach),
          label: approach.name,
          group: approach.runway,
          title: `${approach.name} piste ${approach.runway}${approach.initial.length ? ` · IAF ${approach.initial.map((b) => b.iaf).join(', ')}` : ''} · finale ${approach.final.join(' ')}${approach.missed.length ? ` · API ${approach.missed.join(' ')}` : ''}${missing.length ? ` (non situés : ${missing.join(', ')})` : ''}`,
        }));
    }
    return procedures.procedures
      .filter((p) => p.procedure.type === kind && p.points.length > 0)
      .map(({ procedure, missing }) => {
        const runways = procedure.runways.length ? ` · piste${procedure.runways.length > 1 ? 's' : ''} ${procedure.runways.join(', ')}` : '';
        // Point de transition : dernier point d'une SID, premier d'une STAR
        const transition = (kind === 'SID' ? procedure.fixes.at(-1) : procedure.fixes[0]) ?? procedure.ident;
        return {
          key: procedureKey(procedure),
          label: procedure.ident,
          group: transition,
          title: `${procedure.name}${runways} : ${procedure.fixes.join(' ')}${missing.length ? ` (non situés : ${missing.join(', ')})` : ''}`,
        };
      });
  };
  const hasProcedures = (group: ChartGroup) => {
    const kinds = group === 'DEP' ? (['SID'] as const) : group === 'ARR' ? (['STAR'] as const) : group === 'APP' ? (['APP'] as const) : [];
    return kinds.some((k) => {
      const items = pickerItems(k);
      return items !== 'loading' && items.length > 0;
    });
  };

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setTab(null);
    loadDetails(airport).then((d) => !cancelled && setDetails(d));
    setNotams(airport.icao ? 'loading' : null);
    if (airport.icao) {
      fetchNotams(airport.icao).then(
        (r) => !cancelled && setNotams(r),
        () => !cancelled && setNotams({ status: 'error', message: 'Service NOTAM injoignable' }),
      );
    }

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
    // Départs, arrivées et approches : procédures à tracer sur la carte, au-dessus des cartes officielles
    const kind = group === 'DEP' ? 'SID' : group === 'ARR' ? 'STAR' : group === 'APP' ? 'APP' : null;
    const picker = kind && (
      <ProcedurePicker
        title={kind === 'APP' ? 'Approches' : kind}
        variant={kind === 'SID' ? 'sid' : kind === 'STAR' ? 'star' : 'app'}
        items={pickerItems(kind)}
        shown={shownProcedures}
        onToggle={toggleProcedure}
        onShowAll={showProcedures}
        groupLabel={kind === 'APP' ? (runway) => `Piste ${runway}` : undefined}
        note={
          kind === 'APP'
            ? 'Seules les approches dont l’eAIP publie le tableau de codage peuvent être tracées : les approches conventionnelles (VOR, NDB, certains ILS) restent sur leurs cartes.'
            : undefined
        }
      />
    );
    return (
      <>
        {picker}
        {renderCharts(group)}
      </>
    );
  };

  const renderCharts = (group: ChartGroup) => {
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

  const notamList = notams && notams !== 'loading' && notams.status === 'ok' ? currentNotams(notams.notams) : [];

  const renderNotams = () => {
    if (notams === 'loading') return <p className="placeholder">Chargement des NOTAM…</p>;
    if (!notams) return <p className="placeholder">Ce terrain n’a pas d’indicatif OACI : pas de NOTAM.</p>;
    if (notams.status === 'error') return <p className="placeholder error">NOTAM indisponibles : {notams.message}.</p>;
    const source = (
      <p className="footnote notam-source">
        Source : {notams.source}
        {notams.issued ? `, bulletin du ${utc(notams.issued)}` : ''}. Données non certifiées.
      </p>
    );
    if (!notamList.length) {
      return (
        <>
          <p className="placeholder">Aucun NOTAM en vigueur ou à venir pour cet aérodrome.</p>
          {source}
        </>
      );
    }
    return (
      <>
      <ul className="notam-list">
        {notamList.map(({ notam, active }) => (
          <li key={notam.id} className="notam">
            <header>
              <strong>{notam.number}</strong>
              <span className="notam-category">{notam.category}</span>
              <span className={active ? 'notam-state active' : 'notam-state'}>{active ? 'En vigueur' : 'À venir'}</span>
            </header>
            <p className="notam-validity">
              {notam.start ? `Du ${utc(notam.start)}` : 'En vigueur'} {notam.end ? `au ${utc(notam.end)}${notam.estimated ? ' (estimé)' : ''}` : '· permanent'}
            </p>
            {notam.schedule && <p className="notam-validity">Horaires : {notam.schedule}</p>}
            <NotamText notam={notam} />
            {(notam.lower || notam.upper) && (
              <p className="notam-validity">
                Limites : {notam.lower ?? '—'} → {notam.upper ?? '—'}
              </p>
            )}
          </li>
        ))}
      </ul>
      {source}
      </>
    );
  };

  const renderInfo = () => {
    if (!details) return <p className="placeholder">Chargement…</p>;
    return (
      <div className="info">
        <div className="info-weather">
          <AirportWeather
            icao={airport.icao || airport.ident}
            role="Météo"
            metar={metar}
            atis={atis}
            loading={weather.status === 'loading'}
            nearby={nearby}
          />
        </div>
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
        {(weather.status !== 'none' || atis) && (
          // Résumé météo toujours visible ; le détail décodé est dans l'onglet INFO
          <button className="metar-strip" onClick={() => setTab('INFO')} title="Voir la météo décodée">
            {metar?.category && (
              <span className={`flight-category ${metar.category.toLowerCase()}`}>{CATEGORY_LABEL[metar.category] ?? metar.category}</span>
            )}
            {atis && (
              <span className="atis-badge" title={`ATIS IVAO ${atis.callsign}`}>
                ATIS {atis.letter}
              </span>
            )}
            {nearby && metar && (
              <span className="metar-nearby-badge" title={`METAR de la station la plus proche${nearby.name ? ` : ${nearby.name}` : ''}`}>
                {metar.icao} · {formatNm(nearby.distanceNm)}
              </span>
            )}
            <span className="metar-strip-text">
              {weather.status === 'loading' ? 'Chargement du METAR…' : metar ? metar.raw.replace(/^(METAR|SPECI)\s+/, '') : 'Pas de METAR'}
            </span>
          </button>
        )}
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
              // Départs et arrivées restent accessibles s'il y a des SID ou STAR à tracer, même sans carte
              disabled={charts.status === 'ok' && count === 0 && !hasProcedures(g)}
              title={GROUP_LABELS[g]}
            >
              {g}
              <span className="group-count">{charts.status === 'ok' ? count : '·'}</span>
            </button>
          );
        })}
        <button
          role="tab"
          aria-selected={activeTab === 'NOTAM'}
          className={activeTab === 'NOTAM' ? 'group-tab on' : 'group-tab'}
          style={{ '--type': 'var(--yellow-500)' } as React.CSSProperties}
          onClick={() => setTab('NOTAM')}
          title="NOTAM"
        >
          NOTAM
          <span className="group-count">{notamList.length > 0 ? notamList.length : ''}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'INFO'}
          className={activeTab === 'INFO' ? 'group-tab on' : 'group-tab'}
          style={{ '--type': 'var(--gray-400)' } as React.CSSProperties}
          onClick={() => setTab('INFO')}
          title="Informations"
        >
          INFO
          <span className="group-count" />
        </button>
      </nav>

      <div className="airport-body">
        {charts.status === 'ok' && !charts.data.provider && airport.icao && (
          <p className="notice">
            Cartes officielles pas encore disponibles pour ce pays : aucune source gratuite n’est prise en charge. Les
            informations et le plan au sol restent consultables.
          </p>
        )}
        {activeTab === 'INFO' ? renderInfo() : activeTab === 'NOTAM' ? renderNotams() : renderGroup(activeTab)}
        {activeTab !== 'INFO' && activeTab !== 'NOTAM' && charts.status === 'ok' && charts.data.charts.length > 0 && (
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
