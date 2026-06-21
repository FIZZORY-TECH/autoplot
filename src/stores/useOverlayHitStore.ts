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
import type { HitResult, HitRegionKind } from '../chart/hitRegions';
import type { OverlayPinnedMark } from '../chart/OverlayInfoPanel';

/**
 * Which floating readout is allowed to own the screen for the current
 * interaction. Exactly ONE wins at a time so the panels never pile up and
 * compete for attention (UX-clutter fix).
 *
 *   'popover' — the user clicked an event hotspot; the EventListPopover is
 *               primary. The hover OverlayInfoPanel and the crosshair price
 *               value chip are suppressed.
 *   'event'   — the pointer is over an event hotspot column (research /
 *               timelinePin) but no popover is open yet. The event is the
 *               focus, so the crosshair PRICE chip is suppressed (the user is
 *               asking about the event, not the price). OverlayInfoPanel shows
 *               a concise event hint.
 *   'overlay' — the pointer is over a non-event mark/indicator/trend hotspot;
 *               OverlayInfoPanel shows it and the crosshair behaves normally.
 *   'price'   — plain price area, no hit; crosshair + price chip is the default.
 */
export type PrimaryReadout = 'popover' | 'event' | 'overlay' | 'price';

/** Hover-hit kinds that represent an EVENT (drive the popover + the 'event' rung). */
const EVENT_HIT_KINDS: ReadonlySet<HitRegionKind> = new Set<HitRegionKind>([
  'research',
  'timelinePin',
]);

/**
 * THE precedence ladder — the single authority for "which readout is primary
 * right now" (highest rung first). Pure so it is unit-testable and so callers
 * derive an identical answer everywhere.
 *
 *   1. popover open                → 'popover'
 *   2. hover over an event hotspot → 'event'
 *   3. hover over any other hit    → 'overlay'
 *   4. nothing hovered             → 'price'
 */
export function derivePrimaryReadout(
  hit: HitResult | null,
  eventPopoverOpen: boolean,
): PrimaryReadout {
  if (eventPopoverOpen) return 'popover';
  if (hit && EVENT_HIT_KINDS.has(hit.nearest.kind)) return 'event';
  if (hit) return 'overlay';
  return 'price';
}

/**
 * An open event-list-popover request (S6). Carries the clustered event ids the
 * notch hotspot hit, the pane it hangs from, and the clamped anchor (CSS px,
 * canvas-wrap-relative) at which to float the list. `kind` distinguishes a
 * research `event_mark` cluster from a degraded `timelinePin` cluster so the
 * popover resolves each id against the right store slice.
 */
export interface EventPopoverRequest {
  kind: 'research' | 'timelinePin';
  eventIds: string[];
  paneIndex: number;
  anchorX: number;
  anchorY: number;
}

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
  /**
   * The open event-list popover (S6), or null when none. Opened by the chart
   * click handler when the click lands on an event-hotspot notch; the sole
   * subscriber is `EventListPopover`. Cleared on dismiss/Esc/empty-resolution.
   */
  eventPopover: EventPopoverRequest | null;

  setHit: (hit: HitResult | null) => void;
  pin: () => void;
  setPinnedMark: (pinned: OverlayPinnedMark | null) => void;
  openEventPopover: (req: EventPopoverRequest) => void;
  closeEventPopover: () => void;
}

export const useOverlayHitStore = create<OverlayHitState>((set) => ({
  hit: null,
  clickTick: 0,
  pinnedMark: null,
  eventPopover: null,
  setHit: (hit) => set({ hit }),
  pin: () => set((s) => ({ clickTick: s.clickTick + 1 })),
  setPinnedMark: (pinned) => set({ pinnedMark: pinned }),
  openEventPopover: (req) => set({ eventPopover: req }),
  closeEventPopover: () => set({ eventPopover: null }),
}));

/**
 * Subscribe to the derived primary readout (the precedence ladder). Re-renders
 * the caller only when the WINNER changes (string equality), not on every
 * mousemove within the same rung.
 */
export function usePrimaryReadout(): PrimaryReadout {
  return useOverlayHitStore((s) => derivePrimaryReadout(s.hit, s.eventPopover !== null));
}
