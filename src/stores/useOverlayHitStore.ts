/**
 * src/stores/useOverlayHitStore.ts — chart overlay hover + pin signal.
 *
 * Keeps the high-frequency overlay-hover hit and the chart-click pin signal OUT
 * of AppShell's React state. Previously these lived as `useState` in AppShell,
 * so every hotspot enter/leave and every chart click re-rendered the entire
 * shell (ChartCanvas, Dock, Headline, LegendHUD — none memoized).
 *
 * Writers (wired in AppShell, via setState — NOT React state, so the shell does
 * NOT re-render):
 *   - `setHit(hit)`  ← ChartCanvas `onHotspotChange`.
 *   - `pin()`        ← the chart-click handler (bumps `clickTick`).
 *
 * The ONLY subscriber is `OverlayInfoPanel`, so it is the sole component that
 * re-renders on hover/click. The panel keeps its own pinned/cycler state
 * machine; it publishes the currently-pinned mark/comment back here via
 * `setPinnedMark` so the keyboard Backspace handler can read it through
 * `getState()` (replacing the old `pinnedMarkRef` + `onPinnedMarkChange` prop +
 * `clickTick` prop channels).
 */

import { create } from 'zustand';
import type { HitResult } from '../chart/hitRegions';
import type { OverlayPinnedMark } from '../chart/OverlayInfoPanel';

interface OverlayHitState {
  /** Latest hover hit from ChartCanvas (`onHotspotChange`). null = no hover. */
  hit: HitResult | null;
  /**
   * Monotonic counter bumped on every genuine chart click (below the pan
   * threshold). OverlayInfoPanel pins the current hover hit (or clears the pin
   * when none is hovered) on each bump.
   */
  clickTick: number;
  /**
   * The currently-pinned mark/comment published by OverlayInfoPanel. Read
   * synchronously by the keyboard Backspace handler via `getState()`.
   */
  pinnedMark: OverlayPinnedMark | null;

  setHit: (hit: HitResult | null) => void;
  pin: () => void;
  setPinnedMark: (pinned: OverlayPinnedMark | null) => void;
}

export const useOverlayHitStore = create<OverlayHitState>((set) => ({
  hit: null,
  clickTick: 0,
  pinnedMark: null,
  setHit: (hit) => set({ hit }),
  pin: () => set((s) => ({ clickTick: s.clickTick + 1 })),
  setPinnedMark: (pinned) => set({ pinnedMark: pinned }),
}));
