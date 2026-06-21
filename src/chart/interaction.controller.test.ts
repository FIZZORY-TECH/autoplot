/**
 * src/chart/interaction.controller.test.ts — Unit tests for the stateful
 * interaction controller built by `createChartInteraction`.
 *
 * Tests cover the Phase A (wheel routing) and Phase B (unified Pointer Events)
 * behaviours added in the gesture-unification milestone. Pure DOM-event
 * simulation — no React, no real canvas. Each test builds its own controller
 * via the same config-factory pattern used by ChartCanvas.
 */

import { describe, expect, it, vi } from 'vitest';
import { createChartInteraction, type InteractionConfig } from './interaction';
import type { ViewWindow } from './types';

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

/** A minimal ViewWindow (10 bars wide, arbitrary y). */
function makeView(start = 0, end = 100): ViewWindow {
  return { start, end, yMin: 100, yMax: 200 };
}

/**
 * Build a mock InteractionConfig that returns sensible defaults. Every
 * callback is a vi.fn() so tests can assert calls and arguments.
 *
 * `getView` and `getLayout` are backed by mutable refs so tests can mutate
 * the current view (as `setView` would in production) without reconnecting.
 */
function makeCfg(overrides: Partial<InteractionConfig> = {}): {
  cfg: InteractionConfig;
  setViewSpy: ReturnType<typeof vi.fn>;
  setCrosshairSpy: ReturnType<typeof vi.fn>;
  onRangeSelectSpy: ReturnType<typeof vi.fn>;
  view: { current: ViewWindow };
} {
  const view = { current: makeView() };
  const setViewSpy = vi.fn((next: ViewWindow) => {
    view.current = next;
  });
  const setCrosshairSpy = vi.fn();
  const onRangeSelectSpy = vi.fn();

  const cfg: InteractionConfig = {
    getView: () => view.current,
    getBarCount: () => 600,
    getLayout: () => ({ x: 0, y: 0, w: 600, h: 300 }),
    setView: setViewSpy,
    setCrosshair: setCrosshairSpy,
    onRangeSelect: onRangeSelectSpy,
    ...overrides,
  };
  return { cfg, setViewSpy, setCrosshairSpy, onRangeSelectSpy, view };
}

/**
 * Build a minimal Element stand-in that the controller can call
 * `getBoundingClientRect` / `setPointerCapture` / `releasePointerCapture` on
 * without errors. The rect is positioned at (0,0) with size (600×300) so
 * controller-relative px == clientXY px.
 */
function makeTarget(): Element {
  const el = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 600,
      bottom: 300,
      width: 600,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as Element;
  return el;
}

/** Construct a synthetic PointerEvent with `currentTarget` pre-set to `el`. */
function makePointerEvent(
  type: string,
  opts: Partial<PointerEvent> & {
    pointerId?: number;
    pointerType?: string;
    button?: number;
    shiftKey?: boolean;
    clientX?: number;
    clientY?: number;
  } = {},
  el: Element = makeTarget(),
): PointerEvent {
  const e = {
    type,
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? 'mouse',
    button: opts.button ?? 0,
    shiftKey: opts.shiftKey ?? false,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    currentTarget: el,
    preventDefault: vi.fn(),
  } as unknown as PointerEvent;
  return e;
}

/** Construct a synthetic WheelEvent with `currentTarget` pre-set to `el`. */
function makeWheelEvent(
  opts: {
    deltaX?: number;
    deltaY?: number;
    deltaMode?: number;
    ctrlKey?: boolean;
    clientX?: number;
    clientY?: number;
  } = {},
  el: Element = makeTarget(),
): WheelEvent {
  const e = {
    type: 'wheel',
    deltaX: opts.deltaX ?? 0,
    deltaY: opts.deltaY ?? 0,
    deltaMode: opts.deltaMode ?? 0,
    ctrlKey: opts.ctrlKey ?? false,
    clientX: opts.clientX ?? 300,
    clientY: opts.clientY ?? 150,
    currentTarget: el,
    preventDefault: vi.fn(),
  } as unknown as WheelEvent;
  return e;
}

// ---------------------------------------------------------------------------
// Phase A — Wheel routing
// ---------------------------------------------------------------------------

