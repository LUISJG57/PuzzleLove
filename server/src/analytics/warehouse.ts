import type { PrismaClient } from '@prisma/client';

/** Which population a dashboard shows. `mixed` puzzles (humans and bots together) count as human. */
export type TrafficFilter = 'all' | 'human' | 'bot' | 'synthetic';
export const TRAFFIC_FILTERS: readonly TrafficFilter[] = ['all', 'human', 'bot', 'synthetic'];

export interface DashboardQuery {
  days: number;
  traffic: TrafficFilter;
}

export interface Kpis {
  activePlayers: number;
  sessions: number;
  puzzlesCompleted: number;
  completionRate: number | null;
  snapRate: number | null;
  medianSessionMin: number | null;
}

export interface AnalyticsDashboard {
  available: true;
  range: { from: string; to: string; days: number };
  dataThrough: string;
  kpis: Kpis;
  previous: Kpis;
  daily: { date: string; activePlayers: number; sessions: number; puzzlesCompleted: number; moves: number }[];
  heatmap: { weekday: number; hour: number; sessions: number }[];
  difficulty: { size: string; started: number; played: number; completed: number; medianMinutes: number | null }[];
  lastRun: {
    runId: number;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    checksPassed: number;
    checksTotal: number;
    error: string | null;
  } | null;
}

export type AnalyticsResponse = AnalyticsDashboard | { available: false; reason: 'no_warehouse' | 'no_data' };

export interface WarehouseReader {
  dashboard(query: DashboardQuery): Promise<AnalyticsResponse>;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const dateKey = (d: Date) => Number(isoDate(d).replaceAll('-', ''));

function sessionTypes(t: TrafficFilter) {
  return t === 'all' ? ['human', 'bot', 'synthetic'] : [t];
}

function puzzleTypes(t: TrafficFilter) {
  if (t === 'all') return ['human', 'mixed', 'bot', 'synthetic', 'none'];
  if (t === 'human') return ['human', 'mixed'];
  return [t];
}

/** Reads the dashboards from the warehouse schema published by the analytics pipeline. */
export class PrismaWarehouseReader implements WarehouseReader {
  constructor(private readonly prisma: PrismaClient) {}

  async dashboard({ days, traffic }: DashboardQuery): Promise<AnalyticsResponse> {
    const db = this.prisma;
    const [{ ready }] = await db.$queryRaw<{ ready: boolean }[]>`
      SELECT to_regclass('warehouse.fact_session') IS NOT NULL AND to_regclass('warehouse.fact_puzzle') IS NOT NULL AS ready`;
    if (!ready) return { available: false, reason: 'no_warehouse' };

    // The current day is still in progress (and the nightly run only sees its first hours), so ranges end at the last full day.
    const [{ max_date }] = await db.$queryRaw<{ max_date: Date | null }[]>`
      SELECT max(date) AS max_date FROM warehouse.dim_date WHERE date < (now() AT TIME ZONE 'America/Mexico_City')::date`;
    if (!max_date) return { available: false, reason: 'no_data' };

    // Ranges end at the last day the pipeline has published, not at "now": the warehouse lags by up to a day.
    const to = max_date;
    const from = new Date(to.getTime() - (days - 1) * 86400_000);
    const prevTo = new Date(from.getTime() - 86400_000);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400_000);
    const sTypes = sessionTypes(traffic);
    const pTypes = puzzleTypes(traffic);

    const kpis = async (lo: Date, hi: Date): Promise<Kpis> => {
      const [s] = await db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(DISTINCT client_id) AS players, count(*) AS sessions,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) / 60000.0 AS median_min,
               sum(snaps)::float / nullif(sum(moves), 0) AS snap_rate
        FROM warehouse.fact_session
        WHERE date_key BETWEEN ${dateKey(lo)} AND ${dateKey(hi)} AND traffic_type = ANY(${sTypes})`;
      const [p] = await db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) FILTER (WHERE is_completed) AS completed,
               count(*) FILTER (WHERE is_completed)::float / nullif(count(*) FILTER (WHERE moves > 0), 0) AS completion_rate
        FROM warehouse.fact_puzzle
        WHERE date_key BETWEEN ${dateKey(lo)} AND ${dateKey(hi)} AND traffic_type = ANY(${pTypes})`;
      return {
        activePlayers: num(s.players),
        sessions: num(s.sessions),
        puzzlesCompleted: num(p.completed),
        completionRate: numOrNull(p.completion_rate),
        snapRate: numOrNull(s.snap_rate),
        medianSessionMin: numOrNull(s.median_min),
      };
    };

