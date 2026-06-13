/**
 * src/chart/renderers/line.ts — Close-price line renderer.
 *
 * Verbatim port of chart.jsx line branch.
 * 1.6px stroke (matches prototype `lineWidth = 1.6`).
 * Color: accent-cyan (`--accent` resolved at theme load time as `oklch(0.85 0.06 215)` in prototype).
 */
import type { ChartRenderer, RenderContext } from '../types';

// Prototype uses a muted blue; we pull from the accent token.
// The prototype literal is `oklch(0.85 0.06 215)` — stored in --accent token.
const LINE_COLOR = 'oklch(0.85 0.06 215)';

export const lineRenderer: ChartRenderer = {
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