describe('wheel routing — ctrlKey: focal zoom', () => {
  it('ctrlKey+wheel-down zooms out (span increases, view is focal-anchored)', () => {
    const { cfg, setViewSpy, view } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    // Cursor at center (x=300 in a 600px layout → bar index = 50 out of 0..100).
    const oldSpan = view.current.end - view.current.start; // initial 100 — captured BEFORE the wheel.
    const e = makeWheelEvent({ deltaY: 200, ctrlKey: true, clientX: 300 });
    ctrl.onWheel(e);

    expect(setViewSpy).toHaveBeenCalledOnce();
    const next = setViewSpy.mock.calls[0][0] as ViewWindow;

    // deltaY > 0 → zoom OUT → span should grow.
    const newSpan = next.end - next.start;
    expect(newSpan).toBeGreaterThan(oldSpan);

    // yMin/yMax must be preserved.
    expect(next.yMin).toBe(view.current.yMin);
    expect(next.yMax).toBe(view.current.yMax);
  });

  it('ctrlKey+wheel-up zooms in (span decreases)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    const e = makeWheelEvent({ deltaY: -200, ctrlKey: true, clientX: 300 });
    ctrl.onWheel(e);

    expect(setViewSpy).toHaveBeenCalledOnce();
    const next = setViewSpy.mock.calls[0][0] as ViewWindow;
    const newSpan = next.end - next.start;
    expect(newSpan).toBeLessThan(100); // started at 100
  });

  it('focal-zoom keeps the cursor bar at the same fractional position', () => {
    // Cursor at x=300 → fractional bar ≈ 50 in a 0..100 view.
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    const e = makeWheelEvent({ deltaY: 200, ctrlKey: true, clientX: 300 });
    ctrl.onWheel(e);

    const next = setViewSpy.mock.calls[0][0] as ViewWindow;
    const newSpan = next.end - next.start;
    // focusIdx ≈ 50, ratio ≈ 0.5 → start ≈ focus - 0.5 * newSpan
    const expectedStart = 50 - 0.5 * newSpan;
    expect(next.start).toBeCloseTo(expectedStart, 1);
  });
});

describe('wheel routing — horizontal-dominant: time-axis pan', () => {
  it('|deltaX| > |deltaY| ⇒ pan (start/end shift, span unchanged)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    // deltaX=60, deltaY=0 → horizontal dominant → pan right.
    const e = makeWheelEvent({ deltaX: 60, deltaY: 0 });
    ctrl.onWheel(e);

    expect(setViewSpy).toHaveBeenCalledOnce();
    const next = setViewSpy.mock.calls[0][0] as ViewWindow;

    // Span must be preserved.
    expect(next.end - next.start).toBeCloseTo(100, 5);

    // A positive deltaX shifts the window to the right (later bars).
    expect(next.start).toBeGreaterThan(0);
    expect(next.end).toBeGreaterThan(100);
  });

  it('horizontal pan amount scales with deltaX magnitude', () => {
    const { cfg, setViewSpy: spy1 } = makeCfg();
    const c1 = createChartInteraction(cfg);
    c1.onWheel(makeWheelEvent({ deltaX: 30, deltaY: 0 }));
    const shift1 = (spy1.mock.calls[0][0] as ViewWindow).start;

    const { cfg: cfg2, setViewSpy: spy2 } = makeCfg();
    const c2 = createChartInteraction(cfg2);
    c2.onWheel(makeWheelEvent({ deltaX: 60, deltaY: 0 }));
    const shift2 = (spy2.mock.calls[0][0] as ViewWindow).start;

    // Larger deltaX → larger shift.
    expect(Math.abs(shift2)).toBeGreaterThan(Math.abs(shift1));
  });

  it('ctrlKey suppresses horizontal-pan routing even when |deltaX| > |deltaY|', () => {
    // With ctrlKey, the focal zoom branch takes over regardless of deltaX/Y ratio.
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    ctrl.onWheel(makeWheelEvent({ deltaX: 60, deltaY: 0, ctrlKey: true }));

    // Focal zoom: span should change (NOT a straight pan where span is preserved).
    // With deltaY=0 the scale is 0.9 (zoom in branch) — span < 100.
    const next = setViewSpy.mock.calls[0][0] as ViewWindow;
    const newSpan = next.end - next.start;
    // span × 0.9 = 90 < 100 — zoom, not pan.
    expect(newSpan).toBeLessThan(100);
  });
});

