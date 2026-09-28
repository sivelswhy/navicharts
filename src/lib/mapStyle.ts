// Fond de carte clair et épuré, dans l'esprit des cartes aéronautiques « jour » : terres claires, eau bleu pâle,
// frontières discrètes, réseau routier et libellés atténués pour laisser la place aux informations aéronautiques.
// Tuiles vectorielles OpenFreeMap (schéma OpenMapTiles, données OpenStreetMap).
import type { StyleSpecification } from 'maplibre-gl';

export const FONT_REGULAR = ['Noto Sans Regular'];
export const FONT_BOLD = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];

export const COLORS = {
  land: '#f6f4ef',
  water: '#c9deef',
  waterLabel: '#6f93b3',
  wood: '#eaefe3',
  urban: '#ece8e0',
  road: '#e2ddd3',
  roadMajor: '#d9d2c5',
  border: '#9d978d',
  region: '#d2ccc2',
  place: '#8a847a',
  halo: '#f6f4ef',
};

const NAME = ['coalesce', ['get', 'name:fr'], ['get', 'name_int'], ['get', 'name']] as const;

export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    // Globe quand on dézoome au maximum, carte plane (Mercator) dès qu'on se rapproche
    projection: { type: ['interpolate', ['linear'], ['zoom'], 2, 'vertical-perspective', 3.5, 'mercator'] },
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 3, 0] },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLORS.land } },
      {
        id: 'landcover-wood',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landcover',
        minzoom: 7,
        filter: ['==', ['get', 'class'], 'wood'],
        paint: { 'fill-color': COLORS.wood, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 9, 0.8] },
      },
      {
        id: 'landuse-urban',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        minzoom: 8,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'industrial', 'commercial']]],
        paint: { 'fill-color': COLORS.urban },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': COLORS.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        minzoom: 8,
        filter: ['in', ['get', 'class'], ['literal', ['river', 'canal']]],
        paint: { 'line-color': COLORS.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 13, 2.5] },
      },
      {
        id: 'aeroway-runway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        minzoom: 11,
        filter: ['==', ['get', 'class'], 'runway'],
        paint: { 'line-color': '#cfc9bf', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 11, 2, 16, 40] },
      },
      {
        id: 'aeroway-taxiway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        minzoom: 13,
        filter: ['==', ['get', 'class'], 'taxiway'],
        paint: { 'line-color': '#dcd7ce', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 1, 16, 8] },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary']]],
        paint: { 'line-color': COLORS.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 3] },
      },
      {
        id: 'road-major',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
        paint: { 'line-color': COLORS.roadMajor, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 12, 2, 15, 5] },
      },
      {
        id: 'boundary-region',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        minzoom: 5,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': COLORS.region, 'line-width': 0.8, 'line-dasharray': [3, 2] },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': COLORS.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 10, 1.6] },
      },
      {
        id: 'water-name',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        layout: { 'text-field': NAME as never, 'text-font': FONT_ITALIC, 'text-size': 11, 'symbol-placement': 'point' },
        paint: { 'text-color': COLORS.waterLabel, 'text-halo-color': COLORS.water, 'text-halo-width': 1 },
      },
      {
        id: 'place-village',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['village', 'suburb']]],
        layout: { 'text-field': NAME as never, 'text-font': FONT_REGULAR, 'text-size': 10 },
        paint: { 'text-color': COLORS.place, 'text-halo-color': COLORS.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-town',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 8.5,
        filter: ['==', ['get', 'class'], 'town'],
        layout: { 'text-field': NAME as never, 'text-font': FONT_REGULAR, 'text-size': 10.5 },
        paint: { 'text-color': COLORS.place, 'text-halo-color': COLORS.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-city',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 5.5,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': NAME as never,
          'text-font': FONT_REGULAR,
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10.5, 10, 13],
        },
        paint: { 'text-color': COLORS.place, 'text-halo-color': COLORS.halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-country',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME as never,
          'text-font': FONT_BOLD,
          'text-size': 12,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.15,
        },
        paint: { 'text-color': '#b3ada3', 'text-halo-color': COLORS.halo, 'text-halo-width': 1.4 },
      },
    ],
  };
}
