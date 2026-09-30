# NaviCharts

Alternative gratuite à Navigraph pour la simulation de vol, couvrant l'**Europe**, l'**outre-mer français**, une
partie des **Amériques**, l'**Afrique du Nord**, la **Russie**, une grande partie de l'**Asie** et l'**Australie**, construite à partir de données publiques (et, là où il
n'y en a pas, des sector files de la communauté IVAO).

| Pays | Cartes officielles | Espaces, routes, points | SID, STAR, approches |
| --- | --- | --- | --- |
| France métropolitaine | SIA : eAIP + atlas VAC | eAIP ENR 2.1, 3.2, 4.1, 4.4 | Tableaux de codage de l'eAIP |
| Outre-mer français (Antilles, Guyane, Saint-Pierre-et-Miquelon, Réunion, Mayotte, Nouvelle-Calédonie, Wallis-et-Futuna, Polynésie) | SIA : eAIP d'outre-mer (VAC incluses) | eAIP ENR 2.1, 3.1, 3.2, 4.1, 4.4 | Tableaux de codage de l'eAIP |
| Royaume-Uni, Estonie | eAIP nationales (AD 2.24) | Routes et points : eAIP ENR 3.1–3.3, 4.4 | — |
| Finlande, Islande | eAIP nationales (AD 2.24) | — | — |
| Brésil | — | DECEA : GeoAISWEB (routes, points, balises, FIR, CTA, TMA, CTR, zones P/R/D) | DECEA : jeu AIXM 5.1 officiel |
| États-Unis, Canada, Équateur, Uruguay | — | Sector files IVAO (routes, balises, points, espaces, VFR, MVA) | Sector files IVAO (sauf Uruguay) |
| Corée du Sud, Taïwan, Thaïlande, Israël | eAIP nationales (AD 2.24) | Routes et points : eAIP ENR 3.1–3.3, 4.4 | Thaïlande : sector files IVAO |
| Japon, Singapour, Indonésie | — | Sector files IVAO | Sector files IVAO |
| Chine, Hong Kong, Inde, Asie du Sud-Est, Asie centrale, Moyen-Orient (44 FIR) | — | Sector files Aurora | Sector files Aurora |
| Allemagne, Pays-Bas, Suisse, Autriche, Italie, Espagne, Portugal, Pologne, Tchéquie, Slovaquie, Hongrie, Roumanie, Bulgarie, Grèce, Chypre, Malte, Croatie, Slovénie, Bosnie-Herzégovine, Serbie, Macédoine du Nord, Albanie, Moldavie, Ukraine, Biélorussie, Turquie | — | Sector files Aurora | Sector files Aurora |
| Russie, Algérie, Tunisie, Maroc, Égypte, Australie | — | Sector files Aurora | Sector files Aurora |
| Autres pays d'Europe | — (aérodromes, pistes, fréquences, balises et plan au sol uniquement) | — | — |

## Démarrage

```sh
npm install
npm run data   # télécharge OurAirports, les eAIP, les données du DECEA et les sector files IVAO, génère public/data/
npm run dev    # http://localhost:5173
```

Production : `npm run build && npm start` (port 4173, modifiable via `PORT`).

## Sources

