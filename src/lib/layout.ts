/**
 * src/lib/layout.ts — Shared layout constants for the app shell + dock.
 *
 * Single source of truth for chrome/rail geometry that was previously
 * triplicated by-value across AppShell.tsx, ActivityBar.tsx, and
 * DockDrawer.tsx (RESERVE_*) and duplicated as a magic number in
 * useDockStore.ts (RAIL_W). Import from here instead of redeclaring.
 */

/** Side-rail / drawer top offset (px). 0 = rails and drawers run full-height
 *  (top:0 to bottom:0). Distinct from CHART_RESERVE_TOP (the chart's own inset). */
export const RESERVE_TOP = 0;

/** Side-rail / drawer bottom offset (px). 0 = rails and drawers run full-height
 *  (top:0 to bottom:0). Distinct from CHART_RESERVE_BOTTOM (the chart's own inset). */
export const RESERVE_BOTTOM = 0;

/** Chart wrapper top inset (px) — chart fills to the top; the floating headline overlays it.
 *  Distinct from RESERVE_TOP, which is used by the side rails and drawers. */
export const CHART_RESERVE_TOP = 0;

/** Chart wrapper bottom inset (px) — chart floats to the floor; the dock overlays it.
 *  Distinct from RESERVE_BOTTOM, which is used by the side rails and drawers. */
export const CHART_RESERVE_BOTTOM = 0;

/**
 * Activity-bar rail width (px). MUST stay in sync with the `--rail-w: 48px`
 * token in src/styles/tokens.css — the rails/drawers position off the CSS
 * token; useDockStore uses this constant for the same width in its joint
 * reserve math.
 */
export const RAIL_W = 48;

/** Left-edge static toolbar gutter width (px) — aliases RAIL_W (one source of truth). */
export const TOOLBAR_W = RAIL_W;
