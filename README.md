# NaviCharts

Alternative gratuite à Navigraph pour la simulation de vol, couvrant l'**Europe**, construite uniquement à partir de
données publiques.

| Pays | Cartes officielles | Espaces, routes, points |
| --- | --- | --- |
| France | SIA : eAIP + atlas VAC | eAIP ENR 2.1, 3.2, 4.1, 4.4 |
| Royaume-Uni, Estonie | eAIP nationales (AD 2.24) | Routes et points : eAIP ENR 3.1–3.3, 4.4 |
| Finlande, Islande | eAIP nationales (AD 2.24) | — |
| Autres pays d'Europe | — (aérodromes, pistes, fréquences, balises et plan au sol uniquement) | — |

## Démarrage

```sh
npm install
npm run data   # télécharge OurAirports et l'eAIP (cycle AIRAC en vigueur), génère public/data/
npm run dev    # http://localhost:5173
```

Production : `npm run build && npm start` (port 4173, modifiable via `PORT`).

## Sources

| Donnée | Source | Licence |
| --- | --- | --- |
| Aérodromes, pistes, fréquences, balises (Europe) | [OurAirports](https://ourairports.com/data/) | Domaine public |
| Cartes Royaume-Uni, Finlande, Estonie, Islande | eAIP nationales (NATS, ANS Finland, EANS, Isavia) | © services nationaux |
| Balises en route, points de report, routes RNAV, espaces aériens | eAIP France ENR 4.1, 4.4, 3.2, 2.1, [SIA](https://www.sia.aviation-civile.gouv.fr/) | © SIA/DGAC |
| Cartes IFR (ADC, SID, STAR, IAC…) | eAIP France, [SIA](https://www.sia.aviation-civile.gouv.fr/) | © SIA/DGAC |
| Cartes VAC | Atlas VAC, SIA | © SIA/DGAC |
| NOTAM | [SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr), SIA/DGAC (bulletin d'aérodrome, sans compte, cache 10 min) | Licence Ouverte Etalab 2.0 |
| METAR | [aviationweather.gov](https://aviationweather.gov) (NOAA) | Domaine public |
| Trafic et ATIS | [IVAO](https://www.ivao.aero) (API whazzup publique) | Conditions IVAO |
| Plan au sol : taxiways, aires de trafic, points d'attente, postes | OpenStreetMap via [Overpass](https://overpass-api.de/) (à la demande, cache 30 jours dans `.cache/ground`) | ODbL |
| Désignations de piste (08L, 26R…) | Seuils OurAirports | Domaine public |
| Fond de carte (style clair sur mesure, `src/lib/mapStyle.ts`) | [OpenFreeMap](https://openfreemap.org/) / OpenStreetMap | ODbL |

Les cartes du SIA ne sont **ni stockées ni redistribuées**. Le serveur (`server/`) indexe les liens
de l'eAIP du cycle AIRAC en vigueur et relaie à la demande le PDF officiel vers le navigateur, car le SIA
n'autorise ni CORS ni l'affichage en iframe.

⚠️ Données non certifiées, réservées à la simulation. Ne pas utiliser pour la navigation réelle.

### autorouter (dev uniquement)

En développement (`npm run dev`), les routes aériennes, SID, STAR, points de report et espaces aériens viennent des tuiles
vectorielles d'[autorouter](https://www.autorouter.aero) (couverture Europe) au lieu de nos données eAIP, qui sont
en veille. Le serveur de dev Vite récupère les tuiles **à la demande** (zone affichée, zone du vol analysé) et les
garde dans `.cache/autorouter-tiles` : rien à télécharger d'avance, et les tuiles ne sont ni versionnées ni
redistribuées. Le build de production n'utilise pas autorouter.

- `scripts/autorouter-tiles.ts` : chargement d'une tuile (cache, sinon autorouter)
- `scripts/autorouter-mvt.ts` : décodage des tuiles MVT
- `scripts/autorouter-procedures.ts` : SID et STAR d'un aérodrome (`/dev/autorouter/procedures/:icao`)
- `scripts/autorouter-nav.ts` : points et routes de la zone d'un vol (`/dev/autorouter/nav?bbox=`)
- `scripts/autorouter-search.ts` : recherche des balises et points (`/dev/autorouter/search?q=`) et détail d'une balise (`/dev/autorouter/navaid/:ident`)
- `scripts/view-autorouter-tiles.ts` : visionneuse autonome (`node scripts/view-autorouter-tiles.ts`, port 5180)
- `scripts/fetch-autorouter-tiles.ts` : préchargement limité d'une zone (`--bbox`, `--zooms`, `--max`)

## Structure

- `scripts/build-data.ts` : conversion OurAirports → GeoJSON/JSON statiques
- `scripts/build-aip.ts` : extraction des balises, points, routes et espaces aériens de l'eAIP (champs AIXM du HTML)
- `scripts/build-eaip-enr.ts` : routes et points des eAIP européens au format Eurocontrol (Royaume-Uni, Estonie)
- `src/lib/mapStyle.ts`, `aeroIcons.ts`, `aeroLayers.ts` : fond de carte clair, symboles OACI et couches aéronautiques
- `server/airac.ts` : calcul du cycle AIRAC
- `server/charts.ts` : choix du fournisseur de cartes selon le préfixe OACI
- `server/sia.ts` : index des cartes eAIP + VAC du SIA (France)
- `server/eaip.ts` : fournisseur générique pour les eAIP au format Eurocontrol (menu → page AD 2 → PDF de la section AD 2.24) ;
  ajouter un pays = ajouter une entrée à `EAIP_COUNTRIES`
- `server/ground.ts` : plan au sol OpenStreetMap par aérodrome (serveurs Overpass de repli, cache disque)
- `server/api.ts` : `/api/charts/:icao`, `/api/pdf?url=`, `/api/georef?url=`, `/api/ground/:ident?lat=&lon=`, `/api/airac`
- `src/` : application React (carte MapLibre, recherche, fiche aérodrome, visualiseur pdf.js)

## Superposition des cartes sur la map

Bouton **◩ Superposer** dans le visualiseur. Le calage est d'abord tenté automatiquement (`server/georef.ts`) :

1. Les PDF du SIA n'ont pas de table Unicode, mais chaque glyphe porte un nom `MTnn` où `nn` est le code du
   caractère : le texte est reconstitué en rejouant les opérateurs de dessin de la page avec le code d'origine
   de chaque glyphe.
2. Les graduations du cadre (« 002° 30’ », « 49° 00’ », éventuellement sur deux lignes) sont repérées, puis
   associées à leur trait de graduation par consensus aléatoire (RANSAC).
3. Une similitude en Web Mercator est ajustée aux moindres carrés. La rotation n'est estimée que si la
   disposition des graduations le permet (sinon carte supposée orientée au nord). Le signe des longitudes
   sans lettre E/W est déduit de l'orientation des graduations.
4. Garde-fous : une graduation de plus que d'inconnues, écart résiduel ≤ 4 pt, rotation ≤ 5°, aérodrome
   situé sur la carte calée. Sinon la carte est jugée non calable (schématique, hors échelle, sans graduations).

Sur un échantillon de 13 aérodromes : 13/13 VAC, 192/198 cartes d'approche, ~40 % des SID, ~30 % des STAR ;
les cartes de sol n'ont généralement pas de graduations.

Si le calage automatique échoue, ou pour le corriger, un calage manuel est proposé : pour chaque point, un clic
sur le PDF puis un clic sur la map (aimanté aux seuils de piste, balises et aérodromes). Les calages manuels
sont mémorisés dans le navigateur et ont priorité sur le calage automatique.

Raccourcis du visualiseur : `+`/`-` zoom, `0` ajuster, `R` pivoter, `N` mode nuit, `Échap` fermer.
