import { AERO_COLORS } from '../lib/aeroIcons.ts';
import type { AirspaceInfo } from '../lib/aeroLayers.ts';
import { IconClose } from './icons.tsx';

// Types autorouter (mêmes couleurs que sur la carte, voir aeroLayers.ts)
const TYPES: Record<number, { label: string; short: string; color: string }> = {
  13: { label: 'Zone de contrôle', short: 'CTR', color: '#3b78c4' },
  40: { label: 'Région de contrôle terminale', short: 'TMA', color: '#3b78c4' },
  15: { label: 'Zone dangereuse', short: 'D', color: AERO_COLORS.danger },
  31: { label: 'Zone interdite', short: 'P', color: AERO_COLORS.restricted },
  35: { label: 'Zone réglementée', short: 'R', color: AERO_COLORS.restricted },
  42: { label: 'Zone réservée temporairement', short: 'TRA', color: AERO_COLORS.temporary },
  43: { label: 'Zone ségréguée temporairement', short: 'TSA', color: AERO_COLORS.temporary },
};

// Constaté sur les CTR : 3 pour les terrains militaires, 1 pour les terrains mixtes, 2 pour les terrains civils
const CONTROL: Record<number, string> = { 1: 'Civil et militaire', 2: 'Civil', 3: 'Militaire' };

const hundreds = (n: string) => (Number(n) * 100).toLocaleString('fr-FR');

/** Limite verticale autorouter (F245, A025, H010, GND…) en clair */
function limit(code: unknown): { main: string; sub?: string } {
  const s = String(code ?? '');
  let m: RegExpMatchArray | null;
  if (s === 'GND') return { main: 'Sol', sub: 'GND' };
  if (s === 'MSL') return { main: 'Niveau de la mer', sub: 'MSL' };
  if ((m = s.match(/^F(\d+)$/))) return Number(m[1]) >= 999 ? { main: 'Illimité', sub: 'UNL' } : { main: `FL ${Number(m[1])}`, sub: s };
  if ((m = s.match(/^A(\d+)$/))) return { main: `${hundreds(m[1])} ft`, sub: 'AMSL' };
  if ((m = s.match(/^H(\d+)$/))) return { main: `${hundreds(m[1])} ft`, sub: 'ASFC' };
  return { main: s || '?' };
}

interface Props {
  airspace: AirspaceInfo;
  onClose: () => void;
}

// Nos données (eAIP France, sector files IVAO) : type en toutes lettres
const LOCAL_TYPES: Record<string, { label: string; ivaoLabel?: string }> = {
  FIR: { label: 'Région d’information de vol', ivaoLabel: 'Centre de contrôle en route (ARTCC / FIR)' },
  UIR: { label: 'Région supérieure d’information de vol' },
  CTA: { label: 'Région de contrôle' },
  UTA: { label: 'Région supérieure de contrôle' },
  LTA: { label: 'Région inférieure de contrôle' },
  TMA: { label: 'Région de contrôle terminale', ivaoLabel: 'Espace terminal (approche, classe B ou C)' },
  CTR: { label: 'Zone de contrôle', ivaoLabel: 'Zone de contrôle (classe D)' },
  P: { label: 'Zone interdite' },
  R: { label: 'Zone réglementée' },
  D: { label: 'Zone dangereuse' },
};

/** Limite verticale publiée (« FL 195 », « SFC », « 1500 FT AMSL »…) */
function localLimit(value: unknown): { main: string; sub?: string } {
  const s = String(value ?? '').trim();
  if (!s) return { main: 'Non publiée' };
  if (/^(SFC|GND)$/i.test(s)) return { main: 'Sol', sub: s.toUpperCase() };
  if (/^UNL/i.test(s)) return { main: 'Illimité', sub: 'UNL' };
  return { main: s };
}

