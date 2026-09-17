/**
 * Writes synthetic history into analytics_events (is_synthetic = true) for developing the data pipeline.
 *
 *   DATABASE_URL=postgresql://... npm run backfill -w tools/simulator -- --days 28 --seed 42 --yes
 *
 * Options: --days N (default 28), --end ISO date (default now), --seed N, --purge (delete previous synthetic
 * rows first), --dry-run (print a summary only), --yes (required to write).
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { generateHistory, type SimEvent } from './generate';

const COLUMNS = [
  'event_id', 'event_type', 'schema_version', 'occurred_at', 'ingested_at', 'session_id', 'client_id',
  'room_slug', 'room_type', 'puzzle_id', 'payload', 'is_synthetic',
] as const;
const BATCH = 1000;

function row(e: SimEvent) {
  return [e.eventId, e.eventType, e.schemaVersion, e.occurredAt, e.ingestedAt, e.sessionId, e.clientId, e.roomSlug, e.roomType, e.puzzleId, JSON.stringify(e.payload), true];
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: 'string', default: '28' },
      end: { type: 'string' },
      seed: { type: 'string', default: '42' },
      purge: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });
  const end = values.end ? new Date(values.end) : new Date();
  const start = new Date(end.getTime() - Number(values.days) * 24 * 3600_000);
  const started = Date.now();
  const events = generateHistory({ start, end, seed: Number(values.seed) });

  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
  console.log(`[backfill] generated ${events.length} events from ${start.toISOString()} to ${end.toISOString()} in ${Date.now() - started} ms`);
  console.table(Object.fromEntries([...byType.entries()].sort()));
  if (values['dry-run']) return;

  if (!values.yes) {
    console.error('[backfill] refusing to write without --yes (rows are flagged is_synthetic = true)');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('[backfill] DATABASE_URL is not set');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (values.purge) {
      const { rowCount } = await client.query('DELETE FROM analytics_events WHERE is_synthetic');
      console.log(`[backfill] purged ${rowCount} synthetic rows`);
    }
    let inserted = 0;
    for (let i = 0; i < events.length; i += BATCH) {
      const batch = events.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = batch.map((e) => {
        const values = row(e);
        const placeholders = values.map((_, j) => `$${params.length + j + 1}`);
        params.push(...values);
        return `(${placeholders.join(', ')})`;
      });
      const res = await client.query(
        `INSERT INTO analytics_events (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (event_id) DO NOTHING`,
        params,
      );
      inserted += res.rowCount ?? 0;
    }
    await client.query('COMMIT');
    console.log(`[backfill] inserted ${inserted} rows`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[backfill] failed', err);
  process.exit(1);
});
