/**
 * src/chart/interaction.ts — Pure interaction module (no React).
 *
 * Exports a `createChartInteraction` factory that returns a stateful
 * interaction controller plus DOM event handlers to bind on the chart's
 * outer wrapper. Mirrors the prototype's behavior in
 * `app-design/project/chart.jsx`:
 *
 *   - mouse drag-pan
 *   - scroll-zoom anchored at cursor
 *   - shift+drag → emit range-select event (visual band drawn by P2.6)
 *   - 1-finger pan
 *   - 2-finger pinch zoom around midpoint
 *   - tap-to-toggle crosshair (no-movement tap)
 *
 * The controller is decoupled from rendering. ChartCanvas owns the DOM and
 * calls back into the controller for state changes (view, crosshair).
 */
import type { Bar } from '../data/MarketDataProvider';
import type { ViewWindow } from './types';

/** A 1-bar minimum padding on either side of the candle array — keeps a
 *  visible gap so the user can always see the most recent bar. */
const BAR_PAD = 50;

/** Step 4 — Extra slack on the LEFT edge ONLY. The scroll-back hook
 *  (`useScrollBack`) arms an older-page fetch once the window's left edge
 *  reaches a small positive threshold; allowing `start` to slip a little
 *  further below 0 than `BAR_PAD` keeps the trigger reachable when the user
 *  drags past the oldest loaded bar. The right edge + zoom clamps are
 *  unchanged so the most-recent-bar gutter and zoom-out feel are preserved. */
const LEFT_PAD = 120;

/** Minimum window size in bars (zoom-in floor). */
const MIN_WINDOW_BARS = 10;

/** Maximum window size — caller passes total bars; we widen with a 1.2x buffer
 *  to allow zooming "out beyond" the data, matching the prototype. */
const MAX_WINDOW_MULT = 1.2;

/** Px movement threshold below which a mousedown-mouseup is a tap (no drag). */
const TAP_PX = 4;

/** Range-select event payload — `start`/`end` are bar indices (lo < hi). */
export interface RangeSelectEvent {
  start: number;
  end: number;
}

/** Crosshair state lifted out of the interaction module — null when hidden. */
export interface CrosshairState {
  /** Cursor x in CSS pixels (relative to wrapper). */
  x: number;
  /** Cursor y in CSS pixels (relative to wrapper). */
  y: number;
  /** Bar index under cursor (clamped to [0, bars.length - 1]). */
  barIdx: number;
  /** Price at cursor y (within yMin..yMax). */
  price: number;
}

export interface InteractionConfig {
  /** Returns the current ViewWindow. Live ref, not a snapshot. */
  getView: () => ViewWindow;
  /** Returns the bar array length. */
  getBarCount: () => number;
  /** Returns the chart layout in CSS px (plot area). */
  getLayout: () => { x: number; y: number; w: number; h: number };
  /** Apply a new viewport. The caller decides whether to clamp/animate. */
  setView: (next: ViewWindow) => void;
  /** Set/clear the crosshair. */
  setCrosshair: (next: CrosshairState | null) => void;
  /** Optional callback for shift+drag range select. */
  onRangeSelect?: (range: RangeSelectEvent | null) => void;
  /** Returns whether tap-to-toggle should show or hide (touch only). Defaults true. */
  isCrosshairVisible?: () => boolean;
  /**
   * P2.2 — When this returns true, a plain (non-shift) drag triggers a
   * range-select instead of a pan. Used by the Dock's Range Scope tool.
   * Without this, range-select requires Shift+drag. This is the minimal
   * extension needed to support plain-drag range mode; the Shift+drag path
   * remains unchanged so both paths work independently.
   */
  isRangeDragActive?: () => boolean;
  /**
   * Step 4 — When this returns true, a plain (non-shift) drag is captured by
   * the trend tool: anchor 1 is set on mousedown, anchor 2 follows the
   * cursor, and `commitTrend` is invoked on mouseup. While this is active
   * pan / range / crosshair-update behaviors are suppressed for the drag.
   */
  isTrendDragActive?: () => boolean;
  /**
   * Step 4 — Live cursor in chart-data space (bar-index, price). The
   * controller reports anchor coordinates as (ts, price) pairs to the
   * caller; mapping bar-index → ts is done by the caller via its bar list.
   */
  setTrendDraft?: (anchors: {
    x1Idx: number;
    y1Price: number;
    x2Idx: number;
    y2Price: number;
  } | null) => void;
  /** Step 4 — Final commit on mouseup (only fires when the user actually dragged). */
  commitTrend?: (anchors: {
    x1Idx: number;
    y1Price: number;
    x2Idx: number;
    y2Price: number;
  }) => void;
}

