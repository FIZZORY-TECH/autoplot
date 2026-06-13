/**
 * src/stores/useDockStore.ts — Step 2a foundation store for the VS Code-style
 * activity-bar + drawer dock. SOLE owner of drawer open-state.
 *
 * Pure runtime UI state — nothing here is persisted (mirrors the tiny store
 * `useSettingsUiStore`). Structurally one-per-side: each
 * side (`left` / `right`) holds a single nullable open DrawerId.
 *
 * Every state change (re)writes the reserve CSS vars `--reserve-left` /
 * `--reserve-right` on `document.documentElement` so the chart container can
 * inset to make room for the open drawer(s). `recomputeReserve()` is exposed so
 * AppShell can re-clamp on window resize. No reader consumes this store yet
 * besides the AppShell resize effect — the existing per-panel open flags keep
 * working independently this step.
 */

import { create } from 'zustand';
import { RAIL_W, TOOLBAR_W } from '../lib/layout';

export type DrawerId =
  | 'watchlist'
  | 'research'
  | 'strategy'
  | 'terminal'
  | 'portfolio'
  | 'indicator'
  | 'settings';

export type DockSide = 'left' | 'right';

/** Min chart column guarded at the 800×600 Tauri minimum window. */
const MIN_CHART_W = 240;

interface DockState {
  side: Record<DrawerId, DockSide>;
  width: Record<DrawerId, number>;
  openLeft: DrawerId | null;
  openRight: DrawerId | null;
  toggle: (id: DrawerId) => void;
  close: (side: DockSide) => void;
  openDrawer: (id: DrawerId) => void;
  recomputeReserve: () => void;
}

const SIDE: Record<DrawerId, DockSide> = {
  watchlist: 'right',
  research: 'right',
  strategy: 'right',
  terminal: 'right',
  portfolio: 'right',
  indicator: 'right',
  settings: 'right',
};

const WIDTH: Record<DrawerId, number> = {
  watchlist: 352,
  research: 352,
  strategy: 480,
  terminal: 560,
  portfolio: 360,
  indicator: 320,
  settings: 440,
};

/**
 * Compute BOTH sides' reserves JOINTLY so their SUM never starves the chart
 * column below MIN_CHART_W. Computing each side independently (the old
 * `reserveFor`) let two open drawers (one per side) sum past the available
 * width, driving the chart's `calc(... left + right)` negative and overlapping
 * the drawers (e.g. at 800px: watchlist 352 + terminal 464 ⇒ chart = −112px).
 *
 * When both want-widths fit the available space, each gets its full design
 * width. When they don't, we shrink them PROPORTIONALLY to their want-widths so
 * the chart holds exactly at MIN_CHART_W. A single open drawer at a wide window
 * resolves to its full design width (unchanged behavior).
 */
function jointReserve(
  openLeft: DrawerId | null,
  openRight: DrawerId | null,
): { leftR: number; rightR: number } {
  if (typeof window === 'undefined') return { leftR: 0, rightR: 0 };
  const avail = Math.max(0, window.innerWidth - (RAIL_W + TOOLBAR_W) - MIN_CHART_W);
  const wantL = openLeft ? WIDTH[openLeft] : 0;
  const wantR = openRight ? WIDTH[openRight] : 0;
  let leftR: number;
  let rightR: number;
  if (wantL + wantR <= avail) {
    // Both fit — each side keeps its full design width.
    leftR = wantL;
    rightR = wantR;
  } else {
    // Narrow: shrink proportionally so leftR + rightR === avail (chart == MIN).
    leftR = wantL === 0 ? 0 : Math.round((avail * wantL) / (wantL + wantR));
    rightR = wantR === 0 ? 0 : avail - leftR;
  }
  return { leftR, rightR };
}

/**
 * Write the reserve CSS vars for BOTH sides from the supplied open ids,
 * computed jointly (see `jointReserve`).
 * SSR/test-safe — no-op when `window`/`document` is absent.
 */
function applyReserve(openLeft: DrawerId | null, openRight: DrawerId | null): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  const { leftR, rightR } = jointReserve(openLeft, openRight);
  root.style.setProperty('--reserve-left', `${leftR}px`);
  root.style.setProperty('--reserve-right', `${rightR}px`);
}

export const useDockStore = create<DockState>((set, get) => {
  // Prime the reserve vars once on creation so the Terminal default-open
  // insets the right at launch.
  applyReserve(null, 'terminal');

  return {
    side: SIDE,
    width: WIDTH,
    openLeft: null,
    openRight: 'terminal',

    toggle: (id) =>
      set((s) => {
        const dockSide = s.side[id];
        if (dockSide === 'left') {
          const next = s.openLeft === id ? null : id;
          applyReserve(next, s.openRight);
          return { openLeft: next };
        }
        const next = s.openRight === id ? null : id;
        applyReserve(s.openLeft, next);
        return { openRight: next };
      }),

    close: (side) =>
      set((s) => {
        if (side === 'left') {
          applyReserve(null, s.openRight);
          return { openLeft: null };
        }
        applyReserve(s.openLeft, null);
        return { openRight: null };
      }),

    openDrawer: (id) =>
      set((s) => {
        const dockSide = s.side[id];
        if (dockSide === 'left') {
          applyReserve(id, s.openRight);
          return { openLeft: id };
        }
        applyReserve(s.openLeft, id);
        return { openRight: id };
      }),

    recomputeReserve: () => {
      const s = get();
      applyReserve(s.openLeft, s.openRight);
    },
  };
});
