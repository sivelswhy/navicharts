import { GROUP_OF, groupColor } from '../lib/chartGroups.ts';
import type { Pin } from '../lib/pins.ts';
import type { Chart } from '../lib/types.ts';
import { IconClose, IconPin } from './icons.tsx';

interface Props {
  pins: Pin[];
  displayed: Chart | null;
  onOpen: (pin: Pin) => void;
  onRemove: (id: string) => void;
}

/** Barre des cartes épinglées : une tuile par carte, colorée selon sa famille */
export function Pinboard({ pins, displayed, onOpen, onRemove }: Props) {
  return (
    <div className="pinboard">
      <span className="pinboard-label">
        <IconPin size={16} />
      </span>
      {pins.length === 0 ? (
        <span className="pinboard-empty">Épinglez des cartes pour les retrouver ici en un clic.</span>
      ) : (
        <ul className="pinboard-list">
          {pins.map((pin) => (
            <li
              key={pin.chart.id}
              className={displayed?.id === pin.chart.id ? 'pin-tile on' : 'pin-tile'}
              style={{ '--type': groupColor(GROUP_OF[pin.chart.category]) } as React.CSSProperties}
            >
              <button className="pin-open" onClick={() => onOpen(pin)} title={`${pin.icao} · ${pin.chart.title}`}>
                <span className="pin-icao">{pin.icao}</span>
                <span className="pin-title">{pin.chart.title}</span>
              </button>
              <button className="pin-remove" onClick={() => onRemove(pin.chart.id)} aria-label="Retirer du pinboard">
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