/** Convert a px x to a fractional bar index using the current view. */
function pxToBarX(
  px: number,
  view: ViewWindow,
  layout: { x: number; w: number },
): number {
  const span = view.end - view.start;
  return view.start + ((px - layout.x) / Math.max(1, layout.w)) * span;
}

/** Convert a px y to a price using the current view. */
function pxToPrice(
  py: number,
  view: ViewWindow,
  layout: { y: number; h: number },
): number {
  const range = view.yMax - view.yMin;
  return view.yMin + (1 - (py - layout.y) / Math.max(1, layout.h)) * range;
}

interface DragState {
  kind: 'pan' | 'range' | 'trend';
  startX: number;
  startStart: number;
  startEnd: number;
  /** Step 4 — Anchor 1 in data space (bar-index + price), only for kind='trend'. */
  trendAnchor?: { x1Idx: number; y1Price: number };
}

interface PinchState {
  /** Initial finger distance in px. */
  dist: number;
  /** Initial midpoint x in CSS px (relative to wrapper). */
  cx: number;
  /** Initial view span (end - start). */
  span: number;
  /** Bar index at the midpoint when pinch began. */
  focusIdx: number;
  /** Initial view.start. */
  startStart: number;
}

/**
 * Apply a zoom around a cursor anchor — the bar at `focusIdx` stays at the
 * same screen x. Used by both wheel and pinch.
 */
function zoomAround(
  view: ViewWindow,
  focusIdx: number,
  newSpan: number,
): ViewWindow {
  const span = view.end - view.start;
  const ratio = (focusIdx - view.start) / Math.max(1e-9, span);
  const start = focusIdx - ratio * newSpan;
  const end = start + newSpan;
  return { start, end, yMin: view.yMin, yMax: view.yMax };
}

/** Clamp a [start, end] window so it stays within reasonable bounds of the data. */
function clampWindow(
  start: number,
  end: number,
  barCount: number,
): { start: number; end: number } {
  let s = start;
  let e = end;
  // Step 4 — widen ONLY the left bound (allow start to go a bit further below
  // 0 than BAR_PAD so the scroll-back trigger can arm). The right edge keeps
  // the original BAR_PAD gutter so the most-recent-bar feel is unchanged.
  if (s < -LEFT_PAD) {
    e += -LEFT_PAD - s;
    s = -LEFT_PAD;
  }
  if (e > barCount + BAR_PAD) {
    s -= e - (barCount + BAR_PAD);
    e = barCount + BAR_PAD;
  }
  // Guard against a negative or inverted span (e.g. if a tiny barCount made
  // the two corrections above cross). Keep at least MIN_WINDOW_BARS of width.
  if (e - s < MIN_WINDOW_BARS) {
    e = s + MIN_WINDOW_BARS;
  }
  return { start: s, end: e };
}

export interface InteractionController {
  /** Bind these to the wrapper element. */
  onMouseDown: (e: MouseEvent) => void;
  onMouseMove: (e: MouseEvent) => void;
  onMouseUp: (e: MouseEvent) => void;
  onMouseLeave: (e: MouseEvent) => void;
  onWheel: (e: WheelEvent) => void;
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
  /** Returns true when actively pan-dragging — host can flip cursor to grabbing. */
  isPanning: () => boolean;
  /** Cleanup any in-flight drag/pinch state (e.g. on unmount). */
  reset: () => void;
}

/**
 * Build an interaction controller. The controller is stateful but contains
 * NO React — pure DOM events in, callbacks out. Call `reset()` on unmount.
 */
