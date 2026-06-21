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
export type TimelineGlyphKind = 'pin' | 'vline' | 'range' | 'notch';

/** Notch tab dimensions (px). */
export const NOTCH_W = 10;
export const NOTCH_H = 10;
export const NOTCH_R = 2;
/** Count-badge dimensions (px). */
const BADGE_SIZE = 10;
const BADGE_FONT = '8px "Geist Mono", ui-monospace, monospace';

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
 * Draw a pin / vline / range / notch glyph at the resolved geometry, in `color`,
 * with an optional `label`. The caller has already set `ctx.font` (callers that
 * want the shared label font use `GLYPH_LABEL_FONT`). Geometry is byte-identical
 * to the original inline timeline draw so visuals are unchanged.
 *
 * Returns the hit-region anchor the caller should register (the substrate is
 * caller-owned so each caller attaches its own payload + kind):
 *   - pin    → `{ x, y, r }` (circle)
 *   - vline  → `{ x, y, x2, y2 }` (±4px vertical band)
 *   - range  → `{ x, y, x2, y2 }` (full shaded-band span)
 *   - notch  → `{ x, y, x2, y2 }` (tab bounding box on the BOTTOM spine)
 *
 * **notch-specific params** (only consulted when `kind === 'notch'`):
 * @param active    — true → accent fill + 1px crisp ring (flat, no glow)
 * @param count     — N > 1 → show a small badge in the notch corner
 * @param activeColor — resolved accent color string (e.g. `--accent` resolved)
 * @param badgeBg   — resolved badge background color string
 * @param badgeInk  — resolved badge text color string
 */
export function drawTimelineGlyph(
  ctx: CanvasRenderingContext2D,
  kind: TimelineGlyphKind,
  geom: TimelineGlyphGeom,
  color: string,
  label?: string,
  active?: boolean,
  count?: number,
  activeColor?: string,
  badgeBg?: string,
  badgeInk?: string,
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

  // notch — small tab riding the dispatch spine just ABOVE the time axis at the
  // BOTTOM edge of the pane (TradingView news-flag convention: events live near
  // the time axis where users scan time, minimizing cursor travel from the price
  // action). The spine sits at plotBottom; the tab rises UPWARD from it.
  if (kind === 'notch') {
    ctx.save();
    const spineY = plotBottom;           // spine sits at the bottom edge of the pane
    const tx = Math.round(cx) - NOTCH_W / 2;
    const ty = spineY - NOTCH_H;         // tab rises upward from the spine line

    const isActive = active === true;
    const fillColor = isActive && activeColor ? activeColor : color;

    // Tab body.
    ctx.fillStyle = fillColor;
    ctx.globalAlpha = isActive ? 0.92 : 0.72;
    roundRect(ctx, tx, ty, NOTCH_W, NOTCH_H, NOTCH_R);
    ctx.fill();

    // Crisp ring for active state — flat, no glow.
    if (isActive && activeColor) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 1;
      roundRect(ctx, tx + 0.5, ty + 0.5, NOTCH_W - 1, NOTCH_H - 1, NOTCH_R);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    // Count badge (N > 1) — small roundRect + text in the top-right corner.
    const n = count ?? 0;
    if (n > 1) {
      const badge = String(Math.min(n, 99));
      const bx = tx + NOTCH_W - BADGE_SIZE / 2;
      const by = ty - BADGE_SIZE / 2;
      ctx.font = BADGE_FONT;
      ctx.fillStyle = badgeBg ?? '#1e2230';
      roundRect(ctx, bx, by, BADGE_SIZE, BADGE_SIZE, BADGE_SIZE / 2);
      ctx.fill();
      ctx.fillStyle = badgeInk ?? '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, bx + BADGE_SIZE / 2, by + BADGE_SIZE / 2);
    }

    ctx.restore();
    return { x: tx, y: ty, x2: tx + NOTCH_W, y2: ty + NOTCH_H };
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

/**
 * Draw the dispatch-spine hairline — a faint 1px horizontal line sitting just
 * inside the BOTTOM edge of the given pane rect, riding above the time axis.
 * Notch glyphs (kind='notch') ride this line (rising upward from it); callers
 * invoke this once per pane before drawing their notches.
 *
 * @param ctx    — 2D canvas context
 * @param paneX  — left edge of the pane (CSS px)
 * @param paneY  — top edge of the pane (CSS px)
 * @param paneW  — width of the pane (CSS px)
 * @param paneH  — height of the pane (CSS px) — spine sits at paneY + paneH
 * @param color  — resolved hairline color string (e.g. resolved `--hairline` /
 *                 `--ink-3` token); callers resolve CSS vars before passing in.
 */
export function drawDispatchSpine(
  ctx: CanvasRenderingContext2D,
  paneX: number,
  paneY: number,
  paneW: number,
  paneH: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  const y = Math.round(paneY + paneH) - 0.5; // crisp sub-pixel snap at the bottom edge
  ctx.beginPath();
  ctx.moveTo(paneX, y);
  ctx.lineTo(paneX + paneW, y);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the faint full-pane-height vertical guide line at an event-cluster's x —
 * the hover affordance that makes the (invisible) full-height click COLUMN
 * discoverable. Low-alpha so it reads as a hint, not chrome. Drawn by the layer
 * for the currently-hovered cluster only. No animation (reduced-motion safe — a
 * static line appearing is fine).
 *
 * @param ctx    — 2D canvas context
 * @param cx     — event x (CSS px); snapped to a crisp sub-pixel column
 * @param paneY  — top edge of the pane (CSS px)
 * @param paneH  — height of the pane (CSS px)
 * @param color  — resolved accent/hairline color string (canvas can't read vars)
 */
export function drawHoverGuideLine(
  ctx: CanvasRenderingContext2D,
  cx: number,
  paneY: number,
  paneH: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  const x = Math.round(cx) + 0.5;
  ctx.beginPath();
  ctx.moveTo(x, paneY);
  ctx.lineTo(x, paneY + paneH);
  ctx.stroke();
  ctx.restore();
}
