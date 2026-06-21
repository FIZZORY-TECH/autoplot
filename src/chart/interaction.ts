/**
 * src/chart/interaction.ts — Pure interaction module (no React).
 *
 * Exports a `createChartInteraction` factory that returns a stateful
 * interaction controller plus DOM event handlers to bind on the chart's
 * outer wrapper. Mirrors the prototype's behavior in
 * `app-design/project/chart.jsx`:
 *
 *   - drag-pan (mouse or 1 finger)
 *   - scroll-zoom anchored at cursor
 *   - shift+drag → emit range-select event (visual band drawn by P2.6)
 *   - 2-pointer pinch zoom around midpoint
 *   - tap-to-toggle crosshair (no-movement tap)
 *
 * Phase B — input is unified on the Pointer Events model: a single
 * `onPointerDown/Move/Up/Cancel` family backed by a `Map<pointerId,
 * PointerState>` registry replaces the old split mouse + touch handlers.
 * Gesture is derived from the number of active pointers (1 = drag/pan/tap,
 * 2 = pinch). `onWheel` (Phase A) is unchanged.
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

/** Wheel deltaMode normalization — browsers may report wheel deltas in pixels
 *  (mode 0), lines (mode 1, e.g. Firefox mouse wheel) or pages (mode 2, rare).
 *  We normalize lines/pages to a px-equivalent so the pan/zoom routing below
 *  works in one unit regardless of source. */
const WHEEL_LINE_PX = 16;
/** Pages → px. We don't have the viewport bar count here, so use a safe large
 *  constant; deltaMode===2 is rare in practice. TODO: derive from layout.w. */
const WHEEL_PAGE_PX = 400;

/** Wheel-pan sensitivity: fraction of the px→bar conversion applied to a
 *  horizontal wheel delta. Tuned so a one-hand trackpad swipe scrolls time at
 *  roughly drag-pan speed. */
const PAN_FACTOR = 1;

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

/** Per-pointer cursor position, tracked in the registry keyed by pointerId. */
interface PointerState {
  /** Latest x in CSS px (relative to wrapper). */
  x: number;
  /** Latest y in CSS px (relative to wrapper). */
  y: number;
}

/** Live pinch state — the previous finger distance feeds an incremental
 *  `zoomAround` each move, so we only need the last distance, not the anchor. */
interface PinchState {
  /** Finger distance in px on the previous pinch sample (>= 1). */
  dist: number;
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
  /** Bind these to the wrapper element (Pointer Events). */
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onWheel: (e: WheelEvent) => void;
  /** Returns true when actively pan-dragging — host can flip cursor to grabbing. */
  isPanning: () => boolean;
  /** True while one or more pointers are captured/active (host suppresses the
   *  crosshair-clear on pointerleave mid-drag — see ChartCanvas). */
  hasActivePointer: () => boolean;
  /** Clear the crosshair on hover-out (replaces the old onMouseLeave). Routes
   *  through cfg.setCrosshair so the Headline hover-bar is cleared too. */
  clearCrosshair: () => void;
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
  /** Active pointers keyed by pointerId — gesture is derived from .size. */
  const pointers = new Map<number, PointerState>();
  /** Single-pointer-only: tracks whether the current pointer is a tap (no movement). */
  let tapStart: { x: number; y: number } | null = null;

