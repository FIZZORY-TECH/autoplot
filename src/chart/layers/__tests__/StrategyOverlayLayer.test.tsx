/**
 * Tests for src/chart/layers/StrategyOverlayLayer.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { renderStrategyOverlays } from '../StrategyOverlayLayer';
import type { RenderContext } from '../../types';
import type { StrategyOverlay } from '../../../stores/useChartMutationStore';

// ---------------------------------------------------------------------------
// Minimal canvas context stub
// ---------------------------------------------------------------------------

function makeCtx() {
  const calls: string[] = [];
  return {
    save: vi.fn(() => calls.push('save')),
    restore: vi.fn(() => calls.push('restore')),
    beginPath: vi.fn(() => calls.push('beginPath')),
    moveTo: vi.fn(() => calls.push('moveTo')),
    lineTo: vi.fn(() => calls.push('lineTo')),
    closePath: vi.fn(() => calls.push('closePath')),
    fill: vi.fn(() => calls.push('fill')),
    stroke: vi.fn(() => calls.push('stroke')),
    fillText: vi.fn(() => calls.push('fillText')),
    setLineDash: vi.fn(),
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    globalAlpha: 1,
    calls,
  } as unknown as CanvasRenderingContext2D & { calls: string[] };
}

function makeRC(barCount = 10): RenderContext {
  const bars = Array.from({ length: barCount }, (_, i) => ({
    ts: (i + 1) * 60_000,
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

function makeOverlay(signals: Array<{ ts: number; side: 'long' | 'short' }>): StrategyOverlay {
  return {
    id: 'strat-1',
    bodyJson: JSON.stringify({ id: 'strat-1', name: 'Test', version: 1, signals }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderStrategyOverlays', () => {
  it('renders nothing when overlays record is empty', () => {
    const rc = makeRC();
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    renderStrategyOverlays(rc.ctx, rc, {});
    expect(ctx.calls).toEqual([]);
  });

  it('renders nothing when bars array is empty', () => {
    const rc = makeRC(0);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const overlay = makeOverlay([{ ts: 60_000, side: 'long' }]);
    renderStrategyOverlays(rc.ctx, rc, { s1: overlay });
    expect(ctx.calls).toEqual([]);
  });

  it('renders a fill per signal when signals are present', () => {
    const rc = makeRC(10);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const overlay = makeOverlay([
      { ts: 120_000, side: 'long' },
      { ts: 300_000, side: 'short' },
    ]);
    renderStrategyOverlays(rc.ctx, rc, { s1: overlay });
    // Each signal draws one filled triangle.
    const fillCount = ctx.calls.filter((c) => c === 'fill').length;
    expect(fillCount).toBe(2);
  });

  it('renders no signals when bodyJson has no signals array', () => {
    const rc = makeRC(10);
    const ctx = rc.ctx as unknown as ReturnType<typeof makeCtx>;
    const overlay: StrategyOverlay = {
      id: 's2',
      bodyJson: JSON.stringify({ id: 's2', name: 'No signals', version: 1 }),
    };
    renderStrategyOverlays(rc.ctx, rc, { s2: overlay });
    // save/restore only (no draw calls inside the loop)
    const fillCount = ctx.calls.filter((c) => c === 'fill').length;
    expect(fillCount).toBe(0);
  });
});
