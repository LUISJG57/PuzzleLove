import { PUZZLE_MAX_HEIGHT, PUZZLE_MAX_WIDTH } from '../constants';

export interface PuzzleMeta {
  rows: number;
  cols: number;
  seed: number;
  imageWidth: number;
  imageHeight: number;
}

export interface PuzzleLayout {
  /** Size of the assembled puzzle in world units. The frame sits at (0,0). */
  width: number;
  height: number;
  cellW: number;
  cellH: number;
  /** Extra room around a cell so tabs fit inside the piece bitmap. */
  pad: number;
  /** Max distance (world units) at which two groups snap together. */
  tolerance: number;
  pieceCount: number;
}

export function computeLayout(meta: PuzzleMeta): PuzzleLayout {
  const scale = Math.min(PUZZLE_MAX_WIDTH / meta.imageWidth, PUZZLE_MAX_HEIGHT / meta.imageHeight);
  const width = meta.imageWidth * scale;
  const height = meta.imageHeight * scale;
  const cellW = width / meta.cols;
  const cellH = height / meta.rows;
  const s = Math.min(cellW, cellH);
  return {
    width,
    height,
    cellW,
    cellH,
    pad: Math.ceil(s * 0.32),
    tolerance: s * 0.25,
    pieceCount: meta.rows * meta.cols,
  };
}

/** Picks rows/cols close to the requested count while keeping cells roughly square. */
export function gridForPieceCount(count: number, imageWidth: number, imageHeight: number) {
  const aspect = imageWidth / imageHeight;
  let cols = Math.max(2, Math.round(Math.sqrt(count * aspect)));
  let rows = Math.max(2, Math.round(count / cols));
  // Avoid extremely thin cells on very wide/tall images.
  cols = Math.min(cols, 30);
  rows = Math.min(rows, 30);
  return { rows, cols };
}

export function pieceRowCol(pieceId: number, cols: number) {
  return { row: Math.floor(pieceId / cols), col: pieceId % cols };
}

export function neighborsOf(pieceId: number, rows: number, cols: number): number[] {
  const { row, col } = pieceRowCol(pieceId, cols);
  const out: number[] = [];
  if (row > 0) out.push(pieceId - cols);
  if (row < rows - 1) out.push(pieceId + cols);
  if (col > 0) out.push(pieceId - 1);
  if (col < cols - 1) out.push(pieceId + 1);
  return out;
}
