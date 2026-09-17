import type { Prisma, PrismaClient } from '@prisma/client';
import type { AnalyticsEvent } from './events';
import type { EventStore } from './sink';

export class PrismaEventStore implements EventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(events: AnalyticsEvent[]) {
    // skipDuplicates makes a retried batch that partially landed safe (event_id is unique).
    await this.prisma.analyticsEvent.createMany({
      data: events.map((e) => ({
        eventId: e.eventId,
        eventType: e.eventType,
        schemaVersion: e.schemaVersion,
        occurredAt: e.occurredAt,
        sessionId: e.sessionId ?? null,
        clientId: e.clientId ?? null,
        roomSlug: e.roomSlug ?? null,
        roomType: e.roomType ?? null,
        puzzleId: e.puzzleId ?? null,
        payload: e.payload as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }
}
