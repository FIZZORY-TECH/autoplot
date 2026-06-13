/**
 * src/chart/layers/GenericResearchLayer.ts — Step 7
 *
 * Canvas2D renderer for the `researchOverlays` slice of `useChartMutationStore`.
 * Renders agent-pushed `ResearchOverlay`s — one overlay bundles up to 50
 * heterogeneous `Element`s. Follows the `ChartRenderer` factory pattern (created
 * once, reads data via a closure each frame — never re-created per frame).
 *
 * Element dispatch (reusing the existing draw vocabulary):
 *   line      → polyline (like customSeriesOverlay); nulls break the line.
 *   band      → filled region (like the Bollinger fill); a null upper OR lower
 *               BREAKS the polygon at that index — never fill-to-zero.
 *   hline     → horizontal rule + a right-edge label chip.
 *   markers   → triangle-up / triangle-down / circle / diamond glyphs.
 *   event_mark→ the SHARED `drawTimelineGlyph` primitive (pin / vline / range).
 *   text      → fillText on a glass background pill.
 *   hotspot   → draws NOTHING; registers a hit region carrying its `panel`.
 *
 * Every element registers `kind:'research'` hit regions whose payload feeds
 * `OverlayInfoPanel.researchPanel` (`{ overlayId, label, value?, ts?, panel? }`).
 *
 * Alignment (`align`), shared with Dataset / overlayExtremes.ts:
 *   'right' — last value maps to the last DATASET bar (`bars.length − 1`), so a
 *             study stays pinned to its bars when the view pans or older bars
 *             prepend. (Distinct from customSeries/aiOverlay, which right-align
 *             to the visible edge by design — see seriesStartFor.)
 *   'index' — values[i] maps to bar i. A length ≠ visible-bar-count mismatch is
 *             non-fatal: render the aligned prefix, warn ONCE + toast ONCE per
 *             overlay id (never throw).
 *
 * Colors are validated against the token palette (D5) via `validateResearchColor`.
 */

import type { Bar } from '../../data/MarketDataProvider';
import type {
  ResearchOverlay,
  LineElement,
  BandElement,
  HLineElement,
  MarkersElement,
  EventMarkElement,
  TextElement,
  HotspotElement,
} from '../../ai/schemas';
import { DOT_RADIUS_PX } from '../hitRegions';
import {
  drawTimelineGlyph,
  drawDiamond,
  drawValueChip,
  roundRect,
  GLYPH_LABEL_FONT,
  type TimelineGlyphKind,
} from '../glyphs';
import { barIdxToPx, priceToPx, tsToBarIdx } from '../projection';
import { validateResearchColor } from '../researchPalette';
import { useToastStore } from '../../stores/useToastStore';
import type { OverlayValueSource } from '../overlayExtremes';
import type { ChartRenderer, ChartLayout, RenderContext, ViewWindow } from '../types';

const MARKER_SIZE = 9;

/**
 * Parsed dash-pattern cache. Element dash strings are immutable after apply, so
 * parse each unique `Element` once instead of re-splitting per frame. Keyed by
 * the element object identity (WeakMap → GC'd with the element).
 */
const _dashCache = new WeakMap<{ dash?: string }, number[]>();

/** Parse + memoize an element's `dash` CSS string into a setLineDash array. */
function parseDash(el: { dash?: string }): number[] {
  let parsed = _dashCache.get(el);
  if (!parsed) {
    parsed = (el.dash ?? '').split(',').map((s) => Number(s.trim()) || 0);
    _dashCache.set(el, parsed);
  }
  return parsed;
}

// One-shot guards (per overlay id) for the align:'index' mismatch path.
const _warnedMismatch = new Set<string>();
const _toastedMismatch = new Set<string>();

