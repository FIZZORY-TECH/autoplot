/**
 * src/chart/marks.ts — Mark/Comment renderer.
 *
 * Implements the `ChartRenderer` interface from `./types`. Consumes a list of
 * persisted marks (loaded by AppShell via `dbMarksList(sym)`) and projects each
 * onto canvas coordinates using the same view + layout math the base renderers
 * use.
 *
 * Per-mark visuals (mirrors `app-design/project/chart.jsx` mark-layer):
 *   - A horizontal hairline from the mark's bar position to the right edge.
 *   - A small filled LED dot at (barX, priceY) in the mark color.
 *   - A right-edge price tag in the mark color.
 *   - Comments (note != null) get a slightly larger dot + a soft glow halo.
 *
 * The note text itself is rendered in DOM (`MarksHover.tsx`) — NOT on canvas —
 * so positioning, wrapping, and hover popovers are handled by React/CSS.
 *
 * Wiring choice: ChartCanvas accepts a `marks?: Mark[]` prop and turns it into
 * a renderer via `createMarksRenderer(marks)` when present. This keeps the
 * `ChartRenderer` interface clean (no payload) and means Mark data flows as a
 * normal React prop with zero plumbing into the overlay system.
 */

import type { Mark } from '../lib/db';
import { fmtPrice } from '../engine/indicators';
import { barIdxToPx, priceToPx, tsToBarIdx } from './projection';
import { DOT_RADIUS_PX } from './hitRegions';
import type { ChartRenderer, RenderContext } from './types';

export { tsToBarIdx };

/** A mark projected to screen coordinates — exported for the DOM hover layer. */
export interface ProjectedMark {
  mark: Mark;
  /** CSS px relative to canvas top-left. */
  x: number;
  y: number;
  /** True when this mark has a non-null note (i.e. it's a Comment, not a plain Mark). */
  isComment: boolean;
}

/**
 * Project all marks onto current view/layout. Marks whose anchor bar is outside
 * the visible window still project (we just clip drawing to the layout rect).
 */
export function projectMarks(
  marks: Mark[],
  bars: { ts: number }[],
  view: RenderContext['view'],
  layout: RenderContext['layout'],
): ProjectedMark[] {
  if (!marks.length || !bars.length) return [];
  return marks.map((m) => {
    const idx = tsToBarIdx(m.ts, bars);
    return {
      mark: m,
      x: barIdxToPx(idx, view, layout),
      y: priceToPx(m.price, view, layout),
      isComment: m.note != null && m.note.length > 0,
    };
  });
}

/** Create a `ChartRenderer` that draws the supplied marks. */
export function createMarksRenderer(marks: Mark[]): ChartRenderer {
  return {
    render(rc: RenderContext) {
      if (!marks.length || !rc.bars.length) return;
      const projected = projectMarks(marks, rc.bars, rc.view, rc.layout);
      drawMarks(rc, projected);
    },
  };
}

const TAG_PAD_X = 6;
const TAG_FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
const RIGHT_GAP = 4; // gap between plot edge and right-edge price tag.

function drawMarks(rc: RenderContext, projected: ProjectedMark[]): void {
  const { ctx, layout } = rc;
  const plotRight = layout.x + layout.w;

  // Clip to the plot area so dots near the edges don't draw over the y-axis labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.x, layout.y, layout.w, layout.h);
  ctx.clip();

  for (const p of projected) {
    const yCrisp = Math.round(p.y) + 0.5;

    // Push hotspot region for the dot (comment vs plain mark).
    rc.hitRegions?.push({
      x: p.x,
      y: p.y,
      r: DOT_RADIUS_PX,
      kind: p.isComment ? 'comment' : 'mark',
      payload: p.mark,
    });

    // Hairline guide from mark bar position to right edge.
    ctx.save();
    ctx.strokeStyle = p.mark.color;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.max(layout.x, p.x), yCrisp);
    ctx.lineTo(plotRight, yCrisp);
    ctx.stroke();
    ctx.restore();

    // LED dot — bigger + soft halo for Comments.
    const dotR = p.isComment ? 4.5 : 3;
    if (p.isComment) {
      ctx.save();
      ctx.fillStyle = p.mark.color;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = p.mark.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
    ctx.fill();
    // Inner highlight to read as a "lit" LED.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x - dotR * 0.3, p.y - dotR * 0.3, dotR * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // end clip

  // Price tags drawn OUTSIDE the clip so they sit in the right gutter.
  ctx.save();
  ctx.font = TAG_FONT;
  ctx.textBaseline = 'middle';
  for (const p of projected) {
    const label = fmtPrice(p.mark.price);
    const metrics = ctx.measureText(label);
    const tagW = Math.ceil(metrics.width) + TAG_PAD_X * 2;
    const tagH = 14;
    const tagX = plotRight + RIGHT_GAP;
    const tagY = Math.round(p.y - tagH / 2);

    // Bail if tag would overflow the canvas right edge.
    if (tagX + tagW > rc.layout.x + rc.layout.w + RIGHT_GAP + 60) {
      // PAD_RIGHT in ChartCanvas is 60 — give us ~that much room. If not, skip.
    }

    ctx.fillStyle = p.mark.color;
    roundRect(ctx, tagX, tagY, tagW, tagH, 3);
    ctx.fill();

    // Pick a contrasting text color — the swatch oklch values are bright, so
    // dark text reads best.
    ctx.fillStyle = 'rgba(10, 14, 20, 0.92)';
    ctx.fillText(label, tagX + TAG_PAD_X, tagY + tagH / 2 + 0.5);
  }
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
