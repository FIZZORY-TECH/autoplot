/**
 * Tests for src/chart/layers/TimelineEventsLayer.ts
 *
 * The renderer is a canvas-drawing function — we test it via a stub canvas
 * context (same approach as signals.test.ts). We assert on draw calls to
 * confirm the right number of glyphs render for a given input.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderTimelineEvents } from '../TimelineEventsLayer';
import type { RenderContext } from '../../types';
import type { TimelineLayer } from '../../../stores/useChartMutationStore';

// ---------------------------------------------------------------------------
// Minimal canvas context stub
// ---------------------------------------------------------------------------

function makeCtx() {
  const calls: string[] = [];
  const ctx = {
    save: vi.fn(() => calls.push('save')),
    restore: vi.fn(() => calls.push('restore')),
    beginPath: vi.fn(() => calls.push('beginPath')),
    moveTo: vi.fn(() => calls.push('moveTo')),
    lineTo: vi.fn(() => calls.push('lineTo')),
    closePath: vi.fn(() => calls.push('closePath')),
    fill: vi.fn(() => calls.push('fill')),
    stroke: vi.fn(() => calls.push('stroke')),
    fillRect: vi.fn(() => calls.push('fillRect')),
    fillText: vi.fn(() => calls.push('fillText')),
    setLineDash: vi.fn(),
    font: '',
    textAlign: '' as CanvasTextAlign,
    textBaseline: '' as CanvasTextBaseline,
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    calls,
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[] };
}

// ---------------------------------------------------------------------------
// Minimal render context factory
// ---------------------------------------------------------------------------

function makeRC(barCount = 10): RenderContext {
  const bars = Array.from({ length: barCount }, (_, i) => ({
    ts: (i + 1) * 60_000, // 1-minute bars
    o: 100, h: 110, l: 90, c: 105, v: 1000,
  }));
  return {
    ctx: makeCtx() as unknown as CanvasRenderingContext2D,
    bars,
    view: { start: 0, end: barCount, yMin: 80, yMax: 120 },
    theme: { up: '#0f0', down: '#f00', grid: '#111', hairline: '#222', fg: '#aaa', bg: '#000' },
    dpr: 1,
    layout: { x: 10, y: 10, w: 400, h: 200 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderTimelineEvents', () => {
  it('renders nothing when layers record is empty', () => {
    const rc = makeRC();
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    renderTimelineEvents(rc.ctx, rc, {});
    expect(ctx.calls).toEqual([]); // no draw calls at all
  });

  it('renders nothing when bars array is empty', () => {
    const rc = makeRC(0);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l1',
      name: 'FOMC',
      events: [{ ts: 60_000, label: 'Pin event', kind: 'pin' }],
    };
    renderTimelineEvents(rc.ctx, rc, { l1: layer });
    expect(ctx.calls).toEqual([]);
  });

  it('renders a fill call for each pin event', () => {
    const rc = makeRC(10);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l1',
      name: 'FOMC',
      events: [
        { ts: 120_000, label: 'Pin A', kind: 'pin' },
        { ts: 360_000, label: 'Pin B', kind: 'pin' },
      ],
    };
    renderTimelineEvents(rc.ctx, rc, { l1: layer });
    // Each pin draws a diamond (fill) + a fillText for the label.
    const fillCount = ctx.calls.filter((c) => c === 'fill').length;
    const textCount = ctx.calls.filter((c) => c === 'fillText').length;
    expect(fillCount).toBe(2); // one diamond per pin
    expect(textCount).toBe(2); // one label per pin
  });

  it('renders a stroke (vertical line) for vline events', () => {
    const rc = makeRC(10);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l2',
      name: 'Rate decision',
      events: [{ ts: 240_000, label: 'FOMC', kind: 'vline' }],
    };
    renderTimelineEvents(rc.ctx, rc, { l2: layer });
    const strokeCount = ctx.calls.filter((c) => c === 'stroke').length;
    expect(strokeCount).toBeGreaterThanOrEqual(1);
  });

  it('renders fillRect for range events', () => {
    const rc = makeRC(10);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l3',
      name: 'Window',
      events: [{ ts: 180_000, label: 'Range', kind: 'range' }],
    };
    renderTimelineEvents(rc.ctx, rc, { l3: layer });
    const rectCount = ctx.calls.filter((c) => c === 'fillRect').length;
    expect(rectCount).toBe(1);
  });
});
