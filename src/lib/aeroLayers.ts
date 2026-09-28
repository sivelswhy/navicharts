// Couches aéronautiques affichées par-dessus le fond de carte : espaces aériens, routes, points de report,
// balises, pistes et aérodromes.
import type { ExpressionSpecification, FilterSpecification, Map as MapLibreMap, SymbolLayerSpecification } from 'maplibre-gl';
import { AERO_COLORS, NAVAID_ICON, VOR_ROSE } from './aeroIcons.ts';
import { FONT_BOLD, FONT_REGULAR } from './mapStyle.ts';

export type LayerGroup =
  | 'airspaces'
  | 'airways'
  | 'autorouter'
  | 'autorouterAirspaces'
  | 'autorouterSid'
  | 'autorouterStar'
  | 'autorouterPoints'
  | 'waypoints'
  | 'navaids'
  | 'airports'
  | 'ground'
  | 'ivao';

/** Routes autorouter : test local uniquement, servies par le serveur de dev Vite (voir vite.config.ts) */
const AUTOROUTER = import.meta.env.DEV;

export const LAYER_GROUP_LABELS: Partial<Record<LayerGroup, string>> = {
  airspaces: 'Espaces aériens (France)',
  // Remplacées pour l'instant par les routes autorouter pendant les tests
  ...(!AUTOROUTER && { airways: 'Routes RNAV (France)' }),
  ...(AUTOROUTER && {
    autorouterAirspaces: 'Espaces aériens autorouter (test local)',
    autorouter: 'Routes autorouter (test local)',
    autorouterSid: 'SID autorouter (test local)',
    autorouterStar: 'STAR autorouter (test local)',
  }),
  ...(!AUTOROUTER && { waypoints: 'Points de report (France)' }),
  ...(AUTOROUTER && { autorouterPoints: 'Points de report autorouter (test local)' }),
  navaids: 'Balises',
  airports: 'Aérodromes',
  ground: 'Plan au sol',
  ivao: 'Trafic IVAO (en direct)',
};

export const LAYER_GROUPS: Record<LayerGroup, string[]> = {
  airspaces: ['airspace-fill', 'airspace-fir', 'airspace-line', 'airspace-line-e', 'airspace-label'],
  airways: ['airways', 'airway-labels'],
  autorouterAirspaces: [
    'autorouter-airspace-fill',
    'autorouter-airspace-band',
    'autorouter-airspace-line',
    'autorouter-airspace-highlight-fill',
    'autorouter-airspace-highlight-line',
    'autorouter-airspace-label',
  ],
  autorouter: ['autorouter-airways-casing', 'autorouter-airways', 'autorouter-airway-labels'],
  autorouterSid: ['autorouter-sid', 'autorouter-sid-labels'],
  autorouterStar: ['autorouter-star', 'autorouter-star-labels'],
  waypoints: ['waypoints'],
  autorouterPoints: ['autorouter-waypoints'],
  navaids: ['autorouter-vor-rose', 'navaids'],
  airports: ['runways', 'runway-ends', 'airports'],
  ground: ['ground-apron', 'ground-taxiway', 'ground-taxiway-centerline', 'ground-runway', 'ground-taxiway-labels', 'ground-holding', 'ground-stands'],
  ivao: ['ivao-atcs', 'ivao-pilots'],
};

/** Sources alimentées par le trafic IVAO (voir MapView) */
export const IVAO_PILOTS_SOURCE = 'ivao-pilots';
export const IVAO_ATCS_SOURCE = 'ivao-atcs';

/** Source alimentée à la demande avec le plan au sol des aérodromes visibles (voir MapView) */
export const GROUND_SOURCE = 'ground';

/** Propriétés d'un espace aérien autorouter (ident, name, type, altlower, altupper…) */
export type AirspaceInfo = Record<string, string | number | boolean>;

/** Un espace est repéré par son identifiant et ses limites verticales (une TMA a plusieurs tranches) */
export const airspaceKey = (a: AirspaceInfo) => `${a.ident}|${a.altlower}|${a.altupper}`;

