/**
 * Gameplay analytics events. Stored append-only in `analytics_events` and consumed by the data pipeline.
 * Bump EVENT_SCHEMA_VERSION when a payload changes incompatibly.
 */
export const EVENT_SCHEMA_VERSION = 1;

export type RoomType = 'global' | 'private';
export type PuzzleSource = 'create' | 'restart' | 'queue' | 'reshuffle' | 'default';

export interface EventPayloads {
  room_created: { pieces_requested: number; rows: number; cols: number; image_width: number; image_height: number };
  puzzle_started: { rows: number; cols: number; pieces: number; source: PuzzleSource };
  player_joined: { name: string; color: string; players_in_room: number };
  join_failed: { error: string };
  player_left: { reason: 'disconnect' | 'switch'; duration_ms: number; players_in_room: number };
  piece_grabbed: { group_id: number; group_size: number };
  grab_conflict: { group_id: number; held_ms: number };
  piece_dropped: { group_id: number; hold_ms: number; snapped: boolean; frame: boolean; merged_groups: number; group_size: number };
  /** A grabbed group was released without a drop: the player left, grabbed another group or the lock timed out. */
  piece_abandoned: { group_id: number; hold_ms: number; reason: 'left' | 'regrab' | 'timeout' };
  puzzle_completed: {
    duration_ms: number;
    pieces: number;
    players_in_room: number;
    contributors: { client_id: string; name: string; count: number }[];
  };
  global_rotated: { trigger: 'auto' | 'admin'; source: 'queue' | 'reshuffle' };
  room_expired: { age_ms: number; idle_ms: number };
}

export type EventType = keyof EventPayloads;

export interface EventContext {
  sessionId?: string;
  clientId?: string;
  roomSlug?: string;
  roomType?: RoomType;
  /** One play-through of a puzzle: `${slug}:${seed}`. */
  puzzleId?: string;
}

export interface AnalyticsEvent<T extends EventType = EventType> extends EventContext {
  eventId: string;
  eventType: T;
  schemaVersion: number;
  occurredAt: Date;
  payload: EventPayloads[T];
}
