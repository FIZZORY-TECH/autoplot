/**
 * src/components/MiniSpark.tsx — Inline 32-bar SVG sparkline (P3.2 / P3-20).
 *
 * Renders an `<svg><polyline/></svg>` whose points are the supplied closing
 * prices normalized to fit a fixed (width × height) box. Stroke color is
 * driven by `direction` so callers compute "up / down / flat" once from 24h
 * change and pass it in.
 *
 * Visual binding: app-design/project/panel.jsx MiniSpark (panel.jsx:4–15).
 * Prototype defaults: 56×18 box, strokeWidth 1.2, opacity 0.85.
 *
 * Edge cases:
 *   - `values` empty or single-element → returns null. Caller hides cell.
 *   - All-equal values → mid-line is rendered with `flat` color.
 *
 * Constraints: SVG-only (no canvas) so the row stays cheap to repaint while
 * the watchlist scrolls.
 */

import { useMemo } from 'react';

export interface MiniSparkProps {
  /** Closing prices (or any monotonic series). 32 values is the canonical use. */
  values: number[];
  /** SVG box width in CSS px. Defaults to 56. */
  width?: number;
  /** SVG box height in CSS px. Defaults to 18. */
  height?: number;
  /**
   * Trend color hint:
   *   - 'up'   → var(--up)
   *   - 'down' → var(--down)
   *   - 'flat' → var(--ink-2) at low alpha
   */
  direction?: 'up' | 'down' | 'flat';
  /** Polyline stroke width in px. Defaults to 1.2 (prototype panel.jsx:12). */
  strokeWidth?: number;
  /** Polyline opacity. Defaults to 0.85 (prototype panel.jsx:12). */
  opacity?: number;
}

/** Color tokens by trend direction. */
function strokeColor(direction: 'up' | 'down' | 'flat'): string {
  switch (direction) {
    case 'up':
      return 'var(--up)';
    case 'down':
      return 'var(--down)';
    case 'flat':
    default:
      // ink-2 at ~60% — readable but not visually competing with up/down rows.
      return 'color-mix(in oklab, var(--ink-2) 60%, transparent)';
  }
}

export function MiniSpark({
  values,
  width = 56,
  height = 18,
  direction = 'flat',
  strokeWidth = 1.2,
  opacity = 0.85,
}: MiniSparkProps): JSX.Element | null {
  // Memoize the polyline points string — recomputes only when inputs change.
  const points = useMemo(() => {
    if (!values || values.length < 2) return '';
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const range = hi - lo || 1; // guard against all-equal series
    const step = width / (values.length - 1);
    return values
      .map((v, i) => `${(i * step).toFixed(2)},${(height - ((v - lo) / range) * height).toFixed(2)}`)
      .join(' ');
  }, [values, width, height]);

  if (!points) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', flexShrink: 0 }}
      role="img"
      aria-label="price sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke={strokeColor(direction)}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={opacity}
      />
    </svg>
  );
}

export default MiniSpark;