| Donnée | Source | Licence |
| --- | --- | --- |
| Aérodromes, pistes, fréquences, balises (Europe, outre-mer français, Brésil ; complète les sector files IVAO) | [OurAirports](https://ourairports.com/data/) | Domaine public |
| Cartes Royaume-Uni, Finlande, Estonie, Islande | eAIP nationales (NATS, ANS Finland, EANS, Isavia) | © services nationaux |
| Balises en route, points de report, routes, espaces aériens | eAIP France et outre-mer ENR 4.1, 4.4, 3.1, 3.2, 2.1, [SIA](https://www.sia.aviation-civile.gouv.fr/) | © SIA/DGAC |
| Cartes IFR (ADC, SID, STAR, IAC…) et tableaux de codage des procédures | eAIP France et outre-mer, [SIA](https://www.sia.aviation-civile.gouv.fr/) | © SIA/DGAC |
| Brésil : routes, points, balises, espaces aériens | DECEA, [GeoAISWEB](https://geoaisweb.decea.mil.br) (WFS public, cache 1 jour dans `.cache/decea`) | Données publiques du DECEA |
| Brésil : SID, STAR, approches | DECEA, [jeu AIXM complet](https://aisweb.decea.gov.br/?i=publicacoes&p=aixm) de l'amendement en vigueur (zip de ~55 Mo lu en flux) | Données publiques du DECEA |
| États-Unis, Canada, Équateur, Uruguay, Japon, Singapour, Indonésie, Thaïlande : navdata, espaces, VFR, MVA, secteurs ATC, procédures, plans au sol | Sector files Aurora des divisions IVAO : [US](https://github.com/IVAO-US/SectorFiles), [Canada](https://github.com/IVAO-Canada/SectorFiles), [Équateur](https://github.com/IVAO-Ecuador/IVAO-SectorFile), [Uruguay](https://github.com/Miguel22247/Aurora-Sector-File), [Japon](https://github.com/NightFalconS/RJJJ-AuroraSectorFile), [Singapour](https://github.com/NightFalconS/WSJCAuroraSectorFile), [Indonésie](https://github.com/IVAOID/ID-Sectorfile), [Thaïlande](https://github.com/ivaoth/sector-file) (cache 1 jour dans `.cache/sectorfiles`) | Canada, Indonésie : GPL-3.0 ; autres : sans licence (US : navdata « Keyvan Aviation ») — réservé à la simulation |
| Europe (hors pays à eAIP), Russie, Afrique du Nord, Moyen-Orient, Asie, Australie : mêmes données (les eAIP font foi là où elles existent) | Cache JSON d'Aurora, dépôt [navicharts-sector-files](https://github.com/sivelswhy/navicharts-sector-files) (clone superficiel dans `.cache/aurora`, mis à jour une fois par jour) | Données des divisions IVAO — réservé à la simulation |
| Cartes et routes : Corée du Sud, Taïwan, Thaïlande, Israël | eAIP nationales (KOCA, CAA Taïwan, CAAT, CAAI) | © services nationaux |
| Cartes VAC | Atlas VAC, SIA | © SIA/DGAC |
| NOTAM | [SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr), SIA/DGAC (bulletin d'aérodrome, sans compte, cache 10 min) | Licence Ouverte Etalab 2.0 |
| METAR | [aviationweather.gov](https://aviationweather.gov) (NOAA) | Domaine public |
| Trafic et ATIS | [IVAO](https://www.ivao.aero) (API whazzup publique) | Conditions IVAO |
| Plan au sol : taxiways, aires de trafic, points d'attente, postes | Sector files IVAO quand ils couvrent l'aérodrome, sinon OpenStreetMap via [Overpass](https://overpass-api.de/) (à la demande, cache 30 jours dans `.cache/ground`) | ODbL (OSM) |
| Désignations de piste (08L, 26R…) | Seuils OurAirports | Domaine public |
| Fond de carte (style clair sur mesure, `src/lib/mapStyle.ts`) | [OpenFreeMap](https://openfreemap.org/) / OpenStreetMap | ODbL |

Les cartes du SIA ne sont **ni stockées ni redistribuées**. Le serveur (`server/`) indexe les liens
de l'eAIP du cycle AIRAC en vigueur et relaie à la demande le PDF officiel vers le navigateur, car le SIA
n'autorise ni CORS ni l'affichage en iframe.

Les sector files « GNG » d'AeroNav (VATSIM) ne sont **pas** utilisés : leur navdata vient de Navigraph et leur
licence interdit toute conversion. Le dossier `sector files/` (téléchargements manuels éventuels) est ignoré par git.

⚠️ Données non certifiées, réservées à la simulation. Ne pas utiliser pour la navigation réelle.

### autorouter (dev uniquement)

En développement (`npm run dev`), les routes aériennes, SID, STAR, points de report et espaces aériens d'Europe viennent
des tuiles vectorielles d'[autorouter](https://www.autorouter.aero) au lieu de nos données eAIP ; hors d'Europe (outre-mer,
Amériques), nos données restent affichées. Dans le volet des couches, chaque interrupteur regroupe toutes les sources
d'un même contenu. Le serveur de dev Vite récupère les tuiles **à la demande** (zone affichée, zone du vol analysé) et les
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

- `scripts/build-data.ts` : assemblage de toutes les sources → GeoJSON/JSON statiques dans `public/data/`
- `scripts/build-aip.ts` : extraction des balises, points, routes et espaces aériens des eAIP du SIA, métropole et outre-mer (champs AIXM du HTML)
- `scripts/build-eaip-enr.ts` : routes et points des eAIP européens au format Eurocontrol (Royaume-Uni, Estonie)
- `scripts/build-ivao.ts` : données statiques des sector files IVAO (routes, balises, aérodromes, pistes, fréquences ATC, VFR, espaces, zones P/R/D, MVA, secteurs ATC)
- `scripts/build-aurora.ts` : mêmes données, depuis le cache JSON d'Aurora (dépôt `navicharts-sector-files`)
- `scripts/import-aurora.ts` (`npm run import-aurora`) : ajout de sector files exportés d'Aurora au dépôt de données (`sector files/aurora/`) : extraction des `.zip`, plans au sol précalculés (`ground_<OACI>.json`), tuiles inutiles retirées
- `scripts/build-decea.ts` : couches GeoAISWEB du DECEA (Brésil)
- `scripts/build-decea-procedures.ts` : SID, STAR et approches du jeu AIXM du DECEA → `public/data/procedures/<OACI>.json`
- `src/lib/mapStyle.ts`, `aeroIcons.ts`, `aeroLayers.ts` : fond de carte clair, symboles OACI et couches aéronautiques
- `server/airac.ts` : calcul du cycle AIRAC
- `server/charts.ts` : choix du fournisseur de cartes selon le préfixe OACI
- `server/sia.ts` : index des cartes des eAIP du SIA (métropole et outre-mer, chacune à sa date de publication) et de l'atlas VAC
- `server/sectorfiles.ts` : sector files IVAO (dépôts GitHub, cache disque, coordonnées décimales ou DMS) ; procédures et plans au sol
  à la demande ; ajouter une division = ajouter une entrée à `DIVISIONS`
- `server/aurora.ts` : sector files au format du cache d'Aurora (clone du dépôt, positions Web Mercator) ; procédures (points
  retrouvés par position) et plans au sol à la demande
- `server/eaip.ts` : fournisseur générique pour les eAIP au format Eurocontrol, Europe et Asie (menu → page AD 2 → PDF de la section AD 2.24) ;
  ajouter un pays = ajouter une entrée à `EAIP_COUNTRIES`
- `server/ground.ts` : plan au sol par aérodrome, sector files IVAO sinon OpenStreetMap (serveurs Overpass de repli, cache disque)
- `server/procedures.ts` : SID, STAR et approches d'après les tableaux de codage des eAIP du SIA
- `server/api.ts` : `/api/charts/:icao`, `/api/procedures/:icao` (SIA, sinon sector files IVAO), `/api/pdf?url=`, `/api/georef?url=`,
  `/api/ground/:ident?lat=&lon=`, `/api/airac`
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
