import { hhmm, levelText, type NatTrack } from '../lib/nat.ts';
import { IconChevronDown, IconClose } from './icons.tsx';

const NAT_COLOR = '#0e7c86';

// Centres qui publient les tracks : Shanwick le jour (vers l'ouest), Gander la nuit (vers l'est)
const CENTERS: Record<string, string> = { EGGX: 'Shanwick', CZQX: 'Gander' };

const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** 56° 30′ N 020° 00′ W */
function position([lon, lat]: [number, number]): string {
  const part = (v: number, width: number, pos: string, neg: string) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.round((a - d) * 60);
    return `${String(d).padStart(width, '0')}° ${String(m).padStart(2, '0')}′ ${v >= 0 ? pos : neg}`;
  };
  return `${part(lat, 2, 'N', 'S')} ${part(lon, 3, 'E', 'W')}`;
}

interface Props {
  track: NatTrack;
  onClose: () => void;
}

/** Détails du track NAT choisi sur la carte */
export function NatPanel({ track, onClose }: Props) {
  const center = CENTERS[track.source];
  return (
    <div className="airport nat-panel">
      <header className="airport-header">
        <div className="airport-ident">
          <h2>NAT {track.letter}</h2>
          <span className="chip airspace-chip" style={{ color: NAT_COLOR, borderColor: NAT_COLOR }}>
            {track.active ? 'En vigueur' : 'À venir'}
          </span>
          <button className="icon-button" onClick={onClose} aria-label="Fermer" title="Fermer">
            <IconClose size={18} />
          </button>
        </div>
        <div className="airport-name">
          Track {track.direction === 'west' ? 'vers l’ouest' : track.direction === 'east' ? 'vers l’est' : 'dans les deux sens'}
        </div>
        <div className="airport-city">
          {center ? `${center} (${track.source})` : track.source} · message {track.message}
          {track.tmi && ` · TMI ${track.tmi}`}
        </div>
      </header>

      <div className="airport-body">
        <div className="info">
          <div className="airspace-limits" style={{ borderColor: NAT_COLOR }}>
            <div>
              <span className="airspace-limits-label">Validité</span>
              <span className="airspace-limits-value">
                {hhmm(track.validFrom)} – {hhmm(track.validTo)}
              </span>
              <span className="airspace-limits-sub">
                {day(track.validFrom)}
                {day(track.validTo) !== day(track.validFrom) && ` → ${day(track.validTo)}`}
              </span>
            </div>
            <div>
              <span className="airspace-limits-label">Vers l’ouest</span>
              <span className="airspace-limits-value">{levelText(track.westLevels) || '—'}</span>
              <span className="airspace-limits-sub" />
            </div>
            <div>
              <span className="airspace-limits-label">Vers l’est</span>
              <span className="airspace-limits-value">{levelText(track.eastLevels) || '—'}</span>
              <span className="airspace-limits-sub" />
            </div>
          </div>

          <h3 className="list-heading">Points de report</h3>
          <table className="table nat-route">
            <tbody>
              {track.fixes.map((f, i) => (
                <tr key={i}>
                  <td className="nat-route-index">{i + 1}</td>
                  <td className="mono strong">{f.label}</td>
                  <td className="mono right">{f.lngLat ? position(f.lngLat) : 'position inconnue'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {track.nar.length > 0 && (
            <>
              <h3 className="list-heading">Routes NAR</h3>
              <div className="nat-chips">
                {track.nar.map((n) => (
                  <span key={n} className="chip">
                    {n}
                  </span>
                ))}
              </div>
            </>
          )}

          {track.remarks.length > 0 && (
            <details className="legend-toggle nat-remarks">
              <summary className="list-heading">
                <IconChevronDown size={14} className="legend-chevron" />
                Remarques du message ({track.remarks.length})
              </summary>
              <ol>
                {track.remarks.map((r, i) => (
                  <li key={i}>{r.replace(/^\d+\.\s*/, '')}</li>
                ))}
              </ol>
            </details>
          )}

          <p className="footnote">Tracks NAT : FAA (NMS). Données non certifiées, réservées à la simulation de vol.</p>
        </div>
      </div>
    </div>
  );
}
