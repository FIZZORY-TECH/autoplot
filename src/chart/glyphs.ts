/**
 * src/chart/glyphs.ts — Shared canvas glyph primitives.
 *
 * Geometry vocabulary extracted so the timeline-events layer
 * (`TimelineEventsLayer.ts`) and the generic research overlay
 * (`GenericResearchLayer.ts` — `event_mark` element) draw the SAME pin / vline /
 * range marks. The timeline layer was the original home of this geometry; it now
 * routes through `drawTimelineGlyph` with ZERO visual change.
 *
 * These primitives draw ONLY — they never push hit regions (callers own that, so
 * each caller can attach its own payload). All coordinates are CSS pixels.
 */

import type { ChartLayout } from './types';

/** Pin diamond half-size (px) — matches the original timeline `PIN_SIZE`. */
export const PIN_SIZE = 7;
/** Dashed vertical-line alpha — matches the original timeline `VLINE_ALPHA`. */
export const VLINE_ALPHA = 0.35;
/** Shaded-range fill alpha — matches the original timeline `RANGE_ALPHA`. */
export const RANGE_ALPHA = 0.1;
/** Glyph label font — matches the original timeline `LABEL_FONT`. */
export const GLYPH_LABEL_FONT = '10px "Geist Mono", ui-monospace, monospace';

/** Kind discriminant shared by timeline events and research `event_mark`. */
export type TimelineGlyphKind = 'pin' | 'vline' | 'range';

/** Resolved pixel geometry for a timeline glyph (computed by the caller). */
export interface TimelineGlyphGeom {
  /** Center / left-edge X (CSS px). */
  cx: number;
  /** Right-edge X (CSS px) — only used by `range`. */
  cx2?: number;
  /** Plot-area layout (for full-height vline / range spans + pin baseline). */
  layout: ChartLayout;
}

/**
 * Trace a diamond path centered at (cx, cy) with the given half-size and FILL it
 * in `color`. Shared by the timeline pin glyph and the research-overlay marker
 * 'diamond' shape so both draw the identical path.
 */
export function drawDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx + size, cy);
  ctx.lineTo(cx, cy + size);
  ctx.lineTo(cx - size, cy);
  ctx.closePath();
  ctx.fill();
}

/**
 * Rounded-rect PATH helper (no fill/stroke — caller decides). Shared canvas
 * primitive used by overlays / marks / research chips and pills.
 */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  hh: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, hh / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + hh, rad);
  ctx.arcTo(x + w, y + hh, x, y + hh, rad);
  ctx.arcTo(x, y + hh, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Draw a small right-edge value chip — a color-filled rounded rect with bg-ink
 * text — vertically centered on `y` and clamped into the plot so it never paints
 * outside the axes. Shared by the overlay right-end chip and the research hline
 * label chip (identical vocabulary: GLYPH_LABEL_FONT, padX 4, chipH 14,
 * alpha .85 fill, bg-ink text). No-op when the point is off-plot.
 *
 * `measureText` may be a stub (test canvas mock) returning undefined — the
 * metrics read is guarded so a chip never crashes the draw frame.
 */
export function drawValueChip(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  y: number,
  text: string,
  color: string,
  bgInk: string,
): void {
  if (y < layout.y - 2 || y > layout.y + layout.h + 2) return;
  ctx.save();
  ctx.font = GLYPH_LABEL_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const padX = 4;
  const tw = ctx.measureText(text)?.width ?? text.length * 6;
  const chipW = tw + padX * 2;
  const chipH = 14;
  const chipX = layout.x + layout.w - chipW;
  // Clamp so the chip stays inside the plot vertically.
  const cy = Math.max(layout.y + chipH / 2, Math.min(layout.y + layout.h - chipH / 2, y));
  const chipY = cy - chipH / 2;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  roundRect(ctx, chipX, chipY, chipW, chipH, 3);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = bgInk; // bg-ink on the colored chip for legibility
  ctx.fillText(text, layout.x + layout.w - padX, cy + 0.5);
  ctx.restore();
}

/**
 * Draw a pin / vline / range glyph at the resolved geometry, in `color`, with an
 * optional `label`. The caller has already set `ctx.font` (callers that want the
 * shared label font use `GLYPH_LABEL_FONT`). Geometry is byte-identical to the
 * original inline timeline draw so visuals are unchanged.
 *
 * Returns the hit-region anchor the caller should register (the substrate is
 * caller-owned so each caller attaches its own payload + kind):
 *   - pin   → `{ x, y, r }` (circle)
 *   - vline → `{ x, y, x2, y2 }` (±4px vertical band)
 *   - range → `{ x, y, x2, y2 }` (full shaded-band span)
 */
export function drawTimelineGlyph(
  ctx: CanvasRenderingContext2D,
  kind: TimelineGlyphKind,
  geom: TimelineGlyphGeom,
  color: string,
  label?: string,
): { x: number; y: number; r?: number; x2?: number; y2?: number } {
  const { cx, layout } = geom;
  const plotTop = layout.y;
  const plotBottom = layout.y + layout.h;

  if (kind === 'pin') {
    const cy = plotBottom - PIN_SIZE - 2;
    drawDiamond(ctx, cx, cy, PIN_SIZE, color);
    if (label) {
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, cx, cy - PIN_SIZE - 2);
    }
    return { x: cx, y: cy };
  }

  if (kind === 'vline') {
    ctx.strokeStyle = color;
    ctx.globalAlpha = VLINE_ALPHA;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, plotTop);
    ctx.lineTo(Math.round(cx) + 0.5, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (label) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, cx, plotTop + 2);
      ctx.globalAlpha = 1;
    }
    return { x: cx - 4, y: plotTop, x2: cx + 4, y2: plotBottom };
  }

  // range — shaded band from cx to cx2 (caller resolves the right edge).
  const x1 = cx;
  const x2 = geom.cx2 ?? cx;
  const bandW = Math.max(2, x2 - x1);

  ctx.fillStyle = color;
  ctx.globalAlpha = RANGE_ALPHA;
  ctx.fillRect(x1, plotTop, bandW, layout.h);
  ctx.globalAlpha = 1;

  // Left-edge line.
  ctx.strokeStyle = color;
  ctx.globalAlpha = VLINE_ALPHA;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, plotTop);
  ctx.lineTo(Math.round(x1) + 0.5, plotBottom);
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (label) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x1 + bandW / 2, plotTop + 4);
    ctx.globalAlpha = 1;
  }
  return { x: x1, y: plotTop, x2: x1 + bandW, y2: plotBottom };
}
