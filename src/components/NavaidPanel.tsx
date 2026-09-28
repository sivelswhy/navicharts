import { useEffect, useState } from 'react';
import { AERO_COLORS } from '../lib/aeroIcons.ts';
import { fetchNavaidDetails, type NavaidComponent, type NavaidDetails, type NavaidInfo } from '../lib/navaid.ts';
import { IconClose } from './icons.tsx';

interface Props {
  navaid: NavaidInfo;
  onClose: () => void;
}

const isNdb = (type?: string) => /NDB/.test(type ?? '');

const dms = (value: number, pos: string, neg: string) => {
  const a = Math.abs(value);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${d}° ${m.toFixed(2).padStart(5, '0')}′ ${value >= 0 ? pos : neg}`;
};

/** Détails d'une balise (VOR, DME, NDB…) choisie sur la carte ou dans la recherche */
export function NavaidPanel({ navaid, onClose }: Props) {
  const [details, setDetails] = useState<NavaidDetails | null | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    setDetails('loading');
    fetchNavaidDetails(navaid).then(
      (d) => !cancelled && setDetails(d),
      () => !cancelled && setDetails(null),
    );
    return () => {
      cancelled = true;
    };
  }, [navaid]);

  const d = details === 'loading' ? null : details;
  const color = isNdb(navaid.type) ? AERO_COLORS.ndb : AERO_COLORS.vor;
  const [lon, lat] = d?.lngLat ?? navaid.lngLat;
  const name = navaid.name || d?.name;
  // Sans détail autorouter : la fréquence de nos données
  const components: NavaidComponent[] = d?.components.length
    ? d.components
    : navaid.frequency
      ? [{ type: navaid.type ?? 'Balise', frequency: navaid.frequency, operational: true }]
      : [];

  return (
    <div className="airport navaid-panel">
      <header className="airport-header">
        <div className="airport-ident">
          <h2>{navaid.ident}</h2>
          {navaid.type && (
            <span className="chip airspace-chip" style={{ color, borderColor: color }}>
              {navaid.type}
            </span>
          )}
          <button className="icon-button" onClick={onClose} aria-label="Fermer" title="Fermer">
            <IconClose size={18} />
          </button>
        </div>
        {name && <div className="airport-name">{name}</div>}
      </header>

      <div className="info">
        {components.length > 0 && (
          <div className="airspace-limits" style={{ borderColor: color }}>
            {components.map((c, i) => (
              <div key={i}>
                <span className="airspace-limits-label">{c.type}</span>
                <span className="airspace-limits-value">{c.frequency ?? (c.channel ? `Canal ${c.channel}` : '—')}</span>
                <span className="airspace-limits-sub">
                  {c.channel && c.frequency ? `CH ${c.channel}` : ''}
                  {!c.operational && ' hors service'}
                </span>
              </div>
            ))}
          </div>
        )}
        {details === 'loading' && import.meta.env.DEV && <p className="placeholder">Chargement du détail…</p>}

        <dl className="facts">
          {d?.declination !== undefined && (
            <div>
              <dt>Déclinaison</dt>
              <dd>
                {Math.abs(d.declination).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}° {d.declination >= 0 ? 'E' : 'W'}
              </dd>
            </div>
          )}
          {d?.elevationFt !== undefined && (
            <div>
              <dt>Altitude</dt>
              <dd>{Math.round(d.elevationFt).toLocaleString('fr-FR')} ft</dd>
            </div>
          )}
          <div className="wide">
            <dt>Position</dt>
            <dd className="mono">
              {dms(lat, 'N', 'S')} {dms(lon, 'E', 'W')}
            </dd>
          </div>
        </dl>
        <p className="footnote">
          {d ? 'Détail : autorouter. ' : ''}Données non certifiées, référez-vous toujours à l’AIP.
        </p>
      </div>
    </div>
  );
}
