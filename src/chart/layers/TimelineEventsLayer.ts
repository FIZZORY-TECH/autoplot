/**
 * src/chart/layers/TimelineEventsLayer.ts — Step 11b
 *
 * Canvas2D renderer for the `timelineLayers` slice from `useChartMutationStore`.
 * Follows the same `ChartRenderer` pattern as `signals.ts` and `overlays.ts`.
 *
 * Kinds:
 *   'pin'   — diamond glyph above the x-axis at event.ts, with label rendered
 *             as a small text tag on hover (we render it always at small size
 *             since canvas has no hover state; consumers may add a DOM layer).
 *   'vline' — thin vertical hairline at event.ts spanning the full plot height.
 *   'range' — full-height shaded band; event.ts is the start; label in center.
 *
 * Color: `event.color` if provided, else the neutral accent token.
 *
 * Axis reuse: uses the same `xToPx` projection as `overlays.ts` / `signals.ts`
 * (derived from `view.start`, `view.end`, `layout.x`, `layout.w`). Does NOT
 * recompute a separate time axis — all positioning is in bar-index space
 * because the canonical chart time axis maps bar-index → pixel.
 *
 * Since events carry `ts` (unix ms) we need to find the nearest bar index.
 * We do a binary search over `bars[].ts` to get the closest idx, then project.
 * This is O(log N) per event — fast enough for the expected event count (<100).
 *
 * Public surface:
 *   - `renderTimelineEvents(ctx, rc)` — direct render helper for unit tests.
 *   - `timelineEventsOverlay(getLayers)` — `ChartRenderer` factory. `getLayers`
 *     is called each frame so the overlay stays reactive without re-creation.
 */

import type { Bar } from '../../data/MarketDataProvider';
import type { TimelineLayer } from '../../stores/useChartMutationStore';
import { DOT_RADIUS_PX } from '../hitRegions';
import { drawTimelineGlyph, GLYPH_LABEL_FONT } from '../glyphs';
import type { ChartRenderer, ChartLayout, RenderContext, ViewWindow } from '../types';

const DEFAULT_EVENT_COLOR = 'oklch(0.82 0.14 215)'; // cyan-ish, matches customSeriesOverlay
const LABEL_FONT = GLYPH_LABEL_FONT;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Binary-search for the bar whose ts is closest to the target ts. */
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
  // Pick the closer of lo and lo-1.
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
  const { start, end } = view;
  const span = Math.max(1e-9, end - start);
  const xToPx = (i: number) => layout.x + ((i - start) / span) * layout.w;
  return { xToPx };
}

// ---------------------------------------------------------------------------
// Core render function
// ---------------------------------------------------------------------------

export function renderTimelineEvents(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  layers: Record<string, TimelineLayer>,
): void {
  const { bars, view, layout } = rc;
  if (!bars.length) return;

  const layerList = Object.values(layers);
  if (!layerList.length) return;

  const { xToPx } = buildHelpers(view, layout);

  ctx.save();
  ctx.font = LABEL_FONT;

  for (const layer of layerList) {
    for (const evt of layer.events) {
      const barIdx = nearestBarIndex(bars, evt.ts);
      const cx = xToPx(barIdx + 0.5);

      // Skip events outside the visible window (with a small buffer).
      if (cx < layout.x - 20 || cx > layout.x + layout.w + 20) continue;

      const color = evt.color ?? DEFAULT_EVENT_COLOR;

      // `range` keeps its fixed 4-bar width (we have only one ts per event).
      const cx2 =
        evt.kind === 'range'
          ? xToPx(Math.min(barIdx + 4, bars.length - 1) + 0.5)
          : undefined;

      const anchor = drawTimelineGlyph(ctx, evt.kind, { cx, cx2, layout }, color, evt.label);

      const kind =
        evt.kind === 'pin'
          ? 'timelinePin'
          : evt.kind === 'vline'
            ? 'timelineVline'
            : 'timelineRange';
      rc.hitRegions?.push({
        ...anchor,
        r: evt.kind === 'pin' ? DOT_RADIUS_PX : anchor.r,
        kind,
        payload: evt,
      });
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// ChartRenderer factory
// ---------------------------------------------------------------------------

/**
 * Create a `ChartRenderer` that renders timeline event layers.
 * `getLayers` is called every frame so the renderer stays reactive without
 * re-creation (same pattern as `createRangeScopeRenderer` in rangeScope.ts).
 */
export function timelineEventsOverlay(
  getLayers: () => Record<string, TimelineLayer>,
): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      renderTimelineEvents(rc.ctx, rc, getLayers());
    },
  };
}
