import { createRng } from '../rng';
import type { PuzzleLayout, PuzzleMeta } from './layout';

export interface Pt {
  x: number;
  y: number;
}

/** Cubic bezier segment; straight lines use control points on the line. */
export interface Seg {
  c1: Pt;
  c2: Pt;
  to: Pt;
}

export interface EdgePath {
  from: Pt;
  segs: Seg[];
}

export interface PieceShape {
  id: number;
  row: number;
  col: number;
  /** Top-left corner of the piece's cell in assembled-puzzle coordinates. */
  x: number;
  y: number;
  /** Closed clockwise outline in assembled-puzzle coordinates. */
  path: EdgePath;
}

interface TabParams {
  sign: 1 | -1;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  t: number;
}

const JITTER = 0.04;

function randomTab(rng: () => number): TabParams {
  const j = () => (rng() * 2 - 1) * JITTER;
  return {
    sign: rng() < 0.5 ? 1 : -1,
    a: j() * 0.5,
    b: j(),
    c: j(),
    d: j(),
    e: j() * 0.5,
    t: 0.1,
  };
}

function lerpPt(p: Pt, q: Pt, k: number): Pt {
  return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
}

function straight(from: Pt, to: Pt): EdgePath {
  return { from, segs: [{ c1: lerpPt(from, to, 1 / 3), c2: lerpPt(from, to, 2 / 3), to }] };
}

/**
 * Classic jigsaw tab (based on Draradech's generator). `from`→`to` is an axis-aligned edge.
 * The tab bulges along `normal * sign`. Tab size scales with `s` (the smaller cell side)
 * so pieces look the same on non-square grids.
 */
function tabEdge(from: Pt, to: Pt, normal: Pt, s: number, p: TabParams): EdgePath {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const dir = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  const pt = (l: number, w: number, useLen = false): Pt => {
    const along = useLen ? l * len : len / 2 + (l - 0.5) * s;
    const across = w * s * p.sign;
    return {
      x: from.x + dir.x * along + normal.x * across,
      y: from.y + dir.y * along + normal.y * across,
    };
  };
  const { a, b, c, d, e, t } = p;
  return {
    from,
    segs: [
      { c1: pt(0.2, a, true), c2: pt(0.5 + b + d, -t + c), to: pt(0.5 - t + b, t + c) },
      { c1: pt(0.5 - 2 * t + b - d, 3 * t + c), c2: pt(0.5 + 2 * t + b - d, 3 * t + c), to: pt(0.5 + t + b, t + c) },
      { c1: pt(0.5 + b + d, -t + c), c2: pt(0.8, e, true), to },
    ],
  };
}

export function reverseEdge(edge: EdgePath): EdgePath {
  const segs: Seg[] = [];
  for (let i = edge.segs.length - 1; i >= 0; i--) {
    const seg = edge.segs[i];
    const prev = i === 0 ? edge.from : edge.segs[i - 1].to;
    segs.push({ c1: seg.c2, c2: seg.c1, to: prev });
  }
  return { from: edge.segs[edge.segs.length - 1].to, segs };
}

/**
 * Builds every piece outline. Internal edges are generated once and shared, so neighbors
 * always match exactly. Output is fully determined by rows, cols, seed and layout.
 */
export function generatePieceShapes(meta: PuzzleMeta, layout: PuzzleLayout): PieceShape[] {
  const { rows, cols, seed } = meta;
  const { cellW, cellH } = layout;
  const s = Math.min(cellW, cellH);
  const rng = createRng(seed);

  // horizontal[r][c]: edge on y = r*cellH (1 <= r < rows), left→right, normal +y
  const horizontal: EdgePath[][] = [];
  for (let r = 1; r < rows; r++) {
    horizontal[r] = [];
    for (let c = 0; c < cols; c++) {
      const from = { x: c * cellW, y: r * cellH };
      const to = { x: (c + 1) * cellW, y: r * cellH };
      horizontal[r][c] = tabEdge(from, to, { x: 0, y: 1 }, s, randomTab(rng));
    }
  }
  // vertical[c][r]: edge on x = c*cellW (1 <= c < cols), top→bottom, normal +x
  const vertical: EdgePath[][] = [];
  for (let c = 1; c < cols; c++) {
    vertical[c] = [];
    for (let r = 0; r < rows; r++) {
      const from = { x: c * cellW, y: r * cellH };
      const to = { x: c * cellW, y: (r + 1) * cellH };
      vertical[c][r] = tabEdge(from, to, { x: 1, y: 0 }, s, randomTab(rng));
    }
  }

  const pieces: PieceShape[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = { x: c * cellW, y: r * cellH };
      const tr = { x: (c + 1) * cellW, y: r * cellH };
      const br = { x: (c + 1) * cellW, y: (r + 1) * cellH };
      const bl = { x: c * cellW, y: (r + 1) * cellH };

      const top = r === 0 ? straight(tl, tr) : horizontal[r][c];
      const right = c === cols - 1 ? straight(tr, br) : vertical[c + 1][r];
      const bottom = r === rows - 1 ? straight(br, bl) : reverseEdge(horizontal[r + 1][c]);
      const left = c === 0 ? straight(bl, tl) : reverseEdge(vertical[c][r]);

      pieces.push({
        id: r * cols + c,
        row: r,
        col: c,
        x: tl.x,
        y: tl.y,
        path: { from: tl, segs: [...top.segs, ...right.segs, ...bottom.segs, ...left.segs] },
      });
    }
  }
  return pieces;
}

/** SVG path data for an outline, translated by (-ox, -oy). */
export function pathToSvg(path: EdgePath, ox = 0, oy = 0): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  let d = `M${f(path.from.x - ox)} ${f(path.from.y - oy)}`;
  for (const s of path.segs) {
    d += `C${f(s.c1.x - ox)} ${f(s.c1.y - oy)} ${f(s.c2.x - ox)} ${f(s.c2.y - oy)} ${f(s.to.x - ox)} ${f(s.to.y - oy)}`;
  }
  return d + 'Z';
}