/** TEST-ONLY: clear the one-shot mismatch guards. */
export function _resetMismatchGuards(): void {
  _warnedMismatch.clear();
  _toastedMismatch.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Helpers {
  xToPx: (i: number) => number;
  yToPx: (p: number) => number;
  sIdx: number;
  eIdx: number;
  /** Total loaded bar count — the absolute anchor for align:'right'. */
  barCount: number;
}

function makeHelpers(view: ViewWindow, layout: ChartLayout, barCount: number): Helpers {
  const { start, end } = view;
  const xToPx = (i: number): number => barIdxToPx(i, view, layout);
  const yToPx = (p: number): number => priceToPx(p, view, layout);
  const sIdx = Math.max(0, Math.floor(start));
  const eIdx = Math.min(barCount, Math.ceil(end) + 1);
  return { xToPx, yToPx, sIdx, eIdx, barCount };
}

/**
 * Nearest bar index for a timestamp — reuses the shared `tsToBarIdx`
 * (fractional, projection.ts) and rounds to the closest integer bar. Output is
 * equivalent to a nearest-ts binary search for exact-ts inputs (the only case
 * research overlays produce); fractional ts round to the nearer bar.
 */
function nearestBarIndex(bars: Bar[], ts: number): number {
  if (!bars.length) return 0;
  return Math.round(tsToBarIdx(ts, bars));
}

/**
 * Map a value-series index → bar index for the given alignment, returning the
 * seriesStart offset (so bar index = seriesStart + seriesIdx).
 *
 *   'index' — values[i] maps to bar i (anchored to bars[0]); seriesStart = 0.
 *   'right' — the LAST value maps to the LAST DATASET bar (`barCount − 1`),
 *             pinned to absolute data, NOT to the visible right edge. This is
 *             what keeps a research study glued to its bars as the user pans
 *             left or as older bars are prepended (which grows `barCount`, so
 *             the pin tracks the new last bar automatically).
 *
 * NOTE: this differs intentionally from `customSeriesOverlay`/`aiOverlayGlow`
 * in overlays.ts, which right-align to the visible edge (`eIdx − 1`) BY DESIGN —
 * those are tsless user/AI series that hug the current view. A research study
 * must instead stay on the specific bars it was computed over.
 *
 * Exported pure for unit tests.
 */
export function seriesStartFor(
  align: 'right' | 'index',
  len: number,
  barCount: number,
): number {
  return align === 'right' ? barCount - len : 0;
}

/**
 * Extract the y-range value sources a single research overlay contributes, so
 * the per-element-type → OverlayValueSource knowledge (line / band / hline +
 * the align→mode mapping) lives beside the renderer rather than being
 * re-implemented in AppShell's y-bounds memo.
 *
 * A research study is pinned to ABSOLUTE bars, so its align:'right' maps to
 * 'data-right-aligned' (anchored to bars.length) — matching seriesStartFor(...,
 * barCount) — NOT the visible-edge 'right-aligned' used by custom/AI series.
 * align:'index'→'bar-aligned'. An hline is a constant price across all bars and
 * is contributed as a { constant } source (always inside the window).
 */
export function researchOverlayValueSources(ro: ResearchOverlay): OverlayValueSource[] {
  const out: OverlayValueSource[] = [];
  for (const el of ro.elements) {
    if (el.type === 'line') {
      out.push({
        values: el.values,
        align: el.align === 'right' ? 'data-right-aligned' : 'bar-aligned',
      });
    } else if (el.type === 'band') {
      const ralign = el.align === 'right' ? 'data-right-aligned' : 'bar-aligned';
      out.push({ values: el.upper, align: ralign });
      out.push({ values: el.lower, align: ralign });
    } else if (el.type === 'hline') {
      out.push({ constant: el.price });
    }
  }
  return out;
}

/** Visible bar count for the 'index' mismatch guard. */
function visibleBarCount(eIdx: number, sIdx: number): number {
  return Math.max(0, eIdx - sIdx);
}

/**
 * One-shot mismatch report for an 'index'-aligned series whose length differs
 * from the visible bar count. Warns once + toasts once per overlay id. Pure of
 * throw — only logging side effects. Exported for tests.
 */
export function reportIndexMismatch(overlayId: string, valuesLen: number, barCount: number): void {
  if (!_warnedMismatch.has(overlayId)) {
    _warnedMismatch.add(overlayId);
    console.warn(
      `[research overlay ${overlayId}] align:'index' length mismatch — ` +
        `values=${valuesLen} vs bars=${barCount}; rendering the aligned prefix.`,
    );
  }
  if (!_toastedMismatch.has(overlayId)) {
    _toastedMismatch.add(overlayId);
    try {
      useToastStore.getState().push({
        kind: 'warn',
        title: 'Research overlay misaligned',
        detail: `${overlayId}: value count differs from visible bars; truncated.`,
      });
    } catch {
      /* toast store unavailable (test stub) — warn already emitted. */
    }
  }
}

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------

function drawMarkerShape(
  ctx: CanvasRenderingContext2D,
  shape: 'triangle-up' | 'triangle-down' | 'circle' | 'diamond',
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const half = size / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'triangle-up':
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + half, cy + half);
      ctx.lineTo(cx - half, cy + half);
      ctx.closePath();
      ctx.fill();
      break;
    case 'triangle-down':
      ctx.moveTo(cx, cy + half);
      ctx.lineTo(cx + half, cy - half);
      ctx.lineTo(cx - half, cy - half);
      ctx.closePath();
      ctx.fill();
      break;
    case 'circle':
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'diamond':
      // Shared diamond path (fills in `color`) — identical geometry.
      drawDiamond(ctx, cx, cy, half, color);
      break;
  }
}

