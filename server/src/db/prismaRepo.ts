import prismaPkg from '@prisma/client';
import type { Prisma, PrismaClient as PrismaClientType } from '@prisma/client';
import type { PuzzleState } from '@puzzlelove/shared';
import type { NewRoom, QueueItem, Repo, RoomRecord, RoomUpdate } from './repo';

const { PrismaClient } = prismaPkg;

type RoomRow = Awaited<ReturnType<PrismaClientType['room']['findUnique']>> & {};

function toRecord(row: RoomRow): RoomRecord {
  return {
    slug: row.slug,
    isGlobal: row.isGlobal,
    imageKey: row.imageKey,
    imageWidth: row.imageWidth,
    imageHeight: row.imageHeight,
    rows: row.rows,
    cols: row.cols,
    seed: row.seed,
    state: row.state as unknown as PuzzleState,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  };
}

function toQueueItem(row: { id: string; imageKey: string; imageWidth: number; imageHeight: number; createdAt: Date }) {
  return {
    id: row.id,
    imageKey: row.imageKey,
    imageWidth: row.imageWidth,
    imageHeight: row.imageHeight,
    createdAt: row.createdAt,
  };
}

export class PrismaRepo implements Repo {
  readonly prisma: PrismaClientType = new PrismaClient();

  async getRoom(slug: string) {
    const row = await this.prisma.room.findUnique({ where: { slug } });
    return row ? toRecord(row) : null;
  }

  async createRoom(room: NewRoom) {
    const row = await this.prisma.room.create({
      data: { ...room, state: room.state as unknown as Prisma.InputJsonValue },
    });
    return toRecord(row);
  }

  async updateRoom(slug: string, data: RoomUpdate) {
    const { state, ...rest } = data;
    await this.prisma.room.update({
      where: { slug },
      data: { ...rest, ...(state ? { state: state as unknown as Prisma.InputJsonValue } : {}) },
    });
  }

  async deleteRoom(slug: string) {
    await this.prisma.room.deleteMany({ where: { slug } });
  }

  async findExpiredRooms(before: Date) {
    const rows = await this.prisma.room.findMany({
      where: { isGlobal: false, lastActivityAt: { lt: before } },
      take: 500,
    });
    return rows.map(toRecord);
  }

  async listQueue(): Promise<QueueItem[]> {
    const rows = await this.prisma.globalQueueItem.findMany({
      where: { usedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toQueueItem);
  }

  async addToQueue(item: Omit<QueueItem, 'id' | 'createdAt'>) {
    return toQueueItem(await this.prisma.globalQueueItem.create({ data: item }));
  }

  async removeFromQueue(id: string) {
    const row = await this.prisma.globalQueueItem.findFirst({ where: { id, usedAt: null } });
    if (!row) return null;
    await this.prisma.globalQueueItem.delete({ where: { id } });
    return toQueueItem(row);
  }

  async takeNextFromQueue() {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.globalQueueItem.findFirst({ where: { usedAt: null }, orderBy: { createdAt: 'asc' } });
      if (!row) return null;
      await tx.globalQueueItem.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      return toQueueItem(row);
    });
  }
}
