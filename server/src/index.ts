import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { PrismaEventStore } from './analytics/prismaEventStore';
import { BufferedEventSink } from './analytics/sink';
import { PrismaWarehouseReader } from './analytics/warehouse';
import { createApp } from './app';
import { loadConfig } from './config';
import { PrismaRepo } from './db/prismaRepo';
import { RoomManager, type IoServer } from './rooms/RoomManager';
import { registerSockets } from './sockets';
import { createStorage } from './storage';

async function main() {
  const config = loadConfig();
  const storage = createStorage(config);
  const repo = new PrismaRepo();
  await repo.prisma.$connect();

  const httpServer = createServer();
  const io: IoServer = new Server(httpServer, { serveClient: false, maxHttpBufferSize: 64 * 1024 });
  const events = new BufferedEventSink(new PrismaEventStore(repo.prisma));
  events.start();
  const manager = new RoomManager(io, repo, storage, { events });
  registerSockets(io, manager);
  await manager.init();

  const app = createApp({ config, manager, storage, repo, warehouse: new PrismaWarehouseReader(repo.prisma) });
  httpServer.on('request', app);
  httpServer.listen(config.port, () => {
    console.log(`[server] PuzzleLove listening on http://localhost:${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[server] shutting down, saving rooms...');
    io.close();
    await manager.stop();
    await events.stop();
    await repo.prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
