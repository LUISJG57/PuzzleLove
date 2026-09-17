export const GLOBAL_ROOM = 'global';
export const GLOBAL_ROWS = 5;
export const GLOBAL_COLS = 5;
export const PRIVATE_MAX_PLAYERS = 8;
export const PIECE_COUNT_OPTIONS = [24, 48, 96, 150] as const;
export const DEFAULT_PIECE_COUNT = 48;
export const MAX_NAME_LENGTH = 20;
/** Seconds the victory screen is shown in the global room before the next puzzle starts. */
export const GLOBAL_NEXT_PUZZLE_DELAY_MS = 12_000;
/** Private rooms with no activity for this long are deleted. */
export const PRIVATE_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export const PLAYER_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

/** World units the puzzle image is fitted into. */
export const PUZZLE_MAX_WIDTH = 1200;
export const PUZZLE_MAX_HEIGHT = 900;
