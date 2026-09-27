import { useCallback, useEffect, useMemo, useState } from 'react';
import { AirportPanel } from './components/AirportPanel.tsx';
import { ChartViewer } from './components/ChartViewer.tsx';
import { FlightPanel } from './components/FlightPanel.tsx';
import { IconCharts, IconChevronLeft, IconLayers, IconPlane } from './components/icons.tsx';
import { LayerControl, useLayerVisibility } from './components/LayerControl.tsx';
import { MapView, type MapOverlay, type SnapPoint } from './components/MapView.tsx';
import { CalibrationBar, OverlayPanel } from './components/OverlayControls.tsx';
import { Pinboard } from './components/Pinboard.tsx';
import { SearchBox } from './components/SearchBox.tsx';
import { fetchAutoGeoref, loadAirports, loadDetails, type AutoGeoref } from './lib/data.ts';
import { usePins } from './lib/pins.ts';
import { parseRoute, routeGeoJson, type FlightRoute } from './lib/route.ts';
import { fitTransform, pageCorners, useGeorefs, type ControlPoint, type LngLat, type PdfPoint } from './lib/georef.ts';
import { renderOverlay, type OverlayImage, type OverlayStyle } from './lib/pdf.ts';
import type { Airport, Chart } from './lib/types.ts';

// L'aérodrome sélectionné est reflété dans l'URL (#LFPG) pour pouvoir le partager ou le retrouver.
const identFromHash = () => decodeURIComponent(location.hash.slice(1)).toUpperCase();

interface Calibration {
  chart: Chart;
  points: ControlPoint[];
  /** Point désigné sur le PDF, en attente de son équivalent sur la map */
  pending: PdfPoint | null;
  notice?: string;
}

type AutoGeorefState = { status: 'loading' } | { status: 'none' } | { status: 'ok'; data: AutoGeoref };

type OverlayImageState = { url: string; style: OverlayStyle } & (
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: OverlayImage }
);

const ROUTE_KEY = 'navicharts:route';
const NO_SNAP: SnapPoint[] = [];
const NO_POINTS: LngLat[] = [];
const NO_CONTROL_POINTS: ControlPoint[] = [];

