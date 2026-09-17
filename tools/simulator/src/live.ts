/**
 * Live bots: real Socket.IO clients that play the global room like people do, clearly named "🤖 …" with
 * client ids "bot-…". The number of bots online follows the hourly activity curve, up to BOTS_MAX.
 *
 *   SIM_SERVER_URL=http://localhost:3001 BOTS_MAX=2 npm run live -w tools/simulator
 */
import {
  GLOBAL_ROOM,
  computeLayout,
  type ClientToServerEvents,
  type PuzzleLayout,
  type PuzzleMeta,
  type PuzzleState,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@puzzlelove/shared';
import { io, type Socket } from 'socket.io-client';
import { activityAt, timing } from './behavior';
import { BOT_PERSONAS, type Persona } from './personas';
import { planMove } from './strategy';

const SERVER_URL = process.env.SIM_SERVER_URL ?? 'http://localhost:3001';
const BOTS_MAX = Math.max(0, Number(process.env.BOTS_MAX ?? 2));
const SCHEDULE_MS = Number(process.env.BOTS_SCHEDULE_MS ?? 30_000);

type BotSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[bots] ${new Date().toISOString()} ${msg}`);

class Bot {
  private socket: BotSocket | null = null;
  private meta: PuzzleMeta | null = null;
  private layout: PuzzleLayout | null = null;
  private state: PuzzleState | null = null;
  private lockedByOthers = new Set<number>();
  private completed = false;
  private stopped = false;

  constructor(readonly persona: Persona) {}

  stop() {
    this.stopped = true;
    this.socket?.disconnect();
  }

  private apply(snapshot: RoomSnapshot) {
    this.meta = { ...snapshot.meta };
    this.layout = computeLayout(this.meta);
    this.state = structuredClone(snapshot.state);
    this.lockedByOthers = new Set(Object.keys(snapshot.locks).map(Number));
    this.completed = snapshot.state.completedAt !== null;
  }

  private group(id: number) {
    return this.state?.groups.find((g) => g.id === id);
  }

  async run() {
    const socket: BotSocket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
    this.socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });

      socket.on('room:snapshot', (s) => this.apply(s));
      socket.on('group:locked', ({ groupId }) => this.lockedByOthers.add(groupId));
      socket.on('group:unlocked', ({ groupId, x, y }) => {
        this.lockedByOthers.delete(groupId);
        const g = this.group(groupId);
        if (g) Object.assign(g, { x, y });
      });
      socket.on('groups:moved', (moves) => {
        for (const m of moves) {
          const g = this.group(m.g);
          if (g) Object.assign(g, { x: m.x, y: m.y });
        }
      });
      socket.on('group:snapped', (ev) => {
        if (!this.state) return;
        this.state.groups = this.state.groups.filter((g) => !ev.removed.includes(g.id));
        const g = this.group(ev.groupId);
        if (g) Object.assign(g, { x: ev.x, y: ev.y, pieces: ev.pieces });
        this.lockedByOthers.delete(ev.groupId);
      });
      socket.on('puzzle:completed', () => (this.completed = true));

      const p = this.persona;
      const res = await socket.timeout(10_000).emitWithAck('room:join', { room: GLOBAL_ROOM, name: p.name, color: p.color, clientId: p.clientId });
      if (!res.ok) throw new Error(`join failed: ${res.error}`);
      this.apply(res.snapshot);

      const rng = Math.random;
      const leaveAt = Date.now() + timing.sessionMs(rng, p.sessionMinutes);
      log(`${p.name} joined`);

      while (!this.stopped && socket.connected && Date.now() < leaveAt) {
        await sleep(timing.thinkMs(rng));
        if (this.completed || !this.state || !this.meta || !this.layout) continue;
        const move = planMove(this.state, this.meta, this.layout, rng, p.skill, (id) => this.lockedByOthers.has(id));
        if (!move) continue;
        const group = this.group(move.groupId);
        if (!group) continue;
        const ok = await socket.timeout(5_000).emitWithAck('group:grab', { groupId: move.groupId }).catch(() => false);
        if (!ok) continue;

        // Drag along a straight line, sending moves at roughly the rate a browser would.
        const hold = timing.holdMs(rng, move.aimed);
        const steps = Math.max(2, Math.round(hold / 120));
        const from = { x: group.x, y: group.y };
        for (let i = 1; i <= steps; i++) {
          if (this.stopped || !socket.connected) return;
          const x = from.x + ((move.x - from.x) * i) / steps;
          const y = from.y + ((move.y - from.y) * i) / steps;
          socket.emit('group:move', { g: move.groupId, x, y });
          socket.emit('cursor', { x: x + this.layout.cellW / 2, y: y + this.layout.cellH / 2 });
          await sleep(hold / steps);
        }
        socket.emit('group:release', { g: move.groupId, x: move.x, y: move.y });
      }
    } catch (err) {
      log(`${this.persona.name} stopped: ${(err as Error).message}`);
    } finally {
      socket.disconnect();
      log(`${this.persona.name} left`);
    }
  }
}

const active = new Map<string, Bot>();

function schedule() {
  const target = Math.round(BOTS_MAX * activityAt(new Date()));
  if (active.size >= target) return;
  const available = BOT_PERSONAS.filter((p) => !active.has(p.clientId));
  if (available.length === 0) return;
  const persona = available[Math.floor(Math.random() * available.length)];
  const bot = new Bot(persona);
  active.set(persona.clientId, bot);
  void bot.run().finally(() => active.delete(persona.clientId));
}

function shutdown() {
  log('shutting down');
  for (const bot of active.values()) bot.stop();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (BOTS_MAX === 0) {
  log('BOTS_MAX=0, bots disabled');
  setInterval(() => {}, 1 << 30);
} else {
  log(`up to ${BOTS_MAX} bot(s) against ${SERVER_URL}`);
  schedule();
  setInterval(schedule, SCHEDULE_MS);
}
