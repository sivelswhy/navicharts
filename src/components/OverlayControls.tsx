import { GROUP_OF, groupColor } from '../lib/chartGroups.ts';
import type { OverlayStyle } from '../lib/pdf.ts';
import type { Chart } from '../lib/types.ts';
import { IconClose } from './icons.tsx';

function formatError(rmsMeters: number | null, points: number): string {
  if (rmsMeters === null) return '';
  if (points < 3) return 'Ajoutez un 3ᵉ point pour estimer la précision';
  return `Écart moyen : ${rmsMeters < 10 ? rmsMeters.toFixed(1) : Math.round(rmsMeters)} m`;
}

interface CalibrationBarProps {
  step: 'chart' | 'map';
  /** Message affiché au-dessus des consignes (ex. échec du calage automatique) */
  notice?: string;
  pointCount: number;
  rmsMeters: number | null;
  onUndo: () => void;
  onFinish: () => void;
  onCancel: () => void;
}

export function CalibrationBar({ step, notice, pointCount, rmsMeters, onUndo, onFinish, onCancel }: CalibrationBarProps) {
  const n = pointCount + 1;
  return (
    <div className="calibration-bar" role="status">
      <div className="calibration-text">
        {notice && pointCount === 0 && <span className="calibration-notice">{notice}</span>}
        <strong>
          Calage · point {n} · {step === 'chart' ? 'sur la carte PDF' : 'sur la map'}
        </strong>
        <span>
          {step === 'chart'
            ? 'Cliquez un repère précis : seuil de piste, VOR, intersection de routes… (glisser pour se déplacer, Ctrl + molette pour zoomer)'
            : 'Cliquez le même repère sur la map. Le clic est aimanté aux seuils de piste (jaune), balises et aérodromes.'}
        </span>
        {pointCount >= 2 && <span className="calibration-quality">{formatError(rmsMeters, pointCount)}</span>}
      </div>
      <div className="calibration-actions">
        {(pointCount > 0 || step === 'map') && <button onClick={onUndo}>Annuler le dernier point</button>}
        <button onClick={onCancel}>Abandonner</button>
        {pointCount >= 2 && (
          <button className="primary" onClick={onFinish}>
            Terminer
          </button>
        )}
      </div>
    </div>
  );
}

type GeorefSource =
  | { kind: 'auto'; graduations: number; rmsMeters: number }
  | { kind: 'manual'; points: number; rmsMeters: number | null };

interface OverlayPanelProps {
  chart: Chart;
  status: 'loading' | 'ready' | 'error';
  opacity: number;
  style: OverlayStyle;
  source: GeorefSource;
  onOpacity: (v: number) => void;
  onStyle: (s: OverlayStyle) => void;
  onShowChart: () => void;
  /** Absent pour un calage automatique */
  onRefine?: () => void;
  onRecalibrate: () => void;
  onRemove: () => void;
}

export function OverlayPanel(props: OverlayPanelProps) {
  const { chart, status, opacity, style, source } = props;
  return (
    <div className="floating-panel overlay-panel">
      <header className="floating-head">
        <span className="type-chip" style={{ '--type': groupColor(GROUP_OF[chart.category]) } as React.CSSProperties}>
          {GROUP_OF[chart.category]}
        </span>
        <h3 title={chart.title}>{chart.title}</h3>
        <button className="icon-button" onClick={props.onRemove} aria-label="Retirer la superposition">
          <IconClose size={16} />
        </button>
      </header>
      {status === 'loading' && <p className="footnote">Préparation de l'image…</p>}
      {status === 'error' && <p className="footnote error">Impossible de récupérer la carte auprès du service d’information aéronautique.</p>}
      <label className="overlay-row">
        <span>Opacité</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => props.onOpacity(Number(e.target.value))}
        />
      </label>
      <div className="overlay-row segmented">
        <button className={style === 'transparent' ? 'on' : ''} onClick={() => props.onStyle('transparent')}>
          Fond transparent
        </button>
        <button className={style === 'original' ? 'on' : ''} onClick={() => props.onStyle('original')}>
          Originale
        </button>
      </div>
      <p className="footnote">
        {source.kind === 'auto'
          ? `Calage automatique · ${source.graduations} graduations · écart moyen ${Math.round(source.rmsMeters)} m`
          : `Calage manuel · ${formatError(source.rmsMeters, source.points)}`}
      </p>
      <div className="overlay-actions">
        <button onClick={props.onShowChart}>Voir la carte</button>
        {props.onRefine && <button onClick={props.onRefine}>Ajouter un point</button>}
        <button onClick={props.onRecalibrate}>{source.kind === 'auto' ? 'Caler à la main' : 'Recaler'}</button>
      </div>
    </div>
  );
}
