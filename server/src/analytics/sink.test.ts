import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsEvent } from './events';
import { BufferedEventSink, type EventStore } from './sink';

const quietLogger = { error: vi.fn(), warn: vi.fn() };

class FakeStore implements EventStore {
  batches: AnalyticsEvent[][] = [];
  failNext = 0;
  async insert(events: AnalyticsEvent[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('db down');
    }
    this.batches.push([...events]);
  }
  get written() {
    return this.batches.flat();
  }
}

const track = (sink: BufferedEventSink, groupId: number) =>
  sink.track('piece_grabbed', { roomSlug: 'global', roomType: 'global' }, { group_id: groupId, group_size: 1 });

describe('BufferedEventSink', () => {
  it('writes events in batches with ids and schema version', async () => {
    const store = new FakeStore();
    const sink = new BufferedEventSink(store, { batchSize: 2, logger: quietLogger });
    for (let i = 0; i < 5; i++) track(sink, i);
    await sink.flush();
    expect(store.batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(store.written.map((e) => (e.payload as { group_id: number }).group_id)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(store.written.map((e) => e.eventId)).size).toBe(5);
    expect(store.written[0]).toMatchObject({ eventType: 'piece_grabbed', schemaVersion: 1, roomSlug: 'global' });
  });

  it('keeps events when the store fails and retries on the next flush', async () => {
    const store = new FakeStore();
    store.failNext = 1;
    const sink = new BufferedEventSink(store, { logger: quietLogger });
    track(sink, 1);
    await sink.flush();
    expect(store.written).toHaveLength(0);
    expect(sink.pending).toBe(1);
    await sink.flush();
    expect(store.written).toHaveLength(1);
    expect(sink.pending).toBe(0);
  });

  it('bounds the buffer by dropping the oldest events', async () => {
    const store = new FakeStore();
    store.failNext = 1;
    const logger = { error: vi.fn(), warn: vi.fn() };
    const sink = new BufferedEventSink(store, { maxBuffer: 3, batchSize: 100, logger });
    for (let i = 0; i < 5; i++) track(sink, i);
    expect(sink.pending).toBe(3);
    await sink.flush(); // fails
    await sink.flush();
    expect(store.written.map((e) => (e.payload as { group_id: number }).group_id)).toEqual([2, 3, 4]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2 event(s)'));
  });

  it('flushes what is left on stop', async () => {
    const store = new FakeStore();
    const sink = new BufferedEventSink(store, { flushMs: 60_000, logger: quietLogger });
    sink.start();
    track(sink, 7);
    await sink.stop();
    expect(store.written).toHaveLength(1);
  });
});