/** Espace aérien de nos données (eAIP France, sector files IVAO) */
function LocalAirspacePanel({ airspace, onClose }: Props) {
  const ivao = airspace.ivao === true;
  const type = LOCAL_TYPES[String(airspace.type)];
  const cls = String(airspace.class ?? '');
  const upper = localLimit(airspace.upper);
  const lower = localLimit(airspace.lower);
  const color =
    airspace.type === 'D' ? AERO_COLORS.danger : airspace.type === 'P' || airspace.type === 'R' ? AERO_COLORS.restricted : cls === 'E' ? AERO_COLORS.temporary : airspace.type === 'FIR' ? '#8f8a82' : '#3b78c4';

  return (
    <div className="airport airspace-panel">
      <header className="airport-header">
        <div className="airport-ident">
          <h2>{String(airspace.name ?? '')}</h2>
          <span className="chip airspace-chip" style={{ color, borderColor: color }}>
            {String(airspace.type)}
            {cls && ` · ${cls}`}
          </span>
          <button className="icon-button" onClick={onClose} aria-label="Fermer" title="Fermer">
            <IconClose size={18} />
          </button>
        </div>
        <div className="airport-city">{(ivao && type?.ivaoLabel) || type?.label || 'Espace aérien'}</div>
      </header>

      <div className="info">
        {ivao ? (
          <p className="footnote">Limites verticales non publiées dans les sector files : les niveaux affichés sur la carte, quand il y en a, sont en centaines de pieds.</p>
        ) : (
          <div className="airspace-limits" style={{ borderColor: color }}>
            <div>
              <span className="airspace-limits-label">Plafond</span>
              <span className="airspace-limits-value">{upper.main}</span>
              {upper.sub && <span className="airspace-limits-sub">{upper.sub}</span>}
            </div>
            <div>
              <span className="airspace-limits-label">Plancher</span>
              <span className="airspace-limits-value">{lower.main}</span>
              {lower.sub && <span className="airspace-limits-sub">{lower.sub}</span>}
            </div>
          </div>
        )}
        {cls && (
          <dl className="facts">
            <div>
              <dt>Classe</dt>
              <dd>{cls}</dd>
            </div>
          </dl>
        )}
        <p className="footnote">
          Espaces aériens : {ivao ? 'sector files IVAO (simulation)' : airspace.source === 'DECEA' ? 'DECEA (GeoAISWEB), Brésil' : 'eAIP France, SIA'}. Horaires et fréquences non disponibles
          ici : référez-vous toujours à l’AIP.
        </p>
      </div>
    </div>
  );
}

/** Détails de l'espace aérien mis en évidence sur la carte (autorouter en test local, ou nos données) */
export function AirspacePanel({ airspace, onClose }: Props) {
  if (airspace.origin === 'local') return <LocalAirspacePanel airspace={airspace} onClose={onClose} />;
  const type = TYPES[Number(airspace.type)];
  const upper = limit(airspace.altupper);
  const lower = limit(airspace.altlower);
  const control = CONTROL[Number(airspace.controltype)];

  return (
    <div className="airport airspace-panel">
      <header className="airport-header">
        <div className="airport-ident">
          <h2>{String(airspace.ident ?? '')}</h2>
          {type && (
            <span className="chip airspace-chip" style={{ color: type.color, borderColor: type.color }}>
              {type.short}
            </span>
          )}
          <button className="icon-button" onClick={onClose} aria-label="Fermer" title="Fermer">
            <IconClose size={18} />
          </button>
        </div>
        {airspace.name && <div className="airport-name">{String(airspace.name)}</div>}
        <div className="airport-city">{type?.label ?? `Espace aérien (type ${airspace.type})`}</div>
      </header>

      <div className="info">
        <div className="airspace-limits" style={{ borderColor: type?.color }}>
          <div>
            <span className="airspace-limits-label">Plafond</span>
            <span className="airspace-limits-value">{upper.main}</span>
            {upper.sub && <span className="airspace-limits-sub">{upper.sub}</span>}
          </div>
          <div>
            <span className="airspace-limits-label">Plancher</span>
            <span className="airspace-limits-value">{lower.main}</span>
            {lower.sub && <span className="airspace-limits-sub">{lower.sub}</span>}
          </div>
        </div>

        <dl className="facts">
          {control && (
            <div>
              <dt>Utilisateurs</dt>
              <dd>{control}</dd>
            </div>
          )}
          <div>
            <dt>Utilisation flexible</dt>
            <dd>{airspace.flexibleuse ? 'Oui (FUA)' : 'Non'}</dd>
          </div>
        </dl>
        <p className="footnote">
          Espaces aériens : autorouter / EAD. Classe, horaires et fréquences non disponibles ici : référez-vous
          toujours à l’AIP.
        </p>
      </div>
    </div>
  );
}
