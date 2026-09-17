import { randomUUID } from 'node:crypto';
import { EVENT_SCHEMA_VERSION, type AnalyticsEvent, type EventContext, type EventPayloads, type EventType } from './events';

/** Where batches of events are written (Postgres in production). */
export interface EventStore {
  insert(events: AnalyticsEvent[]): Promise<void>;
}

/** Receives gameplay events. `track` must never throw or block the game. */
export interface EventSink {
  track<T extends EventType>(type: T, context: EventContext, payload: EventPayloads[T]): void;
  /** Writes everything buffered so far. */
  flush(): Promise<void>;
  /** Stops background flushing and writes what is left. */
  stop(): Promise<void>;
}

function buildEvent<T extends EventType>(type: T, context: EventContext, payload: EventPayloads[T]): AnalyticsEvent<T> {
  return {
    eventId: randomUUID(),
    eventType: type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: new Date(),
    ...context,
    payload,
  };
}

export class NoopEventSink implements EventSink {
  track() {}
  async flush() {}
  async stop() {}
}

/** Keeps events in memory; used by tests. */
export class MemoryEventSink implements EventSink {
  events: AnalyticsEvent[] = [];

  track<T extends EventType>(type: T, context: EventContext, payload: EventPayloads[T]) {
    this.events.push(buildEvent(type, context, payload));
  }

  ofType<T extends EventType>(type: T): AnalyticsEvent<T>[] {
    return this.events.filter((e): e is AnalyticsEvent<T> => e.eventType === type);
  }

  async flush() {}
  async stop() {}
}

export interface BufferedEventSinkOptions {
  flushMs?: number;
  batchSize?: number;
  /** When the store is down, the oldest events beyond this many are dropped. */
  maxBuffer?: number;
  logger?: Pick<Console, 'error' | 'warn'>;
}

/**
 * Buffers events in memory and writes them in batches. Store failures are logged and retried on the
 * next flush; the buffer is bounded so a long outage costs old events, never memory or gameplay.
 */
export class BufferedEventSink implements EventSink {
  private buffer: AnalyticsEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private dropped = 0;
  private readonly opts: Required<BufferedEventSinkOptions>;

  constructor(
    private readonly store: EventStore,
    options: BufferedEventSinkOptions = {},
  ) {
    this.opts = { flushMs: 2000, batchSize: 500, maxBuffer: 10_000, logger: console, ...options };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs);
    this.timer.unref();
  }

  get pending() {
    return this.buffer.length;
  }

  track<T extends EventType>(type: T, context: EventContext, payload: EventPayloads[T]) {
    try {
      this.buffer.push(buildEvent(type, context, payload));
      if (this.buffer.length > this.opts.maxBuffer) {
        const excess = this.buffer.length - this.opts.maxBuffer;
        this.buffer.splice(0, excess);
        this.dropped += excess;
      }
      if (this.buffer.length >= this.opts.batchSize) void this.flush();
    } catch (err) {
      this.opts.logger.error('[analytics] track failed', err);
    }
  }

  flush(): Promise<void> {
    // Serialize flushes so batches are written in order.
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain() {
    if (this.dropped > 0) {
      this.opts.logger.warn(`[analytics] dropped ${this.dropped} event(s) while the store was unavailable`);
      this.dropped = 0;
    }
    while (this.buffer.length > 0) {
      const batch = this.buffer.slice(0, this.opts.batchSize);
      try {
        await this.store.insert(batch);
      } catch (err) {
        this.opts.logger.error(`[analytics] failed to write ${batch.length} event(s); will retry`, err);
        return;
      }
      this.buffer.splice(0, batch.length);
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
