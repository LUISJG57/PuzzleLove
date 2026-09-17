import type { PlayerScore, PuzzleState } from './puzzle/state';

export interface RoomMeta {
  slug: string;
  isGlobal: boolean;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  rows: number;
  cols: number;
  seed: number;
  maxPlayers: number | null;
}

export interface PlayerInfo {
  /** Socket id; unique per connection. */
  id: string;
  clientId: string;
  name: string;
  color: string;
}

export interface RoomSnapshot {
  meta: RoomMeta;
  state: PuzzleState;
  players: PlayerInfo[];
  /** groupId -> player id holding it. */
  locks: Record<number, string>;
  serverNow: number;
  /** Epoch ms when the next global puzzle starts, if a completed puzzle is on screen. */
  nextPuzzleAt: number | null;
}

export type JoinError = 'not_found' | 'full' | 'no_puzzle' | 'invalid';

export type JoinResult = { ok: true; snapshot: RoomSnapshot } | { ok: false; error: JoinError };

export interface GroupMove {
  g: number;
  x: number;
  y: number;
}

export interface SnapEvent {
  groupId: number;
  x: number;
  y: number;
  pieces: number[];
  removed: number[];
  frame: boolean;
  by: string;
}

export interface CompletedEvent {
  durationMs: number;
  scores: PlayerScore[];
  nextPuzzleAt: number | null;
}

export interface CursorPos {
  id: string;
  x: number;
  y: number;
}

export interface ServerToClientEvents {
  'room:snapshot': (snapshot: RoomSnapshot) => void;
  'player:joined': (player: PlayerInfo) => void;
  'player:left': (playerId: string) => void;
  'group:locked': (data: { groupId: number; by: string }) => void;
  'group:unlocked': (data: { groupId: number; x: number; y: number }) => void;
  'groups:moved': (moves: GroupMove[]) => void;
  'group:snapped': (data: SnapEvent) => void;
  'cursors:moved': (cursors: CursorPos[]) => void;
  'puzzle:completed': (data: CompletedEvent) => void;
}

export interface JoinRequest {
  room: string;
  name: string;
  color: string;
  clientId: string;
}

export interface ClientToServerEvents {
  'room:join': (req: JoinRequest, ack: (res: JoinResult) => void) => void;
  'group:grab': (data: { groupId: number }, ack: (ok: boolean) => void) => void;
  'group:move': (data: GroupMove) => void;
  'group:release': (data: GroupMove) => void;
  cursor: (data: { x: number; y: number }) => void;
  'puzzle:restart': () => void;
}
