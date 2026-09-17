/**
 * Small hand-rolled SVG charts for the admin dashboard (no chart library).
 * Specs follow the dataviz rules: 2px lines with a 10% area wash, hairline grid, <=24px bars with 4px rounded ends,
 * one-hue sequential ramp for the heatmap, hover/focus tooltips that never gate (a table view exists).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const VIZ = {
  series: '#2a78d6',
  ramp: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  empty: '#f0efec',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= v)!;
  return step * pow;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.content}
    </div>
  );
}

export interface LinePoint {
  label: string;
  value: number;
}

export function LineChart({ points, format, ariaLabel }: { points: LinePoint[]; format: (v: number) => string; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 170;
  const pad = { top: 12, right: 12, bottom: 24, left: 40 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const x = (i: number) => pad.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join('');
  const area = points.length ? `${path}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : '';
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 70))));

  const pick = (clientX: number, rect: DOMRect) => {
    if (points.length === 0 || plotW <= 0) return;
    const rel = (clientX - rect.left - pad.left) / plotW;
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(rel * (points.length - 1)))));
  };

  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="viz-chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(points.length - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? points.length) - 1));
            if (e.key === 'ArrowRight') setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1));
          }}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.left} x2={pad.left + plotW} y1={y(max * f)} y2={y(max * f)} stroke={f === 0 ? VIZ.axis : VIZ.grid} strokeWidth={1} />
              <text x={pad.left - 6} y={y(max * f)} dy="0.32em" textAnchor="end" className="viz-tick">
                {format(max * f)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text key={p.label} x={x(i)} y={height - 6} textAnchor="middle" className="viz-tick">
                {p.label}
              </text>
            ) : null,
          )}
          <path d={area} fill={VIZ.series} fillOpacity={0.1} />
          <path d={path} fill="none" stroke={VIZ.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hp && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} stroke={VIZ.axis} strokeWidth={1} />
              <circle cx={x(hover)} cy={y(hp.value)} r={5} fill={VIZ.series} stroke="#fff" strokeWidth={2} />
            </g>
          )}
          {points.length > 0 && hover === null && (
            <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].value)} r={4} fill={VIZ.series} stroke="#fff" strokeWidth={2} />
          )}
        </svg>
      )}
      <Tooltip
        tip={
          hp && hover !== null
            ? {
                x: Math.min(x(hover), width - 90),
                y: Math.max(0, y(hp.value) - 52),
                content: (
                  <>
                    <strong>{format(hp.value)}</strong>
                    <span>{hp.label}</span>
                  </>
                ),
              }
            : null
        }
      />
    </div>
  );
}

export interface HeatCell {
  row: number;
  col: number;
  value: number;
}

export function Heatmap({
  cells,
  rowLabels,
  colLabel,
  describe,
  ariaLabel,
  legend,
}: {
  cells: HeatCell[];
  rowLabels: string[];
  colLabel: (col: number) => string;
  describe: (cell: HeatCell) => ReactNode;
  ariaLabel: string;
  legend: { low: string; high: string };
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const cols = 24;
  const left = 38;
  const gap = 2;
  const cell = Math.max(8, Math.floor((width - left) / cols));
  // Rows keep a readable fixed height instead of following the (wide or narrow) column width.
  const rowH = Math.min(22, Math.max(14, cell));
  const top = 4;
  const height = top + rowLabels.length * rowH + 22;
  const max = Math.max(...cells.map((c) => c.value), 0);
  const byKey = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]));
  const color = (v: number) => (v <= 0 || max === 0 ? VIZ.empty : VIZ.ramp[Math.min(VIZ.ramp.length - 1, Math.floor((v / max) * VIZ.ramp.length))]);

  return (
    <div className="viz-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerLeave={() => setTip(null)}>
          {rowLabels.map((label, r) => (
            <text key={label} x={0} y={top + r * rowH + rowH / 2} dy="0.32em" className="viz-tick">
              {label}
            </text>
          ))}
          {Array.from({ length: cols }, (_, c) =>
            c % 3 === 0 ? (
              <text key={c} x={left + c * cell + (cell - gap) / 2} y={height - 6} textAnchor="middle" className="viz-tick">
                {colLabel(c)}
              </text>
            ) : null,
          )}
          {rowLabels.map((_, r) =>
            Array.from({ length: cols }, (_, c) => {
              const data = byKey.get(`${r}:${c}`) ?? { row: r, col: c, value: 0 };
              const cx = left + c * cell;
              const cy = top + r * rowH;
              const show = () => setTip({ x: Math.min(cx, width - 150), y: Math.max(0, cy - 48), content: describe(data) });
              return (
                <rect
                  key={`${r}:${c}`}
                  x={cx}
                  y={cy}
                  width={cell - gap}
                  height={rowH - gap}
                  rx={3}
                  fill={color(data.value)}
                  className="viz-cell"
                  tabIndex={-1}
                  onPointerEnter={show}
                  onFocus={show}
                />
              );
            }),
          )}
        </svg>
      )}
      <div className="viz-scale" aria-hidden="true">
        <span>{legend.low}</span>
        {VIZ.ramp.map((c) => (
          <i key={c} style={{ background: c }} />
        ))}
        <span>{legend.high}</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  /** 0..1 */
  value: number | null;
  valueLabel: string;
  detail: string;
}

export function BarList({ rows, ariaLabel }: { rows: BarRow[]; ariaLabel: string }) {
  return (
    <ul className="viz-bars" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="viz-bar-label">{r.label}</span>
          <span className="viz-bar-track">
            <span className="viz-bar-fill" style={{ width: `${Math.max(0, Math.min(1, r.value ?? 0)) * 100}%` }} />
          </span>
          <strong className="viz-bar-value">{r.valueLabel}</strong>
          <span className="viz-bar-detail">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}
