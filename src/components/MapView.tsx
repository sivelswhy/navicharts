import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, ImageSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { loadAeroIcons } from '../lib/aeroIcons.ts';
import { addAeroLayers, GROUND_SOURCE, setGroupVisibility, type LayerGroup } from '../lib/aeroLayers.ts';
import type { LngLat } from '../lib/georef.ts';
import { baseStyle, FONT_BOLD, FONT_REGULAR } from '../lib/mapStyle.ts';
import type { Airport } from '../lib/types.ts';
import { IconRotate, IconRotateLeft } from './icons.tsx';

// MapLibre 6 charge ses workers depuis un fichier séparé, que la pré-compilation de Vite ne sait pas retrouver.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const SNAP_PX = 14;
const ROTATION_STEP = 15;

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

export function MapView({ selected, onSelect, overlay, picking, onPick, snapPoints, controlPoints, layers }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [bearing, setBearing] = useState(0);
  const [rotationControl] = useState(() => new PortalControl('rotation-control'));
  const handlers = useRef({ onSelect, onPick, picking });
  handlers.current = { onSelect, onPick, picking };

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

  const rotateBy = (delta: number) => map.current?.easeTo({ bearing: (map.current.getBearing() + delta) % 360, duration: 250 });
  const heading = Math.round((bearing + 360) % 360) % 360;

  return (
    <>
      <div ref={container} className="map" />
      {createPortal(
        <>
          <button onClick={() => rotateBy(-ROTATION_STEP)} title="Tourner la carte vers la gauche (Maj + ←)" aria-label="Tourner vers la gauche">
            <IconRotateLeft size={17} />
          </button>
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
          </button>
          <button onClick={() => rotateBy(ROTATION_STEP)} title="Tourner la carte vers la droite (Maj + →)" aria-label="Tourner vers la droite">
            <IconRotate size={17} />
          </button>
        </>,
        rotationControl.element,
      )}
    </>
  );
}