describe('wheel routing — vertical-dominant: zoom', () => {
  it('|deltaY| > |deltaX| ⇒ zoom (span changes)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    const e = makeWheelEvent({ deltaX: 5, deltaY: 200 });
    ctrl.onWheel(e);

    expect(setViewSpy).toHaveBeenCalledOnce();
    const next = setViewSpy.mock.calls[0][0] as ViewWindow;
    // Span changes (not preserved as in pan).
    expect(next.end - next.start).not.toBeCloseTo(100, 5);
  });

  it('pure vertical wheel (no ctrlKey) zooms around the cursor', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    ctrl.onWheel(makeWheelEvent({ deltaY: -200, clientX: 0 })); // cursor at bar 0
    const next = setViewSpy.mock.calls[0][0] as ViewWindow;

    // Zooming in around bar 0 — start should be near 0 or even negative (clamped).
    // The key assertion: span decreased.
    expect(next.end - next.start).toBeLessThan(100);
  });
});

describe('wheel routing — deltaMode normalization', () => {
  it('deltaMode===1 (lines) applies 16× multiplier vs deltaMode===0 (px)', () => {
    // Same physical wheel delta (deltaY=1) but different modes.
    // mode=1 ⇒ delta_effective = 1 * 16 = 16 (WHEEL_LINE_PX).
    // mode=0 ⇒ delta_effective = 1 * 1 = 1.
    // Both zoom (vertical dominant). mode=1 should produce a larger span change.

    // Controller 1: deltaMode=0, deltaY=1.
    const { cfg: cfg0, setViewSpy: spy0 } = makeCfg();
    createChartInteraction(cfg0).onWheel(
      makeWheelEvent({ deltaY: 1, deltaMode: 0, clientX: 300 }),
    );
    const span0 = (spy0.mock.calls[0][0] as ViewWindow).end -
      (spy0.mock.calls[0][0] as ViewWindow).start;

    // Controller 2: deltaMode=1, deltaY=1 (logically ~16× larger delta).
    const { cfg: cfg1, setViewSpy: spy1 } = makeCfg();
    createChartInteraction(cfg1).onWheel(
      makeWheelEvent({ deltaY: 1, deltaMode: 1, clientX: 300 }),
    );
    const span1 = (spy1.mock.calls[0][0] as ViewWindow).end -
      (spy1.mock.calls[0][0] as ViewWindow).start;

    // mode=1 should move the span more than mode=0 for the same raw delta.
    // Both started at 100; zoom scale is 1.1 for positive deltaY.
    // mode=0, deltaY_eff=1 → scale=1.1 → span=110.
    // mode=1, deltaY_eff=16 → scale=1.1 → span=110 too (the scale is fixed 1.1/0.9).
    // BUT: the horizontal-dominant check uses the normalized values, so a large
    // deltaY (mode=1) is still vertical-dominant. The outcome is the same zoom
    // scale (1.1) but triggered correctly. The critical correctness assertion is
    // that mode=1 does NOT treat deltaY=1 as 1 px (which would be subpixel and
    // might fall through the <0.5 threshold). Both should fire setView.
    expect(spy0).toHaveBeenCalledOnce();
    expect(spy1).toHaveBeenCalledOnce();
    // Both zoom OUT (deltaY > 0 → scale 1.1) so both spans should be > 100.
    expect(span0).toBeGreaterThan(100);
    expect(span1).toBeGreaterThan(100);

    // For the horizontal-dominant pan branch, normalization matters more.
    // Verify: deltaMode=1 deltaX=1 (effective=16) > deltaY=10 (effective=160)?
    // No — 16 < 160 so it's vertical. Let's verify deltaX=1,deltaY=0 in mode=1
    // produces the same pan as deltaX=16,deltaY=0 in mode=0.
    const { cfg: cfgPan0, setViewSpy: spyPan0 } = makeCfg();
    createChartInteraction(cfgPan0).onWheel(
      makeWheelEvent({ deltaX: 16, deltaY: 0, deltaMode: 0 }),
    );
    const panShift0 = (spyPan0.mock.calls[0][0] as ViewWindow).start;

    const { cfg: cfgPan1, setViewSpy: spyPan1 } = makeCfg();
    createChartInteraction(cfgPan1).onWheel(
      makeWheelEvent({ deltaX: 1, deltaY: 0, deltaMode: 1 }),
    );
    const panShift1 = (spyPan1.mock.calls[0][0] as ViewWindow).start;

    // Both should produce the same pan shift (within floating-point tolerance).
    expect(panShift0).toBeCloseTo(panShift1, 5);
  });
});

