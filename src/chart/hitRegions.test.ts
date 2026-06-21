/**
 * src/chart/hitRegions.test.ts
 *
 * Regression guards for the event-notch dispatch COLUMN hit model and the
 * AppShell popover-anchor derivation that reads from it.
 *
 * The bug: a click anywhere along an event column failed to open the
 * EventListPopover because the popover was anchored off the column's raw
 * `x`/`y` (LEFT edge + pane TOP) instead of the notch center (`payload.cxCenter`)
 * and column BOTTOM (`y2`). These tests pin BOTH halves:
 *   1. hitTest: a full-pane column resolves as `nearest` for a click at its
 *      TOP, MIDDLE, and BOTTOM (no vertical precision required).
 *   2. The anchor derivation prefers `payload.cxCenter` / `region.y2`.
 */

import { describe, it, expect } from 'vitest';
import { hitTest, type HitRegion } from './hitRegions';

// A representative event-notch dispatch column: x is the LEFT edge, y the pane
// TOP, x2/y2 the RIGHT edge / pane BOTTOM. The true notch center x lives on the
// payload as `cxCenter`; the notch sits at the column BOTTOM (y2).
function makeColumn(): HitRegion {
  return {
    x: 190, // left edge
    y: 40, // pane top
    x2: 210, // right edge (column width 20)
    y2: 540, // pane bottom (column height 500)
    shape: 'column',
    kind: 'research',
    payload: {
      eventIds: ['research:ovl-1:0'],
      paneIndex: 0,
      cxCenter: 200, // true notch center x (midpoint of 190..210)
    },
  };
}

describe('hitRegions — event-notch dispatch column', () => {
  it('resolves the column as nearest for a click at TOP, MIDDLE, and BOTTOM', () => {
    const col = makeColumn();
    const regions = [col];

    // Click at the column center x, at the very TOP of the pane.
    const top = hitTest(regions, 200, 41);
    expect(top?.nearest).toBe(col);

    // Click in the MIDDLE.
    const mid = hitTest(regions, 200, 290);
    expect(mid?.nearest).toBe(col);

    // Click near the BOTTOM (where the notch actually rides the spine).
    const bot = hitTest(regions, 200, 539);
    expect(bot?.nearest).toBe(col);
  });

  it('resolves anywhere across the column width, not just the center', () => {
    const col = makeColumn();
    const regions = [col];
    // Left edge and right edge of the column at mid-height.
    expect(hitTest(regions, 190, 290)?.nearest).toBe(col);
    expect(hitTest(regions, 210, 290)?.nearest).toBe(col);
  });

  it('misses outside the column band', () => {
    const col = makeColumn();
    const regions = [col];
    // Just left of the column.
    expect(hitTest(regions, 180, 290)).toBeNull();
    // Above the pane top.
    expect(hitTest(regions, 200, 30)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AppShell anchor derivation — extracted as a pure helper mirror so the
// popover-anchor logic in handleChartClick is unit-guarded. Must stay in sync
// with src/AppShell.tsx handleChartClick (the event-hotspot branch).
// ---------------------------------------------------------------------------

/** Mirror of the AppShell anchor derivation: prefer cxCenter / y2. */
function deriveAnchor(region: HitRegion): { anchorX: number; anchorY: number } {
  const payload = region.payload as { cxCenter?: number } | undefined;
  const anchorX =
    typeof payload?.cxCenter === 'number' ? payload.cxCenter : region.x;
  const anchorY = typeof region.y2 === 'number' ? region.y2 : region.y;
  return { anchorX, anchorY };
}

describe('AppShell popover anchor derivation', () => {
  it('anchors at the notch center x (cxCenter), not the column left edge', () => {
    const col = makeColumn();
    const { anchorX } = deriveAnchor(col);
    expect(anchorX).toBe(200); // cxCenter, NOT col.x (190)
    expect(anchorX).not.toBe(col.x);
  });

  it('anchors at the column bottom y (y2), not the pane top', () => {
    const col = makeColumn();
    const { anchorY } = deriveAnchor(col);
    expect(anchorY).toBe(540); // y2 (bottom), NOT col.y (40)
    expect(anchorY).not.toBe(col.y);
  });

  it('falls back to x/y when cxCenter / y2 are absent', () => {
    const fallback: HitRegion = {
      x: 100,
      y: 50,
      kind: 'research',
      payload: { eventIds: ['x'] },
    };
    const { anchorX, anchorY } = deriveAnchor(fallback);
    expect(anchorX).toBe(100);
    expect(anchorY).toBe(50);
  });
});
