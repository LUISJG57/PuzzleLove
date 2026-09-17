import type { Server, Socket } from 'socket.io';
import {
  GLOBAL_COLS,
  GLOBAL_NEXT_PUZZLE_DELAY_MS,
  GLOBAL_ROOM,
  GLOBAL_ROWS,
  MAX_NAME_LENGTH,
  PIECE_COUNT_OPTIONS,
  PLAYER_COLORS,
  PRIVATE_MAX_PLAYERS,
  PRIVATE_ROOM_TTL_MS,
  computeLayout,
  createInitialState,
  findGroup,
  gridForPieceCount,
  isComplete,
  randomSeed,
  releaseGroup,
  type ClientToServerEvents,
  type CursorPos,
  type GroupMove,
  type JoinRequest,
  type JoinResult,
  type PlayerInfo,
  type PuzzleLayout,
  type PuzzleMeta,
  type RoomMeta,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@puzzlelove/shared';
import type { QueueItem, Repo, RoomRecord } from '../db/repo';
import { randomId, type ProcessedImage, createDefaultGlobalImage } from '../images';
import type { ImageStorage } from '../storage';

export interface SocketData {
  slug?: string;
}

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface RoomManagerOptions {
  tickMs?: number;
  saveMs?: number;
  globalNextDelayMs?: number;
  lockTimeoutMs?: number;
  /** How long an empty private room stays in memory before being unloaded. */
  unloadAfterMs?: number;
  expiryCheckMs?: number;
  maxCursorsBroadcast?: number;
}

interface Lock {
  by: string;
  at: number;
}

class LiveRoom {
  meta: PuzzleMeta;
  layout: PuzzleLayout;
  players = new Map<string, PlayerInfo>();
  locks = new Map<number, Lock>();
  pendingMoves = new Map<number, { x: number; y: number }>();
  cursors = new Map<string, { x: number; y: number }>();
  cursorsDirty = false;
  dirty = false;
  emptySince: number | null = Date.now();
  nextPuzzleAt: number | null = null;
  rotateTimer: NodeJS.Timeout | null = null;

  constructor(public record: RoomRecord) {
    this.meta = LiveRoom.metaOf(record);
    this.layout = computeLayout(this.meta);
  }

  static metaOf(r: RoomRecord): PuzzleMeta {
    return { rows: r.rows, cols: r.cols, seed: r.seed, imageWidth: r.imageWidth, imageHeight: r.imageHeight };
  }

  refreshGeometry() {
    this.meta = LiveRoom.metaOf(this.record);
    this.layout = computeLayout(this.meta);
  }

  get slug() {
    return this.record.slug;
  }

  get state() {
    return this.record.state;
  }
}

const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const COORD_LIMIT = 1_000_000;

function validCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < COORD_LIMIT;
}

function validMove(data: unknown): data is GroupMove {
  const d = data as GroupMove;
  return !!d && Number.isInteger(d.g) && validCoord(d.x) && validCoord(d.y);
}

export function imageUrl(key: string) {
  return `/api/images/${key}`;
}

export class RoomManager {
  private live = new Map<string, LiveRoom>();
  private loading = new Map<string, Promise<LiveRoom | null>>();
  private timers: NodeJS.Timeout[] = [];
  private tickCount = 0;
  private readonly opts: Required<RoomManagerOptions>;

  constructor(
    private readonly io: IoServer,
    private readonly repo: Repo,
    private readonly storage: ImageStorage,
    options: RoomManagerOptions = {},
  ) {
    this.opts = {
      tickMs: 50,
      saveMs: 5000,
      globalNextDelayMs: GLOBAL_NEXT_PUZZLE_DELAY_MS,
      lockTimeoutMs: 30_000,
      unloadAfterMs: 2 * 60_000,
      expiryCheckMs: 60 * 60_000,
      maxCursorsBroadcast: 60,
      ...options,
    };
  }

