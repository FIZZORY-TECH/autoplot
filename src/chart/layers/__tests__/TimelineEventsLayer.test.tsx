/**
 * Tests for src/chart/layers/TimelineEventsLayer.ts
 *
 * The renderer is a canvas-drawing function — we test it via a stub canvas
 * context (same approach as signals.test.ts). We assert on draw calls to
 * confirm the right number of glyphs render for a given input.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderTimelineEvents,
  timelineEventId,
  _resetNotchTokens,
} from '../TimelineEventsLayer';
import type { RenderContext } from '../../types';
import type { HitRegion } from '../../hitRegions';
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
    arc: vi.fn(() => calls.push('arc')),
    arcTo: vi.fn(() => calls.push('arcTo')),
    closePath: vi.fn(() => calls.push('closePath')),
    fill: vi.fn(() => calls.push('fill')),
    stroke: vi.fn(() => calls.push('stroke')),
    fillRect: vi.fn(() => calls.push('fillRect')),
    fillText: vi.fn(() => calls.push('fillText')),
    measureText: vi.fn(() => ({ width: 20 })),
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

function makeRC(barCount = 10, hitRegions?: HitRegion[]): RenderContext {
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
    hitRegions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderTimelineEvents', () => {
  beforeEach(() => _resetNotchTokens());

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

  it('renders each event as a dispatch notch with a generous hit region', () => {
    const hitRegions: HitRegion[] = [];
    const rc = makeRC(10, hitRegions);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l1',
      name: 'FOMC',
      events: [
        { ts: 120_000, label: 'Pin A', kind: 'pin' }, // bar 1
        { ts: 360_000, label: 'Pin B', kind: 'pin' }, // bar 5
      ],
    };
    renderTimelineEvents(rc.ctx, rc, { l1: layer });

    // Notches are roundRect tabs (arcTo) + fill — no diamond/label text.
    expect(ctx.calls.filter((c) => c === 'fillText').length).toBe(0);
    expect(ctx.calls.filter((c) => c === 'arcTo').length).toBeGreaterThanOrEqual(1);

    // Two distinct bars → two full-pane-height COLUMN hit regions, kind 'timelinePin'.
    expect(hitRegions.length).toBe(2);
    for (const r of hitRegions) {
      expect(r.kind).toBe('timelinePin');
      // New target model: a full-pane-height column (not a radius circle).
      expect(r.shape).toBe('column');
      expect(r.y).toBe(10); // pane top (layout.y)
      expect(r.y2).toBe(210); // pane bottom (layout.y + layout.h)
      expect((r.x2 ?? 0) - r.x).toBeGreaterThanOrEqual(36); // ≥36px wide (±18)
      expect((r.payload as { eventIds: string[] }).eventIds.length).toBe(1);
      expect((r.payload as { paneIndex: number }).paneIndex).toBe(0);
    }
  });

  it('merges coincident events into ONE notch carrying every eventId + count badge', () => {
    const hitRegions: HitRegion[] = [];
    const rc = makeRC(10, hitRegions);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l1',
      name: 'FOMC',
      events: [
        { ts: 120_000, label: 'A', kind: 'pin' }, // bar 1
        { ts: 120_000, label: 'B', kind: 'vline' }, // bar 1 (coincident)
      ],
    };
    renderTimelineEvents(rc.ctx, rc, { l1: layer });

    // One cluster → one hit region carrying BOTH ids (in event order).
    expect(hitRegions.length).toBe(1);
    const payload = hitRegions[0]!.payload as { eventIds: string[] };
    expect(payload.eventIds).toEqual([timelineEventId('l1', 0), timelineEventId('l1', 1)]);
    // A count badge (text) renders for N>1 (badge digit via fillText).
    expect(ctx.calls.filter((c) => c === 'fillText').length).toBe(1);
  });

  it('renders fillRect span for range events (the notch hotspot anchors at ts)', () => {
    const hitRegions: HitRegion[] = [];
    const rc = makeRC(10, hitRegions);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const layer: TimelineLayer = {
      id: 'l3',
      name: 'Window',
      events: [{ ts: 180_000, label: 'Range', kind: 'range' }],
    };
    renderTimelineEvents(rc.ctx, rc, { l3: layer });
    // The range still shades its span.
    expect(ctx.calls.filter((c) => c === 'fillRect').length).toBe(1);
    // And registers exactly one notch hotspot at its start ts.
    expect(hitRegions.length).toBe(1);
  });
});