function renderLine(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  h: Helpers,
  el: LineElement,
  overlay: ResearchOverlay,
  colorIdx: number,
): void {
  const { values, align } = el;
  if (!values.length) return;
  const { xToPx, yToPx, sIdx, eIdx, barCount } = h;

  if (align === 'index' && values.length !== visibleBarCount(eIdx, sIdx)) {
    reportIndexMismatch(overlay.id, values.length, visibleBarCount(eIdx, sIdx));
  }

  const color = validateResearchColor(el.color ?? overlay.color, colorIdx);
  const seriesStart = seriesStartFor(align, values.length, barCount);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = el.width ?? 1.6;
  if (el.dash) ctx.setLineDash(parseDash(el));
  ctx.beginPath();
  let started = false;
  // Track the last finite point as three scalars (avoids a per-point object
  // allocation when only the final point survives for the hit region).
  let hasLast = false;
  let lastX = 0;
  let lastY = 0;
  let lastV = 0;
  for (let i = sIdx; i < eIdx; i++) {
    const si = i - seriesStart;
    if (si < 0 || si >= values.length) continue;
    const v = values[si];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      started = false;
      continue;
    }
    const x = xToPx(i + 0.5);
    const y = yToPx(v);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
    hasLast = true;
    lastX = x;
    lastY = y;
    lastV = v;
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Hit region: last non-null point.
  if (rc.hitRegions && hasLast) {
    rc.hitRegions.push({
      x: lastX,
      y: lastY,
      r: DOT_RADIUS_PX,
      kind: 'research',
      payload: { overlayId: overlay.id, label: overlay.label, value: lastV },
    });
  }
}

function renderBand(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  h: Helpers,
  el: BandElement,
  overlay: ResearchOverlay,
  colorIdx: number,
): void {
  const { upper, lower, align } = el;
  if (!upper.length || !lower.length) return;
  const { xToPx, yToPx, sIdx, eIdx, barCount } = h;
  const len = Math.min(upper.length, lower.length);

  if (align === 'index' && len !== visibleBarCount(eIdx, sIdx)) {
    reportIndexMismatch(overlay.id, len, visibleBarCount(eIdx, sIdx));
  }

  const color = validateResearchColor(el.color ?? overlay.color, colorIdx);
  const seriesStart = seriesStartFor(align, len, barCount);

  ctx.save();
  ctx.globalAlpha = el.opacity ?? 0.12;
  ctx.fillStyle = color;

  // Walk bars, emitting one filled quad-polygon per contiguous run where BOTH
  // upper[i] and lower[i] are finite. A null on EITHER side breaks the segment.
  let runUpper: { x: number; y: number }[] = [];
  let runLower: { x: number; y: number }[] = [];
  const flush = (): void => {
    if (runUpper.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(runUpper[0].x, runUpper[0].y);
      for (let k = 1; k < runUpper.length; k++) ctx.lineTo(runUpper[k].x, runUpper[k].y);
      for (let k = runLower.length - 1; k >= 0; k--) ctx.lineTo(runLower[k].x, runLower[k].y);
      ctx.closePath();
      ctx.fill();
    }
    runUpper = [];
    runLower = [];
  };

  let lastFinite: { x: number; y: number; v: number } | null = null;
  for (let i = sIdx; i < eIdx; i++) {
    const si = i - seriesStart;
    let u: number | null | undefined;
    let l: number | null | undefined;
    if (si >= 0 && si < len) {
      u = upper[si];
      l = lower[si];
    }
    const uOk = u !== null && u !== undefined && Number.isFinite(u);
    const lOk = l !== null && l !== undefined && Number.isFinite(l);
    if (!uOk || !lOk) {
      flush(); // break the polygon at this index — never fill-to-zero.
      continue;
    }
    const x = xToPx(i + 0.5);
    runUpper.push({ x, y: yToPx(u as number) });
    runLower.push({ x, y: yToPx(l as number) });
    lastFinite = { x, y: yToPx(u as number), v: u as number };
  }
  flush();
  ctx.restore();

  // Hit region: last fully-defined point.
  if (rc.hitRegions && lastFinite) {
    rc.hitRegions.push({
      x: lastFinite.x,
      y: lastFinite.y,
      r: DOT_RADIUS_PX,
      kind: 'research',
      payload: { overlayId: overlay.id, label: overlay.label, value: lastFinite.v },
    });
  }
}

