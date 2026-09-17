import {
  GLOBAL_COLS,
  GLOBAL_NEXT_PUZZLE_DELAY_MS,
  GLOBAL_ROOM,
  GLOBAL_ROWS,
  PIECE_COUNT_OPTIONS,
  PRIVATE_ROOM_TTL_MS,
  computeLayout,
  createInitialState,
  createRng,
  gridForPieceCount,
  isComplete,
  releaseGroup,
  type PuzzleLayout,
  type PuzzleMeta,
  type PuzzleState,
} from '@puzzlelove/shared';
import { activityAt, pickWeighted, poisson, timing, type Rng } from './behavior';
import { syntheticPopulation, type Persona } from './personas';
import { planMove } from './strategy';

/** One row of analytics_events, mirroring server/src/analytics/events.ts (schema version 1). */
export interface SimEvent {
  eventId: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: Date;
  ingestedAt: Date;
  sessionId: string | null;
  clientId: string | null;
  roomSlug: string;
  roomType: 'global' | 'private';
  puzzleId: string;
  payload: Record<string, unknown>;
}

export interface GenerateOptions {
  start: Date;
  end: Date;
  seed: number;
  /** Expected global-room arrivals per hour at peak activity. */
  globalArrivalsPerPeakHour?: number;
  /** Expected private rooms created per day. */
  privateRoomsPerDay?: number;
  populationSize?: number;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface Session {
  id: string;
  persona: Persona;
  joinAt: number;
  leaveAt: number;
  joined: boolean;
  left: boolean;
}

function uuid(rng: Rng): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function randomSlug(rng: Rng): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
}

interface RoomSim {
  slug: string;
  type: 'global' | 'private';
  meta: PuzzleMeta;
  layout: PuzzleLayout;
  state: PuzzleState;
  scores: Map<string, { name: string; count: number }>;
  startedAt: number | null;
}

/**
 * Generates a plausible event history using the real puzzle engine (`releaseGroup`), so group sizes,
 * merges and completions follow the same rules as the server. Deterministic for a given seed.
 */
