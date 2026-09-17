import { pathToSvg, type PieceShape, type PuzzleLayout } from '@puzzlelove/shared';

/** Upper bound on total bitmap pixels for all pieces, to keep memory sane on phones. */
const PIXEL_BUDGET = 36_000_000;

export interface RenderedPieces {
  canvases: HTMLCanvasElement[];
  /** Bitmap pixels per world unit. */
  resolution: number;
}

export function pieceBox(shape: PieceShape, layout: PuzzleLayout) {
  return {
    x: shape.x - layout.pad,
    y: shape.y - layout.pad,
    w: layout.cellW + layout.pad * 2,
    h: layout.cellH + layout.pad * 2,
  };
}

export function renderPieces(image: HTMLImageElement, layout: PuzzleLayout, shapes: PieceShape[]): RenderedPieces {
  const bw = layout.cellW + layout.pad * 2;
  const bh = layout.cellH + layout.pad * 2;
  const imgScale = image.naturalWidth / layout.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let resolution = Math.min(imgScale, dpr * 1.5);
  resolution = Math.min(resolution, Math.sqrt(PIXEL_BUDGET / (shapes.length * bw * bh)));
  resolution = Math.max(0.5, resolution);

  const s = Math.min(layout.cellW, layout.cellH);
  const canvases = shapes.map((shape) => {
    const box = pieceBox(shape, layout);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(box.w * resolution);
    canvas.height = Math.ceil(box.h * resolution);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(resolution, resolution);
    ctx.translate(-box.x, -box.y);
    const path = new Path2D(pathToSvg(shape.path));

    ctx.save();
    ctx.clip(path);
    // Source rect clamped to the image so border pieces don't read outside it.
    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(layout.width, box.x + box.w);
    const y1 = Math.min(layout.height, box.y + box.h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x0 * imgScale, y0 * imgScale, (x1 - x0) * imgScale, (y1 - y0) * imgScale, x0, y0, x1 - x0, y1 - y0);

    // Bevel: light inner edge top-left, dark inner edge bottom-right.
    const lw = s * 0.05;
    ctx.lineWidth = lw;
    ctx.save();
    ctx.translate(lw * 0.35, lw * 0.35);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.stroke(path);
    ctx.restore();
    ctx.save();
    ctx.translate(-lw * 0.35, -lw * 0.35);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.stroke(path);
    ctx.restore();
    ctx.restore();

    ctx.lineWidth = Math.max(0.6, s * 0.007);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.stroke(path);
    return canvas;
  });
  return { canvases, resolution };
}

export const GLOW_MARGIN = 14;

export function renderGlow(shape: PieceShape, layout: PuzzleLayout): HTMLCanvasElement {
  const box = pieceBox(shape, layout);
  const m = GLOW_MARGIN;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(box.w + m * 2);
  canvas.height = Math.ceil(box.h + m * 2);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(m - box.x, m - box.y);
  const path = new Path2D(pathToSvg(shape.path));
  ctx.shadowColor = 'rgba(255, 200, 80, 1)';
  ctx.shadowBlur = 12;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2.5, Math.min(layout.cellW, layout.cellH) * 0.035);
  ctx.strokeStyle = 'rgba(255, 250, 225, 0.95)';
  ctx.stroke(path);
  ctx.stroke(path);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 245, 200, 0.18)';
  ctx.fill(path);
  return canvas;
}
