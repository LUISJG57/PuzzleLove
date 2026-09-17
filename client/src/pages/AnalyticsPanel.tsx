import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarList, Heatmap, LineChart } from '../components/charts';

type Traffic = 'all' | 'human' | 'bot' | 'synthetic';

interface Kpis {
  activePlayers: number;
  sessions: number;
  puzzlesCompleted: number;
  completionRate: number | null;
  snapRate: number | null;
  medianSessionMin: number | null;
}

type Analytics =
  | { available: false; reason: 'no_warehouse' | 'no_data' }
  | {
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
    };

const DAYS = [7, 14, 30, 90];
const TRAFFIC: Traffic[] = ['all', 'human', 'bot', 'synthetic'];

export function AnalyticsPanel() {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState(30);
  const [traffic, setTraffic] = useState<Traffic>('all');
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/admin/analytics?days=${days}&traffic=${traffic}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: Analytics) => {
        if (cancelled) return;
        setData(json);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, traffic]);

  const lang = i18n.language.startsWith('es') ? 'es-MX' : 'en-US';
  const int = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
  const minutes = (v: number | null) => (v === null ? '—' : t('analytics.minutes', { value: v.toFixed(1) }));
  const shortDate = (iso: string) =>
    new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 8, 14 + i))),
  );

  const filters = (
    <div className="viz-filters">
      <div className="segmented" role="group" aria-label={t('analytics.range')}>
        {DAYS.map((d) => (
          <button key={d} type="button" className={d === days ? 'active' : ''} aria-pressed={d === days} onClick={() => setDays(d)}>
            {t('analytics.days', { count: d })}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label={t('analytics.traffic')}>
        {TRAFFIC.map((k) => (
          <button key={k} type="button" className={k === traffic ? 'active' : ''} aria-pressed={k === traffic} onClick={() => setTraffic(k)}>
            {t(`analytics.trafficTypes.${k}`)}
          </button>
        ))}
      </div>
    </div>
  );

  if (!data) {
    return (
      <section className="admin-section">
        {filters}
        <p className="muted">{failed ? t('analytics.error') : t('common.loading')}</p>
      </section>
    );
  }

  if (!data.available) {
    return (
      <section className="admin-section">
        {filters}
        <p className="muted">{t(`analytics.unavailable.${data.reason}`)}</p>
      </section>
    );
  }

  const delta = (key: keyof Kpis, higherIsBetter = true) => {
    const now = data.kpis[key];
    const before = data.previous[key];
    if (now === null || before === null || before === 0) return null;
    const change = (now - before) / before;
    if (Math.abs(change) < 0.005) return { text: t('analytics.noChange'), tone: 'flat' as const };
    const good = change > 0 === higherIsBetter;
    return { text: `${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change * 100))}%`, tone: good ? ('good' as const) : ('bad' as const) };
  };

  const tiles: { label: string; value: string; delta: ReturnType<typeof delta> }[] = [
    { label: t('analytics.kpi.players'), value: int.format(data.kpis.activePlayers), delta: delta('activePlayers') },
    { label: t('analytics.kpi.completed'), value: int.format(data.kpis.puzzlesCompleted), delta: delta('puzzlesCompleted') },
    { label: t('analytics.kpi.completionRate'), value: pct(data.kpis.completionRate), delta: delta('completionRate') },
    { label: t('analytics.kpi.snapRate'), value: pct(data.kpis.snapRate), delta: delta('snapRate') },
    { label: t('analytics.kpi.session'), value: minutes(data.kpis.medianSessionMin), delta: delta('medianSessionMin') },
  ];

  const run = data.lastRun;
  const runOk = run?.status === 'success';

  return (
    <section className={`admin-section viz-root${loading ? ' refreshing' : ''}`}>
      {filters}
      <p className="muted small">
        {t('analytics.through', { from: shortDate(data.range.from), to: shortDate(data.dataThrough) })}
      </p>

      <div className="viz-kpis">
        {tiles.map((tile) => (
          <div className="viz-tile" key={tile.label}>
            <div className="viz-tile-label">{tile.label}</div>
            <div className="viz-tile-value">{tile.value}</div>
            <div className={`viz-tile-delta ${tile.delta?.tone ?? ''}`}>
              {tile.delta ? t('analytics.vsPrevious', { delta: tile.delta.text }) : ' '}
            </div>
          </div>
        ))}
      </div>

      <div className="viz-grid">
        <figure className="viz-card">
          <figcaption>{t('analytics.charts.players')}</figcaption>
          <LineChart
            points={data.daily.map((d) => ({ label: shortDate(d.date), value: d.activePlayers }))}
            format={(v) => int.format(v)}
            ariaLabel={t('analytics.charts.players')}
          />
        </figure>
        <figure className="viz-card">
          <figcaption>{t('analytics.charts.completed')}</figcaption>
          <LineChart
            points={data.daily.map((d) => ({ label: shortDate(d.date), value: d.puzzlesCompleted }))}
            format={(v) => int.format(v)}
            ariaLabel={t('analytics.charts.completed')}
          />
        </figure>
      </div>

      <figure className="viz-card">
        <figcaption>{t('analytics.charts.heatmap')}</figcaption>
        <Heatmap
          cells={data.heatmap.map((h) => ({ row: h.weekday - 1, col: h.hour, value: h.sessions }))}
          rowLabels={weekdays}
          colLabel={(c) => `${c}h`}
          ariaLabel={t('analytics.charts.heatmap')}
          legend={{ low: t('analytics.fewer'), high: t('analytics.more') }}
          describe={(c) => (
            <>
              <strong>{t('analytics.sessionsCount', { count: c.value })}</strong>
              <span>
                {weekdays[c.row]} · {c.col}:00–{c.col}:59
              </span>
            </>
          )}
        />
      </figure>

      <figure className="viz-card">
        <figcaption>{t('analytics.charts.difficulty')}</figcaption>
        {data.difficulty.length === 0 ? (
          <p className="muted">{t('analytics.empty')}</p>
        ) : (
          <BarList
            ariaLabel={t('analytics.charts.difficulty')}
            rows={data.difficulty.map((d) => ({
              key: d.size,
              label: d.size === 'global' ? t('analytics.globalPuzzle') : t('analytics.pieces', { count: Number(d.size) }),
              value: d.played > 0 ? d.completed / d.played : null,
              valueLabel: pct(d.played > 0 ? d.completed / d.played : null),
              detail: t('analytics.difficultyDetail', { completed: d.completed, played: d.played, median: minutes(d.medianMinutes) }),
            }))}
          />
        )}
      </figure>

      <details className="viz-table">
        <summary>{t('analytics.table')}</summary>
        <div className="viz-table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('analytics.col.date')}</th>
                <th>{t('analytics.kpi.players')}</th>
                <th>{t('analytics.col.sessions')}</th>
                <th>{t('analytics.kpi.completed')}</th>
                <th>{t('analytics.col.moves')}</th>
              </tr>
            </thead>
            <tbody>
              {[...data.daily].reverse().map((d) => (
                <tr key={d.date}>
                  <td>{shortDate(d.date)}</td>
                  <td>{d.activePlayers}</td>
                  <td>{d.sessions}</td>
                  <td>{d.puzzlesCompleted}</td>
                  <td>{d.moves}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {run && (
        <div className={`viz-run ${runOk ? 'ok' : 'fail'}`}>
          <span className="viz-run-status">
            <span aria-hidden="true">{runOk ? '✓' : '✕'}</span> {t(`analytics.run.${runOk ? 'success' : 'failed'}`)}
          </span>
          <span className="muted">
            {t('analytics.run.detail', {
              id: run.runId,
              when: new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.finishedAt ?? run.startedAt)),
              passed: run.checksPassed,
              total: run.checksTotal,
            })}
          </span>
          {run.error && <code className="viz-run-error">{run.error.split('\n')[0]}</code>}
        </div>
      )}
    </section>
  );
}
