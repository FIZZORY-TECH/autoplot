/**
 * src/components/Crosshair.tsx — Floating crosshair overlay for the chart.
 *
 * Draws:
 *   - Vertical + horizontal hairline rules at the cursor position
 *     (color = var(--hairline)).
 *   - A floating .glass price readout pinned near the cursor with the bar's
 *     OHLCV at the hovered bar index.
 *
 * Position is absolute relative to the chart wrapper (passed in via props).
 * Visibility is fully driven by `state` — null hides it.
 *
 * Respects `prefers-reduced-motion`: disables the readout slide-in animation
 * when the user has requested reduced motion.
 */

import { useEffect, useState } from 'react';
import type { Bar } from '../data/MarketDataProvider';
import { fmtPrice } from '../engine/indicators';
import type { CrosshairState } from '../chart/interaction';
import { fmtVol } from '../lib/format';

interface CrosshairProps {
  state: CrosshairState | null;
  bars: Bar[];
  /** Plot-area layout in CSS pixels — used to bound the rules to the plot. */
  layout: { x: number; y: number; w: number; h: number };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fn = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, []);
  return reduced;
}

export function Crosshair({ state, bars, layout }: CrosshairProps): JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();

  if (!state) return null;
  const bar = bars[state.barIdx];

  // Constrain the rule lines to the plot area.
  const xClamped = Math.max(layout.x, Math.min(layout.x + layout.w, state.x));
  const yClamped = Math.max(layout.y, Math.min(layout.y + layout.h, state.y));

  // Position the readout to the right of the cursor; flip left if near the
  // right edge of the plot so it never falls off.
  const READOUT_W = 168;
  const readoutLeft =
    xClamped + READOUT_W + 12 > layout.x + layout.w
      ? xClamped - READOUT_W - 12
      : xClamped + 12;
  const readoutTop = Math.max(layout.y + 4, yClamped - 76);

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 'var(--z-chart-crosshair)',
      }}
    >
      {/* Vertical hairline */}
      <div
        style={{
          position: 'absolute',
          left: Math.round(xClamped) - 0.5,
          top: layout.y,
          width: 1,
          height: layout.h,
          background: 'transparent',
          // Dashed look matches the prototype's canvas setLineDash([1, 3]):
          // 1px painted, 3px gap → stop at 25% on a 4px cycle.
          backgroundImage:
            'linear-gradient(to bottom, var(--hairline) 25%, transparent 25%)',
          backgroundSize: '1px 4px',
          backgroundRepeat: 'repeat-y',
        }}
      />
      {/* Horizontal hairline */}
      <div
        style={{
          position: 'absolute',
          left: layout.x,
          top: Math.round(yClamped) - 0.5,
          width: layout.w,
          height: 1,
          background: 'transparent',
          backgroundImage:
            'linear-gradient(to right, var(--hairline) 25%, transparent 25%)',
          backgroundSize: '4px 1px',
          backgroundRepeat: 'repeat-x',
        }}
      />

      {/* Floating glass readout */}
      {bar && (
        <div
          className="glass"
          style={{
            position: 'absolute',
            left: readoutLeft,
            top: readoutTop,
            width: READOUT_W,
            padding: 'var(--sp-8) var(--sp-12)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 'var(--sp-12)',
            rowGap: 'var(--sp-4, 4px)',
            color: 'var(--ink-1, #cdd2db)',
            fontSize: 'var(--fs-meta, 11px)',
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            fontVariantNumeric: 'tabular-nums',
            // Slide-in only when motion is allowed.
            animation: reducedMotion
              ? undefined
              : 'crosshair-readout-in var(--t-fast) var(--ease)',
          }}
        >
          <span style={{ color: 'var(--ink-3, #8a8f99)' }}>O</span>
          <span style={{ textAlign: 'right' }}>{fmtPrice(bar.o)}</span>
          <span style={{ color: 'var(--ink-3, #8a8f99)' }}>H</span>
          <span style={{ textAlign: 'right' }}>{fmtPrice(bar.h)}</span>
          <span style={{ color: 'var(--ink-3, #8a8f99)' }}>L</span>
          <span style={{ textAlign: 'right' }}>{fmtPrice(bar.l)}</span>
          <span style={{ color: 'var(--ink-3, #8a8f99)' }}>C</span>
          <span style={{ textAlign: 'right' }}>{fmtPrice(bar.c)}</span>
          <span style={{ color: 'var(--ink-3, #8a8f99)' }}>V</span>
          <span style={{ textAlign: 'right' }}>{fmtVol(bar.v)}</span>
        </div>
      )}
    </div>
  );
}

export default Crosshair;