function renderHLine(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  h: Helpers,
  el: HLineElement,
  overlay: ResearchOverlay,
  colorIdx: number,
): void {
  const { layout } = rc;
  const y = h.yToPx(el.price);
  // Skip when off-plot (avoids a chip drawn outside the axes).
  if (y < layout.y - 2 || y > layout.y + layout.h + 2) return;

  const color = validateResearchColor(el.color ?? overlay.color, colorIdx);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.7;
  if (el.dash) ctx.setLineDash(parseDash(el));
  else ctx.setLineDash([4, 3]);
  const yc = Math.round(y) + 0.5;
  ctx.beginPath();
  ctx.moveTo(layout.x, yc);
  ctx.lineTo(layout.x + layout.w, yc);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Right-end label chip (shared chip primitive; mirrors the y-axis price label).
  const labelText = el.label ?? overlay.label;
  if (labelText) {
    drawValueChip(ctx, layout, y, labelText, color, rc.theme.bg);
  }
  ctx.restore();

  // Hit region: the rule (sampled at the right edge where the chip is).
  if (rc.hitRegions) {
    rc.hitRegions.push({
      x: layout.x + layout.w - 12,
      y,
      r: DOT_RADIUS_PX,
      kind: 'research',
      payload: { overlayId: overlay.id, label: labelText || overlay.label, value: el.price },
    });
  }
}

function renderMarkers(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  h: Helpers,
  el: MarkersElement,
  overlay: ResearchOverlay,
  colorIdx: number,
): void {
  const { bars, layout } = rc;
  if (!bars.length) return;

  ctx.save();
  for (const pt of el.points) {
    const barIdx = nearestBarIndex(bars, pt.ts);
    const bar = bars[barIdx];
    if (!bar) continue;
    const cx = h.xToPx(barIdx + 0.5);
    if (cx < layout.x - 20 || cx > layout.x + layout.w + 20) continue;

    let cy: number;
    if (pt.price !== undefined) {
      cy = h.yToPx(pt.price);
    } else if (pt.anchor === 'above') {
      cy = h.yToPx(bar.h) - MARKER_SIZE;
    } else {
      // default / 'below': below the bar low.
      cy = h.yToPx(bar.l) + MARKER_SIZE;
    }

    const color = validateResearchColor(pt.color ?? overlay.color, colorIdx);
    drawMarkerShape(ctx, pt.shape, cx, cy, MARKER_SIZE, color);

    rc.hitRegions?.push({
      x: cx,
      y: cy,
      r: DOT_RADIUS_PX,
      kind: 'research',
      payload: {
        overlayId: overlay.id,
        label: pt.label ?? overlay.label,
        value: pt.price,
        ts: pt.ts,
      },
    });
  }
  ctx.restore();
}

function renderEventMark(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  h: Helpers,
  el: EventMarkElement,
  overlay: ResearchOverlay,
  colorIdx: number,
): void {
  const { bars, layout } = rc;
  if (!bars.length) return;

  const barIdx = nearestBarIndex(bars, el.ts);
  const cx = h.xToPx(barIdx + 0.5);
  if (cx < layout.x - 20 || cx > layout.x + layout.w + 20) return;

  const color = validateResearchColor(el.color ?? overlay.color, colorIdx);
  const kind = el.kind as TimelineGlyphKind;

  // Range uses ts_end to resolve the right edge; fall back to a 4-bar band.
  let cx2: number | undefined;
  if (kind === 'range') {
    const endIdx =
      el.ts_end !== undefined
        ? nearestBarIndex(bars, el.ts_end)
        : Math.min(barIdx + 4, bars.length - 1);
    cx2 = h.xToPx(endIdx + 0.5);
  }

  ctx.save();
  ctx.font = GLYPH_LABEL_FONT;
  const anchor = drawTimelineGlyph(ctx, kind, { cx, cx2, layout }, color, el.label);
  ctx.restore();

  rc.hitRegions?.push({
    ...anchor,
    r: kind === 'pin' ? DOT_RADIUS_PX : anchor.r,
    kind: 'research',
    payload: { overlayId: overlay.id, label: el.label, ts: el.ts },
  });
}

