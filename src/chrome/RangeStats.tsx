/**
 * src/chrome/RangeStats.tsx — Floating stats card for the Range Scope tool (P2.6).
 *
 * Displays Δ% / Δ$ / O / C / H / L / Span for a selected bar range.
 * Floats above the selection band, horizontally centered over it.
 * Glass treatment matches the prototype's `.range-stats` (chart.jsx lines 615–634).
 *
 * Props:
 *   range   — inclusive start, exclusive end (bar indices)
 *   bars    — full Bar array from the data provider
 *   layout  — chart plot rect in CSS px (ChartLayout)
 *   view    — current ViewWindow (needed to compute x positions)
 *   onClear — called when the × button is clicked
 */

import type { Bar } from '../data/MarketDataProvider';
import type { ChartLayout, ViewWindow } from '../chart/types';
import { fmtPrice, fmtPct } from '../engine/indicators';

// ---------------------------------------------------------------------------
// Duration humanizer
// Accepts elapsed milliseconds, returns e.g. "~2d 4h" or "~6h" or "~3d"
// ---------------------------------------------------------------------------
function humanizeDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days > 0 && hours > 0) return `~${days}d ${hours}h`;
  if (days > 0) return `~${days}d`;
  if (hours > 0) return `~${hours}h`;
  const min = totalMinutes % 60;
  return `~${min}m`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RangeStatsProps {
  range: { start: number; end: number };
  bars: Bar[];
  layout: ChartLayout;
  view: ViewWindow;
  onClear: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RangeStats({ range, bars, layout, view, onClear }: RangeStatsProps) {
  const { start, end } = range;

  // Guard: invalid indices → render nothing
  if (
    start >= end ||
    start < 0 ||
    end > bars.length ||
    bars.length === 0
  ) {
    return null;
  }

  const first = bars[start];
  const last = bars[end - 1];
  if (!first || !last) return null;

  // OHLC stats across the range
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i < end; i++) {
    const b = bars[i];
    if (!b) continue;
    if (b.h > high) high = b.h;
    if (b.l < low) low = b.l;
  }

  const openPrice = first.o;
  const closePrice = last.c;
  const deltaAbs = closePrice - openPrice;
  const deltaPct = openPrice !== 0 ? deltaAbs / Math.abs(openPrice) : 0;
  const isUp = deltaPct >= 0;
  const barCount = end - start;

  // Duration: ts of last bar minus ts of first bar
  const durationMs = last.ts - first.ts;
  const durationStr = durationMs > 0 ? humanizeDuration(durationMs) : '';
  const spanStr = durationStr ? `${barCount} bars · ${durationStr}` : `${barCount} bars`;

  // Position: horizontally centered over the band, near top of chart
  const span = view.end - view.start;
  const barToPx = (idx: number) =>
    layout.x + ((idx - view.start) / Math.max(1, span)) * layout.w;

  const x1 = barToPx(start);
  const x2 = barToPx(end);
  const bandCenterX = (x1 + x2) / 2;

  // Card width ~220px; clamp so it doesn't overflow chart
  const cardWidth = 220;
  const rawLeft = bandCenterX - cardWidth / 2;
  const clampedLeft = Math.max(
    layout.x,
    Math.min(layout.x + layout.w - cardWidth, rawLeft),
  );
  // Top: 24px below the plot top (above the candles)
  const cardTop = layout.y + 24;

  const upColor = 'oklch(0.78 0.16 150)';
  const downColor = 'oklch(0.70 0.20 25)';
  const deltaColor = isUp ? upColor : downColor;

  return (
    <div
      className="glass overlay-enter"
      style={{
        position: 'absolute',
        left: clampedLeft,
        top: cardTop,
        width: cardWidth,
        padding: 'var(--sp-6) var(--sp-10)',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.6,
        zIndex: 'var(--z-chart-hud)',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}
      role="region"
      aria-label="Range statistics"
    >
      {/* × close button */}
      <button
        onClick={onClear}
        aria-label="Clear range"
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          background: 'none',
          border: 'none',
          color: 'var(--ink-3)',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: '2px 4px',
        }}
      >
        ×
      </button>

      {/* Δ row */}
      <div style={{ display: 'flex', gap: 'var(--sp-6)', marginBottom: 'var(--sp-4)' }}>
        <span style={{ color: 'var(--ink-3)', minWidth: 32 }}>Δ</span>
        <span style={{ color: deltaColor, fontWeight: 600 }}>
          {fmtPct(deltaPct)}
          {' · '}
          {fmtPrice(deltaAbs)}
        </span>
      </div>

      {/* OHLCV grid */}
      {(
        [
          ['O', fmtPrice(openPrice)],
          ['C', fmtPrice(closePrice)],
          ['H', fmtPrice(high)],
          ['L', fmtPrice(low)],
          ['Span', spanStr],
        ] as [string, string][]
      ).map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 6 }}>
          <span
            style={{
              color: 'var(--ink-3)',
              minWidth: 32,
              flexShrink: 0,
            }}
          >
            {k}
          </span>
          <span
            style={{
              color: 'var(--ink-1)',
              wordBreak: 'break-word',
            }}
          >
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

export default RangeStats;
