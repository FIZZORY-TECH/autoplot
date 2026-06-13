/**
 * src/chart/trends.test.ts — Unit tests for the trend-line helpers.
 *
 * The renderer itself is integration-tested in Playwright (Step 4 e2e).
 * Here we just verify:
 *   - distToSegment math (the building block of hit-testing)
 *   - findTrendAt returns the closest trend within threshold and null otherwise
 */

import { describe, expect, it } from 'vitest';
import { __test__, findTrendAt } from './trends';
import type { TrendRow } from '../lib/db';

const { distToSegment } = __test__;

// ---------------------------------------------------------------------------
// distToSegment
// ---------------------------------------------------------------------------

describe('trends.distToSegment', () => {
  it('returns 0 when the point is on the segment', () => {
    expect(distToSegment(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 6);
  });

  it('returns the perpendicular distance for a point above the segment', () => {
    expect(distToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 6);
  });

  it('clamps to the nearer endpoint when the projection is past the end', () => {
    // Point well beyond the right endpoint — distance is to (10,0).
    expect(distToSegment(20, 0, 0, 0, 10, 0)).toBeCloseTo(10, 6);
  });

  it('handles a degenerate (zero-length) segment as point distance', () => {
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 6);
  });
});

// ---------------------------------------------------------------------------
// findTrendAt
// ---------------------------------------------------------------------------

function makeTrend(id: string, x1: number, y1: number, x2: number, y2: number): TrendRow {
  return {
    id,
    sym: 'BTC',
    provider: 'coinbase',
    quote: 'USD',
    tf: '1h',
    x1_ts: x1,
    y1_price: y1,
    x2_ts: x2,
    y2_price: y2,
    color: 'accent',
    created_at: 0,
  };
}

describe('trends.findTrendAt', () => {
  // For these tests we contrive bars whose ts == bar-index, so x_ts maps
  // straight through tsToBarIdx without surprises.
  const bars = Array.from({ length: 20 }, (_, i) => ({ ts: i }));
  const view = { start: 0, end: 20, yMin: 0, yMax: 100 };
  const layout = { x: 0, y: 0, w: 200, h: 100 };

  it('returns null when no trends exist', () => {
    expect(findTrendAt([], bars, view, layout, 50, 50, 6)).toBeNull();
  });

  it('returns null when the click is far from every trend', () => {
    const t = makeTrend('a', 0, 50, 20, 50);
    // Trend at price=50 → y=50 in pixel space. Click at y=10 → 40px away,
    // far above the 6px threshold.
    expect(findTrendAt([t], bars, view, layout, 100, 10, 6)).toBeNull();
  });

  it('returns the trend when the click is within threshold', () => {
    const t = makeTrend('a', 0, 50, 20, 50);
    // Click directly on the segment.
    expect(findTrendAt([t], bars, view, layout, 100, 50, 6)?.id).toBe('a');
  });

  it('returns the closest trend when multiple are near', () => {
    const t1 = makeTrend('far', 0, 60, 20, 60);    // y=40px in pixel space
    const t2 = makeTrend('near', 0, 50, 20, 50);   // y=50px in pixel space
    // Click at y=51 — t2 is 1px away, t1 is 11px away.
    const hit = findTrendAt([t1, t2], bars, view, layout, 100, 51, 6);
    expect(hit?.id).toBe('near');
  });
});
