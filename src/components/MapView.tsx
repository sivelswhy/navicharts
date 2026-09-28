import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, ImageSource, MapLayerMouseEvent, PointLike } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { loadAeroIcons } from '../lib/aeroIcons.ts';
import type { NavaidInfo } from '../lib/navaid.ts';
import { addAeroLayers, airspaceKey, GROUND_SOURCE, highlightAirspace, type AirspaceInfo, IVAO_ATCS_SOURCE, IVAO_PILOTS_SOURCE, NAT_SOURCE, setGroupVisibility, type LayerGroup } from '../lib/aeroLayers.ts';
import type { LngLat } from '../lib/georef.ts';
import { baseStyle, FONT_BOLD, FONT_REGULAR } from '../lib/mapStyle.ts';
import type { Airport } from '../lib/types.ts';

// MapLibre 6 charge ses workers depuis un fichier séparé, que la pré-compilation de Vite ne sait pas retrouver.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const SNAP_PX = 14;

/** Contrôle MapLibre vide dont le contenu est rendu par React (portail) */
class PortalControl implements maplibregl.IControl {
  readonly element = document.createElement('div');
  constructor(className: string) {
    this.element.className = `maplibregl-ctrl maplibregl-ctrl-group ${className}`;
  }
  onAdd() {
    return this.element;
  }
  onRemove() {
    this.element.remove();
  }
}
// Plan au sol : chargé à partir de ce zoom pour les aérodromes les plus proches du centre de la carte
const GROUND_MIN_ZOOM = 12;
const GROUND_MAX_AIRPORTS = 4;
const GROUND_RETRY_MS = 60_000;

type Corners = [LngLat, LngLat, LngLat, LngLat];

export interface MapOverlay {
  /** Identifiant de la carte superposée (recentrage quand il change) */
  id: string;
  image: ImageBitmap | null;
  corners: Corners;
  opacity: number;
  /** Cadrer la map sur la carte à sa première apparition (désactivé pendant le calage) */
  fit: boolean;
}

export interface SnapPoint {
  label: string;
  lngLat: LngLat;
}

interface Props {
  selected: Airport | null;
  onSelect: (ident: string) => void;
  overlay: MapOverlay | null;
  /** Mode calage : le prochain clic désigne un point (aimanté aux repères proches) */
  picking: boolean;
  onPick: (lngLat: LngLat) => void;
  snapPoints: SnapPoint[];
  controlPoints: LngLat[];
  layers: Record<LayerGroup, boolean>;
  /** Trajet du plan de vol (segments et points) */
  route: FeatureCollection | null;
  /** Point sur lequel centrer la carte (nouvel objet à chaque demande), repéré sur la carte s'il a un nom */
  focus: { lngLat: LngLat; label?: string } | null;
  /** Trafic IVAO (avions et contrôleurs) */
  traffic: { pilots: FeatureCollection; atcs: FeatureCollection } | null;
  /** Tracks NAT (lignes et points de report) */
  nat: FeatureCollection;
  /** Track NAT cliqué (null : clic hors des tracks alors qu'un track est choisi) */
  onNatTrack: (id: string | null) => void;
  natSelected: string | null;
  /** Avion suivi (vol IVAO de l'utilisateur) et trace déjà parcourue */
  ownAircraft: { lngLat: LngLat; heading: number; callsign: string } | null;
  ownTrail: LngLat[];
  /** Garder la carte centrée sur l'avion suivi */
  follow: boolean;
  /** Espace aérien autorouter mis en évidence (test local) */
  airspace: AirspaceInfo | null;
  onAirspace: (airspace: AirspaceInfo | null) => void;
  /** Balise choisie (entourée sur la carte) */
  navaid: NavaidInfo | null;
  onNavaid: (navaid: NavaidInfo) => void;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function points(list: { lngLat: LngLat; label: string }[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: p.lngLat },
      properties: { label: p.label },
    })),
  };
}

function boundsOf(coords: LngLat[]): maplibregl.LngLatBounds {
  return coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
}

