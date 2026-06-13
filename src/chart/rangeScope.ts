/**
 * src/chart/rangeScope.ts — Range Scope renderer (P2.6).
 *
 * Implements ChartRenderer (src/chart/types.ts).
 * Renders a glass selection band spanning the full plot height between
 * two bar indices' x-coords.
 *
 * Visual spec (P2-19, chart.jsx `range-sel` + `range-stats`):
 *   - Vertical band: subtle glass tint over plot area
 *   - Two vertical hairline edges at band start / end
 *   - Renders nothing when range is null
 */

import type { ChartRenderer, RenderContext } from './types';

/** Glass tint for the selection band — blue-cool, very transparent. */
const BAND_FILL = 'rgba(120, 200, 255, 0.06)';

/** Hairline stroke at each edge — matches the prototype's 1px rule. */
const EDGE_STROKE = 'rgba(120, 200, 255, 0.30)';

/**
 * Create a RangeScopeRenderer.
 *
 * Pass the result to ChartCanvas via the `overlays` array.
 *
 * @param getRange  A live getter — called every frame so the renderer always
 *                  reflects the latest rangeScope state without being recreated.
 */
export function createRangeScopeRenderer(
  getRange: () => { start: number; end: number } | null,
): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      const range = getRange();
      if (!range) return;

      const { ctx, bars, view, layout } = rc;
      if (!bars.length) return;

      const { start, end } = range;
      if (start >= end || start < 0 || end > bars.length) return;

      // Convert bar indices to x pixel coords.
      const span = view.end - view.start;
      if (span <= 0) return;

      function barToPx(barIdx: number): number {
        return layout.x + ((barIdx - view.start) / span) * layout.w;
      }

      const x1 = barToPx(start);
      const x2 = barToPx(end);
      const bandLeft = Math.min(x1, x2);
      const bandRight = Math.max(x1, x2);

      // Clamp to plot area
      const plotLeft = layout.x;
      const plotRight = layout.x + layout.w;
      const visLeft = Math.max(bandLeft, plotLeft);
      const visRight = Math.min(bandRight, plotRight);
      if (visRight <= visLeft) return;

      const top = layout.y;
      const height = layout.h;

      ctx.save();

      // Glass tint fill
      ctx.fillStyle = BAND_FILL;
      ctx.fillRect(visLeft, top, visRight - visLeft, height);

      // Hotspot regions for the two edges (thin vertical bands, ±4px each).
      if (rc.hitRegions) {
        if (bandLeft >= plotLeft && bandLeft <= plotRight) {
          rc.hitRegions.push({
            x: bandLeft - 4,
            y: top,
            x2: bandLeft + 4,
            y2: top + height,
            kind: 'rangeEdge',
            payload: { edge: 'start', range },
          });
        }
        if (bandRight >= plotLeft && bandRight <= plotRight) {
          rc.hitRegions.push({
            x: bandRight - 4,
            y: top,
            x2: bandRight + 4,
            y2: top + height,
            kind: 'rangeEdge',
            payload: { edge: 'end', range },
          });
        }
      }

      // Left hairline edge (only if in plot area)
      ctx.strokeStyle = EDGE_STROKE;
      ctx.lineWidth = 1;
      if (bandLeft >= plotLeft && bandLeft <= plotRight) {
        const xCrisp = Math.round(bandLeft) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xCrisp, top);
        ctx.lineTo(xCrisp, top + height);
        ctx.stroke();
      }

      // Right hairline edge (only if in plot area)
      if (bandRight >= plotLeft && bandRight <= plotRight) {
        const xCrisp = Math.round(bandRight) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xCrisp, top);
        ctx.lineTo(xCrisp, top + height);
        ctx.stroke();
      }

      ctx.restore();
    },
  };
}
