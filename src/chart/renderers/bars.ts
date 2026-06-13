/**
 * src/chart/renderers/bars.ts — OHLC bar renderer.
 *
 * Verbatim port of chart.jsx bars branch:
 *   - Vertical line high→low (1.4px stroke)
 *   - Left tick for open
 *   - Right tick for close
 * Color: up/down from theme.
 */
import type { ChartRenderer, RenderContext } from '../types';

export const barsRenderer: ChartRenderer = {
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
    // Tick length: half the candle-body width (same slot fraction as candles)
    const cw = (plotW / span) * 0.72;

    const xToPx = (i: number) => padL + ((i - start) / span) * plotW;
    const yToPx = (p: number) => padT + (1 - (p - yMin) / range) * plotH;

    ctx.lineWidth = 1.4;

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

      // Vertical wick
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, hy);
      ctx.lineTo(Math.round(x) + 0.5, ly);
      ctx.stroke();

      // Left tick (open)
      ctx.beginPath();
      ctx.moveTo(x - cw / 2, oy);
      ctx.lineTo(x, oy);
      ctx.stroke();

      // Right tick (close)
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x + cw / 2, cy);
      ctx.stroke();
    }
  },
};