// Couleurs du trajet par phase de vol (reprises dans styles.css : --route, --sid, --star)
const ROUTE_COLOR = '#c2188f';
const SID_COLOR = '#e8590c';
const STAR_COLOR = '#2b9348';
const PHASE_COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'phase'],
  'departure',
  SID_COLOR,
  'arrival',
  STAR_COLOR,
  ROUTE_COLOR,
];

export function MapView({
  selected,
  onSelect,
  overlay,
  picking,
  onPick,
  snapPoints,
  controlPoints,
  layers,
  route,
  focus,
  traffic,
  nat,
  onNatTrack,
  natSelected,
  ownAircraft,
  ownTrail,
  follow,
  airspace,
  onAirspace,
  navaid,
  onNavaid,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [bearing, setBearing] = useState(0);
  const [rotationControl] = useState(() => new PortalControl('rotation-control'));
  const handlers = useRef({ onSelect, onPick, picking, airspace, onAirspace, onNavaid, onNatTrack, natSelected });
  handlers.current = { onSelect, onPick, picking, airspace, onAirspace, onNavaid, onNatTrack, natSelected };

  useEffect(() => {
    const m = new maplibregl.Map({
      container: container.current!,
      style: baseStyle(),
      center: [8, 50],
      zoom: 4,
      attributionControl: { compact: true, customAttribution: 'Données aéronautiques © SIA et eAIP nationales · OurAirports · OpenFreeMap © OpenStreetMap' },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    // Ajouté après le zoom : MapLibre empile les contrôles du bas vers le haut
    m.addControl(rotationControl, 'bottom-right');
    m.on('rotate', () => setBearing(m.getBearing()));
    m.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');

    m.on('load', async () => {
      await loadAeroIcons(m);
      m.addSource('selected', { type: 'geojson', data: EMPTY });
      m.addSource('snap-points', { type: 'geojson', data: EMPTY });
      m.addSource('focus-point', { type: 'geojson', data: EMPTY });
      m.addSource('selected-navaid', { type: 'geojson', data: EMPTY });
      m.addSource('control-points', { type: 'geojson', data: EMPTY });

      addAeroLayers(m);
      m.addLayer(
        {
          id: 'selected-halo',
          type: 'circle',
          source: 'selected',
          paint: {
            'circle-radius': 16,
            'circle-color': 'rgba(13, 138, 130, 0.12)',
            'circle-stroke-color': '#0d8a82',
            'circle-stroke-width': 2,
          },
        },
        'airports',
      );
      m.addLayer(
        {
          id: 'selected-navaid',
          type: 'circle',
          source: 'selected-navaid',
          paint: {
            'circle-radius': 14,
            'circle-color': 'rgba(29, 95, 168, 0.12)',
            'circle-stroke-color': '#1d5fa8',
            'circle-stroke-width': 2,
          },
        },
        'navaids',
      );
      // Point ou balise choisi dans la recherche
      m.addLayer({
        id: 'focus-point',
        type: 'circle',
        source: 'focus-point',
        paint: {
          'circle-radius': 14,
          'circle-color': 'rgba(13, 138, 130, 0.12)',
          'circle-stroke-color': '#0d8a82',
          'circle-stroke-width': 2,
        },
      });
      m.addLayer({
        id: 'focus-point-label',
        type: 'symbol',
        source: 'focus-point',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': FONT_BOLD,
          'text-size': 12,
          'text-offset': [0, -1.6],
          'text-anchor': 'bottom',
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#0d8a82', 'text-halo-color': '#fff', 'text-halo-width': 2 },
      });
      // Repères d'aimantation (seuils de piste…) et points de calage déjà placés
      m.addLayer({
        id: 'snap-points',
        type: 'circle',
        source: 'snap-points',
        paint: { 'circle-radius': 5, 'circle-color': 'rgba(224, 123, 0, 0.25)', 'circle-stroke-color': '#e07b00', 'circle-stroke-width': 1.8 },
      });
      m.addLayer({
        id: 'snap-labels',
        type: 'symbol',
        source: 'snap-points',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': FONT_BOLD,
          'text-size': 10,
          'text-offset': [0, -1.2],
          'text-anchor': 'bottom',
        },
        paint: { 'text-color': '#c46a00', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      });
      m.addLayer({
        id: 'control-points',
        type: 'circle',
        source: 'control-points',
        paint: { 'circle-radius': 9, 'circle-color': '#ed64a6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
      });
      m.addLayer({
        id: 'control-labels',
        type: 'symbol',
        source: 'control-points',
        layout: { 'text-field': ['get', 'label'], 'text-font': FONT_REGULAR, 'text-size': 11, 'text-allow-overlap': true },
        paint: { 'text-color': '#fff' },
      });

      // Trajet du plan de vol, au-dessus des couches aéronautiques et des cartes superposées
      m.addSource('route', { type: 'geojson', data: EMPTY });
      const isLine: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
      m.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        filter: isLine,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
      });
      m.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['all', isLine, ['!=', ['get', 'style'], 'approximate']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PHASE_COLOR, 'line-width': 3 },
      });
      // Segments approximatifs (procédure non publiée dans nos données, fin d'approche) : en tirets
      m.addLayer({
        id: 'route-procedure',
        type: 'line',
        source: 'route',
        filter: ['all', isLine, ['==', ['get', 'style'], 'approximate']],
        paint: { 'line-color': PHASE_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      });
      m.addLayer({
        id: 'route-procedure-labels',
        type: 'symbol',
        source: 'route',
        filter: ['all', isLine, ['to-boolean', ['get', 'label']]],
        layout: {
          'symbol-placement': 'line-center',
          'text-field': ['get', 'label'],
          'text-font': FONT_BOLD,
          'text-size': 10.5,
          'text-offset': [0, -0.9],
        },
        paint: { 'text-color': PHASE_COLOR, 'text-halo-color': '#fff', 'text-halo-width': 2 },
      });
      m.addLayer({
        id: 'route-points',
        type: 'circle',
        source: 'route',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 4.5, 'circle-color': '#fff', 'circle-stroke-color': PHASE_COLOR, 'circle-stroke-width': 2.5 },
      });
      m.addLayer({
        id: 'route-labels',
        type: 'symbol',
        source: 'route',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'ident'],
          'text-font': FONT_BOLD,
          'text-size': 11,
          'text-anchor': 'left',
          'text-offset': [0.8, 0],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': PHASE_COLOR, 'text-halo-color': '#fff', 'text-halo-width': 2 },
      });

      // Vol suivi : trace parcourue et avion, tout en haut
      m.addSource('own-trail', { type: 'geojson', data: EMPTY });
      m.addSource('own-aircraft', { type: 'geojson', data: EMPTY });
      m.addLayer({
        id: 'own-trail',
        type: 'line',
        source: 'own-trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d99a00', 'line-width': 2.5, 'line-opacity': 0.85 },
      });
      // Halo sous l'avion de l'utilisateur, pour le repérer parmi le trafic
      m.addLayer({
        id: 'own-aircraft-halo',
        type: 'circle',
        source: 'own-aircraft',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 20, 10, 27],
          'circle-color': 'rgba(245, 183, 0, 0.25)',
          'circle-stroke-color': '#f5b700',
          'circle-stroke-width': 2,
        },
      });
      m.addLayer({
        id: 'own-aircraft',
        type: 'symbol',
        source: 'own-aircraft',
        layout: {
          'icon-image': 'aircraft-own',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 1.8, 10, 2.3],
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'text-field': ['get', 'callsign'],
          'text-font': FONT_BOLD,
          'text-size': 11.5,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#1f1f1f', 'text-halo-color': '#f5b700', 'text-halo-width': 2.5 },
      });

      m.on('click', (e) => {
        if (!handlers.current.picking) return;
        // Aimantation au repère le plus proche (seuil de piste, balise, aérodrome)
        const { x, y } = e.point;
        const candidates = m.queryRenderedFeatures(
          [
            [x - SNAP_PX, y - SNAP_PX],
            [x + SNAP_PX, y + SNAP_PX],
          ],
          { layers: ['snap-points', 'navaids', 'airports'] },
        );
        let best: LngLat = [e.lngLat.lng, e.lngLat.lat];
        let bestDist = Infinity;
        for (const f of candidates) {
          if (f.geometry.type !== 'Point') continue;
          const c = f.geometry.coordinates as LngLat;
          const p = m.project(c);
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < bestDist) {
            bestDist = d;
            best = c;
          }
        }
        handlers.current.onPick(best);
      });
      m.on('click', 'airports', (e: MapLayerMouseEvent) => {
        if (handlers.current.picking) return;
        const ident = e.features?.[0]?.properties?.ident;
        if (ident) handlers.current.onSelect(ident);
      });
      m.on('click', 'navaids', (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (handlers.current.picking || !f || f.geometry.type !== 'Point') return;
        const p = f.properties;
        handlers.current.onNavaid({
          ident: String(p.ident),
          name: p.name || undefined,
          type: p.type || undefined,
          frequency: p.frequency || undefined,
          lngLat: f.geometry.coordinates as LngLat,
        });
      });
      m.on('mouseenter', 'navaids', () => {
        if (!handlers.current.picking) m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', 'navaids', () => {
        if (!handlers.current.picking) m.getCanvas().style.cursor = '';
      });
      // Tracks NAT : un clic sur un track ou l'un de ses points le détaille, un clic ailleurs le désélectionne
      const NAT_CLICK_PX = 5;
      const natLayers = ['nat-tracks', 'nat-track-ends', 'nat-fixes', 'nat-fix-labels'];
      const natAt = (p: maplibregl.Point) =>
        m.queryRenderedFeatures(
          [
            [p.x - NAT_CLICK_PX, p.y - NAT_CLICK_PX],
            [p.x + NAT_CLICK_PX, p.y + NAT_CLICK_PX],
          ],
          { layers: natLayers },
        )[0];
      m.on('click', (e) => {
        if (handlers.current.picking) return;
        if (m.queryRenderedFeatures(e.point, { layers: ['navaids', 'airports'] }).length) return;
        const id = natAt(e.point)?.properties.id as string | undefined;
        if (id) handlers.current.onNatTrack(id);
        else if (handlers.current.natSelected) handlers.current.onNatTrack(null);
      });
      m.on('mouseenter', natLayers, () => {
        if (!handlers.current.picking) m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', natLayers, () => {
        if (!handlers.current.picking) m.getCanvas().style.cursor = '';
      });
      // Espaces aériens autorouter (dev) : un clic sur un nom ou une bordure met l'espace en évidence, un autre clic l'efface
      if (m.getLayer('autorouter-airspace-label')) {
        const AIRSPACE_CLICK_PX = 4;
        const airspaceLayers = ['autorouter-airspace-label', 'autorouter-airspace-line', 'autorouter-airspace-band'];
        m.on('click', (e) => {
          if (handlers.current.picking) return;
          // Clic sur une balise ou un aérodrome : c'est lui qui est choisi
          if (m.queryRenderedFeatures(e.point, { layers: ['navaids', 'airports'] }).length || natAt(e.point)) return;
          const { x, y } = e.point;
          const box: [PointLike, PointLike] = [
            [x - AIRSPACE_CLICK_PX, y - AIRSPACE_CLICK_PX],
            [x + AIRSPACE_CLICK_PX, y + AIRSPACE_CLICK_PX],
          ];
          // Le nom d'abord, puis la bordure la plus haute
          const found = m.queryRenderedFeatures(box, { layers: airspaceLayers });
          const p = (found.find((f) => f.layer.id === 'autorouter-airspace-label') ?? found[0])?.properties as AirspaceInfo | undefined;
          const current = handlers.current.airspace;
          if (!p && !current) return;
          handlers.current.onAirspace(p && (!current || airspaceKey(p) !== airspaceKey(current)) ? { ...p } : null);
        });
        m.on('mouseenter', airspaceLayers, () => {
          if (!handlers.current.picking) m.getCanvas().style.cursor = 'pointer';
        });
        m.on('mouseleave', airspaceLayers, () => {
          if (!handlers.current.picking) m.getCanvas().style.cursor = '';
        });
      }
      // Plan au sol (OpenStreetMap) des aérodromes visibles, chargé à la demande et conservé
      const ground = new Map<string, Feature[]>();
      const requested = new Set<string>();
      const failedAt = new Map<string, number>();
      const loadGround = () => {
        if (m.getZoom() < GROUND_MIN_ZOOM) return;
        const center = m.getCenter();
        const visible = m
          .queryRenderedFeatures({ layers: ['airports'] })
          .filter((f) => f.geometry.type === 'Point' && f.properties.type !== 'heliport')
          .map((f) => ({ ident: f.properties.ident as string, at: (f.geometry as Point).coordinates as LngLat }))
          .sort((a, b) => center.distanceTo(new maplibregl.LngLat(...a.at)) - center.distanceTo(new maplibregl.LngLat(...b.at)));
        for (const { ident, at } of visible.slice(0, GROUND_MAX_AIRPORTS)) {
          if (requested.has(ident) || Date.now() - (failedAt.get(ident) ?? 0) < GROUND_RETRY_MS) continue;
          requested.add(ident);
          fetch(`/api/ground/${encodeURIComponent(ident)}?lat=${at[1]}&lon=${at[0]}`)
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((fc: FeatureCollection) => {
              ground.set(ident, fc.features);
              (m.getSource(GROUND_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: [...ground.values()].flat() });
            })
            .catch(() => {
              // OpenStreetMap (Overpass) indisponible : nouvel essai plus tard
              requested.delete(ident);
              failedAt.set(ident, Date.now());
            });
        }
      };
      m.on('idle', loadGround);

      m.on('mouseenter', 'airports', () => {
        if (!handlers.current.picking) m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', 'airports', () => {
        if (!handlers.current.picking) m.getCanvas().style.cursor = '';
      });
      setReady(true);
    });

    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // Balise choisie
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('selected-navaid') as GeoJSONSource).setData(navaid ? points([{ lngLat: navaid.lngLat, label: navaid.ident }]) : EMPTY);
  }, [ready, navaid]);

  // Espace aérien mis en évidence
  useEffect(() => {
    const m = map.current;
    if (m && ready && m.getLayer('autorouter-airspace-highlight-fill')) highlightAirspace(m, airspace);
  }, [ready, airspace]);

  // Aérodrome sélectionné
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('selected') as GeoJSONSource).setData(
      selected ? points([{ lngLat: [selected.lon, selected.lat], label: '' }]) : EMPTY,
    );
    if (selected) m.flyTo({ center: [selected.lon, selected.lat], zoom: Math.max(m.getZoom(), 10), speed: 1.6 });
  }, [selected, ready]);

  // Carte superposée
  const shownImage = useRef<ImageBitmap | null>(null);
  const fittedId = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (!overlay?.image) {
      if (m.getLayer('chart-overlay')) m.removeLayer('chart-overlay');
      if (m.getSource('chart-overlay')) m.removeSource('chart-overlay');
      shownImage.current = null;
      if (!overlay) fittedId.current = null;
      return;
    }
    const source = m.getSource('chart-overlay') as ImageSource | undefined;
    if (!source) {
      m.addSource('chart-overlay', { type: 'image', coordinates: overlay.corners });
      (m.getSource('chart-overlay') as ImageSource).updateImage({ image: overlay.image, coordinates: overlay.corners });
      m.addLayer(
        {
          id: 'chart-overlay',
          type: 'raster',
          source: 'chart-overlay',
          paint: { 'raster-opacity': overlay.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        },
        'selected-halo',
      );
    } else if (shownImage.current !== overlay.image) {
      source.updateImage({ image: overlay.image, coordinates: overlay.corners });
    } else {
      source.setCoordinates(overlay.corners);
    }
    shownImage.current = overlay.image;
    m.setPaintProperty('chart-overlay', 'raster-opacity', overlay.opacity);

    if (overlay.fit && fittedId.current !== overlay.id) {
      fittedId.current = overlay.id;
      m.fitBounds(boundsOf(overlay.corners), { padding: 40, duration: 800 });
    }
  }, [overlay, ready]);

  // Trajet du plan de vol : mise à jour et cadrage sur l'ensemble du vol
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('route') as GeoJSONSource).setData(route ?? EMPTY);
    const coords = (route?.features ?? []).filter((f) => f.geometry.type === 'Point').map((f) => (f.geometry as Point).coordinates as LngLat);
    if (coords.length >= 2) m.fitBounds(boundsOf(coords), { padding: 60, duration: 800, bearing: m.getBearing() });
  }, [route, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('focus-point') as GeoJSONSource).setData(focus?.label ? points([{ lngLat: focus.lngLat, label: focus.label }]) : EMPTY);
    if (focus) m.flyTo({ center: focus.lngLat, zoom: Math.max(m.getZoom(), focus.label ? 10 : 9), speed: 1.6 });
  }, [focus, ready]);

  // Trafic IVAO
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource(IVAO_PILOTS_SOURCE) as GeoJSONSource).setData(traffic?.pilots ?? EMPTY);
    (m.getSource(IVAO_ATCS_SOURCE) as GeoJSONSource).setData(traffic?.atcs ?? EMPTY);
  }, [traffic, ready]);

  // Tracks NAT
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource(NAT_SOURCE) as GeoJSONSource).setData(nat);
  }, [nat, ready]);

  // Vol suivi, et recentrage continu si demandé
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('own-aircraft') as GeoJSONSource).setData(
      ownAircraft
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: ownAircraft.lngLat },
                properties: { heading: ownAircraft.heading, callsign: ownAircraft.callsign },
              },
            ],
          }
        : EMPTY,
    );
    (m.getSource('own-trail') as GeoJSONSource).setData(
      ownTrail.length >= 2
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ownTrail }, properties: {} }] }
        : EMPTY,
    );
    if (follow && ownAircraft) m.easeTo({ center: ownAircraft.lngLat, duration: 1000 });
  }, [ownAircraft, ownTrail, follow, ready]);

  // Couches affichées
  useEffect(() => {
    const m = map.current;
    if (m && ready) setGroupVisibility(m, layers);
  }, [layers, ready]);

  // Mode calage
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.getCanvas().style.cursor = picking ? 'crosshair' : '';
    (m.getSource('snap-points') as GeoJSONSource).setData(picking ? points(snapPoints) : EMPTY);
  }, [picking, snapPoints, ready]);

  // Au premier point d'un calage, cadrer sur les repères de l'aérodrome
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !picking || controlPoints.length > 0 || snapPoints.length === 0) return;
    m.fitBounds(boundsOf(snapPoints.map((p) => p.lngLat)), { padding: 80, maxZoom: 15, duration: 800 });
  }, [picking, controlPoints.length, snapPoints, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('control-points') as GeoJSONSource).setData(
      points(controlPoints.map((lngLat, i) => ({ lngLat, label: String(i + 1) }))),
    );
  }, [controlPoints, ready]);

  const heading = Math.round((bearing + 360) % 360) % 360;

  return (
    <>
      <div ref={container} className="map" />
      {createPortal(
        <button
          className="compass"
          onClick={() => map.current?.easeTo({ bearing: 0, duration: 300 })}
          title="Remettre le nord en haut (clic droit + glisser pour tourner librement)"
          aria-label={`Orientation ${heading}°, remettre le nord en haut`}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden>
            <path d="M12 2.5l3.2 9.5h-6.4z" fill="#e0524a" />
            <path d="M12 21.5l-3.2-9.5h6.4z" fill="currentColor" opacity="0.55" />
          </svg>
          <span className="bearing">{String(heading).padStart(3, '0')}°</span>
        </button>,
        rotationControl.element,
      )}
    </>
  );
}