/** Espace aérien autorouter mis en évidence (clic sur son nom ou sa bordure) */
export function highlightAirspace(map: MapLibreMap, airspace: AirspaceInfo | null) {
  const f = airspace
    ? filter(['all', ['==', ['get', 'object'], 'airspace'], ['==', ['get', 'ident'], airspace.ident], ['==', ['get', 'altlower'], airspace.altlower], ['==', ['get', 'altupper'], airspace.altupper]])
    : filter(['==', ['get', 'object'], '']);
  map.setFilter('autorouter-airspace-highlight-fill', f);
  map.setFilter('autorouter-airspace-highlight-line', f);
}

const HALO = '#ffffff';
const expr = (e: unknown) => e as ExpressionSpecification;
const filter = (e: unknown) => e as FilterSpecification;

// Classes C/D (et A) en trait plein bleu, classe E et LTA en tirets magenta, comme sur les cartes IFR.
// L'UTA (au-dessus du FL 195) couvre tout le territoire et suit les limites des FIR : elle n'est pas dessinée.
const CONTROLLED = filter(['all', ['in', ['get', 'type'], ['literal', ['CTA', 'TMA', 'CTR']]], ['!=', ['get', 'class'], 'E']]);
const CLASS_E = filter(['any', ['==', ['get', 'class'], 'E'], ['==', ['get', 'type'], 'LTA']]);

// Importance d'un aérodrome → zoom à partir duquel il est affiché
const AIRPORT_VISIBLE = filter([
  'any',
  ['get', 'ifr'],
  ['all', ['in', ['get', 'type'], ['literal', ['large_airport', 'medium_airport']]], ['>=', ['zoom'], 6.5]],
  ['all', ['in', ['get', 'type'], ['literal', ['small_airport', 'seaplane_base']]], ['>=', ['zoom'], 8]],
  ['>=', ['zoom'], 10],
]);

