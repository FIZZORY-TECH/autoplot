/**
 * src/chart/overlays.ts — MA20 / MA50 / Bollinger Band overlay renderers.
 *
 * Each export is a factory that returns a ChartRenderer.
 *
 * Colors are taken verbatim from the prototype `app-design/project/chart.jsx:285–311`
 * to guarantee pixel-identical chart visuals:
 *   - MA20 (amber):   oklch(0.85 0.14 80)   line width 1.2
 *   - MA50 (indigo):  oklch(0.78 0.14 280)  line width 1.2
 *   - Bollinger band: rgba(180,200,230,0.35) line width 1
 *   - Bollinger fill: rgba(180,200,230,0.05) (faint region between bands)
 *   - Custom series:  oklch(0.82 0.14 215)  line width 1.6 (cyan-ish)
 *
 * These intentionally do NOT use the global --warn / --violet tokens because
 * those tokens differ slightly in chroma (0.16 / 0.18) from the chart palette
 * (0.14). The chart palette ships verbatim from the prototype.
 */

import { sma, bollinger, fmtPrice } from '../engine/indicators';
import { DOT_RADIUS_PX } from './hitRegions';
import { drawValueChip } from './glyphs';
import type { ChartRenderer, RenderContext, ChartLayout } from './types';

// Verbatim from app-design/project/chart.jsx:285–311.
// Color constants are exported so IndicatorPanel + LegendHUD swatches stay in
// lock-step with the renderer (the source of truth for chart line colors).
export const MA20_COLOR = 'oklch(0.85 0.14 80)';
export const MA50_COLOR = 'oklch(0.78 0.14 280)';
const MA_LINE_WIDTH = 1.2;
const BB_BAND_COLOR = 'rgba(180,200,230,0.35)';
const BB_FILL_COLOR = 'rgba(180,200,230,0.05)';
/** Bollinger swatch/dot color — the band hue at higher alpha so the tiny
 *  panel/legend dot stays legible (the 0.35-alpha band reads too faint at 8px). */
export const BB_SWATCH_COLOR = 'rgba(180,200,230,0.6)';
export const CUSTOM_SERIES_COLOR = 'oklch(0.82 0.14 215)';
const CUSTOM_SERIES_LINE_WIDTH = 1.6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function drawSeries(
  ctx: CanvasRenderingContext2D,
  series: (number | null)[],
  sIdx: number,
  eIdx: number,
  xToPx: (i: number) => number,
  yToPx: (p: number) => number,
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let started = false;
  for (let i = sIdx; i < eIdx; i++) {
    const v = series[i];
    if (v === null || v === undefined || !isFinite(v)) { started = false; continue; }
    const x = xToPx(i + 0.5);
    const y = yToPx(v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * Draw a right-end value chip (price-formatted) — a thin wrapper over the shared
 * `drawValueChip` primitive in glyphs.ts (the chip vocabulary is shared with the
 * GenericResearchLayer hline label chip and the y-axis last-price label).
 */
function drawRightEndChip(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  bgInk: string,
  y: number,
  value: number,
  color: string,
): void {
  drawValueChip(ctx, layout, y, fmtPrice(value), color, bgInk);
}

/**
 * Push an `indicatorLast` hotspot at the last finite point of a (possibly
 * series-offset) bar-aligned series and draw a right-end value chip for it. The
 * series value for bar `i` is `series[i - seriesStart]`; pass `seriesStart = 0`
 * for plain bar-aligned series (MA / Bollinger). No-op when the series has no
 * finite point in-window. `rc` carries the theme bg ink used by the chip.
 */
function pushIndicatorLast(
  rc: RenderContext,
  series: (number | null)[],
  sIdx: number,
  eIdx: number,
  xToPx: (i: number) => number,
  yToPx: (p: number) => number,
  label: string,
  color: string,
  seriesStart = 0,
): void {
  for (let i = eIdx - 1; i >= sIdx; i--) {
    const si = i - seriesStart;
    if (si < 0 || si >= series.length) continue;
    const v = series[si];
    if (v === null || v === undefined || !isFinite(v)) continue;
    const y = yToPx(v);
    drawRightEndChip(rc.ctx, rc.layout, rc.theme.bg, y, v, color);
    rc.hitRegions?.push({
      x: xToPx(i + 0.5),
      y,
      r: DOT_RADIUS_PX,
      kind: 'indicatorLast',
      payload: { label, value: v, color, barIdx: i },
    });
    return;
  }
}

function makeHelpers(rc: RenderContext) {
  const { view, layout } = rc;
  const { start, end, yMin, yMax } = view;
  const { x: padL, y: padT, w: plotW, h: plotH } = layout;
  const range = yMax - yMin;
  const span = end - start;
  const xToPx = (i: number) => padL + ((i - start) / span) * plotW;
  const yToPx = (p: number) => padT + (1 - (p - yMin) / range) * plotH;
  const sIdx = Math.max(0, Math.floor(start));
  const eIdx = Math.min(rc.bars.length, Math.ceil(end) + 1);
  return { xToPx, yToPx, sIdx, eIdx, padT, plotH };
}

// ---------------------------------------------------------------------------
// MA overlay factory
// ---------------------------------------------------------------------------

/**
 * Returns a ChartRenderer that draws a simple moving average line.
 *
 * @param period  Lookback window — 20 for fast (amber), 50 for slow (violet)
 * @param color   CSS color string — defaults to MA20 amber
 */
export function maOverlay(
  period: number,
  color: string = MA20_COLOR,
): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      const { bars, ctx } = rc;
      if (!bars.length) return;
      const closes = bars.map((b) => b.c);
      const series = sma(closes, period);
      const { xToPx, yToPx, sIdx, eIdx } = makeHelpers(rc);
      drawSeries(ctx, series, sIdx, eIdx, xToPx, yToPx, color, MA_LINE_WIDTH);
      pushIndicatorLast(rc, series, sIdx, eIdx, xToPx, yToPx, `MA${period}`, color);
    },
  };
}

