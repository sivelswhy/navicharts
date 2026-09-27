import type { LngLat } from '../lib/georef.ts';
import type { FlightRoute } from '../lib/route.ts';
import { IconClose } from './icons.tsx';

interface Props {
  route: FlightRoute;
  onFocus: (lngLat: LngLat) => void;
  onClear: () => void;
}

/** Bandeau de la route active, en haut de la carte : un bouton par point, les procédures et routes entre les points */
export function RouteStrip({ route, onFocus, onClear }: Props) {
  const first = route.legs[0]?.from;
  if (!first) return null;
  return (
    <div className="route-strip" role="navigation" aria-label="Route active">
      <ol className="route-points">
        <li>
          <button className="route-point terminal" onClick={() => onFocus(first.lngLat)} title={first.name}>
            {first.ident}
          </button>
        </li>
        {route.legs.map((leg, i) => (
          <li key={i}>
            {/* Nom de la procédure ou de la route au premier point qu'elle dessert, simple flèche ensuite */}
            {leg.via !== 'DCT' && leg.via !== route.legs[i - 1]?.via ? (
              <span className={`route-via ${leg.phase}`} aria-label={`via ${leg.via}`}>
                {leg.via}
              </span>
            ) : (
              <span className="route-via direct" aria-hidden>
                ›
              </span>
            )}
            <button
              className={i === route.legs.length - 1 && route.arrival ? 'route-point terminal' : 'route-point'}
              onClick={() => onFocus(leg.to.lngLat)}
              title={leg.to.name ?? leg.to.ident}
            >
              {leg.to.ident}
            </button>
          </li>
        ))}
      </ol>
      <span className="route-total">{Math.round(route.totalNm)} NM</span>
      <button className="icon-button" onClick={onClear} aria-label="Retirer la route" title="Retirer la route">
        <IconClose size={15} />
      </button>
    </div>
  );
}
