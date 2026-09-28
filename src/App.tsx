import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AirportPanel } from './components/AirportPanel.tsx';
import { AirspacePanel } from './components/AirspacePanel.tsx';
import { NavaidPanel } from './components/NavaidPanel.tsx';
import { NatPanel } from './components/NatPanel.tsx';
import { VersionBadge } from './components/VersionBadge.tsx';
import { ChartViewer } from './components/ChartViewer.tsx';
import { FlightPanel } from './components/FlightPanel.tsx';
import { IconCharts, IconChevronLeft, IconLayers, IconPlane } from './components/icons.tsx';
import { LayerControl, useLayerVisibility } from './components/LayerControl.tsx';
import { MapView, type MapOverlay, type SnapPoint } from './components/MapView.tsx';
import { CalibrationBar, OverlayPanel } from './components/OverlayControls.tsx';
import { Pinboard } from './components/Pinboard.tsx';
import { RouteStrip } from './components/RouteStrip.tsx';
import { SearchBox } from './components/SearchBox.tsx';
import { fetchAutoGeoref, loadAirports, loadDetails, type AutoGeoref } from './lib/data.ts';
import { usePins } from './lib/pins.ts';
import { useNatTracks } from './lib/nat.ts';
import { flightPlanText, trafficGeoJson, useIvaoPilot, useIvaoTraffic } from './lib/ivao.ts';
import { editRoute, parseRoute, routeGeoJson, routeProgress, type FlightRoute, type RouteChange } from './lib/route.ts';
import { fitTransform, pageCorners, useGeorefs, type ControlPoint, type LngLat, type PdfPoint } from './lib/georef.ts';
import { renderOverlay, type OverlayImage, type OverlayStyle } from './lib/pdf.ts';
import type { Airport, Chart } from './lib/types.ts';
import type { AirspaceInfo } from './lib/aeroLayers.ts';
import type { NavaidInfo } from './lib/navaid.ts';

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
const IVAO_VID_KEY = 'navicharts:ivao-vid';
const NO_TRAIL: LngLat[] = [];

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function store(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // préférence non mémorisée
  }
}
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
  // Espace aérien autorouter mis en évidence sur la carte, détaillé dans le panneau (test local)
  const [airspace, setAirspace] = useState<AirspaceInfo | null>(null);
  // Balise choisie sur la carte ou dans la recherche, détaillée dans le panneau
  const [navaid, setNavaid] = useState<NavaidInfo | null>(null);
  const showAirspace = useCallback((a: AirspaceInfo | null) => {
    setAirspace(a);
    if (a) {
      setNavaid(null);
      setNatSelected(null);
      setDrawerOpen(true);
      setDrawerView('charts');
    }
  }, []);
  const showNavaid = useCallback((n: NavaidInfo) => {
    setNavaid(n);
    setAirspace(null);
    setNatSelected(null);
    setDrawerOpen(true);
    setDrawerView('charts');
  }, []);
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
  const [mapFocus, setMapFocus] = useState<{ lngLat: LngLat; label?: string } | null>(null);
  const [routeStatus, setRouteStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const routeFeatures = useMemo(() => (flightRoute ? routeGeoJson(flightRoute) : null), [flightRoute]);

  const traceRoute = useCallback(async (text: string) => {
    try {
      localStorage.setItem(ROUTE_KEY, text);
    } catch {
      // route non mémorisée
    }
    setRouteStatus('loading');
    try {
      setFlightRoute(await parseRoute(text));
      setRouteStatus('idle');
    } catch {
      setRouteStatus('error');
    }
  }, []);

  // ───────── IVAO ─────────

  const traffic = useIvaoTraffic(layers.ivao);
  // Track NAT choisi sur la carte, détaillé dans le panneau
  const [natSelected, setNatSelected] = useState<string | null>(null);
  const nat = useNatTracks(layers.nat, natSelected);
  const natTrack = natSelected ? (nat.tracks.find((t) => t.id === natSelected) ?? null) : null;
  const showNatTrack = useCallback((id: string | null) => {
    setNatSelected(id);
    if (id) {
      setAirspace(null);
      setNavaid(null);
      setDrawerOpen(true);
      setDrawerView('charts');
    }
  }, []);
  const [ivaoVid, setIvaoVid] = useState(() => readStored(IVAO_VID_KEY));
  const [follow, setFollow] = useState(false);
  const own = useIvaoPilot(ivaoVid || null);
  const ownPilot = own.data?.pilot ?? null;
  const [trail, setTrail] = useState<{ session: number; points: LngLat[] } | null>(null);
  const importedPlan = useRef<string | null>(null);

  const linkIvao = useCallback((vid: string) => {
    store(IVAO_VID_KEY, vid);
    setIvaoVid(vid);
    setTrail(null);
    importedPlan.current = null;
    if (!vid) setFollow(false);
  }, []);

  // Trace parcourue, accumulée au fil des positions reçues pendant la session
  useEffect(() => {
    if (!ownPilot) return;
    const here: LngLat = [ownPilot.lon, ownPilot.lat];
    setTrail((prev) => {
      if (!prev || prev.session !== ownPilot.sessionId) return { session: ownPilot.sessionId, points: [here] };
      const last = prev.points.at(-1)!;
      return last[0] === here[0] && last[1] === here[1] ? prev : { ...prev, points: [...prev.points, here] };
    });
  }, [ownPilot]);

  // Plan de vol déposé sur IVAO : importé et tracé à chaque nouveau plan ou nouvelle révision
  const ownPlan = own.data?.flightPlan ?? null;
  useEffect(() => {
    if (!ownPlan?.route && !ownPlan?.departure) return;
    const key = `${ownPlan.id}:${ownPlan.revision}`;
    if (importedPlan.current === key) return;
    importedPlan.current = key;
    const text = flightPlanText(ownPlan);
    setRouteText(text);
    traceRoute(text);
  }, [ownPlan, traceRoute]);

  const trafficFeatures = useMemo(
    () => (layers.ivao && traffic.data ? trafficGeoJson(traffic.data, ownPilot?.vid ?? null) : null),
    [layers.ivao, traffic.data, ownPilot?.vid],
  );
  const ownAircraft = useMemo(
    () => (ownPilot ? { lngLat: [ownPilot.lon, ownPilot.lat] as LngLat, heading: ownPilot.heading, callsign: ownPilot.callsign } : null),
    [ownPilot],
  );
  const progress = useMemo(
    () => (flightRoute && ownPilot ? routeProgress(flightRoute, [ownPilot.lon, ownPilot.lat]) : null),
    [flightRoute, ownPilot],
  );

  // Piste, SID ou STAR choisie dans le panneau : la route texte est réécrite puis retracée
  const changeRoute = useCallback(
    (change: RouteChange) => {
      if (!flightRoute) return;
      const text = editRoute(routeText, flightRoute, change);
      setRouteText(text);
      traceRoute(text);
    },
    [flightRoute, routeText, traceRoute],
  );

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
    setAirspace(null);
    setNavaid(null);
    setNatSelected(null);
    setMapFocus(null);
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
        <VersionBadge />
      </nav>

      <aside className="drawer" inert={!drawerOpen}>
        <div className="drawer-inner">
          <div className="drawer-head">
            <SearchBox
              airports={airports}
              onSelect={select}
              onSelectPoint={(p) => {
                setMapFocus({ lngLat: p.lngLat, label: p.ident });
                if (p.kind === 'navaid') showNavaid({ ident: p.ident, name: p.name, type: p.type, lngLat: p.lngLat });
              }}
            />
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
              onShow={() => traceRoute(routeText)}
              onChange={changeRoute}
              ivao={{
                vid: ivaoVid,
                onLink: linkIvao,
                pilot: ownPilot,
                flightPlan: ownPlan,
                loading: Boolean(ivaoVid) && !own.data && !own.error,
                error: own.error,
                follow,
                onFollow: setFollow,
                progress,
              }}
              onClear={() => setFlightRoute(null)}
              onSelectAirport={(ident) => {
                select(ident);
                setDrawerView('charts');
              }}
              onOpenChart={openChart}
              openChart={chart}
            />
          ) : natTrack ? (
            <NatPanel track={natTrack} onClose={() => setNatSelected(null)} />
          ) : airspace ? (
            <AirspacePanel airspace={airspace} onClose={() => setAirspace(null)} />
          ) : navaid ? (
            <NavaidPanel navaid={navaid} onClose={() => setNavaid(null)} />
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
        <div className={flightRoute ? 'stage with-route' : 'stage'}>
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
            focus={mapFocus}
            traffic={trafficFeatures}
            nat={nat.geojson}
            natSelected={natSelected}
            onNatTrack={showNatTrack}
            ownAircraft={ownAircraft}
            ownTrail={trail?.points ?? NO_TRAIL}
            follow={follow}
            airspace={airspace}
            onAirspace={showAirspace}
            navaid={navaid}
            onNavaid={showNavaid}
          />
          {flightRoute && (
            <RouteStrip
              route={flightRoute}
              nextLeg={progress?.legIndex ?? null}
              onFocus={(lngLat) => setMapFocus({ lngLat })}
              onClear={() => setFlightRoute(null)}
            />
          )}
          <button
            className={layersOpen ? 'map-layers-button on' : 'map-layers-button'}
            onClick={() => setLayersOpen((o) => !o)}
            title="Couches de la carte"
            aria-pressed={layersOpen}
          >
            <IconLayers size={18} />
            <span>Couches</span>
          </button>
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
