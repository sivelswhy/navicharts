import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GROUP_OF, groupColor } from '../lib/chartGroups.ts';
import { pdfUrl } from '../lib/data.ts';
import type { PdfPoint } from '../lib/georef.ts';
import { pdfjs } from '../lib/pdf.ts';
import type { Chart } from '../lib/types.ts';
import { IconClose, IconExternal, IconFit, IconMinus, IconMoon, IconOverlay, IconPlus, IconRotate } from './icons.tsx';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const NIGHT_KEY = 'navicharts:night';

interface Props {
  chart: Chart;
  onClose: () => void;
  /** Superposer la carte sur la map (ou lancer son calage) */
  onOverlay: () => void;
  /** Calage automatique en cours */
  overlayBusy?: boolean;
  /** Mode calage : un clic sur la page 1 désigne un point de calage */
  onPick?: (point: PdfPoint) => void;
  /** Points de calage déjà placés, affichés sur la page */
  markers?: PdfPoint[];
  hidden?: boolean;
}

// Au-delà de ce déplacement (px), un appui est un glisser et non un clic
const CLICK_TOLERANCE = 4;

function readNight(): boolean {
  try {
    return localStorage.getItem(NIGHT_KEY) === '1';
  } catch {
    return false;
  }
}

export function ChartViewer({ chart, onClose, onOverlay, overlayBusy, onPick, markers = [], hidden }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = page ajustée à la zone d'affichage
  const [rotation, setRotation] = useState(0);
  const [night, setNight] = useState(readNight);
  // Page 1 affichée (conteneur positionné autour du canvas) et sa projection, pour convertir clics ↔ coordonnées PDF
  const [page1, setPage1] = useState<{ element: HTMLDivElement; viewport: pdfjs.PageViewport } | null>(null);

  // Chargement du document
  useEffect(() => {
    setDoc(null);
    setError(null);
    setZoom(1);
    setRotation(0);
    let cancelled = false;
    const task = pdfjs.getDocument({ url: pdfUrl(chart.url) });
    task.promise.then(
      (d) => !cancelled && setDoc(d),
      () => !cancelled && setError('Impossible de récupérer la carte auprès du service d’information aéronautique.'),
    );
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [chart.url]);

  // Rendu des pages à l'échelle courante (re-rendu net à chaque zoom)
  useEffect(() => {
    if (!doc || !viewport.current || !pagesRef.current) return;
    const container = pagesRef.current;
    const box = viewport.current.getBoundingClientRect();
    const tasks: pdfjs.RenderTask[] = [];
    let cancelled = false;

    (async () => {
      const first = await doc.getPage(1);
      const unit = first.getViewport({ scale: 1, rotation });
      const fit = Math.min((box.width - 32) / unit.width, (box.height - 32) / unit.height);
      const scale = fit * zoom;
      const ratio = window.devicePixelRatio || 1;

      const pages: HTMLDivElement[] = [];
      let firstViewport: pdfjs.PageViewport | null = null;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = n === 1 ? first : await doc.getPage(n);
        if (cancelled) return;
        const vp = page.getViewport({ scale, rotation });
        firstViewport ??= vp;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * ratio);
        canvas.height = Math.floor(vp.height * ratio);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        const task = page.render({
          canvas,
          viewport: vp,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        tasks.push(task);
        const wrapper = document.createElement('div');
        wrapper.className = 'page';
        wrapper.append(canvas);
        pages.push(wrapper);
        await task.promise.catch(() => undefined);
        if (cancelled) return;
      }
      container.replaceChildren(...pages);
      setPage1({ element: pages[0], viewport: firstViewport! });
    })();

    return () => {
      cancelled = true;
      tasks.forEach((t) => t.cancel());
    };
  }, [doc, zoom, rotation]);

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
  }, []);

  const toggleNight = () =>
    setNight((n) => {
      try {
        localStorage.setItem(NIGHT_KEY, n ? '0' : '1');
      } catch {
        // préférence non mémorisée
      }
      return !n;
    });

  // Raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hidden || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === '0') setZoom(1);
      else if (e.key === 'r') setRotation((r) => (r + 90) % 360);
      else if (e.key === 'n') toggleNight();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy, hidden]);

  // Zoom au pavé tactile / Ctrl + molette
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // Déplacement par glisser
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const el = viewport.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const el = viewport.current!;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const start = drag.current;
    drag.current = null;
    if (!start || !onPick || !page1) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_TOLERANCE) return;
    const rect = page1.element.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const [px, py] = page1.viewport.convertToPdfPoint(x, y);
    onPick([px, py]);
  };

  // Points de calage, positionnés dans le repère de la page affichée
  const markerElements = page1
    ? markers.map((m, i) => {
        const [left, top] = page1.viewport.convertToViewportPoint(m[0], m[1]);
        return (
          <span key={i} className="pick-marker" style={{ left, top }}>
            {i + 1}
          </span>
        );
      })
    : null;

  return (
    <div className={hidden ? 'viewer hidden' : 'viewer'}>
      <header className="viewer-toolbar">
        <div className="viewer-title" title={chart.title}>
          <span className="type-chip" style={{ '--type': groupColor(GROUP_OF[chart.category]) } as React.CSSProperties}>
            {GROUP_OF[chart.category]}
          </span>
          <span className="viewer-title-text">{chart.title}</span>
        </div>
        <div className="toolbar-group">
          <button className="tool" onClick={() => zoomBy(0.8)} aria-label="Dézoomer" title="Dézoomer (-)">
            <IconMinus size={18} />
          </button>
          <span className="zoom-level">{Math.round(zoom * 100)} %</span>
          <button className="tool" onClick={() => zoomBy(1.25)} aria-label="Zoomer" title="Zoomer (+)">
            <IconPlus size={18} />
          </button>
          <button className="tool" onClick={() => setZoom(1)} aria-label="Ajuster" title="Ajuster à l'écran (0)">
            <IconFit size={18} />
          </button>
        </div>
        <div className="toolbar-group">
          <button className="tool" onClick={() => setRotation((r) => (r + 90) % 360)} title="Pivoter (R)" aria-label="Pivoter">
            <IconRotate size={18} />
          </button>
          <button className={night ? 'tool on' : 'tool'} onClick={toggleNight} title="Mode nuit (N)" aria-label="Mode nuit" aria-pressed={night}>
            <IconMoon size={18} />
          </button>
          {!onPick && (
            <button className="tool labelled" onClick={onOverlay} title="Superposer la carte sur la map" disabled={overlayBusy}>
              <IconOverlay size={18} />
              <span>{overlayBusy ? 'Calage…' : 'Superposer'}</span>
            </button>
          )}
          <a className="tool" href={chart.url} target="_blank" rel="noreferrer" title="Ouvrir le PDF officiel">
            <IconExternal size={17} />
          </a>
        </div>
        <button className="tool" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)">
          <IconClose size={18} />
        </button>
      </header>
      <div
        ref={viewport}
        className={['viewer-canvas', night && 'night', onPick && 'picking'].filter(Boolean).join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {error ? <p className="placeholder error">{error}</p> : !doc && <p className="placeholder">Chargement de la carte…</p>}
        <div ref={pagesRef} className="pages" />
        {page1 && createPortal(markerElements, page1.element)}
      </div>
    </div>
  );
}
