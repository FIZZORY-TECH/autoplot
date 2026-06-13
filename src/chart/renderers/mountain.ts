/**
 * src/chart/renderers/mountain.ts — Dotted-column / pulse renderer.
 *
 * Verbatim port of chart.jsx mountain branch.
 * Each bar draws a 2px-wide filled column from the close price down to
 * the bottom of the plot. Color is green-ish (up day) or red-ish (down day)
 * at 0.7 opacity — matches prototype rgba values.
 */
import type { ChartRenderer, RenderContext } from '../types';

const UP_COLOR   = 'rgba(120, 220, 170, 0.7)';
const DOWN_COLOR = 'rgba(240, 130, 110, 0.7)';

export const mountainRenderer: ChartRenderer = {
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

    const bottom = padT + plotH;

    for (let i = sIdx; i < eIdx; i++) {
      const b = bars[i];
      if (!b) continue;
      const x = xToPx(i + 0.5);
      const cy = yToPx(b.c);
      // "up" = this bar's close >= previous bar's close (or first bar)
      const up = i === 0 ? true : (bars[i - 1] ? b.c >= bars[i - 1].c : true);
      ctx.fillStyle = up ? UP_COLOR : DOWN_COLOR;
      // 2px column from close down to plot bottom (matches `fillRect(x - 1, cy, 2, ...)`)
      ctx.fillRect(x - 1, cy, 2, bottom - cy);
    }
  },
};
