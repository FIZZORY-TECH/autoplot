/**
 * src/chart/signals.ts — Wave 5 / W5-C12 (P7 Co-Strategy)
 *
 * Backtest-trade signals overlay. Returns a `ChartRenderer` that draws an
 * entry triangle (upward, green) below each trade's entry-bar low, and an
 * exit triangle (downward, red) above each trade's exit-bar high. A dashed
 * connector line is drawn between the two triangles, colored by trade pnl
 * (green if pnl > 0, red if pnl <= 0).
 *
 * Trades with `openAtEnd: true` get a HOLLOW (outline-only) exit triangle
 * to indicate "still open at end of window".
 *
 * Architectural notes:
 *   - This is a SEPARATE renderer pass; it survives chart-type morph because
 *     ChartCanvas iterates `overlays[]` after the base renderer (see
 *     `ChartCanvas.tsx` line ~623) and the morph only swaps the BASE
 *     renderer. Same pattern as `aiOverlayGlow` (P6 W4-B).
 *   - Triangle pixel size is clamped to [8, 14] regardless of zoom — we
 *     pick a constant 10 px which sits comfortably in that range; the
 *     min/max sizing is preserved here as a clamp() in case future bar
 *     widths change the visual emphasis.
 *   - We use existing chart palette tokens — green = oklch(0.82 0.18 150)
 *     (matches `.strat-node.entry .sn-badge`), red = oklch(0.78 0.20 25)
 *     (matches `.strat-node.exit .sn-badge`). No new colors introduced.
 *
 * Public surface:
 *   - `renderSignals(ctx, viewport, trades, bars)` — direct render helper
 *     used by the unit test (stub canvas) and by the renderer factory.
 *   - `signalsOverlay(trades)` — `ChartRenderer` factory consumed by
 *     `buildOverlays` / AppShell.
 */

import type { Bar } from '../data/MarketDataProvider';
import type { Trade } from '../engine/backtest';
import type { HitRegion } from './hitRegions';
import { DOT_RADIUS_PX } from './hitRegions';
import type { ChartLayout, ChartRenderer, RenderContext, ViewWindow } from './types';

export const SIGNAL_GREEN = 'oklch(0.82 0.18 150)';
export const SIGNAL_RED = 'oklch(0.78 0.20 25)';

export const TRIANGLE_PX = 10; // clamped between 8 and 14 by spec
const TRIANGLE_OFFSET_PX = 6;
const DASH = [4, 3];

export interface ChartViewport {
  view: ViewWindow;
  layout: ChartLayout;
}

function buildHelpers(viewport: ChartViewport) {
  const { view, layout } = viewport;
  const { start, end, yMin, yMax } = view;
  const { x: padL, y: padT, w: plotW, h: plotH } = layout;
  const span = end - start;
  const range = yMax - yMin;
  const xToPx = (i: number) => padL + ((i - start) / span) * plotW;
  const yToPx = (p: number) => padT + (1 - (p - yMin) / range) * plotH;
  return { xToPx, yToPx };
}

function drawUpTriangle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  fill: boolean,
): void {
  const half = size / 2;
  // Apex up; base below.
  ctx.beginPath();
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx + half, cy + half);
  ctx.lineTo(cx - half, cy + half);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

function drawDownTriangle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  fill: boolean,
): void {
  const half = size / 2;
  // Apex down; base above.
  ctx.beginPath();
  ctx.moveTo(cx, cy + half);
  ctx.lineTo(cx + half, cy - half);
  ctx.lineTo(cx - half, cy - half);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

/**
 * Render the signals layer directly into the supplied 2D context using the
 * supplied viewport, trades, and bars. Pure side-effect on `ctx` — no return.
 *
 * Gracefully no-ops when `trades` is empty or `bars` is empty.
 */
export function renderSignals(
  ctx: CanvasRenderingContext2D,
  viewport: ChartViewport,
  trades: Trade[],
  bars: Bar[],
  hitRegions?: HitRegion[],
): void {
  if (!trades.length || !bars.length) return;

  const { xToPx, yToPx } = buildHelpers(viewport);
  const size = Math.max(8, Math.min(14, TRIANGLE_PX));

  ctx.save();
  ctx.lineWidth = 1.5;

  for (const t of trades) {
    const entryBar = bars[t.entryBar];
    const exitBar = bars[t.exitBar];
    if (!entryBar || !exitBar) continue;

    const entryX = xToPx(t.entryBar + 0.5);
    const exitX = xToPx(t.exitBar + 0.5);
    const entryY = yToPx(entryBar.l) + TRIANGLE_OFFSET_PX + size / 2;
    const exitY = yToPx(exitBar.h) - TRIANGLE_OFFSET_PX - size / 2;

    // Entry triangle — solid green, apex up, below the entry-bar low.
    ctx.fillStyle = SIGNAL_GREEN;
    ctx.strokeStyle = SIGNAL_GREEN;
    drawUpTriangle(ctx, entryX, entryY, size, true);

    // Exit triangle — red. Hollow if openAtEnd, else solid.
    ctx.fillStyle = SIGNAL_RED;
    ctx.strokeStyle = SIGNAL_RED;
    drawDownTriangle(ctx, exitX, exitY, size, !t.openAtEnd);

    // Hotspots for entry + exit triangles.
    if (hitRegions) {
      hitRegions.push({
        x: entryX,
        y: entryY,
        r: DOT_RADIUS_PX,
        kind: 'signal',
        payload: { trade: t, edge: 'entry' },
      });
      hitRegions.push({
        x: exitX,
        y: exitY,
        r: DOT_RADIUS_PX,
        kind: 'signal',
        payload: { trade: t, edge: 'exit' },
      });
    }

    // Dashed connector — color by pnl sign.
    ctx.strokeStyle = t.pnl > 0 ? SIGNAL_GREEN : SIGNAL_RED;
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.moveTo(entryX, entryY - size / 2);
    ctx.lineTo(exitX, exitY + size / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/**
 * `ChartRenderer` factory — adapter that pulls the bars + viewport out of
 * the standard `RenderContext` and delegates to `renderSignals`.
 */
export function signalsOverlay(trades: Trade[]): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      renderSignals(rc.ctx, { view: rc.view, layout: rc.layout }, trades, rc.bars, rc.hitRegions);
    },
  };
}
