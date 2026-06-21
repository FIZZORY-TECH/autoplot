/**
 * src/components/Crosshair.tsx — Floating crosshair overlay for the chart.
 *
 * Draws:
 *   - Vertical + horizontal hairline rules at the cursor position
 *     (color = var(--hairline)).
 *   - A floating .glass price readout pinned near the cursor with:
 *       • Header line — formatted bar timestamp
 *       • Block 1 "Change" — vs Open + Δ prev close (colored –up/–down)
 *       • Block 2 "Range / Vol" — range + volume vs trailing avg (neutral)
 *       • Block 3 "Price" — O/H/L/C demoted to --ink-2
 *     All derived in-memory from the frozen Bar array. No extra state, no fetches.
 *
 * Position is absolute relative to the chart wrapper (passed in via props).
 * Visibility is fully driven by `state` — null hides it.
 *
 * Respects `prefers-reduced-motion`: disables the readout slide-in animation
 * when the user has requested reduced motion.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Bar, Tf } from '../data/MarketDataProvider';
import { fmtPrice, fmtPct } from '../engine/indicators';
import type { CrosshairState } from '../chart/interaction';
import { fmtVol, fmtBarTime } from '../lib/format';
import { usePrimaryReadout } from '../stores/useOverlayHitStore';

/** Number of preceding bars used to compute the average volume multiple. */
const VOL_LOOKBACK = 20;

interface CrosshairProps {
  state: CrosshairState | null;
  bars: Bar[];
  /** Plot-area layout in CSS pixels — used to bound the rules to the plot. */
  layout: { x: number; y: number; w: number; h: number };
  /** Active chart timeframe — passed to fmtBarTime to select the right format. */
  timeframe: Tf | string;
}

// ---------------------------------------------------------------------------
// Derived fields — keyed on bar index, recomputed only when bars/idx change.
// ---------------------------------------------------------------------------

interface DerivedFields {
  /** Formatted timestamp header, e.g. "Jun 21, 14:00" */
  ts: string;
  vsOAbs: string;
  /** empty string when not computable */
  vsOPct: string;
  /** +1 / -1 / 0 (for color) */
  vsOSign: number;
  /** undefined when idx === 0 */
  dPrevAbs: string | undefined;
  /** undefined when idx === 0 */
  dPrevPct: string | undefined;
  dPrevSign: number;
  rngAbs: string;
  /** empty string when not computable */
  rngPct: string;
  vol: string;
  /** undefined when no preceding bars */
  volAvgMultiple: string | undefined;
  o: string;
  h: string;
  l: string;
  c: string;
}

function deriveFields(bars: Bar[], idx: number, tf: Tf | string): DerivedFields {
  const bar = bars[idx];

  const signedPrice = (v: number): string =>
    Number.isFinite(v) ? (v > 0 ? '+' : '') + fmtPrice(v) : '—';
  const safePct = (v: number): string => (Number.isFinite(v) ? fmtPct(v) : '');

  // Header timestamp
  const ts = fmtBarTime(bar.ts, tf);

  // --- vs Open ------------------------------------------------------------
  const vsORaw = bar.c - bar.o;
  const vsOPctRaw = bar.o !== 0 && Number.isFinite(bar.o) ? vsORaw / bar.o : NaN;
  const vsOAbs = signedPrice(vsORaw);
  const vsOPct = safePct(vsOPctRaw);
  const vsOSign = vsORaw > 0 ? 1 : vsORaw < 0 ? -1 : 0;

  // --- Δ prev close -------------------------------------------------------
  let dPrevAbs: string | undefined;
  let dPrevPct: string | undefined;
  let dPrevSign = 0;
  if (idx > 0) {
    const prev = bars[idx - 1];
    if (prev && Number.isFinite(prev.c) && prev.c !== 0) {
      const delta = bar.c - prev.c;
      const pct = delta / prev.c;
      dPrevAbs = signedPrice(delta);
      dPrevPct = safePct(pct);
      dPrevSign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    }
  }

  // --- Range / Vol --------------------------------------------------------
  const rngRaw = bar.h - bar.l;
  const rngPctRaw = bar.c !== 0 && Number.isFinite(bar.c) ? rngRaw / bar.c : NaN;
  const rngAbs = Number.isFinite(rngRaw) ? fmtPrice(rngRaw) : '—';
  const rngPct = safePct(rngPctRaw);
  const vol = fmtVol(bar.v);

  let volAvgMultiple: string | undefined;
  if (idx > 0 && Number.isFinite(bar.v)) {
    const lookbackStart = Math.max(0, idx - VOL_LOOKBACK);
    const slice = bars.slice(lookbackStart, idx);
    if (slice.length > 0) {
      const avg = slice.reduce((s, b) => s + (Number.isFinite(b.v) ? b.v : 0), 0) / slice.length;
      if (avg > 0) {
        volAvgMultiple = `×${(bar.v / avg).toFixed(1)}avg`;
      }
    }
  }

  // --- O/H/L/C ------------------------------------------------------------
  return {
    ts,
    vsOAbs,
    vsOPct,
    vsOSign,
    dPrevAbs,
    dPrevPct,
    dPrevSign,
    rngAbs,
    rngPct,
    vol,
    volAvgMultiple,
    o: fmtPrice(bar.o),
    h: fmtPrice(bar.h),
    l: fmtPrice(bar.l),
    c: fmtPrice(bar.c),
  };
}

// ---------------------------------------------------------------------------
// Style constants (inline — no CSS module dependency)
// ---------------------------------------------------------------------------

const ROW_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 'var(--sp-8, 8px)',
  rowGap: 'var(--sp-2, 2px)',
};

