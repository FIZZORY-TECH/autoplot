/**
 * src/chart/axes.ts — Y/X axis label & grid drawing.
 *
 * Ported from app-design/project/chart.jsx (YAxis / XAxis components and the
 * inline grid loop). The prototype uses DOM-positioned divs for axis labels;
 * we render directly to canvas to avoid a layout-thrash hit when the price
 * scale animates 60 times a second.
 *
 * Public API:
 *   - niceStep(min, max, targetCount) — 1/2/5 × 10^n step rounding.
 *   - drawGrid(ctx, layout, view, theme) — subtle horizontal grid lines.
 *   - drawYAxis(ctx, layout, view, theme) — right-edge price labels + last-price tag.
 *   - drawXAxis(ctx, layout, bars, view, theme) — bottom-edge absolute date/time labels (zoom-adaptive).
 */

import type { Bar } from '../data/MarketDataProvider';
import type { ChartLayout, ThemeTokens, ViewWindow } from './types';
import { formatAxisTick, pickTier } from './axisFormat';

// Derive the axis font from the design-token CSS variable, read once and cached.
// getComputedStyle is safe to call at module initialisation (after the first
// render) and far too expensive to call per-frame inside the canvas draw path.
let _axisFont: string | null = null;
function getAxisFont(): string {
  if (_axisFont !== null) return _axisFont;
  if (typeof document !== 'undefined') {
    const style = getComputedStyle(document.documentElement);
    const size = style.getPropertyValue('--fs-meta').trim() || '11px';
    const family = style.getPropertyValue('--font-mono').trim() ||
      '"Geist Mono", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace';
    _axisFont = `${size} ${family}`;
  } else {
    // SSR / test fallback — matches prototype typography.
    _axisFont = '11px "Geist Mono", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace';
  }
  return _axisFont;
}
const TARGET_Y_TICKS = 6;
const TARGET_X_TICKS = 6;

/**
 * Round `targetCount` ticks across `[min, max]` to the nearest 1, 2, or 5
 * times a power of 10. Same algorithm as chart.jsx YAxis.step().
 */
export function niceStep(min: number, max: number, targetCount: number): number {
  const range = Math.max(0, max - min);
  if (range === 0 || !isFinite(range)) return 1;
  const target = range / Math.max(1, targetCount);
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const m = target / pow;
  const ms = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return ms * pow;
}

function priceToY(price: number, layout: ChartLayout, view: ViewWindow): number {
  const { yMin, yMax } = view;
  const range = yMax - yMin;
  if (range === 0) return layout.y + layout.h / 2;
  return layout.y + (1 - (price - yMin) / range) * layout.h;
}

function indexToX(idx: number, layout: ChartLayout, view: ViewWindow): number {
  const span = view.end - view.start;
  if (span <= 0) return layout.x;
  return layout.x + ((idx - view.start) / span) * layout.w;
}

/**
 * Subtle horizontal grid — same step as the Y axis labels so they line up.
 * Color comes from theme.grid (which resolves to --hairline at runtime).
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  view: ViewWindow,
  theme: ThemeTokens,
): void {
  const step = niceStep(view.yMin, view.yMax, TARGET_Y_TICKS);
  if (step <= 0 || !isFinite(step)) return;

  ctx.save();
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const first = Math.ceil(view.yMin / step) * step;
  // Bound the loop so a malformed view (yMax < yMin) cannot spin.
  const maxIters = 200;
  let count = 0;
  for (let v = first; v <= view.yMax && count < maxIters; v += step, count += 1) {
    const y = Math.round(priceToY(v, layout, view)) + 0.5; // crisp 1px line
    ctx.moveTo(layout.x, y);
    ctx.lineTo(layout.x + layout.w, y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Right-edge price labels at every nice-step tick + a highlighted tag at the
 * latest close (passed in as `lastPrice`). Renders into the gutter that sits
 * to the right of `layout.w` (caller is expected to reserve ~60 px there).
 */
