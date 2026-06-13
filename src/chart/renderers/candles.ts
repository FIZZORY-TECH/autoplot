/**
 * src/chart/renderers/candles.ts — Candlestick renderer.
 *
 * Verbatim port of chart.jsx candles branch.
 * Wick: 1px DPR-corrected. Body: filled rect with up/down color.
 * Opacity: the prototype renders candles fully opaque (no globalAlpha change).
 */
import type { ChartRenderer, RenderContext } from '../types';

export const candlesRenderer: ChartRenderer = {
  render(rc: RenderContext): void {
    const { ctx, bars, view, theme, layout } = rc;
    if (!bars.length) return;

    const { start, end, yMin, yMax } = view;
    const { x: padL, y: padT, w: plotW, h: plotH } = layout;
    const range = yMax - yMin;
    if (range <= 0) return;

    const sIdx = Math.max(0, Math.floor(start));
    const eIdx = Math.min(bars.length, Math.ceil(end) + 1);
    const span = end - start;
    // Bar width: 72% of the slot width — matches prototype `cw`
    const cw = (plotW / span) * 0.72;

    const xToPx = (i: number) => padL + ((i - start) / span) * plotW;
    const yToPx = (p: number) => padT + (1 - (p - yMin) / range) * plotH;

    for (let i = sIdx; i < eIdx; i++) {
      const b = bars[i];
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

      // Wick — crisp vertical line through the center of the bar slot.
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, hy);
      ctx.lineTo(Math.round(x) + 0.5, ly);
      ctx.stroke();

      // Body — filled rect; minimum 1px height so doji bars are visible.
      const bodyTop = Math.min(oy, cy);
      const bodyH = Math.max(1, Math.abs(cy - oy));
      ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
    }
  },
};
