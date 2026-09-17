/** Random distributions and activity curves shared by the live bots and the backfill generator. */

export type Rng = () => number;

export function normal(rng: Rng): number {
  // Box-Muller; 1 - rng() avoids log(0).
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/** Right-skewed durations: most are near the median, a few are much longer. */
export function lognormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(sigma * normal(rng));
}

export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng();
  while (p > limit) {
    k++;
    p *= rng();
  }
  return k;
}

export function pickWeighted<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export const TIME_ZONE = 'America/Mexico_City';

/** Local hour and weekday (0 = Sunday) in the players' time zone. */
export function localTime(date: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  return { hour, weekday };
}

// Relative activity per local hour (0-23): quiet at night, a lunch bump, peak in the evening.
const HOURLY = [
  0.12, 0.07, 0.04, 0.03, 0.03, 0.04, 0.08, 0.15, 0.22, 0.28, 0.32, 0.38,
  0.45, 0.5, 0.42, 0.38, 0.42, 0.5, 0.62, 0.8, 0.95, 1, 0.8, 0.4,
];

/** Expected share of peak activity at `date`, including a weekend boost. */
export function activityAt(date: Date): number {
  const { hour, weekday } = localTime(date);
  const weekend = weekday === 0 || weekday === 6 ? 1.35 : weekday === 5 ? 1.15 : 1;
  return Math.min(1, HOURLY[hour] * weekend);
}

export const timing = {
  /** Pause between moves. */
  thinkMs: (rng: Rng) => Math.min(20_000, lognormal(rng, 2200, 0.55)),
  /** How long a piece is held while dragging; aimed drops take longer. */
  holdMs: (rng: Rng, aimed: boolean) => Math.min(12_000, lognormal(rng, aimed ? 1700 : 900, 0.45)),
  /** Time a player stays in a room. */
  sessionMs: (rng: Rng, medianMinutes: number) => Math.min(3 * 3600_000, lognormal(rng, medianMinutes * 60_000, 0.7)),
};
