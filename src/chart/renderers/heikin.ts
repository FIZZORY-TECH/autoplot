/**
 * src/chart/renderers/heikin.ts — Heikin-Ashi renderer.
 *
 * Recomputes the Heikin-Ashi series via toHeikinAshi (from indicators.ts)
 * then renders using the same candle drawing logic as candles.ts.
 * Does NOT duplicate toHeikinAshi — imports from the engine.
 */
import { toHeikinAshi } from '../../engine/indicators';
import type { ChartRenderer, RenderContext } from '../types';

export const heikinRenderer: ChartRenderer = {
  render(rc: RenderContext): void {
    const { ctx, bars, view, theme, layout } = rc;
    if (!bars.length) return;

    // Recompute Heikin-Ashi on the full bar series.
    const haBars = toHeikinAshi(bars);

    const { start, end, yMin, yMax } = view;
    const { x: padL, y: padT, w: plotW, h: plotH } = layout;
    const range = yMax - yMin;
    if (range <= 0) return;

    const sIdx = Math.max(0, Math.floor(start));
    const eIdx = Math.min(haBars.length, Math.ceil(end) + 1);
    const span = end - start;
    const cw = (plotW / span) * 0.72;

    const xToPx = (i: number) => padL + ((i - start) / span) * plotW;
    const yToPx = (p: number) => padT + (1 - (p - yMin) / range) * plotH;

    for (let i = sIdx; i < eIdx; i++) {
      const b = haBars[i];
      if (!b) continue;
      const x = xToPx(i + 0.5);
      const oy = yToPx(b.o);
      const cy = yToPx(b.c);
      const hy = yToPx(b.h);
      const ly = yToPx(b.l);
      const up = b.c >= b.o;
      const color = up ? theme.up : theme.down;

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;

      // Wick
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, hy);
      ctx.lineTo(Math.round(x) + 0.5, ly);
      ctx.stroke();

      // Body
      const bodyTop = Math.min(oy, cy);
      const bodyH = Math.max(1, Math.abs(cy - oy));
      ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
    }
  },
};
