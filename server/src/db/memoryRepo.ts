import type { NewRoom, QueueItem, Repo, RoomRecord, RoomUpdate } from './repo';

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory implementation used by tests. */
export class MemoryRepo implements Repo {
  rooms = new Map<string, RoomRecord>();
  queue: (QueueItem & { usedAt: Date | null })[] = [];
  private nextId = 1;

  async getRoom(slug: string) {
    const r = this.rooms.get(slug);
    return r ? clone(r) : null;
  }

  async createRoom(room: NewRoom) {
    if (this.rooms.has(room.slug)) throw new Error('duplicate slug');
    const now = new Date();
    const rec: RoomRecord = { ...clone(room), createdAt: now, lastActivityAt: now };
    this.rooms.set(room.slug, rec);
    return clone(rec);
  }

  async updateRoom(slug: string, data: RoomUpdate) {
    const r = this.rooms.get(slug);
    if (!r) throw new Error('room not found');
    Object.assign(r, clone(data));
  }

  async deleteRoom(slug: string) {
    this.rooms.delete(slug);
  }

  async findExpiredRooms(before: Date) {
    return [...this.rooms.values()].filter((r) => !r.isGlobal && r.lastActivityAt < before).map(clone);
  }

  async listQueue() {
    return this.queue.filter((q) => !q.usedAt).map(({ usedAt: _u, ...q }) => clone(q));
  }

  async addToQueue(item: Omit<QueueItem, 'id' | 'createdAt'>) {
    const q = { ...item, id: String(this.nextId++), createdAt: new Date(), usedAt: null };
    this.queue.push(q);
    const { usedAt: _u, ...rest } = q;
    return clone(rest);
  }

  async removeFromQueue(id: string) {
    const idx = this.queue.findIndex((q) => q.id === id && !q.usedAt);
    if (idx < 0) return null;
    const [{ usedAt: _u, ...q }] = this.queue.splice(idx, 1);
    return q;
  }

  async takeNextFromQueue() {
    const q = this.queue.find((i) => !i.usedAt);
    if (!q) return null;
    q.usedAt = new Date();
    const { usedAt: _u, ...rest } = q;
    return clone(rest);
  }
}