const LBL: React.CSSProperties = {
  color: 'var(--ink-3, #8a8f99)',
  textAlign: 'left' as const,
};

const VAL: React.CSSProperties = {
  textAlign: 'right' as const,
};

const DIVIDER_STYLE: React.CSSProperties = {
  borderBottom: '1px dashed var(--ink-4, rgba(255,255,255,0.08))',
  margin: '4px 0',
};

const ROW_GRID_MB2: React.CSSProperties = { ...ROW_GRID, marginBottom: 2 };
const DIVIDER_HEADER: React.CSSProperties = { ...DIVIDER_STYLE, margin: '0 0 6px' };

/** Map a signed delta to the correct color token. */
function signColor(sign: number): string {
  if (sign > 0) return 'var(--up, #4caf7d)';
  if (sign < 0) return 'var(--down, #e05b5b)';
  return 'inherit';
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

export function Crosshair({ state, bars, layout, timeframe }: CrosshairProps): JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();
  // Precedence ladder (see useOverlayHitStore): when an event hotspot is hovered
  // ('event') or its popover is open ('popover'), the EVENT owns the readout —
  // the crosshair PRICE value chip must NOT compete. We keep faint hairlines for
  // spatial context but suppress the OHLCV chip in those two rungs.
  const primary = usePrimaryReadout();
  const showPriceChip = primary !== 'event' && primary !== 'popover';

  // All derived numbers — recomputed only when bar index, bars array, or
  // timeframe changes.
  // NOTE: useMemo MUST be called before any conditional return to satisfy the
  // Rules of Hooks. When state is null (no hover), barIdx falls back to 0 and
  // the result is discarded anyway (card is not rendered).
  const barIdx = state?.barIdx ?? 0;
  const d = useMemo(
    () => {
      const bar = bars[barIdx];
      return bar ? deriveFields(bars, barIdx, timeframe) : null;
    },
    [bars, barIdx, timeframe],
  );

  if (!state) return null;
  const bar = bars[state.barIdx];

  // Constrain the rule lines to the plot area.
  const xClamped = Math.max(layout.x, Math.min(layout.x + layout.w, state.x));
  const yClamped = Math.max(layout.y, Math.min(layout.y + layout.h, state.y));

  // Position the readout to the right of the cursor; flip left if near the
  // right edge of the plot so it never falls off.
  const READOUT_W = 200;
  const readoutLeft =
    xClamped + READOUT_W + 12 > layout.x + layout.w
      ? xClamped - READOUT_W - 12
      : xClamped + 12;
  // Pull the card up further than the old 76px offset — card is taller now.
  const readoutTop = Math.max(layout.y + 4, yClamped - 100);

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

      {/* Floating glass readout — suppressed while an event is the primary
          readout so the price chip never competes with the event affordance. */}
      {bar && d && showPriceChip && (
        <div
          className="glass"
          data-testid="crosshair-readout"
          style={{
            position: 'absolute',
            left: readoutLeft,
            top: readoutTop,
            width: READOUT_W,
            padding: 'var(--sp-8) var(--sp-12)',
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
          {/* ── Header: timestamp ──────────────────────────────────────── */}
          <div
            style={{
              fontSize: 'var(--fs-eyebrow, 10px)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #8a8f99)',
              marginBottom: 6,
            }}
          >
            {d.ts}
          </div>

          {/* Dashed rule beneath header */}
          <div style={DIVIDER_HEADER} />

          {/* ── Block 1: Change (THE one colored, slightly heavier block) ── */}
          <div style={ROW_GRID_MB2}>

            {/* vs Open */}
            <span style={LBL}>vs O</span>
            <span
              style={{
                ...VAL,
                color: signColor(d.vsOSign),
                fontWeight: d.vsOSign !== 0 ? 500 : undefined,
              }}
            >
              {d.vsOAbs}{d.vsOPct ? ` (${d.vsOPct})` : ''}
            </span>

            {/* Δ prev close — row omitted entirely at idx === 0 */}
            {d.dPrevAbs !== undefined && (
              <>
                <span style={LBL}>&Delta; prev</span>
                <span
                  style={{
                    ...VAL,
                    color: signColor(d.dPrevSign),
                    opacity: 0.75,
                  }}
                >
                  {d.dPrevAbs}{d.dPrevPct ? ` (${d.dPrevPct})` : ''}
                </span>
              </>
            )}
          </div>

          {/* Divider */}
          <div style={DIVIDER_STYLE} />

          {/* ── Block 2: Range / Vol (neutral ink) ─────────────────────── */}
          <div style={ROW_GRID_MB2}>
            <span style={LBL}>Rng</span>
            <span style={VAL}>
              {d.rngAbs}{d.rngPct ? ` ${d.rngPct}` : ''}
            </span>

            <span style={LBL}>Vol</span>
            <span style={VAL}>
              {d.vol}{d.volAvgMultiple ? ` (${d.volAvgMultiple})` : ''}
            </span>
          </div>

          {/* Divider */}
          <div style={DIVIDER_STYLE} />

          {/* ── Block 3: OHLC demoted to --ink-2 ───────────────────────── */}
          <div style={{ ...ROW_GRID, color: 'var(--ink-2, #7a7f8e)' }}>
            <span style={LBL}>O</span><span style={VAL}>{d.o}</span>
            <span style={LBL}>H</span><span style={VAL}>{d.h}</span>
            <span style={LBL}>L</span><span style={VAL}>{d.l}</span>
            <span style={LBL}>C</span><span style={VAL}>{d.c}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default Crosshair;
