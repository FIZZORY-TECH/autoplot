/**
 * src/chart/trends.ts — Trend-line renderer + hit-test.
 *
 * Mirrors `src/chart/marks.ts` in shape: a trend list projects to canvas
 * coordinates via the same view + layout math the base renderers use, then
 * draws each as a 2px line segment in the trend's color token. The selected
 * trend gets a soft glow halo (shadowColor + shadowBlur) so the user can
 * tell which trend Backspace will delete.
 *
 * The trend tool's *in-progress* draft (mid-drag) is rendered the same way
 * but with a slightly higher alpha and a dashed pattern, so the user can
 * see what they're drawing before mouseup.
 *
 * Hit-test: `findTrendAt(trends, dataX, dataY, threshold)` returns the trend
 * whose segment is within `threshold` data-space distance of the click point.
 * Distance is computed in *data space* (bar-index, price) — callers compute
 * threshold from a px-per-bar / px-per-price ratio so a click feels right
 * regardless of zoom.
 */

import type { TrendRow } from '../lib/db';
import { barIdxToPx, priceToPx, tsToBarIdx } from './projection';
import { distToSegment } from './hitRegions';
import type { ChartRenderer, RenderContext } from './types';

/** Resolve a trend's color token. 'accent' is the special default → var(--accent). */
function resolveColor(token: string): string {
  if (token === 'accent') return 'var(--accent, #7CC9F0)';
  return token;
}

export interface TrendsRendererArgs {
  trends: TrendRow[];
  /** Optional in-progress draft — drawn dashed on top of the persisted trends. */
  draft?: { x1_ts: number; y1_price: number; x2_ts: number; y2_price: number } | null;
  /** Id of the currently-selected trend. Selected trends get a halo + thicker line. */
  selectedId?: string | null;
}

/**
 * Build a `ChartRenderer` that draws the supplied trends.
 *
 * Trends + draft + selection are bundled into a single renderer so callers
 * pass one renderer to ChartCanvas (matching the marks pattern).
 */
export function createTrendsRenderer(args: TrendsRendererArgs): ChartRenderer {
  return {
    render(rc: RenderContext) {
      const { ctx, bars, view, layout } = rc;
      if (!bars.length) return;

      // Clip to plot area so segments near the edges don't draw over axes.
      ctx.save();
      ctx.beginPath();
      ctx.rect(layout.x, layout.y, layout.w, layout.h);
      ctx.clip();

      // Persisted trends.
      for (const t of args.trends) {
        const x1Idx = tsToBarIdx(t.x1_ts, bars);
        const x2Idx = tsToBarIdx(t.x2_ts, bars);
        const px1 = barIdxToPx(x1Idx, view, layout);
        const py1 = priceToPx(t.y1_price, view, layout);
        const px2 = barIdxToPx(x2Idx, view, layout);
        const py2 = priceToPx(t.y2_price, view, layout);

        // Push hotspot region (segment) for the shared overlay registry.
        rc.hitRegions?.push({
          x: px1,
          y: py1,
          x2: px2,
          y2: py2,
          kind: 'trend',
          payload: t,
        });

        const isSelected = args.selectedId === t.id;
        const stroke = resolveColor(t.color);

        ctx.save();
        if (isSelected) {
          // Soft glow halo for the selected trend.
          ctx.shadowColor = stroke;
          ctx.shadowBlur = 8;
          ctx.lineWidth = 2.5;
        } else {
          ctx.lineWidth = 2;
        }
        ctx.strokeStyle = stroke;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
        ctx.restore();

        // Endpoint dots — subtle, only on selection (avoids visual noise).
        if (isSelected) {
          ctx.save();
          ctx.fillStyle = stroke;
          for (const [x, y] of [[px1, py1], [px2, py2]] as const) {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }

      // In-progress draft — dashed, on top.
      if (args.draft) {
        const d = args.draft;
        const x1Idx = tsToBarIdx(d.x1_ts, bars);
        const x2Idx = tsToBarIdx(d.x2_ts, bars);
        const px1 = barIdxToPx(x1Idx, view, layout);
        const py1 = priceToPx(d.y1_price, view, layout);
        const px2 = barIdxToPx(x2Idx, view, layout);
        const py2 = priceToPx(d.y2_price, view, layout);
        ctx.save();
        ctx.strokeStyle = resolveColor('accent');
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore(); // end clip
    },
  };
}

// ---------------------------------------------------------------------------
// Hit-test
// ---------------------------------------------------------------------------

// Segment-distance math lives in the shared hit-test substrate (`hitRegions`)
// so trends + the overlay registry agree byte-for-byte. Imported above.

/**
 * Find the closest trend whose segment is within `thresholdPx` pixels of the
 * click point (cx, cy in canvas px). Returns null if nothing is near enough.
 *
 * Hit-testing is done in pixel space (not data space) so the clickable
 * "tolerance band" stays a constant visual size regardless of zoom — this is
 * what users intuit from other tools (Photoshop, Figma).
 */
export function findTrendAt(
  trends: TrendRow[],
  bars: { ts: number }[],
  view: RenderContext['view'],
  layout: RenderContext['layout'],
  cx: number,
  cy: number,
  thresholdPx = 8,
): TrendRow | null {
  if (!trends.length || !bars.length) return null;
  let best: { trend: TrendRow; dist: number } | null = null;
  for (const t of trends) {
    const x1Idx = tsToBarIdx(t.x1_ts, bars);
    const x2Idx = tsToBarIdx(t.x2_ts, bars);
    const px1 = barIdxToPx(x1Idx, view, layout);
    const py1 = priceToPx(t.y1_price, view, layout);
    const px2 = barIdxToPx(x2Idx, view, layout);
    const py2 = priceToPx(t.y2_price, view, layout);
    const d = distToSegment(cx, cy, px1, py1, px2, py2);
    if (d <= thresholdPx && (!best || d < best.dist)) {
      best = { trend: t, dist: d };
    }
  }
  return best ? best.trend : null;
}

export const __test__ = {
  distToSegment,
};