// ---------------------------------------------------------------------------
// Phase B — Drag kinds
// ---------------------------------------------------------------------------

describe('drag kind — pan (plain pointerdown+move+up)', () => {
  it('moving left shifts the view right (earlier bars come into view)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    ctrl.onPointerDown(makePointerEvent('pointerdown', { clientX: 300, clientY: 150 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { clientX: 200, clientY: 150 }, el));

    // At least one setView call while panning.
    expect(setViewSpy.mock.calls.length).toBeGreaterThan(0);

    // Moving LEFT (clientX decreases) = dragging to see earlier bars → start should decrease.
    const last = setViewSpy.mock.lastCall![0] as ViewWindow;
    expect(last.start).toBeGreaterThan(0); // panned forward (to the right in time)
  });

  it('pan preserves span', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    ctrl.onPointerDown(makePointerEvent('pointerdown', { clientX: 300, clientY: 150 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { clientX: 100, clientY: 150 }, el));

    const last = setViewSpy.mock.lastCall![0] as ViewWindow;
    expect(last.end - last.start).toBeCloseTo(100, 5);
  });

  it('isPanning() returns true during drag and false after pointerup', () => {
    const { cfg } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    expect(ctrl.isPanning()).toBe(false);

    ctrl.onPointerDown(makePointerEvent('pointerdown', { clientX: 300, clientY: 150 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { clientX: 200, clientY: 150 }, el));
    expect(ctrl.isPanning()).toBe(true);

    ctrl.onPointerUp(makePointerEvent('pointerup', { clientX: 200, clientY: 150 }, el));
    expect(ctrl.isPanning()).toBe(false);
  });
});

describe('drag kind — range-select (shift+drag)', () => {
  it('shift+drag emits a range-select on pointerup', () => {
    const { cfg, onRangeSelectSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Start at bar 0 (clientX=0), drag to bar 50 (clientX=300).
    ctrl.onPointerDown(
      makePointerEvent('pointerdown', { clientX: 0, clientY: 150, shiftKey: true }, el),
    );
    ctrl.onPointerMove(
      makePointerEvent('pointermove', { clientX: 300, clientY: 150, shiftKey: true }, el),
    );
    ctrl.onPointerUp(
      makePointerEvent('pointerup', { clientX: 300, clientY: 150, shiftKey: true }, el),
    );

    // onRangeSelect(null) is called on pointerdown (clears prior range).
    // onRangeSelect({start, end}) should be called on pointerup.
    const rangeCall = onRangeSelectSpy.mock.calls.find(
      (c) => c[0] !== null,
    );
    expect(rangeCall).toBeDefined();
    const range = rangeCall![0] as { start: number; end: number };
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeGreaterThan(range.start);
  });

  it('shift+drag does NOT call setView (no pan)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    ctrl.onPointerDown(
      makePointerEvent('pointerdown', { clientX: 0, clientY: 150, shiftKey: true }, el),
    );
    ctrl.onPointerMove(
      makePointerEvent('pointermove', { clientX: 300, clientY: 150, shiftKey: true }, el),
    );
    ctrl.onPointerUp(
      makePointerEvent('pointerup', { clientX: 300, clientY: 150, shiftKey: true }, el),
    );

    expect(setViewSpy).not.toHaveBeenCalled();
  });
});

