import type { PuzzleState } from '@puzzlelove/shared';

export interface RoomRecord {
  slug: string;
  isGlobal: boolean;
  imageKey: string;
  imageWidth: number;
  imageHeight: number;
  rows: number;
  cols: number;
  seed: number;
  state: PuzzleState;
  createdAt: Date;
  lastActivityAt: Date;
}

export type NewRoom = Omit<RoomRecord, 'createdAt' | 'lastActivityAt'>;

export type RoomUpdate = Partial<
  Pick<RoomRecord, 'imageKey' | 'imageWidth' | 'imageHeight' | 'rows' | 'cols' | 'seed' | 'state' | 'lastActivityAt'>
>;

export interface QueueItem {
  id: string;
  imageKey: string;
  imageWidth: number;
  imageHeight: number;
  createdAt: Date;
}

export interface Repo {
  getRoom(slug: string): Promise<RoomRecord | null>;
  createRoom(room: NewRoom): Promise<RoomRecord>;
  updateRoom(slug: string, data: RoomUpdate): Promise<void>;
  deleteRoom(slug: string): Promise<void>;
  /** Private rooms whose last activity is older than `before`. */
  findExpiredRooms(before: Date): Promise<RoomRecord[]>;

  listQueue(): Promise<QueueItem[]>;
  addToQueue(item: Omit<QueueItem, 'id' | 'createdAt'>): Promise<QueueItem>;
  /** Removes an unused queue item and returns it, or null if it does not exist. */
  removeFromQueue(id: string): Promise<QueueItem | null>;
  /** Marks the oldest unused item as used and returns it. */
  takeNextFromQueue(): Promise<QueueItem | null>;
}
