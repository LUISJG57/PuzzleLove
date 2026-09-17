import { neighborsOf, type GroupState, type PuzzleLayout, type PuzzleMeta, type PuzzleState } from '@puzzlelove/shared';
import { pickWeighted, type Rng } from './behavior';

export interface PlannedMove {
  groupId: number;
  x: number;
  y: number;
  /** True when the player lines the group up with the frame or a neighbor (it will usually snap). */
  aimed: boolean;
}

function neighborGroups(state: PuzzleState, meta: PuzzleMeta, group: GroupState, isLocked: (id: number) => boolean) {
  const owner = new Map<number, GroupState>();
  for (const g of state.groups) for (const p of g.pieces) owner.set(p, g);
  const found = new Set<GroupState>();
  for (const p of group.pieces) {
    for (const n of neighborsOf(p, meta.rows, meta.cols)) {
      const other = owner.get(n)!;
      if (other !== group && !isLocked(other.id)) found.add(other);
    }
  }
  return [...found];
}

/**
 * Chooses the next move like a person would: loose pieces are picked more often, and the chance of
 * lining a piece up correctly grows with skill and with how far along the puzzle is.
 */
export function planMove(
  state: PuzzleState,
  meta: PuzzleMeta,
  layout: PuzzleLayout,
  rng: Rng,
  skill: number,
  isLocked: (groupId: number) => boolean = () => false,
): PlannedMove | null {
  const free = state.groups.filter((g) => !isLocked(g.id));
  if (free.length === 0) return null;
  const group = pickWeighted(rng, free, free.map((g) => 1 / g.pieces.length));

  const total = meta.rows * meta.cols;
  const progress = 1 - (state.groups.length - 1) / Math.max(1, total - 1);
  const aimChance = Math.min(0.92, skill * (0.65 + 0.5 * progress));

  if (rng() < aimChance) {
    const neighbors = neighborGroups(state, meta, group, isLocked);
    const target = neighbors.length > 0 && rng() < 0.6 ? neighbors[Math.floor(rng() * neighbors.length)] : { x: 0, y: 0 };
    const jitter = layout.tolerance * 0.5;
    return { groupId: group.id, x: target.x + (rng() * 2 - 1) * jitter, y: target.y + (rng() * 2 - 1) * jitter, aimed: true };
  }

  const spread = Math.max(layout.cellW, layout.cellH) * 1.5;
  return { groupId: group.id, x: group.x + (rng() * 2 - 1) * spread, y: group.y + (rng() * 2 - 1) * spread, aimed: false };
}
