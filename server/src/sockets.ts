import type { IoServer, RoomManager } from './rooms/RoomManager';

export function registerSockets(io: IoServer, manager: RoomManager) {
  io.on('connection', (socket) => {
    socket.on('room:join', async (req, ack) => {
      if (typeof ack !== 'function') return;
      try {
        ack(await manager.join(socket, req));
      } catch (err) {
        console.error('[socket] join failed', err);
        ack({ ok: false, error: 'invalid' });
      }
    });

    socket.on('group:grab', (data, ack) => {
      const ok = manager.grab(socket, data?.groupId);
      if (typeof ack === 'function') ack(ok);
    });

    socket.on('group:move', (data) => manager.move(socket, data));
    socket.on('group:release', (data) => manager.release(socket, data));
    socket.on('cursor', (data) => manager.cursor(socket, data));
    socket.on('puzzle:restart', () => {
      manager.restart(socket).catch((err) => console.error('[socket] restart failed', err));
    });

    socket.on('disconnect', () => manager.leave(socket));
  });
}