/** Pre-built MA20 overlay (amber). */
export const ma20Overlay: ChartRenderer = maOverlay(20, MA20_COLOR);

/** Pre-built MA50 overlay (violet/indigo). */
export const ma50Overlay: ChartRenderer = maOverlay(50, MA50_COLOR);

// ---------------------------------------------------------------------------
// Bollinger Band overlay factory
// ---------------------------------------------------------------------------

/**
 * Returns a ChartRenderer that draws Bollinger Bands:
 *   - Upper band line
 *   - Lower band line
 *   - Faint filled region between bands (alpha ~0.05)
 *
 * @param period  SMA lookback (default 20)
 * @param k       Std-dev multiplier (default 2)
 */
export function bollingerOverlay(period = 20, k = 2): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      const { bars, ctx } = rc;
      if (!bars.length) return;

      const closes = bars.map((b) => b.c);
      const { upper, lower } = bollinger(closes, period, k);
      const { xToPx, yToPx, sIdx, eIdx } = makeHelpers(rc);

      // Upper and lower lines
      drawSeries(ctx, upper, sIdx, eIdx, xToPx, yToPx, BB_BAND_COLOR, 1);
      drawSeries(ctx, lower, sIdx, eIdx, xToPx, yToPx, BB_BAND_COLOR, 1);

      // Faint fill between bands (upper forward then lower backward)
      ctx.fillStyle = BB_FILL_COLOR;
      ctx.beginPath();
      let started = false;
      for (let i = sIdx; i < eIdx; i++) {
        const u = upper[i];
        if (u === null || u === undefined || !isFinite(u)) continue;
        const x = xToPx(i + 0.5);
        const y = yToPx(u);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      for (let i = eIdx - 1; i >= sIdx; i--) {
        const l = lower[i];
        if (l === null || l === undefined || !isFinite(l)) continue;
        const x = xToPx(i + 0.5);
        const y = yToPx(l);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    },
  };
}

/** Pre-built default Bollinger overlay (period 20, k 2). */
export const defaultBollingerOverlay: ChartRenderer = bollingerOverlay(20, 2);

// ---------------------------------------------------------------------------
// Custom series overlay factory
// ---------------------------------------------------------------------------

/**
 * Returns a ChartRenderer that draws a user-pasted numeric series as a thin
 * polyline, right-aligned to the last visible bar.
 *
 * Rendering notes:
 *   - Values are mapped onto the chart's current yMin/yMax.
 *   - Series shorter/longer than the visible window are clipped / right-padded.
 *   - If the series is empty or all values are NaN the renderer is a no-op.
 *   - Color/width: verbatim from prototype chart.jsx:311 — solid (no dash).
 */
