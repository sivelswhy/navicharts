import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfUrl } from './data.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

// Taille maximale de l'image superposée (limite de texture WebGL courante)
const MAX_OVERLAY_PX = 4096;

export type OverlayStyle = 'transparent' | 'original';

export interface OverlayImage {
  image: ImageBitmap;
  /** Emprise de la page en espace PDF : [x0, y0, x1, y1] */
  view: number[];
}

/**
 * Rend la page 1 d'une carte en image pour la superposer à la map.
 * En style « transparent », le blanc du papier devient transparent (« couleur vers alpha ») : superposée à un fond
 * blanc, l'image restitue exactement la carte d'origine, et le fond de carte reste visible sous les zones claires.
 */
export async function renderOverlay(chartUrl: string, style: OverlayStyle): Promise<OverlayImage> {
  const task = pdfjs.getDocument({ url: pdfUrl(chartUrl) });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const unit = page.getViewport({ scale: 1, rotation: 0 });
    const scale = MAX_OVERLAY_PX / Math.max(unit.width, unit.height);
    const viewport = page.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;

    if (style === 'transparent') {
      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        // Opacité minimale permettant de retrouver la couleur d'origine par-dessus du blanc :
        // c = a·C + (1 − a)·255  ⇒  C = (c − 255·(1 − a)) / a
        const a = (255 - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
        if (a === 0) {
          d[i + 3] = 0;
          continue;
        }
        for (let k = 0; k < 3; k++) d[i + k] = Math.round((d[i + k] - 255 * (1 - a)) / a);
        d[i + 3] = Math.round(a * 255);
      }
      ctx.putImageData(img, 0, 0);
    }

    return { image: await createImageBitmap(canvas), view: page.view };
  } finally {
    task.destroy();
  }
}
