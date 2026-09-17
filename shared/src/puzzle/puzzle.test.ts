import { describe, expect, it } from 'vitest';
import { computeLayout, gridForPieceCount, neighborsOf, type PuzzleMeta } from './layout';
import { generatePieceShapes, reverseEdge, type EdgePath } from './shapes';
import { connectedCount, createInitialState, isComplete, releaseGroup, type PuzzleState } from './state';

const meta: PuzzleMeta = { rows: 4, cols: 5, seed: 1234, imageWidth: 1600, imageHeight: 1200 };
const layout = computeLayout(meta);

function edgeSlice(path: EdgePath, start: number, count: number): EdgePath {
  const from = start === 0 ? path.from : path.segs[start - 1].to;
  return { from, segs: path.segs.slice(start, start + count) };
}

function close(a: number, b: number) {
  expect(Math.abs(a - b)).toBeLessThan(1e-9);
}

describe('generatePieceShapes', () => {
  it('is deterministic for the same seed', () => {
    expect(generatePieceShapes(meta, layout)).toEqual(generatePieceShapes(meta, layout));
    expect(generatePieceShapes({ ...meta, seed: 99 }, layout)).not.toEqual(generatePieceShapes(meta, layout));
  });

  it('produces closed outlines', () => {
    for (const piece of generatePieceShapes(meta, layout)) {
      const last = piece.path.segs[piece.path.segs.length - 1].to;
      close(last.x, piece.path.from.x);
      close(last.y, piece.path.from.y);
    }
  });

  it('neighbors share exactly the same edge geometry', () => {
    const pieces = generatePieceShapes(meta, layout);
    // Segment counts per side: straight = 1, tab = 3.
    const sides = (row: number, col: number) => {
      const top = row === 0 ? 1 : 3;
      const right = col === meta.cols - 1 ? 1 : 3;
      const bottom = row === meta.rows - 1 ? 1 : 3;
      const left = col === 0 ? 1 : 3;
      return { top: [0, top], right: [top, right], bottom: [top + right, bottom], left: [top + right + bottom, left] };
    };
    for (const p of pieces) {
      const s = sides(p.row, p.col);
      if (p.col < meta.cols - 1) {
        const q = pieces[p.id + 1];
        const qs = sides(q.row, q.col);
        expect(edgeSlice(p.path, s.right[0], s.right[1])).toEqual(
          reverseEdge(edgeSlice(q.path, qs.left[0], qs.left[1])),
        );
      }
      if (p.row < meta.rows - 1) {
        const q = pieces[p.id + meta.cols];
        const qs = sides(q.row, q.col);
        expect(edgeSlice(p.path, s.bottom[0], s.bottom[1])).toEqual(
          reverseEdge(edgeSlice(q.path, qs.top[0], qs.top[1])),
        );
      }
    }
  });

  it('keeps tabs inside the padded piece bounds', () => {
    for (const piece of generatePieceShapes(meta, layout)) {
      const pts: { x: number; y: number }[] = [];
      let p0 = piece.path.from;
      for (const s of piece.path.segs) {
        for (let i = 0; i <= 20; i++) {
          const t = i / 20;
          const u = 1 - t;
          const bez = (a: number, b: number, c: number, d: number) =>
            u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
          pts.push({ x: bez(p0.x, s.c1.x, s.c2.x, s.to.x), y: bez(p0.y, s.c1.y, s.c2.y, s.to.y) });
        }
        p0 = s.to;
      }
      for (const pt of pts) {
        expect(pt.x).toBeGreaterThanOrEqual(piece.x - layout.pad);
        expect(pt.x).toBeLessThanOrEqual(piece.x + layout.cellW + layout.pad);
        expect(pt.y).toBeGreaterThanOrEqual(piece.y - layout.pad);
        expect(pt.y).toBeLessThanOrEqual(piece.y + layout.cellH + layout.pad);
      }
    }
  });
});

describe('layout helpers', () => {
  it('computes a grid near the requested count', () => {
    const { rows, cols } = gridForPieceCount(48, 1600, 1200);
    expect(rows * cols).toBeGreaterThanOrEqual(40);
    expect(rows * cols).toBeLessThanOrEqual(56);
  });

  it('lists neighbors', () => {
    expect(neighborsOf(0, 4, 5).sort()).toEqual([1, 5]);
    expect(neighborsOf(6, 4, 5).sort((a, b) => a - b)).toEqual([1, 5, 7, 11]);
  });
});

describe('snapping', () => {
  function fresh(): PuzzleState {
    return createInitialState(meta, layout);
  }

  it('scatters pieces outside the frame', () => {
    const state = fresh();
    expect(state.groups).toHaveLength(20);
    for (const g of state.groups) {
      const col = g.id % meta.cols;
      const row = Math.floor(g.id / meta.cols);
      const x = g.x + col * layout.cellW;
      const y = g.y + row * layout.cellH;
      const overlaps = x + layout.cellW > 0 && x < layout.width && y + layout.cellH > 0 && y < layout.height;
      expect(overlaps).toBe(false);
    }
  });

  it('does nothing when groups are far apart', () => {
    const state = fresh();
    expect(releaseGroup(state, meta, layout, 0, 5000, 5000)).toBeNull();
    expect(state.groups).toHaveLength(20);
  });

  it('merges a released piece into a nearby neighbor and snaps to its offset', () => {
    const state = fresh();
    const target = state.groups.find((g) => g.id === 1)!;
    const res = releaseGroup(state, meta, layout, 0, target.x + 3, target.y - 2)!;
    expect(res).not.toBeNull();
    expect(res.groupId).toBe(1);
    expect(res.removed).toEqual([0]);
    expect(res.pieces).toEqual([0, 1]);
    expect(res.x).toBe(target.x);
    expect(state.groups).toHaveLength(19);
    expect(connectedCount(state)).toBe(2);
  });

  it('does not merge into a locked group', () => {
    const state = fresh();
    const target = state.groups.find((g) => g.id === 1)!;
    expect(releaseGroup(state, meta, layout, 0, target.x, target.y, (id) => id === 1)).toBeNull();
  });

  it('snaps to the frame', () => {
    const state = fresh();
    const res = releaseGroup(state, meta, layout, 7, 4, -3)!;
    expect(res.frame).toBe(true);
    expect(res.x).toBe(0);
    expect(res.y).toBe(0);
  });

  it('chains merges and detects completion', () => {
    const state = fresh();
    // Put every piece on the frame except piece 0, then drop piece 0 in place.
    for (let id = 1; id < 20; id++) releaseGroup(state, meta, layout, id, 0, 0);
    expect(isComplete(state)).toBe(false);
    const res = releaseGroup(state, meta, layout, 0, 2, 2)!;
    expect(res.pieces).toHaveLength(20);
    expect(isComplete(state)).toBe(true);
    expect(state.groups[0].x).toBe(0);
  });
});