export function App() {
  const [airports, setAirports] = useState<Airport[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [selectedIdent, setSelectedIdent] = useState(identFromHash);
  const [chart, setChart] = useState<Chart | null>(null);
  const pins = usePins();
  const { layers, toggle: toggleLayer } = useLayerVisibility();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerView, setDrawerView] = useState<'charts' | 'flight'>('charts');
  const [layersOpen, setLayersOpen] = useState(false);

  // Plan de vol : dernière route saisie, mémorisée dans le navigateur
  const [routeText, setRouteText] = useState(() => {
    try {
      return localStorage.getItem(ROUTE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [flightRoute, setFlightRoute] = useState<FlightRoute | null>(null);
  const [routeStatus, setRouteStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const routeFeatures = useMemo(() => (flightRoute ? routeGeoJson(flightRoute) : null), [flightRoute]);

  const showRoute = useCallback(async () => {
    try {
      localStorage.setItem(ROUTE_KEY, routeText);
    } catch {
      // route non mémorisée
    }
    setRouteStatus('loading');
    try {
      setFlightRoute(await parseRoute(routeText));
      setRouteStatus('idle');
    } catch {
      setRouteStatus('error');
    }
  }, [routeText]);

  /** Bouton du rail : ouvre la vue demandée, ou replie le panneau si elle est déjà affichée */
  const toggleDrawer = (view: 'charts' | 'flight') => {
    if (drawerOpen && drawerView === view) setDrawerOpen(false);
    else {
      setDrawerView(view);
      setDrawerOpen(true);
    }
  };

  const { georefs, save: saveGeoref } = useGeorefs();
  const [calib, setCalib] = useState<Calibration | null>(null);
  const [overlayChart, setOverlayChart] = useState<Chart | null>(null);
  const [overlayStyle, setOverlayStyle] = useState<OverlayStyle>('original');
  const [opacity, setOpacity] = useState(0.7);
  const [overlayImage, setOverlayImage] = useState<OverlayImageState | null>(null);
  const [snapPoints, setSnapPoints] = useState<SnapPoint[]>(NO_SNAP);
  const [autoGeorefs, setAutoGeorefs] = useState<Record<string, AutoGeorefState>>({});

  useEffect(() => {
    loadAirports().then(setAirports, () => setLoadError(true));
    const onHash = () => setSelectedIdent(identFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selected = useMemo(
    () => (selectedIdent ? (airports.find((a) => a.ident === selectedIdent || a.icao === selectedIdent) ?? null) : null),
    [airports, selectedIdent],
  );

  const select = useCallback((ident: string) => {
    setChart(null);
    setCalib(null);
    setSelectedIdent(ident);
    history.replaceState(null, '', ident ? `#${ident}` : location.pathname);
  }, []);

  // ───────── Superposition ─────────

  const overlayTarget = calib?.chart ?? overlayChart;

  // Rendu de l'image superposée (une fois par carte et par style)
  useEffect(() => {
    if (!overlayTarget) {
      setOverlayImage(null);
      return;
    }
    const url = overlayTarget.url;
    const style = overlayStyle;
    let cancelled = false;
    setOverlayImage({ url, style, status: 'loading' });
    renderOverlay(url, style).then(
      (data) => !cancelled && setOverlayImage({ url, style, status: 'ready', data }),
      () => !cancelled && setOverlayImage({ url, style, status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [overlayTarget?.url, overlayStyle]);

  // Calage retenu : manuel s'il existe (l'utilisateur l'a voulu), sinon automatique
  const autoOf = (id: string) => {
    const a = autoGeorefs[id];
    return a?.status === 'ok' ? a.data : undefined;
  };
  const activePoints =
    calib?.points ??
    (overlayChart && (georefs[overlayChart.id]?.points ?? autoOf(overlayChart.id)?.points)) ??
    NO_CONTROL_POINTS;
  const transform = useMemo(() => fitTransform(activePoints), [activePoints]);

  const mapOverlay = useMemo<MapOverlay | null>(() => {
    if (!overlayTarget || !transform || overlayImage?.status !== 'ready' || overlayImage.url !== overlayTarget.url) {
      return null;
    }
    return {
      id: overlayTarget.id,
      image: overlayImage.data.image,
      corners: pageCorners(transform, overlayImage.data.view),
      // Plus transparente pendant le calage pour laisser voir les repères
      opacity: calib ? Math.min(opacity, 0.55) : opacity,
      fit: !calib,
    };
  }, [overlayTarget, transform, overlayImage, opacity, calib]);

  // Aérodrome d'une carte : son identifiant contient l'indicatif OACI (AD_2_LFPG_…, EGLL_3_…)
  const airportOf = useCallback(
    (chartId: string) => {
      const codes: string[] = chartId.match(/[A-Z]{4}/g) ?? [];
      return airports.find((a) => a.icao && codes.includes(a.icao));
    },
    [airports],
  );

  // Repères d'aimantation : seuils de piste de l'aérodrome de la carte
  const calibChartId = calib?.chart.id;
  useEffect(() => {
    const airport = calibChartId && airportOf(calibChartId);
    if (!airport) {
      setSnapPoints(NO_SNAP);
      return;
    }
    let cancelled = false;
    loadDetails(airport).then((d) => {
      if (cancelled || !d) return;
      const ends = d.runways.flatMap((r) =>
        r.ends
          .filter((e) => e.lat !== null && e.lon !== null)
          .map((e) => ({ label: `THR ${e.ident}`, lngLat: [e.lon!, e.lat!] as LngLat })),
      );
      setSnapPoints(ends);
    });
    return () => {
      cancelled = true;
    };
  }, [calibChartId, airportOf]);

  const startCalibration = useCallback((target: Chart, points: ControlPoint[], notice?: string) => {
    setCalib({ chart: target, points, pending: null, notice });
    setOverlayChart(target);
    setChart(target);
  }, []);

  const showOverlay = useCallback((target: Chart) => {
    setOverlayChart(target);
    setChart(null);
  }, []);

  // « Superposer » : calage manuel existant, sinon calage automatique, sinon calage manuel à faire
  const overlayFromViewer = useCallback(async () => {
    if (!chart) return;
    const target = chart;
    if (georefs[target.id]?.points.length >= 2 || autoOf(target.id)) return showOverlay(target);
    if (autoGeorefs[target.id]?.status === 'loading') return;

    setAutoGeorefs((prev) => ({ ...prev, [target.id]: { status: 'loading' } }));
    const auto = await fetchAutoGeoref(target.url, airportOf(target.id)).catch(() => null);
    setAutoGeorefs((prev) => ({ ...prev, [target.id]: auto ? { status: 'ok', data: auto } : { status: 'none' } }));
    if (auto) showOverlay(target);
    else startCalibration(target, [], "Calage automatique impossible : cette carte n'a pas de graduations exploitables (carte schématique ou sans échelle).");
  }, [chart, georefs, autoGeorefs, airportOf, showOverlay, startCalibration]);

  const cancelCalibration = useCallback(() => {
    if (calib && !georefs[calib.chart.id] && !autoOf(calib.chart.id)) setOverlayChart(null);
    setCalib(null);
  }, [calib, georefs]);

  const finishCalibration = () => {
    if (!calib) return;
    saveGeoref(calib.chart.id, calib.points);
    setOverlayChart(calib.chart);
    setCalib(null);
    setChart(null);
  };

  const undoPoint = () =>
    setCalib((c) => c && (c.pending ? { ...c, pending: null } : { ...c, points: c.points.slice(0, -1) }));

  const onMapPick = useCallback(
    (lngLat: LngLat) =>
      setCalib((c) => (c?.pending ? { ...c, points: [...c.points, { pdf: c.pending, lngLat }], pending: null } : c)),
    [],
  );

  const openChart = useCallback((c: Chart) => {
    setCalib(null);
    setChart(c);
  }, []);

  const closeChart = useCallback(() => {
    if (calib) cancelCalibration();
    setChart(null);
  }, [calib, cancelCalibration]);

  const calibrating = calib && chart && calib.chart.id === chart.id ? calib : null;
  const controlPoints = useMemo(() => calib?.points.map((p) => p.lngLat) ?? NO_POINTS, [calib?.points]);
  const overlayGeoref = overlayChart ? georefs[overlayChart.id] : undefined;
  const overlayAuto = overlayChart && !overlayGeoref ? autoOf(overlayChart.id) : undefined;

  return (
    <div className={['app', drawerOpen && 'drawer-open', chart && !calib?.pending && 'with-chart'].filter(Boolean).join(' ')}>
      <nav className="rail" aria-label="Navigation">
        <div className="rail-mark" aria-hidden>
          ✦
        </div>
        <button
          className={drawerOpen && drawerView === 'charts' ? 'rail-button on' : 'rail-button'}
          onClick={() => toggleDrawer('charts')}
          title="Aérodromes et cartes"
          aria-pressed={drawerOpen && drawerView === 'charts'}
        >
          <IconCharts />
          <span>Cartes</span>
        </button>
        <button
          className={drawerOpen && drawerView === 'flight' ? 'rail-button on' : 'rail-button'}
          onClick={() => toggleDrawer('flight')}
          title="Plan de vol"
          aria-pressed={drawerOpen && drawerView === 'flight'}
        >
          <IconPlane />
          <span>Vol</span>
        </button>
        <button
          className={layersOpen ? 'rail-button on' : 'rail-button'}
          onClick={() => setLayersOpen((o) => !o)}
          title="Couches de la carte"
          aria-pressed={layersOpen}
        >
          <IconLayers />
          <span>Couches</span>
        </button>
      </nav>

      <aside className="drawer" inert={!drawerOpen}>
        <div className="drawer-inner">
          <div className="drawer-head">
            <SearchBox airports={airports} onSelect={select} />
            <button className="icon-button" onClick={() => setDrawerOpen(false)} aria-label="Replier le panneau" title="Replier">
              <IconChevronLeft size={18} />
            </button>
          </div>
          {loadError && (
            <p className="placeholder error">
              Données introuvables. Lancez <code>npm run data</code> puis rechargez la page.
            </p>
          )}
          {drawerView === 'flight' ? (
            <FlightPanel
              text={routeText}
              onText={setRouteText}
              route={flightRoute}
              status={routeStatus}
              onShow={showRoute}
              onClear={() => setFlightRoute(null)}
              onSelectAirport={(ident) => {
                select(ident);
                setDrawerView('charts');
              }}
              onOpenChart={openChart}
              openChart={chart}
            />
          ) : selected ? (
            <AirportPanel
              airport={selected}
              openChart={chart}
              onOpenChart={openChart}
              isPinned={pins.isPinned}
              onTogglePin={(c) => pins.toggle(selected.icao || selected.ident, c)}
              isOverlaid={(id) => overlayChart?.id === id}
              hasGeoref={(id) => Boolean(georefs[id] || autoOf(id))}
              onClose={() => select('')}
            />
          ) : (
            <div className="welcome">
              <h2>Cartes aéronautiques d’Europe</h2>
              <p>Recherchez un aérodrome par code OACI, IATA, nom ou ville, ou cliquez sur un terrain de la carte.</p>
              <p className="footnote">
                Cartes officielles disponibles : France (SIA, eAIP et atlas VAC), Royaume-Uni, Finlande, Estonie et
                Islande (eAIP nationales), cycle AIRAC en vigueur. Espaces aériens, routes et points de report : France
                uniquement. Données non certifiées, réservées à la simulation de vol. Ne pas utiliser pour la navigation
                réelle.
              </p>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="stage">
          <MapView
            selected={selected}
            onSelect={select}
            overlay={mapOverlay}
            picking={Boolean(calib?.pending)}
            onPick={onMapPick}
            snapPoints={calib ? snapPoints : NO_SNAP}
            controlPoints={controlPoints}
            layers={layers}
            route={routeFeatures}
          />
          {layersOpen && <LayerControl layers={layers} onToggle={toggleLayer} onClose={() => setLayersOpen(false)} />}
          {overlayChart && !calib && (
            <OverlayPanel
              chart={overlayChart}
              status={overlayImage?.status ?? 'loading'}
              opacity={opacity}
              style={overlayStyle}
              source={
                overlayAuto
                  ? { kind: 'auto', graduations: overlayAuto.graduations, rmsMeters: overlayAuto.rmsMeters }
                  : { kind: 'manual', points: overlayGeoref?.points.length ?? 0, rmsMeters: transform?.rmsMeters ?? null }
              }
              onOpacity={setOpacity}
              onStyle={setOverlayStyle}
              onShowChart={() => setChart(overlayChart)}
              onRefine={overlayGeoref ? () => startCalibration(overlayChart, overlayGeoref.points) : undefined}
              onRecalibrate={() => startCalibration(overlayChart, [])}
              onRemove={() => setOverlayChart(null)}
            />
          )}
          {chart && (
            <ChartViewer
              chart={chart}
              onClose={closeChart}
              onOverlay={overlayFromViewer}
              overlayBusy={autoGeorefs[chart.id]?.status === 'loading'}
              onPick={calibrating && !calibrating.pending ? (p) => setCalib({ ...calibrating, pending: p }) : undefined}
              markers={calibrating ? [...calibrating.points.map((p) => p.pdf), ...(calibrating.pending ? [calibrating.pending] : [])] : []}
              hidden={Boolean(calibrating?.pending)}
            />
          )}
          {calib && (
            <CalibrationBar
              step={calib.pending ? 'map' : 'chart'}
              pointCount={calib.points.length}
              rmsMeters={transform?.rmsMeters ?? null}
              notice={calib.notice}
              onUndo={undoPoint}
              onFinish={finishCalibration}
              onCancel={cancelCalibration}
            />
          )}
        </div>
        <Pinboard
          pins={pins.pins}
          displayed={chart}
          onOpen={(pin) => openChart(pin.chart)}
          onRemove={pins.remove}
        />
      </main>
    </div>
  );
}