export function addAeroLayers(map: MapLibreMap, beforeId?: string) {
  const data = (name: string) => `/data/${name}.geojson`;
  map.addSource('airspaces', { type: 'geojson', data: data('airspaces') });
  map.addSource('airways', { type: 'geojson', data: data('airways') });
  map.addSource('waypoints', { type: 'geojson', data: data('waypoints') });
  map.addSource('navaids', { type: 'geojson', data: data('navaids') });
  map.addSource('runways', { type: 'geojson', data: data('runways') });
  map.addSource('airports', { type: 'geojson', data: data('airports') });
  map.addSource('runway-ends', { type: 'geojson', data: data('runway-ends') });
  map.addSource(GROUND_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(IVAO_PILOTS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(IVAO_ATCS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  const add = (layer: Parameters<MapLibreMap['addLayer']>[0]) => map.addLayer(layer, beforeId);

  // Espaces aériens
  add({
    id: 'airspace-fill',
    type: 'fill',
    source: 'airspaces',
    // Les espaces se superposent : le remplissage n'apparaît qu'à l'échelle régionale pour ne pas voiler la carte
    minzoom: 7,
    filter: CONTROLLED,
    // et s'efface à fort zoom, où l'on est souvent à l'intérieur de plusieurs parties d'une même TMA
    paint: { 'fill-color': '#3b78c4', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 0.03, 10, 0.03, 11, 0] },
  });
  add({
    id: 'airspace-fir',
    type: 'line',
    source: 'airspaces',
    filter: filter(['==', ['get', 'type'], 'FIR']),
    paint: { 'line-color': '#8f8a82', 'line-width': 1.6, 'line-dasharray': [6, 2, 1, 2] },
  });
  add({
    id: 'airspace-line',
    type: 'line',
    source: 'airspaces',
    minzoom: 5,
    filter: CONTROLLED,
    paint: { 'line-color': '#3b78c4', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.4] },
  });
  add({
    id: 'airspace-line-e',
    type: 'line',
    source: 'airspaces',
    minzoom: 6,
    filter: CLASS_E,
    paint: { 'line-color': '#b46aa6', 'line-opacity': 0.7, 'line-width': 1, 'line-dasharray': [3, 2] },
  });
  add({
    id: 'airspace-label',
    type: 'symbol',
    source: 'airspaces',
    minzoom: 8.5,
    filter: filter(['in', ['get', 'type'], ['literal', ['CTA', 'TMA', 'CTR', 'LTA']]]),
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 400,
      'text-field': expr(['concat', ['get', 'name'], '  ', ['coalesce', ['get', 'class'], ''], '  ', ['get', 'lower'], '–', ['get', 'upper']]),
      'text-font': FONT_REGULAR,
      'text-size': 9.5,
      'text-offset': [0, 0.8],
    },
    paint: {
      'text-color': expr(['case', ['==', ['get', 'class'], 'E'], '#9a4f8c', '#2f64a6']),
      'text-halo-color': HALO,
      'text-halo-width': 1.5,
    },
  });

  // Espaces aériens autorouter (test local) : toute l'Europe, dans la couche MVT `airspace`.
  // `object` distingue le contour (airspace), la bande intérieure (airspacefatborder) et l'étiquette (airspacelabel)
  if (AUTOROUTER) {
    map.addSource('autorouter-airspace', {
      type: 'vector',
      tiles: [`${location.origin}/dev/autorouter/airspace/{z}/{x}/{y}.mvt`],
      // Pas de vues d'ensemble : assemblés, les polygones découpés feraient apparaître les bords des tuiles
      minzoom: 5,
      maxzoom: 10,
      attribution: 'Espaces aériens © autorouter / EAD (test local)',
    });
    const src = { source: 'autorouter-airspace', 'source-layer': 'airspace' } as const;
    const is = (object: string) => ['==', ['get', 'object'], object];
    // Types autorouter : 13 CTR, 40 TMA, 15 zone D, 31 zone P, 35 zone R, 42 TRA, 43 TSA
    const color = expr([
      'match',
      ['get', 'type'],
      [13, 40],
      '#3b78c4',
      [31, 35],
      AERO_COLORS.restricted,
      15,
      AERO_COLORS.danger,
      [42, 43],
      AERO_COLORS.temporary,
      '#7d858f',
    ]);
    const controlled = ['in', ['get', 'type'], ['literal', [13, 40]]];
    add({
      id: 'autorouter-airspace-fill',
      type: 'fill',
      ...src,
      minzoom: 7,
      filter: filter(['all', is('airspace'), ['==', ['get', 'type'], 13]]),
      paint: { 'fill-color': color, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 0.04, 11, 0.04, 12, 0] },
    });
    // Bande intérieure le long du contour, comme sur les cartes autorouter
    add({
      id: 'autorouter-airspace-band',
      type: 'fill',
      ...src,
      minzoom: 8,
      filter: filter(is('airspacefatborder')),
      paint: { 'fill-color': color, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 9, 0.18] },
    });
    add({
      id: 'autorouter-airspace-line',
      type: 'line',
      ...src,
      filter: filter(is('airspace')),
      paint: {
        'line-color': color,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 8, 0.8],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 1.3],
        'line-dasharray': expr(['case', ['in', ['get', 'type'], ['literal', [42, 43]]], ['literal', [4, 2]], ['literal', [1, 0]]]),
      },
    });
    // Espace choisi en cliquant son nom (voir highlightAirspace) ; aucun au départ
    add({
      id: 'autorouter-airspace-highlight-fill',
      type: 'fill',
      ...src,
      filter: filter(['==', ['get', 'object'], '']),
      paint: { 'fill-color': color, 'fill-opacity': 0.14 },
    });
    add({
      id: 'autorouter-airspace-highlight-line',
      type: 'line',
      ...src,
      filter: filter(['==', ['get', 'object'], '']),
      layout: { 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': 2.5 },
    });
    add({
      id: 'autorouter-airspace-label',
      type: 'symbol',
      ...src,
      minzoom: 8.5,
      filter: filter(is('airspacelabel')),
      layout: {
        'text-field': expr([
          'format',
          ['coalesce', ['get', 'ident'], ''],
          {},
          '\n',
          {},
          ['concat', ['coalesce', ['get', 'altlower'], '?'], ' – ', ['coalesce', ['get', 'altupper'], '?']],
          { 'font-scale': 0.85, 'text-font': ['literal', FONT_REGULAR] },
        ]),
        'text-font': FONT_BOLD,
        'text-size': 9.5,
        'symbol-sort-key': expr(['case', controlled, 0, 1]),
        'text-padding': 4,
      },
      paint: { 'text-color': color, 'text-halo-color': HALO, 'text-halo-width': 1.5 },
    });
  }

  // Routes RNAV (masquées pendant les tests des routes autorouter ; route.ts charge ses propres données)
  if (!AUTOROUTER) {
    add({
      id: 'airways',
      type: 'line',
      source: 'airways',
      minzoom: 5.5,
      paint: { 'line-color': AERO_COLORS.airway, 'line-width': ['interpolate', ['linear'], ['zoom'], 5.5, 0.6, 10, 1.5] },
    });
    add({
      id: 'airway-labels',
      type: 'symbol',
      source: 'airways',
      minzoom: 7.5,
      layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'name'],
        'text-font': FONT_BOLD,
        'text-size': 9.5,
        'text-keep-upright': true,
      },
      paint: { 'text-color': AERO_COLORS.airwayLabel, 'text-halo-color': HALO, 'text-halo-width': 2.2 },
    });
  }

  // Autorouter (test local) : une source par contenu (routes, SID, STAR), toutes dans la couche MVT `airway`
  if (AUTOROUTER) {
    for (const kind of ['airway', 'sid', 'star']) {
      map.addSource(`autorouter-${kind}`, {
        type: 'vector',
        tiles: [`${location.origin}/dev/autorouter/${kind}/{z}/{x}/{y}.mvt`],
        // autorouter fournit les tuiles dès le zoom 5 ; en dessous, vues d'ensemble assemblées par le serveur de dev
        minzoom: 3,
        maxzoom: 10,
        attribution: 'Routes et procédures © autorouter (test local)',
      });
    }
    const src = (kind: string) => ({ source: `autorouter-${kind}`, 'source-layer': 'airway' }) as const;
    const next = (i: number) => ['case', ['has', `a${i}ident`], ['concat', ' · ', ['get', `a${i}ident`]], ''];
    // Au plus `max` désignations par tronçon, puis le nombre restant
    const names = (max: number) => [
      'concat',
      ['coalesce', ['get', 'a0ident'], ''],
      ...Array.from({ length: max - 1 }, (_, i) => next(i + 1)),
      ['case', ['>', ['coalesce', ['get', 'airways'], 0], max], ['concat', ' +', ['to-string', ['-', ['get', 'airways'], max]]], ''],
    ];
    // Cartouches horizontaux, lisibles quelle que soit l'orientation du tronçon
    const boxedLabel: SymbolLayerSpecification['layout'] = {
      'text-rotation-alignment': 'viewport',
      'icon-rotation-alignment': 'viewport',
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [1, 4, 1, 4],
      'text-font': FONT_BOLD,
    };

    // SID en vert, STAR en rouge brique et en tirets, sous les routes
    const procedure = (kind: 'sid' | 'star', color: string, dash?: number[]) => {
      add({
        id: `autorouter-${kind}`,
        type: 'line',
        ...src(kind),
        minzoom: 6,
        layout: { 'line-join': 'round', 'line-cap': dash ? 'butt' : 'round' },
        paint: {
          'line-color': color,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 9, 0.8],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 11, 1.8],
          ...(dash && { 'line-dasharray': dash }),
        },
      });
      add({
        id: `autorouter-${kind}-labels`,
        type: 'symbol',
        ...src(kind),
        minzoom: 9.5,
        filter: filter(['has', 'a0ident']),
        layout: {
          ...boxedLabel,
          'symbol-placement': 'line',
          'symbol-spacing': 400,
          'text-field': expr(names(2)),
          'text-size': 9,
          'text-padding': 8,
          'icon-image': `box-${kind}`,
        },
        paint: { 'text-color': color },
      });
    };
    procedure('sid', AERO_COLORS.sid);
    procedure('star', AERO_COLORS.star, [3, 1.5]);

    // Routes : inférieures en bleu, supérieures en violet, comme sur les cartes en route.
    // Supérieure : plancher au FL 195 ou plus (altlower vaut « F245 », « GND »…), ou désignation en U
    const upper = ['any', ['==', ['slice', ['coalesce', ['get', 'a0ident'], ''], 0, 1], 'U'], ['>=', ['to-number', ['slice', ['coalesce', ['get', 'altlower'], ''], 1], 0], 195]];
    const color = expr(['case', upper, AERO_COLORS.airwayUpper, AERO_COLORS.airwayLower]);
    add({
      id: 'autorouter-airways-casing',
      type: 'line',
      ...src('airway'),
      minzoom: 7,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': HALO, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2, 11, 5] },
    });
    add({
      id: 'autorouter-airways',
      type: 'line',
      ...src('airway'),
      minzoom: 3,
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': expr(['case', upper, 0, 1]) },
      paint: {
        'line-color': color,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.45, 5, 0.7, 8, 0.9],
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 5, 0.7, 7, 1, 11, 2.2],
      },
    });
    add({
      id: 'autorouter-airway-labels',
      type: 'symbol',
      ...src('airway'),
      minzoom: 7.5,
      filter: filter(['has', 'a0ident']),
      layout: {
        ...boxedLabel,
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'symbol-sort-key': expr(['case', upper, 1, 0]),
        'text-field': expr([
          'step',
          ['zoom'],
          ['format', names(3), {}],
          9.5,
          ['format', names(3), {}, '\n', {}, ['concat', ['coalesce', ['get', 'altlower'], '?'], ' – ', ['coalesce', ['get', 'altupper'], '?']], { 'font-scale': 0.85, 'text-font': ['literal', FONT_REGULAR] }],
        ]),
        'text-size': ['interpolate', ['linear'], ['zoom'], 7.5, 9, 11, 10.5],
        'text-padding': 6,
        'icon-image': expr(['case', upper, 'box-airway-upper', 'box-airway-lower']),
      },
      paint: { 'text-color': color },
    });
  }

  // Points de report (remplacés en dev par ceux d'autorouter, partout où il y en a)
  if (AUTOROUTER) {
    map.addSource('autorouter-designatedpoint', {
      type: 'vector',
      tiles: [`${location.origin}/dev/autorouter/designatedpoint/{z}/{x}/{y}.mvt`],
      minzoom: 3,
      maxzoom: 10,
      attribution: 'Points © autorouter (test local)',
    });
    // Tous les points : type 0 (points en route à 5 lettres) mis en avant, les autres (points terminaux,
    // points liés à une balise…) plus petits et plus discrets, leur nom à partir du zoom 10
    const enRoute = ['==', ['get', 'type'], 0];
    add({
      id: 'autorouter-waypoints',
      type: 'symbol',
      source: 'autorouter-designatedpoint',
      'source-layer': 'designatedpoint',
      minzoom: 3,
      filter: filter(['!=', ['get', 'ident'], '']),
      layout: {
        'icon-image': 'waypoint',
        'icon-size': expr(['interpolate', ['linear'], ['zoom'], 3, ['case', enRoute, 0.2, 0.15], 6, ['case', enRoute, 0.35, 0.3], 7, ['case', enRoute, 0.5, 0.35], 11, ['case', enRoute, 0.8, 0.6]]),
        'icon-allow-overlap': true,
        'symbol-sort-key': expr(['case', enRoute, 0, 1]),
        'text-field': expr(['step', ['zoom'], '', 8.5, ['case', enRoute, ['get', 'ident'], ''], 10, ['get', 'ident']]),
        'text-font': FONT_REGULAR,
        'text-size': 9,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'icon-opacity': expr(['interpolate', ['linear'], ['zoom'], 3, ['case', enRoute, 1, 0.5], 9, ['case', enRoute, 1, 0.8]]),
        'text-color': AERO_COLORS.waypoint,
        'text-halo-color': HALO,
        'text-halo-width': 1.5,
      },
    });
  } else add({
    id: 'waypoints',
    type: 'symbol',
    source: 'waypoints',
    minzoom: 7,
    layout: {
      'icon-image': 'waypoint',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 11, 0.8],
      'icon-allow-overlap': true,
      'text-field': expr(['step', ['zoom'], '', 8.5, ['get', 'ident']]),
      'text-font': FONT_REGULAR,
      'text-size': 9,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': AERO_COLORS.waypoint, 'text-halo-color': HALO, 'text-halo-width': 1.5 },
  });

  // Plan au sol (OpenStreetMap), sous les pistes et les symboles
  const kind = (k: string) => filter(['==', ['get', 'kind'], k]);
  add({
    id: 'ground-apron',
    type: 'fill',
    source: GROUND_SOURCE,
    minzoom: 12,
    filter: kind('apron'),
    paint: { 'fill-color': '#dedad2', 'fill-outline-color': '#c9c3b8' },
  });
  add({
    id: 'ground-taxiway',
    type: 'line',
    source: GROUND_SOURCE,
    minzoom: 12,
    filter: kind('taxiway'),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#a8a195',
      'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 1, 14, 3, 16, 12, 18, 48],
    },
  });
  add({
    id: 'ground-taxiway-centerline',
    type: 'line',
    source: GROUND_SOURCE,
    minzoom: 15,
    filter: kind('taxiway'),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#e8b923', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 18, 2] },
  });
  add({
    id: 'ground-runway',
    type: 'line',
    source: GROUND_SOURCE,
    minzoom: 12,
    filter: kind('runway'),
    paint: { 'line-color': '#56606b', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 3, 16, 36, 18, 144] },
  });

  // Pistes (sous les symboles d'aérodromes)
  add({
    id: 'runways',
    type: 'line',
    source: 'runways',
    minzoom: 10,
    layout: { 'line-cap': 'butt' },
    paint: {
      'line-color': expr(['case', ['get', 'hard'], '#56606b', '#98a07a']),
      'line-width': ['interpolate', ['exponential', 2], ['zoom'], 10, 1.5, 13, 5, 16, 36],
    },
  });

  // Détails au sol, au-dessus des pistes
  add({
    id: 'ground-holding',
    type: 'symbol',
    source: GROUND_SOURCE,
    minzoom: 14,
    filter: kind('holding'),
    layout: {
      'icon-image': expr(['case', ['==', ['get', 'holdingType'], 'ILS'], 'holding-ils', 'holding']),
      // Le symbole est dessiné à l'horizontale (orienté est-ouest) ; `bearing` est la direction du marquage
      'icon-rotate': expr(['-', ['coalesce', ['get', 'bearing'], 90], 90]),
      'icon-rotation-alignment': 'map',
      'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 14, 0.6, 16, 1.6, 18, 5],
      'icon-allow-overlap': true,
      'text-field': expr(['step', ['zoom'], '', 15, ['coalesce', ['get', 'ref'], '']]),
      'text-font': FONT_BOLD,
      'text-size': 10,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#d0342c', 'text-halo-color': HALO, 'text-halo-width': 1.6 },
  });
  add({
    id: 'ground-taxiway-labels',
    type: 'symbol',
    source: GROUND_SOURCE,
    minzoom: 13.5,
    // `ref` vaut null pour les tronçons sans nom : sans ce test, le cartouche s'afficherait vide
    filter: filter(['all', ['==', ['get', 'kind'], 'taxiway'], ['to-boolean', ['get', 'ref']]]),
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 250,
      'text-field': ['get', 'ref'],
      'text-font': FONT_BOLD,
      'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, 9, 17, 12],
      'text-rotation-alignment': 'viewport',
      'text-keep-upright': true,
      'icon-image': 'box-taxiway',
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [1, 3, 1, 3],
      'icon-rotation-alignment': 'viewport',
    },
    paint: { 'text-color': '#1f1f1f' },
  });
  add({
    id: 'ground-stands',
    type: 'symbol',
    source: GROUND_SOURCE,
    minzoom: 15.5,
    filter: kind('stand'),
    layout: { 'text-field': ['get', 'ref'], 'text-font': FONT_REGULAR, 'text-size': 9.5 },
    paint: { 'text-color': '#6b665e', 'text-halo-color': HALO, 'text-halo-width': 1.2 },
  });
  add({
    id: 'runway-ends',
    type: 'symbol',
    source: 'runway-ends',
    minzoom: 12,
    layout: {
      'text-field': ['get', 'ident'],
      'text-font': FONT_BOLD,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
      'icon-image': 'box-runway',
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [1, 3, 1, 3],
      'text-allow-overlap': true,
      'icon-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff' },
  });

  // Aérodromes
  add({
    id: 'airports',
    type: 'symbol',
    source: 'airports',
    filter: AIRPORT_VISIBLE,
    layout: {
      'icon-image': expr(['case', ['==', ['get', 'type'], 'heliport'], 'heliport', ['get', 'ifr'], 'airport-ifr', 'airport-vfr']),
      'icon-size': expr(['interpolate', ['linear'], ['zoom'], 5, ['case', ['get', 'ifr'], 0.7, 0.55], 10, ['case', ['get', 'ifr'], 1, 0.8]]),
      // Les symboles restent tous visibles (le filtre de zoom limite la densité) ; seuls les libellés s'effacent
      'icon-allow-overlap': true,
      'symbol-sort-key': expr(['case', ['get', 'ifr'], 0, 1]),
      'text-field': expr([
        'step',
        ['zoom'],
        ['coalesce', ['get', 'icao'], ''],
        10,
        ['format', ['coalesce', ['get', 'icao'], ['get', 'ident']], {}, '\n', {}, ['get', 'name'], { 'font-scale': 0.8, 'text-font': ['literal', FONT_REGULAR] }],
      ]),
      'text-font': FONT_BOLD,
      'text-size': 10.5,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 12, 1, 13.5, 0.35],
      'text-color': expr(['case', ['get', 'ifr'], AERO_COLORS.ifr, AERO_COLORS.vfr]),
      'text-halo-color': HALO,
      'text-halo-width': 1.6,
    },
  });

  // Trafic IVAO : contrôleurs (position de leur secteur) et avions orientés selon leur cap
  add({
    id: 'ivao-atcs',
    type: 'symbol',
    source: IVAO_ATCS_SOURCE,
    layout: {
      'icon-image': 'atc',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 9, 0.85],
      'icon-allow-overlap': true,
      'text-field': expr(['step', ['zoom'], '', 6, ['format', ['get', 'callsign'], {}, '\n', {}, ['get', 'frequency'], { 'font-scale': 0.85 }]]),
      'text-font': FONT_BOLD,
      'text-size': 9.5,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#0f766e', 'text-halo-color': HALO, 'text-halo-width': 1.6 },
  });
  add({
    id: 'ivao-pilots',
    type: 'symbol',
    source: IVAO_PILOTS_SOURCE,
    layout: {
      'icon-image': expr(['case', ['get', 'onGround'], 'aircraft-ground', 'aircraft']),
      // Bien visibles même à l'échelle d'un continent
      'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 1.35, 7, 1.6, 12, 1.9],
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'text-field': expr(['step', ['zoom'], '', 5.5, ['get', 'callsign'], 8, ['format', ['get', 'callsign'], {}, '\n', {}, ['get', 'info'], { 'font-scale': 0.8, 'text-font': ['literal', FONT_REGULAR] }]]),
      'text-font': FONT_BOLD,
      'text-size': 10,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#1e3a8a', 'text-halo-color': HALO, 'text-halo-width': 1.8 },
  });

  // Roses des VOR (test local) : autorouter donne la déclinaison de chaque station (`decl`, positive vers l'est),
  // qui oriente la rose sur le nord magnétique. Taille fixe au sol (environ 0,5 NM de rayon)
  if (AUTOROUTER) {
    map.addSource('autorouter-navaid', {
      type: 'vector',
      tiles: [`${location.origin}/dev/autorouter/navaid/{z}/{x}/{y}.mvt`],
      minzoom: 5,
      maxzoom: 10,
      attribution: 'Balises © autorouter (test local)',
    });
    add({
      id: 'autorouter-vor-rose',
      type: 'symbol',
      source: 'autorouter-navaid',
      'source-layer': 'navaid',
      minzoom: 9.5,
      filter: filter(['==', ['get', 'vor'], true]),
      layout: {
        'icon-image': VOR_ROSE,
        'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 7, 0.025, 12, 0.8],
        'icon-rotate': expr(['coalesce', ['get', 'decl'], 0]),
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 10.5, 1] },
    });
  }

  // Balises (au-dessus du reste)
  add({
    id: 'navaids',
    type: 'symbol',
    source: 'navaids',
    minzoom: 5.5,
    layout: {
      'icon-image': expr(NAVAID_ICON),
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5.5, 0.7, 10, 1],
      'icon-allow-overlap': true,
      'text-field': expr([
        'step',
        ['zoom'],
        ['get', 'ident'],
        8,
        ['format', ['get', 'ident'], {}, '\n', {}, ['coalesce', ['get', 'frequency'], ''], { 'font-scale': 0.85, 'text-font': ['literal', FONT_REGULAR] }],
      ]),
      'text-font': FONT_BOLD,
      'text-size': 10,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': expr(['case', ['in', ['get', 'type'], ['literal', ['NDB', 'NDB-DME']]], AERO_COLORS.ndb, AERO_COLORS.vor]),
      'text-halo-color': HALO,
      'text-halo-width': 1.8,
    },
  });
}

export function setGroupVisibility(map: MapLibreMap, visible: Record<LayerGroup, boolean>) {
  for (const [group, layers] of Object.entries(LAYER_GROUPS) as [LayerGroup, string[]][]) {
    for (const id of layers) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[group] ? 'visible' : 'none');
    }
  }
}
