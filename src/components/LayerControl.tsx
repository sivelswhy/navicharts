import { useCallback, useState } from 'react';
import { aeroIconUrl, type AeroIcon } from '../lib/aeroIcons.ts';
import { LAYER_GROUP_LABELS, type LayerGroup } from '../lib/aeroLayers.ts';
import { IconChevronDown, IconClose } from './icons.tsx';

const KEY = 'navicharts:layers';
const DEFAULTS: Record<LayerGroup, boolean> = {
  airspaces: true,
  airways: true,
  autorouter: true,
  autorouterAirspaces: true,
  autorouterSid: true,
  autorouterStar: true,
  autorouterPoints: true,
  waypoints: true,
  navaids: true,
  airports: true,
  ground: true,
  // Trafic IVAO : interroge le réseau toutes les 20 s, activé à la demande
  nat: true,
  ivao: false,
};

function read(): Record<LayerGroup, boolean> {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

/** Couches aéronautiques affichées, mémorisées dans le navigateur */
export function useLayerVisibility() {
  const [layers, setLayers] = useState(read);
  const toggle = useCallback((group: LayerGroup) => {
    setLayers((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // préférence non mémorisée
      }
      return next;
    });
  }, []);
  return { layers, toggle };
}

interface Props {
  layers: Record<LayerGroup, boolean>;
  onToggle: (group: LayerGroup) => void;
  onClose: () => void;
}

const LEGEND: [AeroIcon, string][] = [
  ['airport-ifr', 'Aérodrome IFR (cartes eAIP)'],
  ['airport-vfr', 'Aérodrome VFR'],
  ['heliport', 'Hélistation'],
  ['vor', 'VOR'],
  ['vor-dme', 'VOR-DME'],
  ['dme', 'DME'],
  ['tacan', 'TACAN / VORTAC'],
  ['ndb', 'NDB'],
  ['waypoint', 'Point de report'],
];

/** Volet des couches de la carte, avec la légende des symboles */
export function LayerControl({ layers, onToggle, onClose }: Props) {
  return (
    <div className="floating-panel layer-panel">
      <header className="floating-head">
        <h3>Couches</h3>
        <button className="icon-button" onClick={onClose} aria-label="Fermer">
          <IconClose size={16} />
        </button>
      </header>
      <ul className="switch-list">
        {(Object.keys(LAYER_GROUP_LABELS) as LayerGroup[]).map((group) => (
          <li key={group}>
            <label className="switch-row">
              <span>{LAYER_GROUP_LABELS[group]}</span>
              <input type="checkbox" role="switch" checked={layers[group]} onChange={() => onToggle(group)} />
            </label>
          </li>
        ))}
      </ul>
      {/* Légende repliée par défaut, dépliée d'un clic */}
      <details className="legend-toggle">
        <summary className="list-heading">
          <IconChevronDown size={14} className="legend-chevron" />
          Légende
        </summary>
        <ul className="legend">
          {LEGEND.map(([icon, label]) => (
            <li key={icon}>
              <img src={aeroIconUrl(icon)} alt="" width={16} height={16} /> {label}
            </li>
          ))}
          {import.meta.env.DEV ? (
            <>
              <li>
                <i className="swatch airspace" /> CTR, TMA
              </li>
              <li>
                <i className="swatch airspace-restricted" /> Zone réglementée (R) ou interdite (P)
              </li>
              <li>
                <i className="swatch airspace-danger" /> Zone dangereuse (D)
              </li>
              <li>
                <i className="swatch airspace-temporary" /> TRA, TSA
              </li>
            </>
          ) : (
            <>
              <li>
                <i className="swatch airspace" /> Espace contrôlé (classes A, C, D)
              </li>
              <li>
                <i className="swatch airspace-e" /> Classe E, LTA
              </li>
            </>
          )}
          <li>
            <i className="swatch airway" /> Route RNAV
          </li>
        </ul>
      </details>
    </div>
  );
}
