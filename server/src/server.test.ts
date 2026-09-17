import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_ROOM,
  computeLayout,
  type ClientToServerEvents,
  type JoinResult,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@puzzlelove/shared';
import { createApp } from './app';
import { MemoryRepo } from './db/memoryRepo';
import { RoomManager, type IoServer } from './rooms/RoomManager';
import { registerSockets } from './sockets';
import { LocalStorage } from './storage';

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let tmp: string;
let repo: MemoryRepo;
let storage: LocalStorage;
let httpServer: HttpServer;
let io: IoServer;
let manager: RoomManager;
let app: ReturnType<typeof createApp>;
let url: string;
const clients: Client[] = [];

async function testImage(width = 800, height = 600) {
  return sharp({ create: { width, height, channels: 3, background: '#ff88aa' } }).png().toBuffer();
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c: Client = ioClient(url, { transports: ['websocket'], forceNew: true });
    clients.push(c);
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
}

function join(c: Client, room: string, name = 'Ana'): Promise<JoinResult> {
  return new Promise((resolve) => c.emit('room:join', { room, name, color: '#ef4444', clientId: `cid-${name}` }, resolve));
}

function grab(c: Client, groupId: number): Promise<boolean> {
  return new Promise((resolve) => c.emit('group:grab', { groupId }, resolve));
}

function next<E extends keyof ServerToClientEvents>(c: Client, event: E): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve) => {
    c.once(event, ((data: never) => resolve(data)) as never);
  });
}