export function generateHistory(opts: GenerateOptions): SimEvent[] {
  const rng = createRng(opts.seed);
  // Identifiers also depend on the window, so re-running with the same seed later never reuses ids for different events.
  const idRng = createRng((opts.seed ^ Math.floor(opts.start.getTime() / 60_000)) >>> 0);
  const population = syntheticPopulation(opts.populationSize ?? 150, opts.seed ^ 0x5eed);
  const start = opts.start.getTime();
  const end = opts.end.getTime();
  const events: SimEvent[] = [];

  const emit = (room: RoomSim, type: string, at: number, session: Session | null, payload: Record<string, unknown>) => {
    events.push({
      eventId: uuid(idRng),
      eventType: type,
      schemaVersion: 1,
      occurredAt: new Date(at),
      ingestedAt: new Date(at + 150 + Math.floor(rng() * 1800)),
      sessionId: session?.id ?? null,
      clientId: session?.persona.clientId ?? null,
      roomSlug: room.slug,
      roomType: room.type,
      puzzleId: `${room.slug}:${room.meta.seed}`,
      payload,
    });
  };

  const newPuzzle = (room: RoomSim, at: number, source: string) => {
    room.meta = { ...room.meta, seed: Math.floor(rng() * 0x7fffffff) };
    room.layout = computeLayout(room.meta);
    room.state = createInitialState(room.meta, room.layout);
    room.scores = new Map();
    room.startedAt = null;
    const { rows, cols } = room.meta;
    emit(room, 'puzzle_started', at, null, { rows, cols, pieces: rows * cols, source });
  };

  const pickPersona = (exclude: Set<string>) => {
    for (let i = 0; i < 20; i++) {
      const p = pickWeighted(rng, population, population.map((x) => x.weight));
      if (!exclude.has(p.clientId)) return p;
    }
    return population.find((p) => !exclude.has(p.clientId))!;
  };

  /**
   * Plays a room forward from `from` while any of `sessions` is present. Returns the time of the last
   * activity. `onComplete` decides what happens after a completion (next puzzle or stop).
   */
  const playRoom = (
    room: RoomSim,
    sessions: Session[],
    from: number,
    until: number,
    onComplete: (at: number) => { continueAt: number } | null,
  ): number => {
    let t = from;
    let last = from;
    const present = () => sessions.filter((s) => s.joined && !s.left);

    const syncPresence = (now: number) => {
      const due = sessions
        .flatMap((s) => [
          ...(!s.joined && s.joinAt <= now ? [{ at: s.joinAt, s, kind: 'join' as const }] : []),
          ...(!s.left && s.leaveAt <= now ? [{ at: s.leaveAt, s, kind: 'leave' as const }] : []),
        ])
        .sort((a, b) => a.at - b.at);
      for (const d of due) {
        if (d.kind === 'join' && !d.s.joined) {
          d.s.joined = true;
          emit(room, 'player_joined', d.at, d.s, { name: d.s.persona.name, color: d.s.persona.color, players_in_room: present().length });
        } else if (d.kind === 'leave' && d.s.joined && !d.s.left) {
          d.s.left = true;
          emit(room, 'player_left', d.at, d.s, {
            reason: 'disconnect',
            duration_ms: d.at - d.s.joinAt,
            players_in_room: present().length,
          });
        }
      }
    };

    while (t < until) {
      syncPresence(t);
      const active = present();
      if (active.length === 0) {
        const nextJoin = sessions.filter((s) => !s.joined).map((s) => s.joinAt).sort((a, b) => a - b)[0];
        if (nextJoin === undefined || nextJoin >= until) break;
        t = nextJoin;
        continue;
      }

      const player = active[Math.floor(rng() * active.length)];
      t += Math.floor(timing.thinkMs(rng) / Math.sqrt(active.length));
      if (t >= until || t >= player.leaveAt) continue;

      if (active.length > 1 && rng() < 0.04) {
        emit(room, 'grab_conflict', t, player, { group_id: room.state.groups[0].id, held_ms: Math.floor(timing.holdMs(rng, true)) });
        continue;
      }

      const move = planMove(room.state, room.meta, room.layout, rng, player.persona.skill);
      if (!move) continue;
      const group = room.state.groups.find((g) => g.id === move.groupId)!;
      room.startedAt ??= t;
      emit(room, 'piece_grabbed', t, player, { group_id: group.id, group_size: group.pieces.length });
      const hold = Math.floor(timing.holdMs(rng, move.aimed));
      t += hold;
      last = t;
      // Nobody leaves mid-drag: finish the drop first.
      if (player.leaveAt <= t) player.leaveAt = t + 500 + Math.floor(rng() * 3000);

      if (rng() < 0.02) {
        emit(room, 'piece_abandoned', t, player, { group_id: group.id, hold_ms: hold, reason: 'regrab' });
        continue;
      }

      const sizeBefore = group.pieces.length;
      const result = releaseGroup(room.state, room.meta, room.layout, move.groupId, move.x, move.y);
      emit(room, 'piece_dropped', t, player, {
        group_id: move.groupId,
        hold_ms: hold,
        snapped: !!result,
        frame: result?.frame ?? false,
        merged_groups: result?.removed.length ?? 0,
        group_size: result ? result.pieces.length : sizeBefore,
      });
      if (result) {
        const score = room.scores.get(player.persona.clientId) ?? { name: player.persona.name, count: 0 };
        score.count += result.removed.length > 0 ? result.removed.length : 1;
        room.scores.set(player.persona.clientId, score);
      }

      if (isComplete(room.state)) {
        emit(room, 'puzzle_completed', t, null, {
          duration_ms: t - (room.startedAt ?? t),
          pieces: room.meta.rows * room.meta.cols,
          players_in_room: active.length,
          contributors: [...room.scores.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([clientId, s]) => ({ client_id: clientId, name: s.name, count: s.count })),
        });
        const next = onComplete(t);
        if (!next) break;
        t = next.continueAt;
      }
    }
    // Emit the remaining joins and leaves that happen before the end of the window.
    syncPresence(until);
    return last;
  };

  // ------------------------------------------------------------ global room: one continuous timeline
  const globalSessions: Session[] = [];
  for (let hour = start; hour < end; hour += HOUR) {
    const arrivals = poisson(rng, (opts.globalArrivalsPerPeakHour ?? 6) * activityAt(new Date(hour)));
    for (let i = 0; i < arrivals; i++) {
      const persona = pickPersona(new Set());
      const joinAt = hour + Math.floor(rng() * HOUR);
      globalSessions.push({
        id: `sim-${uuid(idRng)}`,
        persona,
        joinAt,
        leaveAt: joinAt + Math.floor(timing.sessionMs(rng, persona.sessionMinutes)),
        joined: false,
        left: false,
      });
    }
  }
  globalSessions.sort((a, b) => a.joinAt - b.joinAt);

  const globalMeta: PuzzleMeta = { rows: GLOBAL_ROWS, cols: GLOBAL_COLS, seed: 0, imageWidth: 1600, imageHeight: 1200 };
  const global: RoomSim = {
    slug: GLOBAL_ROOM,
    type: 'global',
    meta: globalMeta,
    layout: computeLayout(globalMeta),
    state: createInitialState(globalMeta, computeLayout(globalMeta)),
    scores: new Map(),
    startedAt: null,
  };
  newPuzzle(global, start, 'default');
  playRoom(global, globalSessions, start, end, (at) => {
    const next = at + GLOBAL_NEXT_PUZZLE_DELAY_MS;
    if (next >= end) return null;
    const source = rng() < 0.3 ? 'queue' : 'reshuffle';
    emit(global, 'global_rotated', next, null, { trigger: 'auto', source });
    newPuzzle(global, next, source);
    return { continueAt: next };
  });

  // ------------------------------------------------------------ private rooms
  for (let day = start; day < end; day += DAY) {
    const count = poisson(rng, (opts.privateRoomsPerDay ?? 5) * (0.6 + activityAt(new Date(day + 20 * HOUR))));
    for (let i = 0; i < count; i++) {
      // Creation time follows the hourly activity curve.
      let createdAt = day;
      for (let attempt = 0; attempt < 50; attempt++) {
        createdAt = day + Math.floor(rng() * DAY);
        if (rng() < activityAt(new Date(createdAt))) break;
      }
      if (createdAt >= end) continue;

      const pieces = pickWeighted(rng, PIECE_COUNT_OPTIONS, [0.35, 0.35, 0.2, 0.1]);
      const [imageWidth, imageHeight] = pickWeighted(rng, [[1600, 1200], [1200, 1600], [1920, 1080], [1080, 1080]], [4, 3, 2, 1]);
      const { rows, cols } = gridForPieceCount(pieces, imageWidth, imageHeight);
      const meta: PuzzleMeta = { rows, cols, seed: 0, imageWidth, imageHeight };
      const room: RoomSim = {
        slug: randomSlug(idRng),
        type: 'private',
        meta,
        layout: computeLayout(meta),
        state: createInitialState(meta, computeLayout(meta)),
        scores: new Map(),
        startedAt: null,
      };
      room.meta = { ...meta, seed: Math.floor(rng() * 0x7fffffff) };
      room.layout = computeLayout(room.meta);
      room.state = createInitialState(room.meta, room.layout);
      emit(room, 'room_created', createdAt, null, { pieces_requested: pieces, rows, cols, image_width: imageWidth, image_height: imageHeight });
      emit(room, 'puzzle_started', createdAt, null, { rows, cols, pieces: rows * cols, source: 'create' });

      // Bigger puzzles keep people around longer.
      const minutesFactor = Math.sqrt(rows * cols / 24);
      const taken = new Set<string>();
      const sessions: Session[] = [];
      const guests = Math.min(7, poisson(rng, 1.3));
      for (let g = 0; g <= guests; g++) {
        const persona = pickPersona(taken);
        taken.add(persona.clientId);
        const joinAt = createdAt + (g === 0 ? 5_000 + Math.floor(rng() * 40_000) : Math.floor(rng() * 12 * 60_000));
        sessions.push({
          id: `sim-${uuid(idRng)}`,
          persona,
          joinAt,
          leaveAt: joinAt + Math.floor(timing.sessionMs(rng, persona.sessionMinutes * 2 * minutesFactor)),
          joined: false,
          left: false,
        });
      }

      let restarts = 0;
      const lastActivity = playRoom(room, sessions, createdAt, end, (at) => {
        if (restarts < 2 && rng() < 0.25) {
          restarts++;
          const next = at + 20_000 + Math.floor(rng() * 60_000);
          newPuzzle(room, next, 'restart');
          return { continueAt: next };
        }
        // Players drift away shortly after finishing.
        for (const s of sessions) {
          if (s.joined) s.leaveAt = Math.min(s.leaveAt, at + 30_000 + Math.floor(rng() * 90_000));
          else s.joined = s.left = true; // would have arrived after the finish; never shows up
        }
        return null;
      });

      const lastLeave = Math.max(lastActivity, ...sessions.map((s) => s.leaveAt));
      const expiresAt = lastLeave + PRIVATE_ROOM_TTL_MS + Math.floor(rng() * HOUR);
      if (expiresAt < end) {
        emit(room, 'room_expired', expiresAt, null, { age_ms: expiresAt - createdAt, idle_ms: expiresAt - lastLeave });
      }
    }
  }

  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