    const [current, previous, daily, heatmap, difficulty, runs] = await Promise.all([
      kpis(from, to),
      kpis(prevFrom, prevTo),
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT d.date, coalesce(s.players, 0) AS players, coalesce(s.sessions, 0) AS sessions, coalesce(s.moves, 0) AS moves,
               coalesce(p.completed, 0) AS completed
        FROM warehouse.dim_date d
        LEFT JOIN (
          SELECT date_key, count(DISTINCT client_id) AS players, count(*) AS sessions, sum(moves) AS moves
          FROM warehouse.fact_session WHERE traffic_type = ANY(${sTypes}) GROUP BY date_key
        ) s USING (date_key)
        LEFT JOIN (
          SELECT date_key, count(*) FILTER (WHERE is_completed) AS completed
          FROM warehouse.fact_puzzle WHERE traffic_type = ANY(${pTypes}) GROUP BY date_key
        ) p USING (date_key)
        WHERE d.date BETWEEN ${from}::date AND ${to}::date
        ORDER BY d.date`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT weekday, hour_local AS hour, count(*) AS sessions
        FROM warehouse.fact_session
        WHERE date_key BETWEEN ${dateKey(from)} AND ${dateKey(to)} AND traffic_type = ANY(${sTypes})
        GROUP BY weekday, hour_local`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT size, count(*) AS started, count(*) FILTER (WHERE moves > 0) AS played,
               count(*) FILTER (WHERE is_completed) AS completed,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE is_completed) / 60000.0 AS median_min,
               min(sort_key) AS sort_key
        FROM (
          SELECT *,
                 CASE WHEN room_type = 'global' THEN 'global'
                      WHEN pieces <= 36 THEN '24' WHEN pieces <= 72 THEN '48' WHEN pieces <= 120 THEN '96' ELSE '150' END AS size,
                 CASE WHEN room_type = 'global' THEN 0 ELSE pieces END AS sort_key
          FROM warehouse.fact_puzzle
          WHERE date_key BETWEEN ${dateKey(from)} AND ${dateKey(to)} AND traffic_type = ANY(${pTypes}) AND pieces IS NOT NULL
        ) t
        GROUP BY size ORDER BY sort_key`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT run_id, status, started_at, finished_at, left(error, 300) AS error,
               (SELECT count(*) FROM jsonb_array_elements(coalesce(checks, '[]'::jsonb)) c WHERE (c->>'passed')::boolean) AS passed,
               jsonb_array_length(coalesce(checks, '[]'::jsonb)) AS total
        FROM warehouse.pipeline_runs ORDER BY run_id DESC LIMIT 1`,
    ]);

    const run = runs[0];
    return {
      available: true,
      range: { from: isoDate(from), to: isoDate(to), days },
      dataThrough: isoDate(to),
      kpis: current,
      previous,
      daily: daily.map((r) => ({
        date: isoDate(r.date as Date),
        activePlayers: num(r.players),
        sessions: num(r.sessions),
        puzzlesCompleted: num(r.completed),
        moves: num(r.moves),
      })),
      heatmap: heatmap.map((r) => ({ weekday: num(r.weekday), hour: num(r.hour), sessions: num(r.sessions) })),
      difficulty: difficulty.map((r) => ({
        size: String(r.size),
        started: num(r.started),
        played: num(r.played),
        completed: num(r.completed),
        medianMinutes: numOrNull(r.median_min),
      })),
      lastRun: run
        ? {
            runId: num(run.run_id),
            status: String(run.status),
            startedAt: (run.started_at as Date).toISOString(),
            finishedAt: run.finished_at ? (run.finished_at as Date).toISOString() : null,
            checksPassed: num(run.passed),
            checksTotal: num(run.total),
            error: (run.error as string | null) ?? null,
          }
        : null,
    };
  }
}