function renderText(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  h: Helpers,
  el: TextElement,
  overlay: ResearchOverlay,
  colorIdx: number,
): void {
  const { bars, layout } = rc;
  if (!bars.length) return;
  const barIdx = nearestBarIndex(bars, el.ts);
  const cx = h.xToPx(barIdx + 0.5);
  const cy = h.yToPx(el.price);
  if (cx < layout.x - 40 || cx > layout.x + layout.w + 40) return;

  const color = validateResearchColor(el.color ?? overlay.color, colorIdx);
  const fontSize = el.size ?? 11;

  ctx.save();
  ctx.font = `${fontSize}px "Geist Mono", ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const padX = 6;
  const padY = 4;
  const tw = ctx.measureText(el.content).width;
  const pillW = tw + padX * 2;
  const pillH = fontSize + padY * 2;
  const pillX = cx;
  const pillY = cy - pillH / 2;

  // Glass-ish pill: faint dark fill + hairline stroke derived from theme.
  // Base fill is the chart background at higher alpha → reads as frosted glass.
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = rc.theme.bg;
  roundRect(ctx, pillX, pillY, pillW, pillH, 4);
  ctx.fill();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = rc.theme.hairline;
  ctx.lineWidth = 1;
  roundRect(ctx, pillX, pillY, pillW, pillH, 4);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = color;
  ctx.fillText(el.content, pillX + padX, cy + 0.5);
  ctx.restore();

  rc.hitRegions?.push({
    x: pillX,
    y: pillY,
    x2: pillX + pillW,
    y2: pillY + pillH,
    kind: 'research',
    payload: { overlayId: overlay.id, label: el.content, ts: el.ts, value: el.price },
  });
}

function renderHotspot(
  rc: RenderContext,
  h: Helpers,
  el: HotspotElement,
  overlay: ResearchOverlay,
): void {
  // Draws NOTHING — only registers a hit region carrying its explicit panel.
  const { bars, layout } = rc;
  if (!bars.length || !rc.hitRegions) return;
  const barIdx = nearestBarIndex(bars, el.ts);
  const cx = h.xToPx(barIdx + 0.5);
  const cy = el.price !== undefined ? h.yToPx(el.price) : layout.y + layout.h / 2;
  rc.hitRegions.push({
    x: cx,
    y: cy,
    r: DOT_RADIUS_PX,
    kind: 'research',
    payload: { overlayId: overlay.id, label: overlay.label, ts: el.ts, panel: el.panel },
  });
}

// ---------------------------------------------------------------------------
// Core render
// ---------------------------------------------------------------------------

export function renderResearchOverlays(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  overlays: Record<string, ResearchOverlay>,
): void {
  const { bars, view, layout } = rc;
  if (!bars.length) return;

  const overlayList = Object.values(overlays);
  if (!overlayList.length) return;

  const h = makeHelpers(view, layout, bars.length);

  // Per-overlay color index (stable order via Object.values insertion order),
  // used by validateResearchColor → colorForIndex for rejected/missing colors.
  let overlayIdx = 0;
  for (const overlay of overlayList) {
    const colorIdx = overlayIdx++;
    for (const el of overlay.elements) {
      switch (el.type) {
        case 'line':
          renderLine(ctx, rc, h, el, overlay, colorIdx);
          break;
        case 'band':
          renderBand(ctx, rc, h, el, overlay, colorIdx);
          break;
        case 'hline':
          renderHLine(ctx, rc, h, el, overlay, colorIdx);
          break;
        case 'markers':
          renderMarkers(ctx, rc, h, el, overlay, colorIdx);
          break;
        case 'event_mark':
          renderEventMark(ctx, rc, h, el, overlay, colorIdx);
          break;
        case 'text':
          renderText(ctx, rc, h, el, overlay, colorIdx);
          break;
        case 'hotspot':
          renderHotspot(rc, h, el, overlay);
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ChartRenderer factory
// ---------------------------------------------------------------------------

/**
 * Create a `ChartRenderer` that renders agent-pushed research overlays.
 * `getOverlays` is called every frame so the renderer stays reactive without
 * re-creation (same pattern as `timelineEventsOverlay`).
 */
export function genericResearchOverlay(
  getOverlays: () => Record<string, ResearchOverlay>,
): ChartRenderer {
  return {
    render(rc: RenderContext): void {
      renderResearchOverlays(rc.ctx, rc, getOverlays());
    },
  };
}
