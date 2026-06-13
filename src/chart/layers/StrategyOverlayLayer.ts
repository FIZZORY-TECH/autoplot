/**
 * src/chart/layers/StrategyOverlayLayer.ts — Step 11b
 *
 * Canvas2D renderer for the `strategyOverlays` slice from `useChartMutationStore`.
 * Follows the same `ChartRenderer` pattern as `signals.ts`.
 *
 * Each `StrategyOverlay` carries a `bodyJson` string (the raw Strategy DSL from
 * the DB). We parse the JSON to extract `signals` if present. The Strategy schema
 * (src/ai/schemas.ts) may include a `signals` array — if not present the overlay
 * is a no-op (strategy has no backtest results yet).
 *
 * Signal rendering follows the `signals.ts` convention exactly:
 *   - `side: 'long'`  → triangle-up (green) below bar low (entry)
 *   - `side: 'short'` → triangle-down (red) above bar high (entry)
 *   - exits           → inferred via ts ordering (next signal of opposite side)
 *                       or left hollow if no matching exit in data.
 *
 * Since `strategyOverlays[].signals` carry `{ ts, side, price? }` (from the
 * MCP bridge — not from the backtest engine which uses bar indices), we map
 * ts → nearest bar index via binary search (same helper as TimelineEventsLayer).
 *
 * Public surface:
 *   - `renderStrategyOverlays(ctx, rc, overlays)` — used by unit tests.
 *   - `strategyOverlaysRenderer(getOverlays)` — `ChartRenderer` factory.
 */

import type { Bar } from '../../data/MarketDataProvider';
import type { StrategyOverlay } from '../../stores/useChartMutationStore';
import type { ChartRenderer, ChartLayout, RenderContext, ViewWindow } from '../types';
import { SIGNAL_GREEN, SIGNAL_RED, TRIANGLE_PX } from '../signals';
import { DOT_RADIUS_PX } from '../hitRegions';

const TRIANGLE_OFFSET_PX = 6;

// ---------------------------------------------------------------------------
// Signal shape from bodyJson
// ---------------------------------------------------------------------------

interface StrategySignal {
  ts: number;
  side: 'long' | 'short';
  price?: number;
}

function parseSignals(bodyJson: string): StrategySignal[] {
  try {
    const parsed: unknown = JSON.parse(bodyJson);
    if (!parsed || typeof parsed !== 'object') return [];
    const p = parsed as Record<string, unknown>;
    if (!Array.isArray(p['signals'])) return [];
    return (p['signals'] as unknown[]).filter(
      (s): s is StrategySignal =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Record<string, unknown>)['ts'] === 'number' &&
        typeof (s as Record<string, unknown>)['side'] === 'string',
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers (shared with signals.ts pattern)
// ---------------------------------------------------------------------------

function nearestBarIndex(bars: Bar[], ts: number): number {
  if (!bars.length) return 0;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const bar = bars[mid];
    if (!bar) break;
    if (bar.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const prev = bars[lo - 1];
    const curr = bars[lo];
    if (prev && curr && Math.abs(prev.ts - ts) < Math.abs(curr.ts - ts)) {
      return lo - 1;
    }
  }
  return lo;
}

function buildHelpers(view: ViewWindow, layout: ChartLayout) {
  const { start, end, yMin, yMax } = view;
  const span = Math.max(1e-9, end - start);
  const range = Math.max(1e-9, yMax - yMin);
  const xToPx = (i: number) => layout.x + ((i - start) / span) * layout.w;
  const yToPx = (p: number) => layout.y + (1 - (p - yMin) / range) * layout.h;
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
  ctx.beginPath();
  ctx.moveTo(cx, cy + half);
  ctx.lineTo(cx + half, cy - half);
  ctx.lineTo(cx - half, cy - half);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

// ---------------------------------------------------------------------------
// Core render function
// ---------------------------------------------------------------------------

export function renderStrategyOverlays(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  overlays: Record<string, StrategyOverlay>,
): void {
  const { bars, view, layout } = rc;
  if (!bars.length) return;

  const overlayList = Object.values(overlays);
  if (!overlayList.length) return;

  const { xToPx, yToPx } = buildHelpers(view, layout);
  const size = Math.max(8, Math.min(14, TRIANGLE_PX));

  ctx.save();
  ctx.lineWidth = 1.5;

  for (const overlay of overlayList) {
    const signals = parseSignals(overlay.bodyJson);
    if (!signals.length) continue;

    for (const signal of signals) {
      const barIdx = nearestBarIndex(bars, signal.ts);
      const bar = bars[barIdx];
      if (!bar) continue;

      const cx = xToPx(barIdx + 0.5);
      // Skip signals outside the visible window.
      if (cx < layout.x - 20 || cx > layout.x + layout.w + 20) continue;

      if (signal.side === 'long') {
        // Long entry — green triangle up, below bar low
        const cy = yToPx(bar.l) + TRIANGLE_OFFSET_PX + size / 2;
        ctx.fillStyle = SIGNAL_GREEN;
        ctx.strokeStyle = SIGNAL_GREEN;
        drawUpTriangle(ctx, cx, cy, size, true);
        rc.hitRegions?.push({
          x: cx,
          y: cy,
          r: DOT_RADIUS_PX,
          kind: 'strategySignal',
          payload: { signal, overlay },
        });
      } else if (signal.side === 'short') {
        // Short entry — red triangle down, above bar high
        const cy = yToPx(bar.h) - TRIANGLE_OFFSET_PX - size / 2;
        ctx.fillStyle = SIGNAL_RED;
        ctx.strokeStyle = SIGNAL_RED;
        drawDownTriangle(ctx, cx, cy, size, true);
        rc.hitRegions?.push({
          x: cx,
          y: cy,
          r: DOT_RADIUS_PX,
          kind: 'strategySignal',
          payload: { signal, overlay },
        });
      }
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// ChartRenderer factory
// ---------------------------------------------------------------------------

export function strategyOverlaysRenderer(
  getOverlays: () => Record<string, StrategyOverlay>,
): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      renderStrategyOverlays(rc.ctx, rc, getOverlays());
    },
  };
}