export function drawYAxis(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  view: ViewWindow,
  theme: ThemeTokens,
  lastPrice?: number,
): void {
  const step = niceStep(view.yMin, view.yMax, TARGET_Y_TICKS);
  if (step <= 0 || !isFinite(step)) return;

  ctx.save();
  ctx.font = getAxisFont();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.fg;

  const labelX = layout.x + layout.w + 6;
  const first = Math.ceil(view.yMin / step) * step;
  const maxIters = 200;
  let count = 0;
  for (let v = first; v <= view.yMax && count < maxIters; v += step, count += 1) {
    const y = priceToY(v, layout, view);
    ctx.fillText(formatPrice(v), labelX, y);
  }

  // Last-price tag (bright color, no background pill — keeps the prototype's airy feel).
  if (lastPrice !== undefined && isFinite(lastPrice)) {
    const y = priceToY(lastPrice, layout, view);
    ctx.fillStyle = theme.up; // direction is computed in the canvas; keep a sensible default here.
    ctx.fillText(formatPrice(lastPrice), labelX, y);
  }

  ctx.restore();
}

/**
 * Bottom-edge X labels — absolute date/time, zoom-span-adaptive. Density: ~5–7
 * across. Each label uses the actual bar `ts` (not bar count × heuristic), which
 * makes the labels accurate regardless of which timeframe is active.
 *
 * Tier selection uses the visible time span per rendered label:
 *   < 12 h/label → 'time'  (HH:mm, with day-boundary → "MMM d")
 *   < 25 d/label → 'day'   (MMM d, with year-boundary → "MMM yyyy")
 *   else         → 'month' (MMM,   with year-boundary → "yyyy")
 */
export function drawXAxis(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  bars: Bar[],
  view: ViewWindow,
  theme: ThemeTokens,
): void {
  if (bars.length <= 1) return;
  const span = view.end - view.start;
  if (span <= 0) return;

  // Pick a stride in bar-index space that yields ~TARGET_X_TICKS labels.
  const target = span / TARGET_X_TICKS;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
  const m = target / pow;
  const ms = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  const step = Math.max(1, Math.round(ms * pow));

  // Clamp visible bar indices — shared by the tier-selection and render loop.
  const startIdx = Math.max(0, Math.ceil(view.start / step) * step);
  const endIdx = Math.min(bars.length - 1, Math.floor(view.end));

  // Derive per-label time span for tier selection.
  // totalSpanMs * step / barSpan ≈ ms of real time each rendered label covers.
  let tier = pickTier(Infinity); // fallback = 'month' when span is unknown
  const firstBar = bars[Math.max(0, Math.floor(view.start))];
  const lastBar  = bars[endIdx];
  if (firstBar && lastBar && lastBar.ts > firstBar.ts) {
    const barSpan = endIdx - Math.max(0, Math.floor(view.start));
    if (barSpan > 0) {
      const perLabelSpanMs = (lastBar.ts - firstBar.ts) * step / barSpan;
      tier = pickTier(perLabelSpanMs);
    }
  }

  const labelY = layout.y + layout.h + 14;

  ctx.save();
  ctx.font = getAxisFont();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.fg;

  // prevTs tracks the previously rendered tick so formatAxisTick can detect
  // calendar-boundary crossings (day/year) and switch to the fallback format.
  let prevTs: number | null = null;
  for (let i = startIdx; i <= endIdx; i += step) {
    const bar = bars[i];
    if (!bar) continue;
    const x = indexToX(i + 0.5, layout, view);
    if (x < layout.x || x > layout.x + layout.w) continue;
    ctx.fillText(formatAxisTick(bar.ts, tier, prevTs), x, labelY);
    prevTs = bar.ts;
  }

  ctx.restore();
}

/**
 * Compact price formatter — matches chart.jsx fmtPrice's intent without
 * importing it (P1.1 owns indicators.ts; we don't want a circular dep when
 * P1.1 hasn't landed). Switches precision based on magnitude.
 */
function formatPrice(v: number): string {
  if (!isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 10000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}