async function createRoom(pieces = 24) {
  const res = await request(app)
    .post('/api/rooms')
    .field('pieces', String(pieces))
    .attach('image', await testImage(), { filename: 'a.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  return res.body.slug as string;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'puzzlelove-test-'));
  repo = new MemoryRepo();
  storage = new LocalStorage(tmp);
  httpServer = createServer();
  io = new Server(httpServer);
  manager = new RoomManager(io, repo, storage, { tickMs: 10, saveMs: 50, globalNextDelayMs: 100 });
  registerSockets(io, manager);
  await manager.init();
  app = createApp({
    config: { adminPassword: 'secret', sessionSecret: 'test', trustProxy: false, clientDist: path.join(tmp, 'none') },
    manager,
    storage,
    repo,
  });
  httpServer.on('request', app);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await manager.stop();
  io.close();
  await new Promise((r) => httpServer.close(r));
  await rm(tmp, { recursive: true, force: true });
});

describe('HTTP', () => {
  it('creates the global room with a default image on startup', async () => {
    const global = await repo.getRoom(GLOBAL_ROOM);
    expect(global?.rows).toBe(5);
    expect(global?.cols).toBe(5);
    const img = await request(app).get(`/api/images/${global!.imageKey}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/webp');
  });

  it('creates a private room from an upload', async () => {
    const slug = await createRoom(48);
    const room = await repo.getRoom(slug);
    expect(room?.isGlobal).toBe(false);
    expect(room!.rows * room!.cols).toBeGreaterThanOrEqual(40);
    expect((await storage.get(room!.imageKey))?.length).toBeGreaterThan(0);
  });

  it('rejects invalid uploads', async () => {
    const bad = await request(app).post('/api/rooms').field('pieces', '24').attach('image', Buffer.from('nope'), {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(bad.status).toBe(400);
    const badCount = await request(app)
      .post('/api/rooms')
      .field('pieces', '7')
      .attach('image', await testImage(), { filename: 'a.png', contentType: 'image/png' });
    expect(badCount.status).toBe(400);
  });

  it('rejects image keys outside the allowed pattern', async () => {
    expect((await request(app).get('/api/images/..%2F..%2Fsecret/x.webp')).status).toBe(404);
    expect((await request(app).get('/api/images/rooms/nope.webp')).status).toBe(404);
  });

  it('protects admin routes and manages the global queue', async () => {
    expect((await request(app).post('/api/admin/next')).status).toBe(401);
    expect((await request(app).post('/api/admin/login').send({ password: 'wrong' })).status).toBe(401);

    const agent = request.agent(app);
    expect((await agent.post('/api/admin/login').send({ password: 'secret' })).status).toBe(200);
    const added = await agent
      .post('/api/admin/queue')
      .attach('image', await testImage(1000, 1000), { filename: 'g.png', contentType: 'image/png' });
    expect(added.status).toBe(201);

    const status = await agent.get('/api/admin/status');
    expect(status.body.authenticated).toBe(true);
    expect(status.body.queue).toHaveLength(1);

    const before = (await repo.getRoom(GLOBAL_ROOM))!.imageKey;
    expect((await agent.post('/api/admin/next')).status).toBe(200);
    const after = await repo.getRoom(GLOBAL_ROOM);
    expect(after!.imageKey).not.toBe(before);
    expect(after!.imageWidth).toBe(1000);
    expect((await agent.get('/api/admin/status')).body.queue).toHaveLength(0);
  });

  it('deletes private rooms after 24 hours without activity', async () => {
    const slug = await createRoom();
    const room = (await repo.getRoom(slug))!;
    expect(await manager.expireRooms(Date.now())).toBe(0);
    await repo.updateRoom(slug, { lastActivityAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    expect(await manager.expireRooms(Date.now())).toBe(1);
    expect(await repo.getRoom(slug)).toBeNull();
    expect(await storage.get(room.imageKey)).toBeNull();
    expect(await repo.getRoom(GLOBAL_ROOM)).not.toBeNull();
  });
});

describe('multiplayer', () => {
  it('joins rooms and reports unknown rooms', async () => {
    const a = await connect();
    const res = await join(a, GLOBAL_ROOM);
    expect(res.ok).toBe(true);
    expect((await join(a, 'doesnotexist')).ok).toBe(false);
  });

  it('limits private rooms to 8 players but not the global room', async () => {
    const slug = await createRoom();
    for (let i = 0; i < 8; i++) expect((await join(await connect(), slug, `p${i}`)).ok).toBe(true);
    const ninth = await join(await connect(), slug, 'p9');
    expect(ninth).toEqual({ ok: false, error: 'full' });
    for (let i = 0; i < 12; i++) expect((await join(await connect(), GLOBAL_ROOM, `g${i}`)).ok).toBe(true);
  });

  it('locks groups, relays moves and snaps pieces for everyone', async () => {
    const slug = await createRoom();
    const a = await connect();
    const b = await connect();
    const snap = ((await join(a, slug, 'Ana')) as { snapshot: RoomSnapshot }).snapshot;
    const joined = next(a, 'player:joined');
    await join(b, slug, 'Beto');
    expect((await joined).name).toBe('Beto');

    const locked = next(b, 'group:locked');
    expect(await grab(a, 0)).toBe(true);
    expect((await locked).groupId).toBe(0);
    expect(await grab(b, 0)).toBe(false);

    const moved = next(b, 'groups:moved');
    a.emit('group:move', { g: 0, x: 12345, y: 6789 });
    expect((await moved)[0]).toEqual({ g: 0, x: 12345, y: 6789 });

    const target = snap.state.groups.find((g) => g.id === 1)!;
    const snapped = next(b, 'group:snapped');
    a.emit('group:release', { g: 0, x: target.x + 2, y: target.y - 1 });
    const ev = await snapped;
    expect(ev.pieces).toEqual([0, 1]);
    expect(ev.removed).toEqual([0]);
    expect(ev.by).toBe(a.id);
  });

  it('releases locks when a player disconnects', async () => {
    const slug = await createRoom();
    const a = await connect();
    const b = await connect();
    await join(a, slug, 'Ana');
    await join(b, slug, 'Beto');
    expect(await grab(a, 3)).toBe(true);
    const unlocked = next(b, 'group:unlocked');
    const left = next(b, 'player:left');
    const aId = a.id;
    a.disconnect();
    expect((await unlocked).groupId).toBe(3);
    expect(await left).toBe(aId);
    expect(await grab(b, 3)).toBe(true);
  });

  it('completes a puzzle, ranks players and persists state', async () => {
    const slug = await createRoom();
    const a = await connect();
    const snap = ((await join(a, slug, 'Ana')) as { snapshot: RoomSnapshot }).snapshot;
    const ids = snap.state.groups.map((g) => g.id);
    const completed = next(a, 'puzzle:completed');
    for (const id of ids) {
      expect(await grab(a, id)).toBe(true);
      a.emit('group:release', { g: id, x: 0, y: 0 });
      await new Promise((r) => setTimeout(r, 5));
    }
    const done = await completed;
    expect(done.scores[0].name).toBe('Ana');
    expect(done.nextPuzzleAt).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    const saved = await repo.getRoom(slug);
    expect(saved!.state.completedAt).not.toBeNull();
    expect(saved!.state.groups).toHaveLength(1);

    const reshuffled = next(a, 'room:snapshot');
    a.emit('puzzle:restart');
    const fresh = await reshuffled;
    expect(fresh.state.groups).toHaveLength(snap.state.groups.length);
    expect(fresh.meta.seed).not.toBe(snap.meta.seed);
  });

  it('reshuffles the global puzzle after completion when the queue is empty', async () => {
    const a = await connect();
    const snap = ((await join(a, GLOBAL_ROOM, 'Ana')) as { snapshot: RoomSnapshot }).snapshot;
    const completed = next(a, 'puzzle:completed');
    const layout = computeLayout({ ...snap.meta });
    expect(layout.pieceCount).toBe(25);
    for (const g of snap.state.groups) {
      await grab(a, g.id);
      a.emit('group:release', { g: g.id, x: 0, y: 0 });
      await new Promise((r) => setTimeout(r, 5));
    }
    const done = await completed;
    expect(done.nextPuzzleAt).not.toBeNull();
    const fresh = await next(a, 'room:snapshot');
    expect(fresh.meta.imageUrl).toBe(snap.meta.imageUrl);
    expect(fresh.state.groups).toHaveLength(25);
    expect(fresh.state.completedAt).toBeNull();
  });
});
