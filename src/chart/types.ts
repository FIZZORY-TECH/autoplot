/**
 * src/chart/types.ts — Core chart types & RenderContext
 *
 * The `RenderContext` is the substrate every renderer (P1.3) and overlay
 * consumes. ChartCanvas (P1.2) constructs it once per frame and dispatches.
 *
 * `Bar` is imported from the FROZEN MarketDataProvider interface (A3).
 */

import type { Bar } from '../data/MarketDataProvider';
import type { HitRegion } from './hitRegions';

/** Visible window over the bar array + the y-axis range to map prices into pixels. */
export interface ViewWindow {
  /** Bar index, inclusive. May be fractional during pan/zoom; floor for slicing. */
  start: number;
  /** Bar index, exclusive. May be fractional. */
  end: number;
  /** Y-axis lower bound (price). */
  yMin: number;
  /** Y-axis upper bound (price). */
  yMax: number;
}

/** Plot-area layout in CSS pixels (NOT device pixels — DPR is applied in ctx transform). */
export interface ChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Theme tokens resolved from CSS custom properties at runtime.
 * ChartCanvas reads these once on mount via getComputedStyle(document.documentElement).
 */
export interface ThemeTokens {
  up: string;
  down: string;
  grid: string;
  hairline: string;
  fg: string;
  bg: string;
}

/** Everything a renderer needs to draw one frame. */
export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  bars: Bar[];
  view: ViewWindow;
  theme: ThemeTokens;
  dpr: number;
  layout: ChartLayout;
  /**
   * Shared overlay-hotspot registry (Step 5). When present, interactive
   * overlay renderers PUSH a `HitRegion` for each glyph they draw, in CSS-px
   * space. ChartCanvas resets it (`length = 0`) once at the top of each frame;
   * renderers never reset. Absent in unit-test stubs and non-interactive draws.
   */
  hitRegions?: HitRegion[];
}

/** P1.3 implements this for each chart type (candles / heikin / bars / line / area / mountain). */
export interface ChartRenderer {
  render(ctx: RenderContext): void;
}
