// Visionneuse LOCALE des tuiles autorouter. Les tuiles absentes du cache sont récupérées
// à la demande, uniquement pour la zone affichée (comme la carte autorouter elle-même).
// N'écoute que sur 127.0.0.1 : rien n'est exposé sur le réseau.
//
//   node scripts/view-autorouter-tiles.ts   → http://127.0.0.1:5180

import { createServer } from 'node:http';
import { AUTOROUTER_MAXZOOM as maxzoom, AUTOROUTER_MINZOOM as minzoom, loadAutorouterTile, type AutorouterKind } from './autorouter-tiles.ts';

const PORT = 5180;

const html = /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tuiles autorouter (test local)</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.css">
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.js"></script>
<style>
  html, body, #map { margin: 0; height: 100%; }
  .info { position: absolute; top: 10px; left: 10px; background: #fffd; padding: 6px 10px;
          font: 13px system-ui; border-radius: 6px; box-shadow: 0 1px 4px #0003; }
  .maplibregl-popup-content { font: 12px system-ui; }
</style>
</head>
<body>
<div id="map"></div>
<div class="info">Routes (bleu), SID (vert), STAR (rouge, tirets) — zooms ${minzoom}–${maxzoom}, chargées à la demande (au-delà : sur-zoom) · clic sur une route pour le détail</div>
<script>
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [2.5, 46.6],
  zoom: 5.5,
  hash: true,
});
map.addControl(new maplibregl.NavigationControl());

const COLORS = { airway: '#2f6f9f', sid: '#1f7a4d', star: '#b4442c' };

map.on('load', () => {
  for (const [kind, color] of Object.entries(COLORS)) {
    map.addSource(kind, {
      type: 'vector',
      tiles: [location.origin + '/tiles/' + kind + '/{z}/{x}/{y}.mvt'],
      minzoom: ${minzoom},
      maxzoom: ${maxzoom},
    });
    map.addLayer({
      id: kind + '-line',
      type: 'line',
      source: kind,
      'source-layer': 'airway',
      paint: {
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 11, 2],
        'line-opacity': 0.8,
        ...(kind === 'star' && { 'line-dasharray': [3, 1.5] }),
      },
    });
    map.addLayer({
      id: kind + '-label',
      type: 'symbol',
      source: kind,
      'source-layer': 'airway',
      minzoom: kind === 'airway' ? 8 : 9.5,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['concat', ['coalesce', ['get', 'a0ident'], ''], ' ', ['coalesce', ['get', 'a1ident'], '']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
      },
      paint: { 'text-color': color, 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
    map.on('mouseenter', kind + '-line', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', kind + '-line', () => (map.getCanvas().style.cursor = ''));
    map.on('click', kind + '-line', (e) => {
      const p = e.features[0].properties;
      const names = Array.from({ length: p.airways ?? 0 }, (_, i) => p['a' + i + 'ident']).filter(Boolean).join(' ');
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          '<b>' + kind.toUpperCase() + '</b> ' + (names || '—') + '<br>' +
          (p.sident ?? '?') + ' → ' + (p.eident ?? '?') + '<br>' +
          (p.altlower ?? '?') + ' – ' + (p.altupper ?? '?')
        )
        .addTo(map);
    });
  }
});
</script>
</body>
</html>`;

createServer(async (req, res) => {
  const m = req.url?.match(/^\/tiles\/(airway|sid|star)\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
  if (m) {
    try {
      const data = await loadAutorouterTile(m[1] as AutorouterKind, m[2], m[3], m[4]);
      if (data.length === 0) return res.writeHead(204).end();
      res.writeHead(200, { 'Content-Type': 'application/vnd.mapbox-vector-tile' }).end(data);
    } catch (err) {
      console.error(`${m[1]} ${m[2]}/${m[3]}/${m[4]} : ${(err as Error).message}`);
      res.writeHead(502).end();
    }
    return;
  }
  if (req.url === '/' || req.url?.startsWith('/#')) {
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Visionneuse : http://127.0.0.1:${PORT}  (zooms ${minzoom}-${maxzoom})`);
});
