/**
 * src/chart/interaction.test.ts — Unit tests for the pure interaction helpers.
 *
 * The DOM event handlers are integration-tested via Playwright (P1.4 / P2.7).
 * Here we just verify the math primitives — px<->bar, anchor zoom, clamp.
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from './interaction';

const { pxToBarX, pxToPrice, zoomAround, clampWindow, BAR_PAD, LEFT_PAD, MIN_WINDOW_BARS } = __test__;

describe('interaction.pxToBarX', () => {
  it('maps the left edge to view.start and right edge to view.end', () => {
    const view = { start: 100, end: 200, yMin: 0, yMax: 1 };
    const layout = { x: 10, y: 0, w: 500, h: 100 };
    expect(pxToBarX(10, view, layout)).toBe(100);
    expect(pxToBarX(510, view, layout)).toBeCloseTo(200, 6);
  });

  it('is linear across the plot', () => {
    const view = { start: 0, end: 100, yMin: 0, yMax: 1 };
    const layout = { x: 0, y: 0, w: 100, h: 100 };
    expect(pxToBarX(50, view, layout)).toBe(50);
  });
});

describe('interaction.pxToPrice', () => {
  it('inverts the y axis (top = yMax, bottom = yMin)', () => {
    const view = { start: 0, end: 1, yMin: 100, yMax: 200 };
    const layout = { x: 0, y: 0, w: 1, h: 100 };
    expect(pxToPrice(0, view, layout)).toBe(200);
    expect(pxToPrice(100, view, layout)).toBe(100);
    expect(pxToPrice(50, view, layout)).toBe(150);
  });
});

describe('interaction.zoomAround', () => {
  it('keeps the focus bar at the same fractional position post-zoom', () => {
    const view = { start: 0, end: 100, yMin: 0, yMax: 1 };
    const focusIdx = 70;
    const out = zoomAround(view, focusIdx, 50);
    // ratio in old window: 70 / 100 = 0.7
    // new window must satisfy: focus = start + 0.7 * 50 → start = 35, end = 85
    expect(out.start).toBeCloseTo(35, 6);
    expect(out.end).toBeCloseTo(85, 6);
  });

  it('handles span widening (zoom out) symmetrically', () => {
    const view = { start: 100, end: 200, yMin: 0, yMax: 1 };
    const out = zoomAround(view, 150, 200);
    // ratio = (150 - 100) / 100 = 0.5 → start = 150 - 0.5 * 200 = 50
    expect(out.start).toBeCloseTo(50, 6);
    expect(out.end).toBeCloseTo(250, 6);
  });
});

describe('interaction.clampWindow', () => {
  it('does not change windows already inside bounds', () => {
    const out = clampWindow(10, 50, 600);
    expect(out).toEqual({ start: 10, end: 50 });
  });

  it('shifts a window past the right edge back into bounds', () => {
    const out = clampWindow(700, 800, 600);
    expect(out.end).toBeLessThanOrEqual(600 + BAR_PAD);
  });

  it('shifts a window past the left edge back into bounds (Step 4: left clamp uses LEFT_PAD)', () => {
    // Step 4 relaxed the left clamp from -BAR_PAD to -LEFT_PAD so the
    // scroll-back trigger can arm. The right-edge BAR_PAD gutter is unchanged.
    const out = clampWindow(-200, -100, 600);
    expect(out.start).toBeGreaterThanOrEqual(-LEFT_PAD);
    // Sanity: the new clamp is more permissive than the old one
    expect(-LEFT_PAD).toBeLessThan(-BAR_PAD);
  });
});

describe('interaction constants', () => {
  it('locks the minimum window to 10 bars', () => {
    expect(MIN_WINDOW_BARS).toBe(10);
  });
});
