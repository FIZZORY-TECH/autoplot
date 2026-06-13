/**
 * src/chart/renderers/area.ts — Filled area chart renderer.
 *
 * Verbatim port of chart.jsx area branch.
 * Gradient: rgba(140, 200, 230, 0.35) top → rgba(140, 200, 230, 0) bottom.
 * Line: 1.6px `oklch(0.85 0.06 215)`.
 *
 * Note: the prototype tried `color-mix()` in gradient stops but fell back to
 * the rgba literals above (Canvas2D doesn't support color-mix in createLinearGradient).
 * We use the rgba literals directly.
 */
import type { ChartRenderer, RenderContext } from '../types';

const LINE_COLOR = 'oklch(0.85 0.06 215)';

export const areaRenderer: ChartRenderer = {
  render(rc: RenderContext): void {
    const { ctx, bars, view, layout } = rc;
    if (!bars.length) return;

    const { start, end, yMin, yMax } = view;
    const { x: padL, y: padT, w: plotW, h: plotH } = layout;
    const range = yMax - yMin;
    if (range <= 0) return;

    const sIdx = Math.max(0, Math.floor(start));
    const eIdx = Math.min(bars.length, Math.ceil(end) + 1);
    const span = end - start;

    const xToPx = (i: number) => padL + ((i - start) / span) * plotW;
    const yToPx = (p: number) => padT + (1 - (p - yMin) / range) * plotH;

    // Fill gradient — top alpha → bottom transparent.
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(140, 200, 230, 0.35)');
    grad.addColorStop(1, 'rgba(140, 200, 230, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    const xs = xToPx(sIdx + 0.5);
    ctx.moveTo(xs, padT + plotH);
    let lastX = xs;
    for (let i = sIdx; i < eIdx; i++) {
      const b = bars[i];
      if (!b) continue;
      const x = xToPx(i + 0.5);
      const y = yToPx(b.c);
      ctx.lineTo(x, y);
      lastX = x;
    }
    ctx.lineTo(lastX, padT + plotH);
    ctx.closePath();
    ctx.fill();

    // Stroke the top line over the fill.
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let first = true;
    for (let i = sIdx; i < eIdx; i++) {
      const b = bars[i];
      if (!b) continue;
      const x = xToPx(i + 0.5);
      const y = yToPx(b.c);
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};