export function createChartInteraction(
  cfg: InteractionConfig,
): InteractionController {
  let drag: DragState | null = null;
  let pinch: PinchState | null = null;
  /** Touch-only: tracks whether the current touch is a tap (no movement). */
  let touchTapStart: { x: number; y: number } | null = null;

  function relativeXY(
    e: MouseEvent | Touch,
    target: Element,
  ): { x: number; y: number } {
    const rect = target.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function emitCrosshair(x: number, y: number): void {
    const view = cfg.getView();
    const barCount = cfg.getBarCount();
    const layout = cfg.getLayout();
    const idx = Math.floor(pxToBarX(x, view, layout));
    const price = pxToPrice(y, view, layout);
    const clamped = Math.max(0, Math.min(barCount - 1, idx));
    cfg.setCrosshair({ x, y, barIdx: clamped, price });
  }

  function applyPan(currentX: number, d: DragState): void {
    const view = cfg.getView();
    const layout = cfg.getLayout();
    const dx = currentX - d.startX;
    const span = d.startEnd - d.startStart;
    const shift = -(dx / Math.max(1, layout.w)) * span;
    const next = clampWindow(
      d.startStart + shift,
      d.startEnd + shift,
      cfg.getBarCount(),
    );
    cfg.setView({ start: next.start, end: next.end, yMin: view.yMin, yMax: view.yMax });
  }

  // -------------------------------------------------------------------------
  // Mouse handlers
  // -------------------------------------------------------------------------

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const { x, y } = relativeXY(e, target);
    const view = cfg.getView();
    const layout = cfg.getLayout();

    // Step 4 — Trend tool wins over range/pan when active. Plain mousedown
    // captures anchor 1; mousemove updates a live draft; mouseup commits.
    if (cfg.isTrendDragActive?.() && !e.shiftKey) {
      const x1Idx = pxToBarX(x, view, layout);
      const y1Price = pxToPrice(y, view, layout);
      drag = {
        kind: 'trend',
        startX: x,
        startStart: view.start,
        startEnd: view.end,
        trendAnchor: { x1Idx, y1Price },
      };
      // Seed the draft at anchor1=anchor2 so the renderer shows a single dot
      // until the user starts moving.
      cfg.setTrendDraft?.({ x1Idx, y1Price, x2Idx: x1Idx, y2Price: y1Price });
      return;
    }

    // P2.2 — Range Scope tool: plain drag triggers range-select when active.
    // Shift+drag also triggers range-select regardless (existing behavior).
    const isRange = e.shiftKey || (cfg.isRangeDragActive?.() ?? false);
    drag = {
      kind: isRange ? 'range' : 'pan',
      startX: x,
      startStart: view.start,
      startEnd: view.end,
    };
    if (isRange && cfg.onRangeSelect) {
      // Clear any committed range until mouseup decides.
      cfg.onRangeSelect(null);
    }
  }

  function onMouseMove(e: MouseEvent): void {
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const { x, y } = relativeXY(e, target);
    emitCrosshair(x, y);

    if (drag?.kind === 'pan') {
      applyPan(x, drag);
    } else if (drag?.kind === 'trend' && drag.trendAnchor && cfg.setTrendDraft) {
      // Step 4 — update the in-progress trend draft to track the cursor.
      const view = cfg.getView();
      const layout = cfg.getLayout();
      const x2Idx = pxToBarX(x, view, layout);
      const y2Price = pxToPrice(y, view, layout);
      cfg.setTrendDraft({
        x1Idx: drag.trendAnchor.x1Idx,
        y1Price: drag.trendAnchor.y1Price,
        x2Idx,
        y2Price,
      });
    }
    // Range drags: defer band rendering to P2.6; we only emit final range on mouseup.
  }

  function onMouseUp(e: MouseEvent): void {
    const d = drag;
    drag = null;
    if (!d) return;
    // The mouseup listener is bound on `window` (so a drag that ends off the
    // canvas still cleans up), which means `e.currentTarget` is the Window —
    // it has no getBoundingClientRect. Prefer currentTarget only when it is a
    // real rect-providing Element; otherwise fall back to `e.target` (the
    // canvas under the pointer). Without this, relativeXY throws a TypeError
    // here and aborts the whole mouseup handler — silently killing the
    // click→onChartClick path (event-hotspot popover, mark composer, trend
    // deselect). See hitRegions/event-hotspot real-click regression test.
    const ct = e.currentTarget as unknown;
    const target: Element | null =
      ct && typeof (ct as Element).getBoundingClientRect === 'function'
        ? (ct as Element)
        : (e.target as Element | null);
    if (!target || typeof target.getBoundingClientRect !== 'function') return;
    const { x, y } = relativeXY(e, target);
    const moved = Math.abs(x - d.startX) > TAP_PX;

    // Step 4 — Trend tool: commit on mouseup if the user actually dragged.
    // A no-movement click clears the draft (treated as a cancelled draw).
    if (d.kind === 'trend' && d.trendAnchor) {
      cfg.setTrendDraft?.(null);
      if (moved && cfg.commitTrend) {
        const view = cfg.getView();
        const layout = cfg.getLayout();
        const x2Idx = pxToBarX(x, view, layout);
        const y2Price = pxToPrice(y, view, layout);
        cfg.commitTrend({
          x1Idx: d.trendAnchor.x1Idx,
          y1Price: d.trendAnchor.y1Price,
          x2Idx,
          y2Price,
        });
      }
      return;
    }

    if (d.kind === 'range' && moved && cfg.onRangeSelect) {
      const view = cfg.getView();
      const layout = cfg.getLayout();
      const a = pxToBarX(Math.min(d.startX, x), view, layout);
      const b = pxToBarX(Math.max(d.startX, x), view, layout);
      const lo = Math.max(0, Math.floor(Math.min(a, b)));
      const hi = Math.min(cfg.getBarCount() - 1, Math.floor(Math.max(a, b)));
      if (hi > lo) {
        cfg.onRangeSelect({ start: lo, end: hi });
      } else {
        cfg.onRangeSelect(null);
      }
    }
  }

  function onMouseLeave(_e: MouseEvent): void {
    cfg.setCrosshair(null);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const { x } = relativeXY(e, target);
    const view = cfg.getView();
    const layout = cfg.getLayout();
    const barCount = cfg.getBarCount();
    const focusIdx = pxToBarX(x, view, layout);
    const span = view.end - view.start;
    const scale = e.deltaY > 0 ? 1.1 : 0.9;
    const newSpan = Math.max(
      MIN_WINDOW_BARS,
      Math.min(barCount * MAX_WINDOW_MULT, span * scale),
    );
    const zoomed = zoomAround(view, focusIdx, newSpan);
    const clamped = clampWindow(zoomed.start, zoomed.end, barCount);
    cfg.setView({
      start: clamped.start,
      end: clamped.end,
      yMin: view.yMin,
      yMax: view.yMax,
    });
  }

  // -------------------------------------------------------------------------
  // Touch handlers
  // -------------------------------------------------------------------------

  function onTouchStart(e: TouchEvent): void {
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const view = cfg.getView();
    if (e.touches.length === 1) {
      const t = e.touches[0]!;
      const { x, y } = relativeXY(t, target);
      drag = { kind: 'pan', startX: x, startStart: view.start, startEnd: view.end };
      touchTapStart = { x, y };
    } else if (e.touches.length === 2) {
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      const layout = cfg.getLayout();
      const aRel = relativeXY(a, target);
      const bRel = relativeXY(b, target);
      const dist = Math.hypot(aRel.x - bRel.x, aRel.y - bRel.y);
      const cx = (aRel.x + bRel.x) / 2;
      pinch = {
        dist: Math.max(1, dist),
        cx,
        span: view.end - view.start,
        focusIdx: pxToBarX(cx, view, layout),
        startStart: view.start,
      };
      drag = null;
      touchTapStart = null;
    }
  }

  function onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const view = cfg.getView();
    const barCount = cfg.getBarCount();

    if (e.touches.length === 2 && pinch) {
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      const aRel = relativeXY(a, target);
      const bRel = relativeXY(b, target);
      const dist = Math.hypot(aRel.x - bRel.x, aRel.y - bRel.y);
      const ratio = pinch.dist / Math.max(1, dist);
      const newSpan = Math.max(
        MIN_WINDOW_BARS,
        Math.min(barCount * MAX_WINDOW_MULT, pinch.span * ratio),
      );
      const r = (pinch.focusIdx - pinch.startStart) / Math.max(1e-9, pinch.span);
      const start = pinch.focusIdx - r * newSpan;
      const end = start + newSpan;
      const clamped = clampWindow(start, end, barCount);
      cfg.setView({
        start: clamped.start,
        end: clamped.end,
        yMin: view.yMin,
        yMax: view.yMax,
      });
      return;
    }

    if (e.touches.length === 1 && drag) {
      const t = e.touches[0]!;
      const { x, y } = relativeXY(t, target);
      // Cancel "tap" if the finger moved beyond TAP_PX.
      if (
        touchTapStart &&
        (Math.abs(x - touchTapStart.x) > TAP_PX ||
          Math.abs(y - touchTapStart.y) > TAP_PX)
      ) {
        touchTapStart = null;
      }
      // Pan + live crosshair while dragging.
      emitCrosshair(x, y);
      applyPan(x, drag);
    }
  }

  function onTouchEnd(e: TouchEvent): void {
    if (pinch && e.touches.length < 2) pinch = null;
    if (drag && e.touches.length === 0) {
      // Detect tap (no movement) → toggle crosshair.
      if (touchTapStart) {
        const visible = cfg.isCrosshairVisible?.() ?? true;
        if (visible) {
          cfg.setCrosshair(null);
        } else {
          emitCrosshair(touchTapStart.x, touchTapStart.y);
        }
      }
      drag = null;
      touchTapStart = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave,
    onWheel,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    isPanning: () => drag?.kind === 'pan',
    reset: () => {
      drag = null;
      pinch = null;
      touchTapStart = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests.
// ---------------------------------------------------------------------------

/** Look up the bar at a given fractional bar index, clamped. */
export function getBarAt(bars: Bar[], idx: number): Bar | null {
  if (!bars.length) return null;
  const i = Math.max(0, Math.min(bars.length - 1, Math.floor(idx)));
  return bars[i] ?? null;
}

export const __test__ = {
  pxToBarX,
  pxToPrice,
  zoomAround,
  clampWindow,
  BAR_PAD,
  LEFT_PAD,
  MIN_WINDOW_BARS,
  MAX_WINDOW_MULT,
};
