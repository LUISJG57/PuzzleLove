import { describe, expect, it } from 'vitest';
import { generateHistory, type SimEvent } from './generate';

const end = new Date('2026-09-14T00:00:00Z');
const start = new Date(end.getTime() - 3 * 24 * 3600_000);
const events = generateHistory({ start, end, seed: 7 });

const KNOWN_TYPES = new Set([
  'room_created', 'puzzle_started', 'player_joined', 'join_failed', 'player_left', 'piece_grabbed', 'grab_conflict',
  'piece_dropped', 'piece_abandoned', 'puzzle_completed', 'global_rotated', 'room_expired',
]);

describe('generateHistory', () => {
  it('produces a sizeable, time-ordered history inside the window', () => {
    expect(events.length).toBeGreaterThan(1000);
    for (const e of events) {
      expect(KNOWN_TYPES.has(e.eventType)).toBe(true);
      expect(e.occurredAt.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(e.occurredAt.getTime()).toBeLessThan(end.getTime() + 60_000);
      expect(e.ingestedAt.getTime()).toBeGreaterThan(e.occurredAt.getTime());
    }
    const times = events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });

  it('is deterministic for a seed', () => {
    const again = generateHistory({ start, end, seed: 7 });
    expect(again.map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
    expect(generateHistory({ start, end, seed: 8 })[0].eventId).not.toBe(events[0].eventId);
  });

  it('never reuses event ids when the same seed runs over a shifted window', () => {
    const shifted = generateHistory({ start: new Date(start.getTime() + 5 * 60_000), end: new Date(end.getTime() + 5 * 60_000), seed: 7 });
    const ids = new Set(events.map((e) => e.eventId));
    expect(shifted.some((e) => ids.has(e.eventId))).toBe(false);
  });

  it('keeps sessions consistent: join first, leave last, grabs resolved', () => {
    const bySession = new Map<string, SimEvent[]>();
    for (const e of events) if (e.sessionId) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
    expect(bySession.size).toBeGreaterThan(50);

    for (const list of bySession.values()) {
      expect(list[0].eventType).toBe('player_joined');
      const leaves = list.filter((e) => e.eventType === 'player_left');
      expect(leaves.length).toBeLessThanOrEqual(1);
      if (leaves.length === 1) expect(list.at(-1)!.eventType).toBe('player_left');

      let open = false;
      for (const e of list) {
        if (e.eventType === 'piece_grabbed') {
          expect(open).toBe(false);
          open = true;
        } else if (e.eventType === 'piece_dropped' || e.eventType === 'piece_abandoned') {
          expect(open).toBe(true);
          open = false;
        }
      }
    }
  });

  it('completes puzzles through the real engine', () => {
    const completed = events.filter((e) => e.eventType === 'puzzle_completed');
    expect(completed.length).toBeGreaterThan(5);
    const startedIds = new Set(events.filter((e) => e.eventType === 'puzzle_started').map((e) => e.puzzleId));
    for (const c of completed) {
      expect(startedIds.has(c.puzzleId)).toBe(true);
      const drops = events.filter((e) => e.puzzleId === c.puzzleId && e.eventType === 'piece_dropped');
      const merged = drops.reduce((n, d) => n + (d.payload.merged_groups as number), 0);
      // Every piece except the first ends up merged into one group.
      expect(merged).toBe((c.payload.pieces as number) - 1);
      expect(completed.filter((x) => x.puzzleId === c.puzzleId)).toHaveLength(1);
    }
    expect(events.some((e) => e.eventType === 'room_created')).toBe(true);
    expect(events.every((e) => !e.clientId || e.clientId.startsWith('sim-'))).toBe(true);
  });
});