  function relativeXY(
    e: { clientX: number; clientY: number },
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
  // Unified Pointer handlers (Phase B)
  //
  // A registry of active pointers keyed by pointerId derives the gesture:
  //   1 active pointer  → drag / pan / range / trend / tap-to-toggle crosshair
  //   2 active pointers → pinch zoom around the midpoint (uses zoomAround)
  // Pointer capture (set on the target in pointerdown) guarantees move/up are
  // delivered even when the pointer leaves the element mid-drag — so the old
  // window-level mouseup workaround is no longer needed.
  // -------------------------------------------------------------------------

  /** Returns the midpoint + distance of the two currently active pointers. */
  function pinchGeometry(): { cx: number; cy: number; dist: number } {
    const it = pointers.values();
    const a = it.next().value as PointerState;
    const b = it.next().value as PointerState;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  /** Begin a single-pointer drag (pan / range / trend) from (x, y). */
  function beginDrag(x: number, y: number, shiftKey: boolean, button: number): void {
    const view = cfg.getView();
    const layout = cfg.getLayout();

    // Step 4 — Trend tool wins over range/pan when active. Plain pointerdown
    // captures anchor 1; pointermove updates a live draft; pointerup commits.
    if (cfg.isTrendDragActive?.() && button === 0 && !shiftKey) {
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
    const isRange = shiftKey || (cfg.isRangeDragActive?.() ?? false);
    drag = {
      kind: isRange ? 'range' : 'pan',
      startX: x,
      startStart: view.start,
      startEnd: view.end,
    };
    if (isRange && cfg.onRangeSelect) {
      // Clear any committed range until pointerup decides.
      cfg.onRangeSelect(null);
    }
  }

  function onPointerDown(e: PointerEvent): void {
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const { x, y } = relativeXY(e, target);
    pointers.set(e.pointerId, { x, y });
    // Capture so move/up are delivered even off-element (drag released off-canvas
    // ends cleanly — replaces the old window mouseup workaround).
    try {
      (target as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(
        e.pointerId,
      );
    } catch {
      // setPointerCapture can throw if the pointer is already gone; ignore.
    }

    if (pointers.size === 2) {
      // Second finger down → switch from drag to pinch. Drop any in-flight
      // single-pointer drag/tap so it doesn't also pan.
      drag = null;
      tapStart = null;
      pinch = { dist: pinchGeometry().dist };
      return;
    }
    if (pointers.size !== 1) return; // 3+ pointers: ignore until back to 1/2.

    // Only the primary button starts a single-pointer drag (mouse: left button;
    // touch/pen report button 0). Mirrors the old onMouseDown button gate.
    if (e.button !== 0) return;
    beginDrag(x, y, e.shiftKey, e.button);
    tapStart = { x, y };
  }

  function onPointerMove(e: PointerEvent): void {
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const { x, y } = relativeXY(e, target);
    const tracked = pointers.get(e.pointerId);
    if (tracked) {
      tracked.x = x;
      tracked.y = y;
    }

    // Pinch: 2 active pointers → incremental zoomAround the midpoint.
    if (pointers.size === 2 && pinch) {
      const { cx, dist } = pinchGeometry();
      const view = cfg.getView();
      const layout = cfg.getLayout();
      const barCount = cfg.getBarCount();
      const ratio = pinch.dist / dist; // fingers apart (dist↑) ⇒ ratio<1 ⇒ zoom in.
      pinch.dist = dist;
      const span = view.end - view.start;
      const newSpan = Math.max(
        MIN_WINDOW_BARS,
        Math.min(barCount * MAX_WINDOW_MULT, span * ratio),
      );
      const focusIdx = pxToBarX(cx, view, layout);
      const zoomed = zoomAround(view, focusIdx, newSpan);
      const clamped = clampWindow(zoomed.start, zoomed.end, barCount);
      cfg.setView({
        start: clamped.start,
        end: clamped.end,
        yMin: view.yMin,
        yMax: view.yMax,
      });
      return;
    }

    // Single pointer (or hover before any down): live crosshair.
    emitCrosshair(x, y);

    // Cancel "tap" if the pointer moved beyond TAP_PX.
    if (
      tapStart &&
      (Math.abs(x - tapStart.x) > TAP_PX || Math.abs(y - tapStart.y) > TAP_PX)
    ) {
      tapStart = null;
    }

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
    // Range drags: defer band rendering to P2.6; we only emit final range on up.
  }

  function endPointer(e: PointerEvent): void {
    const target = e.currentTarget as Element | null;
    pointers.delete(e.pointerId);
    try {
      (target as (Element & { releasePointerCapture?: (id: number) => void }) | null)?.releasePointerCapture?.(
        e.pointerId,
      );
    } catch {
      // already released / gone — ignore.
    }
    // Pinch needs 2 pointers; lifting one ends the pinch. A remaining pointer
    // does NOT resume a drag (it was never tracked as a drag) — matches the old
    // touch behavior where lifting one of two fingers stopped interaction.
    if (pointers.size < 2) pinch = null;
  }

  function onPointerUp(e: PointerEvent): void {
    const d = drag;
    const tap = tapStart;
    const wasPinch = pointers.size === 2 && !!pinch;
    endPointer(e);

    // Pinch release — no tap/click semantics.
    if (wasPinch) {
      drag = null;
      tapStart = null;
      return;
    }

    drag = null;
    tapStart = null;

    const target = e.currentTarget as Element | null;
    if (!target || typeof target.getBoundingClientRect !== 'function') return;
    const { x, y } = relativeXY(e, target);

    // Tap-to-toggle crosshair: a touch/pen tap whose total movement stayed under
    // the tap threshold toggles the crosshair on release. Mouse is EXCLUDED —
    // mouse clicks fall through to ChartCanvas's onChartClick path (mark
    // composer / event-hotspot popover / trend deselect), and the mouse
    // crosshair already tracks hover continuously, so toggling it on click would
    // be a regression. This matches the pre-Phase-B split where only the touch
    // path toggled the crosshair.
    const isTouchLike = e.pointerType !== 'mouse';
    if (
      isTouchLike &&
      d &&
      tap &&
      !(Math.abs(x - tap.x) > TAP_PX || Math.abs(y - tap.y) > TAP_PX)
    ) {
      // Trend draft started on this same tap must be cleared (cancelled draw)
      // below; the crosshair toggle still applies for pan/range taps.
      if (d.kind === 'trend' && d.trendAnchor) {
        cfg.setTrendDraft?.(null);
        return;
      }
      const visible = cfg.isCrosshairVisible?.() ?? true;
      if (visible) {
        cfg.setCrosshair(null);
      } else {
        emitCrosshair(tap.x, tap.y);
      }
      return;
    }

    if (!d) return;
    const moved = Math.abs(x - d.startX) > TAP_PX;

    // Step 4 — Trend tool: commit on pointerup if the user actually dragged.
    // A no-movement release clears the draft (treated as a cancelled draw).
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

  function onPointerCancel(e: PointerEvent): void {
    // Aborted gesture (e.g. OS gesture takeover) — drop all in-flight state for
    // this pointer with no tap/commit semantics.
    endPointer(e);
    if (pointers.size === 0) {
      drag = null;
      tapStart = null;
      cfg.setTrendDraft?.(null);
    }
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const target = e.currentTarget as Element | null;
    if (!target) return;
    const { x } = relativeXY(e, target);
    const view = cfg.getView();
    const layout = cfg.getLayout();
    const barCount = cfg.getBarCount();

    // 1. Normalize deltas for deltaMode FIRST so all routing below is in px.
    const unit =
      e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const deltaX = e.deltaX * unit;
    const deltaY = e.deltaY * unit;

    // 2. ctrlKey ⇒ focal-point zoom (macOS pinch-to-zoom; also Ctrl+wheel).
    //    3. else horizontal-dominant ⇒ time-axis pan (trackpad swipe).
    //    4. else (vertical-dominant) ⇒ zoom (plain mouse wheel / vertical swipe).
    if (!e.ctrlKey && Math.abs(deltaX) > Math.abs(deltaY)) {
      // Pan: convert px deltaX → bar shift via the same px→bars ratio drag uses
      // (a rightward swipe / positive deltaX moves the window forward in time).
      const span = view.end - view.start;
      const shift = (deltaX / Math.max(1, layout.w)) * span * PAN_FACTOR;
      const next = clampWindow(view.start + shift, view.end + shift, barCount);
      cfg.setView({
        start: next.start,
        end: next.end,
        yMin: view.yMin,
        yMax: view.yMax,
      });
      return;
    }

    const focusIdx = pxToBarX(x, view, layout);
    const span = view.end - view.start;
    const scale = deltaY > 0 ? 1.1 : 0.9;
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
  // Public surface
  // -------------------------------------------------------------------------

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onWheel,
    isPanning: () => drag?.kind === 'pan',
    hasActivePointer: () => pointers.size > 0,
    clearCrosshair: () => cfg.setCrosshair(null),
    reset: () => {
      drag = null;
      pinch = null;
      tapStart = null;
      pointers.clear();
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