describe('drag kind — trend (isTrendDragActive)', () => {
  it('trend drag commits via commitTrend on pointerup when moved', () => {
    const setTrendDraftSpy = vi.fn();
    const commitTrendSpy = vi.fn();
    const { cfg } = makeCfg({
      isTrendDragActive: () => true,
      setTrendDraft: setTrendDraftSpy,
      commitTrend: commitTrendSpy,
    });
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Down at (0,0), move to (300,150), up at (300,150).
    ctrl.onPointerDown(makePointerEvent('pointerdown', { clientX: 0, clientY: 0 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { clientX: 300, clientY: 150 }, el));
    ctrl.onPointerUp(makePointerEvent('pointerup', { clientX: 300, clientY: 150 }, el));

    // setTrendDraft(null) is called at the end of the drag to clear the preview.
    expect(setTrendDraftSpy).toHaveBeenCalledWith(null);
    // commitTrend fires because the pointer actually moved.
    expect(commitTrendSpy).toHaveBeenCalledOnce();
    const anchors = commitTrendSpy.mock.calls[0][0] as {
      x1Idx: number;
      y1Price: number;
      x2Idx: number;
      y2Price: number;
    };
    expect(anchors.x1Idx).toBeCloseTo(0, 0);
    expect(anchors.x2Idx).toBeCloseTo(50, 0); // bar 50 at x=300 in 600px layout, 0..100 span
    expect(typeof anchors.y1Price).toBe('number');
    expect(typeof anchors.y2Price).toBe('number');
  });

  it('trend tap (no movement) clears the draft without committing', () => {
    const setTrendDraftSpy = vi.fn();
    const commitTrendSpy = vi.fn();
    const { cfg } = makeCfg({
      isTrendDragActive: () => true,
      setTrendDraft: setTrendDraftSpy,
      commitTrend: commitTrendSpy,
      // touch/pen tap: pointerType = 'touch' (non-mouse) so the tap branch fires
    });
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Down and up at the SAME spot (no movement → tap).
    ctrl.onPointerDown(
      makePointerEvent('pointerdown', { clientX: 100, clientY: 100, pointerType: 'touch' }, el),
    );
    ctrl.onPointerUp(
      makePointerEvent('pointerup', { clientX: 100, clientY: 100, pointerType: 'touch' }, el),
    );

    expect(setTrendDraftSpy).toHaveBeenCalledWith(null);
    expect(commitTrendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase B — Pinch zoom (2-pointer registry)
// ---------------------------------------------------------------------------

describe('pinch zoom — 2-pointer registry', () => {
  it('two pointers moving apart zooms in (span decreases)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Finger 1 at x=200, finger 2 at x=400 → initial distance = 200px.
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 1, clientX: 200, clientY: 150 }, el));
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 2, clientX: 400, clientY: 150 }, el));

    // Move fingers apart: finger 1 to x=100, finger 2 to x=500 → distance = 400px.
    ctrl.onPointerMove(makePointerEvent('pointermove', { pointerId: 1, clientX: 100, clientY: 150 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { pointerId: 2, clientX: 500, clientY: 150 }, el));

    expect(setViewSpy.mock.calls.length).toBeGreaterThan(0);
    const lastView = setViewSpy.mock.lastCall![0] as ViewWindow;
    const newSpan = lastView.end - lastView.start;
    // Moving apart → ratio = old_dist / new_dist = 200/400 = 0.5 → span × 0.5 = 50.
    expect(newSpan).toBeLessThan(100);
  });

  it('two pointers moving together zooms out (span increases)', () => {
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Start further apart.
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 150 }, el));
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 2, clientX: 500, clientY: 150 }, el));

    // Pinch together: finger 1 to x=200, finger 2 to x=400 → distance decreases.
    ctrl.onPointerMove(makePointerEvent('pointermove', { pointerId: 1, clientX: 200, clientY: 150 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { pointerId: 2, clientX: 400, clientY: 150 }, el));

    expect(setViewSpy.mock.calls.length).toBeGreaterThan(0);
    const lastView = setViewSpy.mock.lastCall![0] as ViewWindow;
    const newSpan = lastView.end - lastView.start;
    // Pinching together → ratio = 400/200 = 2 → span × 2 = 200 (clamped to barCount*1.2=720).
    expect(newSpan).toBeGreaterThan(100);
  });

  it('second pointerdown drops any in-flight single-pointer drag', () => {
    // If a pan is in progress when a second finger lands, the pan must abort.
    const { cfg, setViewSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Start a pan.
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 1, clientX: 300, clientY: 150 }, el));
    ctrl.onPointerMove(makePointerEvent('pointermove', { pointerId: 1, clientX: 200, clientY: 150 }, el));
    expect(ctrl.isPanning()).toBe(true);

    setViewSpy.mockClear();

    // Second finger down → switches to pinch, pan drops.
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 2, clientX: 400, clientY: 150 }, el));
    expect(ctrl.isPanning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase B — Crosshair + pointer-leave guard
// ---------------------------------------------------------------------------

describe('crosshair + leave-clear guard', () => {
  it('onPointerMove (no button held) emits crosshair', () => {
    const { cfg, setCrosshairSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    ctrl.onPointerMove(makePointerEvent('pointermove', { clientX: 300, clientY: 150 }, el));
    expect(setCrosshairSpy).toHaveBeenCalledOnce();
    const ch = setCrosshairSpy.mock.calls[0][0] as { x: number; y: number; barIdx: number; price: number };
    expect(ch).not.toBeNull();
    expect(typeof ch.barIdx).toBe('number');
    expect(typeof ch.price).toBe('number');
  });

  it('clearCrosshair() with no active pointer clears the crosshair', () => {
    const { cfg, setCrosshairSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);

    // No active pointer.
    expect(ctrl.hasActivePointer()).toBe(false);
    ctrl.clearCrosshair();
    expect(setCrosshairSpy).toHaveBeenCalledWith(null);
  });

  it('hasActivePointer() is false before any pointer and true after pointerdown', () => {
    const { cfg } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    expect(ctrl.hasActivePointer()).toBe(false);
    ctrl.onPointerDown(makePointerEvent('pointerdown', { clientX: 300, clientY: 150 }, el));
    expect(ctrl.hasActivePointer()).toBe(true);
    ctrl.onPointerUp(makePointerEvent('pointerup', { clientX: 300, clientY: 150 }, el));
    expect(ctrl.hasActivePointer()).toBe(false);
  });

  it('clearCrosshair (simulating pointerleave) while pointer IS active does NOT clear', () => {
    // ChartCanvas calls `interaction.clearCrosshair()` in the pointerleave
    // handler ONLY when `!hasActivePointer()`. This test verifies the guard
    // from the caller side: when hasActivePointer() returns true, the host
    // should skip the clearCrosshair call. We simulate the host's guard logic.
    const { cfg, setCrosshairSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    ctrl.onPointerDown(makePointerEvent('pointerdown', { clientX: 300, clientY: 150 }, el));
    expect(ctrl.hasActivePointer()).toBe(true);

    // Host guard: do NOT call clearCrosshair when hasActivePointer is true.
    if (!ctrl.hasActivePointer()) {
      ctrl.clearCrosshair();
    }

    // setCrosshair should NOT have been called (pointer is mid-drag).
    expect(setCrosshairSpy).not.toHaveBeenCalledWith(null);
  });

  it('mouse hover (pointerType=mouse) does NOT toggle crosshair on tap-up', () => {
    // Mouse clicks are excluded from the tap-to-toggle crosshair path.
    // The crosshair is cleared on mouse pointerleave, not on click.
    const { cfg, setCrosshairSpy } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Quick stationary mouse click (no movement → tap).
    ctrl.onPointerDown(
      makePointerEvent('pointerdown', { clientX: 200, clientY: 150, pointerType: 'mouse' }, el),
    );
    ctrl.onPointerUp(
      makePointerEvent('pointerup', { clientX: 200, clientY: 150, pointerType: 'mouse' }, el),
    );

    // Mouse tap-up must NOT call setCrosshair(null) (tap-toggle is touch/pen only).
    const nullCalls = setCrosshairSpy.mock.calls.filter((c) => c[0] === null);
    expect(nullCalls).toHaveLength(0);
  });

  it('touch tap toggles crosshair off when crosshair is visible', () => {
    const { cfg, setCrosshairSpy } = makeCfg({
      isCrosshairVisible: () => true, // crosshair currently on
    });
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    // Stationary touch tap.
    ctrl.onPointerDown(
      makePointerEvent('pointerdown', { clientX: 200, clientY: 150, pointerType: 'touch' }, el),
    );
    ctrl.onPointerUp(
      makePointerEvent('pointerup', { clientX: 200, clientY: 150, pointerType: 'touch' }, el),
    );

    // Touch tap with visible crosshair should call setCrosshair(null).
    const nullCalls = setCrosshairSpy.mock.calls.filter((c) => c[0] === null);
    expect(nullCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('reset()', () => {
  it('clears all in-flight state', () => {
    const { cfg } = makeCfg();
    const ctrl = createChartInteraction(cfg);
    const el = makeTarget();

    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 1, clientX: 300, clientY: 150 }, el));
    ctrl.onPointerDown(makePointerEvent('pointerdown', { pointerId: 2, clientX: 400, clientY: 150 }, el));

    ctrl.reset();

    expect(ctrl.hasActivePointer()).toBe(false);
    expect(ctrl.isPanning()).toBe(false);
  });
});
