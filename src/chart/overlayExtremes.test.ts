/**
 * src/chart/overlayExtremes.test.ts
 *
 * Verifies the y-range union math across alignment modes, with focus on the
 * panned-window / prepend regression: 'data-right-aligned' research sources
 * must pin to the DATASET end (barCount), so panning left changes which values
 * are visible (and therefore contribute) WITHOUT sliding the anchor — while the
 * pre-existing 'right-aligned' (visible-edge) mode is left intact.
 */

import { describe, it, expect } from 'vitest';
import { collectOverlayExtremes } from './overlayExtremes';

describe('collectOverlayExtremes — bar-aligned', () => {
  it('unions only the visible slice', () => {
    const values = [10, 20, 30, 40, 50]; // bars 0..4
    // Visible window bars 1..3 (end exclusive ceil) → values 20,30,40.
    const { lo, hi } = collectOverlayExtremes([{ values, align: 'bar-aligned' }], 1, 3, 5);
    expect(lo).toBe(20);
    expect(hi).toBe(30); // hi0 = ceil(3) = 3 exclusive → indices 1,2 → 20,30
  });
});

describe("collectOverlayExtremes — 'data-right-aligned' pins to dataset end", () => {
  // 5 values pinned to the last 5 bars of a 100-bar dataset → bars 95..99.
  const values = [10, 20, 30, 40, 50];

  it('contributes nothing when the series is fully out of the panned window', () => {
    // View bars 0..10 — the series lives on bars 95..99 → off-screen.
    const { lo, hi } = collectOverlayExtremes(
      [{ values, align: 'data-right-aligned' }],
      0,
      10,
      100,
    );
    expect(lo).toBe(Infinity);
    expect(hi).toBe(-Infinity);
  });

  it('contributes only the visible tail when partially in view', () => {
    // View bars 97..100 → visible bars 97,98,99 → series indices 2,3,4 → 30,40,50.
    const { lo, hi } = collectOverlayExtremes(
      [{ values, align: 'data-right-aligned' }],
      97,
      100,
      100,
    );
    expect(lo).toBe(30);
    expect(hi).toBe(50);
  });

  it('tracks the new dataset end after a prepend (barCount grows)', () => {
    // 20 bars prepended → dataset is 120 bars; series now sits on bars 115..119.
    // The same visible-of-last-3 window must still surface 30,40,50.
    const { lo, hi } = collectOverlayExtremes(
      [{ values, align: 'data-right-aligned' }],
      117,
      120,
      120,
    );
    expect(lo).toBe(30);
    expect(hi).toBe(50);
  });

  it("falls back to visible-edge anchoring when barCount is omitted", () => {
    // Without barCount, dataEnd = ceil(end) = 100 → identical to the data-end
    // case here (window right edge == dataset end).
    const { lo, hi } = collectOverlayExtremes(
      [{ values, align: 'data-right-aligned' }],
      97,
      100,
    );
    expect(lo).toBe(30);
    expect(hi).toBe(50);
  });
});

describe('collectOverlayExtremes — { constant } (hline price)', () => {
  it('contributes the constant unconditionally regardless of the window', () => {
    // The constant lands in the union no matter how the view is panned.
    const { lo, hi } = collectOverlayExtremes([{ constant: 50000 }], 0, 10, 100);
    expect(lo).toBe(50000);
    expect(hi).toBe(50000);
  });

  it('unions a constant alongside positional sources', () => {
    const values = [10, 20, 30, 40, 50]; // bars 0..4
    // Visible window bars 0..5 → bar values 10..50; constant widens hi to 99.
    const { lo, hi } = collectOverlayExtremes(
      [{ values, align: 'bar-aligned' }, { constant: 99 }],
      0,
      5,
      5,
    );
    expect(lo).toBe(10);
    expect(hi).toBe(99);
  });

  it('ignores a non-finite constant', () => {
    const { lo, hi } = collectOverlayExtremes([{ constant: Number.NaN }], 0, 10, 100);
    expect(lo).toBe(Infinity);
    expect(hi).toBe(-Infinity);
  });
});

describe("collectOverlayExtremes — 'right-aligned' (visible edge) is unchanged", () => {
  it('pins the last value to the visible right edge regardless of barCount', () => {
    const values = [10, 20, 30]; // hugs whatever the view's right edge is.
    // Visible window bars 50..53; right edge bar 52 (hi0=53 exclusive).
    // seriesStart = 53 - 3 = 50 → bars 50,51,52 → values 10,20,30.
    const { lo, hi } = collectOverlayExtremes(
      [{ values, align: 'right-aligned' }],
      50,
      53,
      100, // barCount must NOT affect this mode
    );
    expect(lo).toBe(10);
    expect(hi).toBe(30);
  });
});
