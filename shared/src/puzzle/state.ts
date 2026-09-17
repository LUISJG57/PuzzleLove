import { createRng } from '../rng';
import { neighborsOf, type PuzzleLayout, type PuzzleMeta } from './layout';

/**
 * A group is a set of connected pieces that move together. Its (x, y) is a translation:
 * a piece's cell sits at (piece.x + group.x, piece.y + group.y) on the board, so a group
 * at (0, 0) is exactly on the frame. Two groups connect when their offsets are close.
 */
export interface GroupState {
  id: number;
  x: number;
  y: number;
  pieces: number[];
}

export interface PlayerScore {
  clientId: string;
  name: string;
  color: string;
  count: number;
}

export interface PuzzleState {
  groups: GroupState[];
  scores: Record<string, PlayerScore>;
  startedAt: number | null;
  completedAt: number | null;
}

export interface SnapResult {
  /** Group that survived after merging (may differ from the released group). */
  groupId: number;
  x: number;
  y: number;
  pieces: number[];
  /** Group ids that no longer exist. */
  removed: number[];
  /** True when the group locked into the frame outline (no neighbor merge needed). */
  frame: boolean;
}

export function createInitialState(meta: PuzzleMeta, layout: PuzzleLayout): PuzzleState {
  const rng = createRng((meta.seed ^ 0x9e3779b9) >>> 0);
  const { width: W, height: H, cellW, cellH, pad } = layout;
  const count = meta.rows * meta.cols;

  // Scatter area: a ring around the frame.
  const minX = -W * 0.85;
  const maxX = W * 1.85 - cellW;
  const minY = -H * 0.7;
  const maxY = H * 1.7 - cellH;
  const margin = pad * 1.5;
  const placed: { x: number; y: number }[] = [];
  const minDist = Math.min(cellW, cellH) * 0.9;

  // Shuffle order so neighbors don't land next to each other.
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const groups: GroupState[] = [];
  for (const id of order) {
    let best = { x: 0, y: 0 };
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = minX + rng() * (maxX - minX);
      const y = minY + rng() * (maxY - minY);
      const insideFrame = x + cellW > -margin && x < W + margin && y + cellH > -margin && y < H + margin;
      if (insideFrame) continue;
      let nearest = Infinity;
      for (const p of placed) nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y));
      if (nearest >= minDist) {
        best = { x, y };
        bestScore = Infinity;
        break;
      }
      if (nearest > bestScore) {
        bestScore = nearest;
        best = { x, y };
      }
    }
    if (bestScore === -Infinity) {
      // Every attempt landed on the frame; push it above the frame.
      best = { x: minX + rng() * (maxX - minX), y: minY };
    }
    placed.push(best);
    const col = id % meta.cols;
    const row = Math.floor(id / meta.cols);
    groups.push({ id, x: best.x - col * cellW, y: best.y - row * cellH, pieces: [id] });
  }
  groups.sort((a, b) => a.id - b.id);
  return { groups, scores: {}, startedAt: null, completedAt: null };
}

export function findGroup(state: PuzzleState, groupId: number): GroupState | undefined {
  return state.groups.find((g) => g.id === groupId);
}

export function isComplete(state: PuzzleState): boolean {
  return state.groups.length === 1;
}

export function connectedCount(state: PuzzleState): number {
  // Pieces that are part of a group with at least one other piece.
  return state.groups.reduce((n, g) => (g.pieces.length > 1 ? n + g.pieces.length : n), 0);
}

/**
 * Moves a group to (x, y) and merges it with every neighboring group within tolerance.
 * Groups for which `isLocked` returns true (held by another player) are never merged.
 * Mutates `state`. Returns null when nothing snapped.
 */
export function releaseGroup(
  state: PuzzleState,
  meta: PuzzleMeta,
  layout: PuzzleLayout,
  groupId: number,
  x: number,
  y: number,
  isLocked: (groupId: number) => boolean = () => false,
): SnapResult | null {
  const released = findGroup(state, groupId);
  if (!released) return null;
  released.x = x;
  released.y = y;

  const pieceToGroup = new Map<number, GroupState>();
  for (const g of state.groups) for (const p of g.pieces) pieceToGroup.set(p, g);

  const tol = layout.tolerance;
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  const neighborGroups = (g: GroupState): GroupState[] => {
    const found = new Set<GroupState>();
    for (const p of g.pieces) {
      for (const n of neighborsOf(p, meta.rows, meta.cols)) {
        const other = pieceToGroup.get(n)!;
        if (other !== g && !isLocked(other.id)) found.add(other);
      }
    }
    return [...found];
  };

  // Step 1: the released group snaps onto the closest neighbor group.
  let survivor: GroupState = released;
  let closest: GroupState | null = null;
  for (const other of neighborGroups(released)) {
    const d = dist(released, other);
    if (d < tol && (!closest || d < dist(released, closest))) closest = other;
  }

  const removed: number[] = [];
  const merge = (into: GroupState, from: GroupState) => {
    into.pieces.push(...from.pieces);
    for (const p of from.pieces) pieceToGroup.set(p, into);
    removed.push(from.id);
    state.groups = state.groups.filter((g) => g !== from);
  };

  let frame = false;
  if (closest) {
    merge(closest, released);
    survivor = closest;
  } else if (dist(released, { x: 0, y: 0 }) < tol) {
    released.x = 0;
    released.y = 0;
    frame = true;
  } else {
    return null;
  }

  // Step 2: pull in any other neighbors that now line up with the survivor.
  let changed = true;
  while (changed) {
    changed = false;
    for (const other of neighborGroups(survivor)) {
      if (dist(survivor, other) < tol) {
        merge(survivor, other);
        changed = true;
      }
    }
  }

  // Once connected to the frame, a group stays aligned with it.
  if (!frame && dist(survivor, { x: 0, y: 0 }) < 0.5) frame = true;

  survivor.pieces.sort((a, b) => a - b);
  return { groupId: survivor.id, x: survivor.x, y: survivor.y, pieces: [...survivor.pieces], removed, frame };
}