  async init() {
    const global = await this.ensureGlobal();
    if (global.state.completedAt) this.scheduleGlobalRotation(global);
    await this.expireRooms().catch((err) => console.error('[rooms] expiry failed', err));
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs));
    this.timers.push(setInterval(() => void this.saveDirty(), this.opts.saveMs));
    this.timers.push(
      setInterval(() => void this.expireRooms().catch((err) => console.error('[rooms] expiry failed', err)), this.opts.expiryCheckMs),
    );
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const room of this.live.values()) if (room.rotateTimer) clearTimeout(room.rotateTimer);
    await this.saveDirty();
  }

  // ---------------------------------------------------------------- loading

  private async ensureGlobal(): Promise<LiveRoom> {
    const existing = await this.getLive(GLOBAL_ROOM);
    if (existing) return existing;

    const item = await this.repo.takeNextFromQueue();
    let image: { key: string; width: number; height: number };
    if (item) {
      image = { key: item.imageKey, width: item.imageWidth, height: item.imageHeight };
    } else {
      const img = await createDefaultGlobalImage();
      const key = `global/default-${randomId(8)}.webp`;
      await this.storage.put(key, img.data, 'image/webp');
      image = { key, width: img.width, height: img.height };
    }
    const meta: PuzzleMeta = {
      rows: GLOBAL_ROWS,
      cols: GLOBAL_COLS,
      seed: randomSeed(),
      imageWidth: image.width,
      imageHeight: image.height,
    };
    await this.repo.createRoom({
      slug: GLOBAL_ROOM,
      isGlobal: true,
      imageKey: image.key,
      imageWidth: image.width,
      imageHeight: image.height,
      rows: meta.rows,
      cols: meta.cols,
      seed: meta.seed,
      state: createInitialState(meta, computeLayout(meta)),
    });
    return (await this.getLive(GLOBAL_ROOM))!;
  }

  private async getLive(slug: string): Promise<LiveRoom | null> {
    const live = this.live.get(slug);
    if (live) return live;
    let pending = this.loading.get(slug);
    if (!pending) {
      pending = this.repo.getRoom(slug).then((rec) => {
        this.loading.delete(slug);
        if (!rec) return null;
        const room = new LiveRoom(rec);
        this.live.set(slug, room);
        return room;
      });
      pending.catch(() => this.loading.delete(slug));
      this.loading.set(slug, pending);
    }
    return pending;
  }

  private metaFor(room: LiveRoom): RoomMeta {
    const r = room.record;
    return {
      slug: r.slug,
      isGlobal: r.isGlobal,
      imageUrl: imageUrl(r.imageKey),
      imageWidth: r.imageWidth,
      imageHeight: r.imageHeight,
      rows: r.rows,
      cols: r.cols,
      seed: r.seed,
      maxPlayers: r.isGlobal ? null : PRIVATE_MAX_PLAYERS,
    };
  }

  private snapshot(room: LiveRoom): RoomSnapshot {
    const locks: Record<number, string> = {};
    for (const [g, l] of room.locks) locks[g] = l.by;
    return {
      meta: this.metaFor(room),
      state: room.state,
      players: [...room.players.values()],
      locks,
      serverNow: Date.now(),
      nextPuzzleAt: room.nextPuzzleAt,
    };
  }

  private touch(room: LiveRoom) {
    room.record.lastActivityAt = new Date();
    room.dirty = true;
  }

  private roomOf(socket: IoSocket): LiveRoom | undefined {
    return socket.data.slug ? this.live.get(socket.data.slug) : undefined;
  }

  // ---------------------------------------------------------------- socket handlers

  async join(socket: IoSocket, req: JoinRequest): Promise<JoinResult> {
    if (!req || typeof req.room !== 'string' || typeof req.name !== 'string') return { ok: false, error: 'invalid' };
    const slug = req.room;
    if (!SLUG_PATTERN.test(slug)) return { ok: false, error: 'not_found' };

    this.leave(socket);
    const room = await this.getLive(slug);
    if (!room) return { ok: false, error: 'not_found' };
    if (!socket.connected) return { ok: false, error: 'invalid' };
    if (socket.data.slug) this.leave(socket); // joined something else while loading
    if (!room.record.isGlobal && room.players.size >= PRIVATE_MAX_PLAYERS) return { ok: false, error: 'full' };

    const name = req.name.trim().slice(0, MAX_NAME_LENGTH) || 'Player';
    const color = (PLAYER_COLORS as readonly string[]).includes(req.color)
      ? req.color
      : PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    const clientId = typeof req.clientId === 'string' && req.clientId ? req.clientId.slice(0, 64) : socket.id;
    const player: PlayerInfo = { id: socket.id, clientId, name, color };

    room.players.set(socket.id, player);
    room.emptySince = null;
    socket.data.slug = slug;
    await socket.join(slug);
    socket.to(slug).emit('player:joined', player);
    this.touch(room);
    return { ok: true, snapshot: this.snapshot(room) };
  }

  leave(socket: IoSocket) {
    const room = this.roomOf(socket);
    socket.data.slug = undefined;
    if (!room) return;
    room.players.delete(socket.id);
    this.releaseLocksOf(room, socket.id);
    if (room.cursors.delete(socket.id)) room.cursorsDirty = true;
    void socket.leave(room.slug);
    this.io.to(room.slug).emit('player:left', socket.id);
    if (room.players.size === 0) room.emptySince = Date.now();
  }

  private releaseLocksOf(room: LiveRoom, playerId: string) {
    for (const [groupId, lock] of room.locks) {
      if (lock.by !== playerId) continue;
      room.locks.delete(groupId);
      room.pendingMoves.delete(groupId);
      const g = findGroup(room.state, groupId);
      if (g) this.io.to(room.slug).emit('group:unlocked', { groupId, x: g.x, y: g.y });
    }
  }

  grab(socket: IoSocket, groupId: number): boolean {
    const room = this.roomOf(socket);
    if (!room || room.state.completedAt || !Number.isInteger(groupId)) return false;
    if (!findGroup(room.state, groupId)) return false;
    const lock = room.locks.get(groupId);
    if (lock && lock.by !== socket.id) return false;
    if (!lock) this.releaseLocksOf(room, socket.id);
    room.locks.set(groupId, { by: socket.id, at: Date.now() });
    socket.to(room.slug).emit('group:locked', { groupId, by: socket.id });
    if (room.state.startedAt === null) room.state.startedAt = Date.now();
    this.touch(room);
    return true;
  }

  move(socket: IoSocket, data: GroupMove) {
    const room = this.roomOf(socket);
    if (!room || !validMove(data)) return;
    const lock = room.locks.get(data.g);
    if (!lock || lock.by !== socket.id) return;
    const g = findGroup(room.state, data.g);
    if (!g) return;
    g.x = data.x;
    g.y = data.y;
    lock.at = Date.now();
    room.pendingMoves.set(data.g, { x: data.x, y: data.y });
    room.dirty = true;
  }

  release(socket: IoSocket, data: GroupMove) {
    const room = this.roomOf(socket);
    if (!room || !validMove(data)) return;
    const lock = room.locks.get(data.g);
    if (!lock || lock.by !== socket.id) return;
    room.locks.delete(data.g);
    room.pendingMoves.delete(data.g);
    const g = findGroup(room.state, data.g);
    if (!g) return;

    const result = releaseGroup(room.state, room.meta, room.layout, data.g, data.x, data.y, (id) => room.locks.has(id));
    this.touch(room);
    if (!result) {
      this.io.to(room.slug).emit('group:unlocked', { groupId: g.id, x: g.x, y: g.y });
      return;
    }

    const player = room.players.get(socket.id);
    if (player) {
      const score = room.state.scores[player.clientId] ?? { clientId: player.clientId, name: player.name, color: player.color, count: 0 };
      score.name = player.name;
      score.color = player.color;
      score.count += result.removed.length > 0 ? result.removed.length : 1;
      room.state.scores[player.clientId] = score;
    }
    for (const id of result.removed) room.pendingMoves.delete(id);
    this.io.to(room.slug).emit('group:snapped', { ...result, by: socket.id });

    if (isComplete(room.state)) this.complete(room);
  }

  private complete(room: LiveRoom) {
    const now = Date.now();
    const state = room.state;
    state.completedAt = now;
    state.groups[0].x = 0;
    state.groups[0].y = 0;
    room.locks.clear();
    room.pendingMoves.clear();
    room.nextPuzzleAt = room.record.isGlobal ? now + this.opts.globalNextDelayMs : null;
    this.io.to(room.slug).emit('puzzle:completed', {
      durationMs: now - (state.startedAt ?? now),
      scores: Object.values(state.scores).sort((a, b) => b.count - a.count),
      nextPuzzleAt: room.nextPuzzleAt,
    });
    if (room.record.isGlobal) this.scheduleGlobalRotation(room);
    void this.save(room);
  }

  cursor(socket: IoSocket, data: { x: number; y: number }) {
    const room = this.roomOf(socket);
    if (!room || !data || !validCoord(data.x) || !validCoord(data.y)) return;
    // Re-insert so iteration order is "least recently moved first".
    room.cursors.delete(socket.id);
    room.cursors.set(socket.id, { x: data.x, y: data.y });
    room.cursorsDirty = true;
  }

  async restart(socket: IoSocket) {
    const room = this.roomOf(socket);
    if (!room || room.record.isGlobal || !room.state.completedAt) return;
    await this.startNewPuzzle(room);
  }

  // ---------------------------------------------------------------- puzzle lifecycle

  private async startNewPuzzle(room: LiveRoom, image?: QueueItem) {
    if (room.rotateTimer) clearTimeout(room.rotateTimer);
    room.rotateTimer = null;
    const rec = room.record;
    if (image) {
      rec.imageKey = image.imageKey;
      rec.imageWidth = image.imageWidth;
      rec.imageHeight = image.imageHeight;
    }
    if (rec.isGlobal) {
      rec.rows = GLOBAL_ROWS;
      rec.cols = GLOBAL_COLS;
    }
    rec.seed = randomSeed();
    room.refreshGeometry();
    rec.state = createInitialState(room.meta, room.layout);
    room.locks.clear();
    room.pendingMoves.clear();
    room.nextPuzzleAt = null;
    this.touch(room);
    this.io.to(room.slug).emit('room:snapshot', this.snapshot(room));
    await this.repo.updateRoom(rec.slug, {
      imageKey: rec.imageKey,
      imageWidth: rec.imageWidth,
      imageHeight: rec.imageHeight,
      rows: rec.rows,
      cols: rec.cols,
      seed: rec.seed,
      state: rec.state,
      lastActivityAt: rec.lastActivityAt,
    });
    room.dirty = false;
  }

  private scheduleGlobalRotation(room: LiveRoom) {
    if (room.rotateTimer) clearTimeout(room.rotateTimer);
    const at = room.nextPuzzleAt ?? Date.now() + this.opts.globalNextDelayMs;
    room.nextPuzzleAt = at;
    room.rotateTimer = setTimeout(() => {
      void this.rotateGlobal().catch((err) => console.error('[rooms] global rotation failed', err));
    }, Math.max(0, at - Date.now()));
  }

  /** Starts the next global puzzle: next queued image, or the same image reshuffled. */
  async rotateGlobal() {
    const room = await this.ensureGlobal();
    const item = await this.repo.takeNextFromQueue();
    await this.startNewPuzzle(room, item ?? undefined);
  }

  async globalStatus() {
    const room = await this.ensureGlobal();
    return {
      imageUrl: imageUrl(room.record.imageKey),
      players: room.players.size,
      completed: !!room.state.completedAt,
      groups: room.state.groups.length,
      pieces: room.meta.rows * room.meta.cols,
    };
  }

  // ---------------------------------------------------------------- HTTP-facing

  async createPrivateRoom(image: ProcessedImage, pieceCount: number): Promise<string> {
    if (!(PIECE_COUNT_OPTIONS as readonly number[]).includes(pieceCount)) throw new Error('invalid_piece_count');
    const slug = randomId(10);
    const imageKey = `rooms/${slug}-${randomId(6)}.webp`;
    await this.storage.put(imageKey, image.data, 'image/webp');
    try {
      const { rows, cols } = gridForPieceCount(pieceCount, image.width, image.height);
      const meta: PuzzleMeta = { rows, cols, seed: randomSeed(), imageWidth: image.width, imageHeight: image.height };
      await this.repo.createRoom({
        slug,
        isGlobal: false,
        imageKey,
        imageWidth: image.width,
        imageHeight: image.height,
        rows,
        cols,
        seed: meta.seed,
        state: createInitialState(meta, computeLayout(meta)),
      });
    } catch (err) {
      await this.storage.delete(imageKey).catch(() => {});
      throw err;
    }
    return slug;
  }

  async addGlobalImage(image: ProcessedImage): Promise<QueueItem> {
    const imageKey = `global/${randomId(16)}.webp`;
    await this.storage.put(imageKey, image.data, 'image/webp');
    return this.repo.addToQueue({ imageKey, imageWidth: image.width, imageHeight: image.height });
  }

  async removeGlobalImage(id: string): Promise<boolean> {
    const item = await this.repo.removeFromQueue(id);
    if (!item) return false;
    await this.storage.delete(item.imageKey).catch((err) => console.error('[rooms] image delete failed', err));
    return true;
  }

  // ---------------------------------------------------------------- background work

  tick() {
    this.tickCount++;
    const now = Date.now();
    const sendCursors = this.tickCount % 2 === 0;
    for (const room of this.live.values()) {
      if (room.pendingMoves.size > 0) {
        const moves: GroupMove[] = [];
        for (const [g, p] of room.pendingMoves) moves.push({ g, x: p.x, y: p.y });
        room.pendingMoves.clear();
        this.io.to(room.slug).emit('groups:moved', moves);
      }
      if (sendCursors && room.cursorsDirty) {
        room.cursorsDirty = false;
        const all = [...room.cursors.entries()];
        const recent = all.slice(-this.opts.maxCursorsBroadcast);
        const payload: CursorPos[] = recent.map(([id, p]) => ({ id, x: p.x, y: p.y }));
        this.io.to(room.slug).volatile.emit('cursors:moved', payload);
      }
      for (const [groupId, lock] of room.locks) {
        if (now - lock.at > this.opts.lockTimeoutMs) {
          room.locks.delete(groupId);
          const g = findGroup(room.state, groupId);
          if (g) this.io.to(room.slug).emit('group:unlocked', { groupId, x: g.x, y: g.y });
        }
      }
    }
  }

  private async save(room: LiveRoom) {
    room.dirty = false;
    try {
      await this.repo.updateRoom(room.slug, { state: room.state, lastActivityAt: room.record.lastActivityAt });
    } catch (err) {
      room.dirty = true;
      console.error(`[rooms] save failed for ${room.slug}`, err);
    }
  }

  async saveDirty() {
    const now = Date.now();
    for (const room of [...this.live.values()]) {
      if (room.dirty) await this.save(room);
      const idle = room.emptySince !== null && now - room.emptySince > this.opts.unloadAfterMs;
      if (!room.record.isGlobal && idle && !room.dirty) this.live.delete(room.slug);
    }
  }

  /** Deletes private rooms (and their images) with no activity for 24 hours. */
  async expireRooms(now = Date.now()) {
    const expired = await this.repo.findExpiredRooms(new Date(now - PRIVATE_ROOM_TTL_MS));
    let deleted = 0;
    for (const rec of expired) {
      const live = this.live.get(rec.slug);
      if (live && live.players.size > 0) continue;
      await this.storage.delete(rec.imageKey).catch((err) => console.error('[rooms] image delete failed', err));
      await this.repo.deleteRoom(rec.slug);
      this.live.delete(rec.slug);
      deleted++;
    }
    if (deleted > 0) console.log(`[rooms] deleted ${deleted} expired private room(s)`);
    return deleted;
  }

  isLive(slug: string) {
    return this.live.has(slug);
  }
}