export function customSeriesOverlay(values: number[]): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      const { ctx } = rc;
      if (!values.length) return;

      const { xToPx, yToPx, sIdx, eIdx } = makeHelpers(rc);
      const visibleCount = eIdx - sIdx;
      if (visibleCount <= 0) return;

      // Right-align: the last value maps to the last visible bar.
      // Build a per-bar lookup: bar global index → series value.
      const len = values.length;
      const seriesStart = eIdx - len; // may be < sIdx (series longer than window)

      ctx.strokeStyle = CUSTOM_SERIES_COLOR;
      ctx.lineWidth = CUSTOM_SERIES_LINE_WIDTH;
      ctx.beginPath();
      let started = false;

      for (let i = sIdx; i < eIdx; i++) {
        // Which series index maps to bar i?
        const si = i - seriesStart;
        if (si < 0 || si >= len) continue;
        const v = values[si];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = xToPx(i + 0.5);
        const y = yToPx(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }

      ctx.stroke();

      // Hotspot + right-end chip: last finite point of the custom series.
      pushIndicatorLast(rc, values, sIdx, eIdx, xToPx, yToPx, 'Custom series', CUSTOM_SERIES_COLOR, seriesStart);
    },
  };
}

// ---------------------------------------------------------------------------
// AI overlay glow pass (P6 W4-B)
// ---------------------------------------------------------------------------

/**
 * Render an AI-computed dataset as a glowing polyline on top of the base
 * chart. Same series shape as `customSeriesOverlay` but layered with a soft
 * outer-glow stroke (using `shadowBlur`) so it reads as the "AI" surface.
 *
 * Behavior:
 *   - Color is supplied by the caller (palette mapping in `useDatasetStore`).
 *   - Length-mismatch with the visible bars window is **silently clamped** to
 *     the visible-bars range (right-aligned). No warning, per spec.
 *   - Empty / all-NaN series is a no-op (won't crash the chart).
 *   - Survives chart-type morph because it's a separate ChartRenderer pass —
 *     the morph only swaps the base renderer; overlay list is preserved.
 */
export function aiOverlayGlow(values: number[], color: string): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      const { ctx } = rc;
      if (!values.length) return;

      const { xToPx, yToPx, sIdx, eIdx } = makeHelpers(rc);
      const visibleCount = eIdx - sIdx;
      if (visibleCount <= 0) return;

      // Right-align: the last value maps to the last visible bar (silent clamp).
      const len = values.length;
      const seriesStart = eIdx - len;

      // Two-pass: outer glow first (wide, low-alpha), then crisp line on top.
      // Save/restore so we don't leak shadow state into other overlays.
      ctx.save();

      // Glow pass.
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      let started = false;
      for (let i = sIdx; i < eIdx; i++) {
        const si = i - seriesStart;
        if (si < 0 || si >= len) continue;
        const v = values[si];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = xToPx(i + 0.5);
        const y = yToPx(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Crisp top line — no shadow, full alpha.
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      started = false;
      for (let i = sIdx; i < eIdx; i++) {
        const si = i - seriesStart;
        if (si < 0 || si >= len) continue;
        const v = values[si];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = xToPx(i + 0.5);
        const y = yToPx(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.restore();

      // Hotspot + right-end chip: last finite point of the AI dataset overlay.
      pushIndicatorLast(rc, values, sIdx, eIdx, xToPx, yToPx, 'AI overlay', color, seriesStart);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build the active overlays array from toggle flags
// ---------------------------------------------------------------------------

export interface OverlayFlags {
  ma20: boolean;
  ma50: boolean;
  bollinger: boolean;
}

/**
 * Returns the array of ChartRenderer to pass to ChartCanvas.overlays,
 * based on toggle flags. Pure function — no memoization here; caller does that.
 *
 * @param flags           MA / Bollinger toggle flags.
 * @param customSeries    Optional user-pasted series (pass when enabled).
 * @param ai              Optional AI overlay (P6 W4-B): values + token color.
 */
export function buildOverlays(
  flags: OverlayFlags,
  customSeries?: number[],
  ai?: { values: number[]; color: string },
): ChartRenderer[] {
  const out: ChartRenderer[] = [];
  if (flags.ma20) out.push(ma20Overlay);
  if (flags.ma50) out.push(ma50Overlay);
  if (flags.bollinger) out.push(defaultBollingerOverlay);
  if (customSeries && customSeries.length > 0) {
    out.push(customSeriesOverlay(customSeries));
  }
  // AI overlay last so its glow renders on top of every other indicator.
  if (ai && ai.values.length > 0) {
    out.push(aiOverlayGlow(ai.values, ai.color));
  }
  return out;
}
