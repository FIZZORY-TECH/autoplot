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
 * ── Stacked-pane model (S2) ─────────────────────────────────────────────────
 *
 * A sub-chart pane sits below the main price chart for non-price-scaled series
 * (e.g. RSI 0–100). All panes SHARE the time axis via the single
 * `ViewWindow.start/end`; each pane owns an INDEPENDENT y-scale (`PaneView`).
 *
 * LOW-RIPPLE by design: `RenderContext.layout` stays a single `ChartLayout`
 * rect = the ACTIVE pane's rect. Individual layer renderers
 * (GenericResearchLayer, StrategyOverlayLayer, TimelineEventsLayer,
 * drawGrid/drawYAxis/drawXAxis) are UNCHANGED — they still read one rect + one
 * view. The S4 draw coordinator in ChartCanvas loops the panes and dispatches
 * each layer once per pane with THAT pane's rect + view.
 *
 * `projection.ts` is untouched: `barIdxToPx(idx, view, layout)` already accepts
 * any rect, so feeding it a sub-pane's rect makes x-sync across panes automatic.
 */

/** One stacked pane in the chart. */
export interface Pane {
  /** 'price' = the main candle/line chart; 'series' = a non-price sub-pane (e.g. RSI). */
  kind: 'price' | 'series';
  /** Optional axis/title label for the pane (e.g. "RSI"). */
  label?: string;
}

/**
 * Per-pane y-bounds. The x-range is shared via `ViewWindow.start/end`, so a
 * PaneView holds ONLY the pane's independent y scale.
 */
export interface PaneView {
  yMin: number;
  yMax: number;
}

/**
 * Full stacked-layout state, consumed ONLY by ChartCanvas's S4 draw
 * coordinator — never by an individual layer. Each entry bundles a pane, its
 * y-scale, and its computed rect so the coordinator can, in one loop, build a
 * per-pane `RenderContext` (`layout = rect`, `view = {start, end, ...pane.view}`)
 * and dispatch the layers. Bundled (vs parallel arrays) so a pane and its
 * view/rect can never drift out of index-sync.
 */
export interface LayoutState {
  panes: Array<{
    pane: Pane;
    view: PaneView;
    rect: ChartLayout;
  }>;
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
