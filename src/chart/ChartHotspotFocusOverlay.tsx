/**
 * src/chart/ChartHotspotFocusOverlay.tsx — Step S9
 *
 * A transparent DOM layer that makes canvas-drawn event-notch hotspots
 * keyboard-reachable. For each visible notch cluster it renders one
 * visually-hidden `<button>` positioned at the notch's x coordinate along the
 * top of the chart. These buttons are focusable via Tab and announced by screen
 * readers; pressing Enter (or clicking) opens the EventListPopover for that
 * cluster, exactly as a mouse click on the canvas would.
 *
 * Why DOM buttons over canvas-only interaction:
 *   - Canvas has no native Tab-stop semantics; DOM buttons get them for free.
 *   - Screen readers cannot reach canvas-drawn elements at all without a DOM
 *     counterpart.
 *   - Visually-hidden (.sr-only) buttons add zero visual noise but full a11y.
 *
 * Stacking & drag-safety:
 *   The overlay is `position:absolute; inset:0; pointer-events:none` so it does
 *   not steal mouse events from ChartCanvas. Each button is ALSO
 *   `pointer-events:none` — a wide DOM element capturing the mouse in the
 *   full-height event column would swallow chart pans/range-selects. Mouse
 *   clicks therefore fall through to the canvas hit-test (which is drag-safe:
 *   it only treats a STATIONARY mouseup as a click). The buttons remain
 *   Tab-focusable and Enter-activatable for keyboard regardless of
 *   pointer-events (focus + key events do not require pointer hit-testing), so
 *   Scenario-4 keyboard reachability is preserved. Buttons are capped at the
 *   chart's right edge minus the 48px rail so they never overlap the right rail
 *   (constraint from full-height rails ADR, full-height-rails-corner-overlap.md).
 *
 * Focus-return:
 *   The component exposes `getFocusTrigger(key)` via an imperative handle so
 *   EventListPopover can return focus to the originating button on Esc.
 *
 * Relationship to AppShell:
 *   AppShell passes `notchClusters` (from `ChartCanvas.onNotchClustersChange`)
 *   and `onOpenPopover` (wrapping `openEventPopover`). The overlay lives inside
 *   the chart-wrap div (same stacking context), so its button coordinates are
 *   already in canvas-wrap-relative CSS px — no conversion needed.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { NotchCluster } from './ChartCanvas';
import type { EventPopoverRequest } from '../stores/useOverlayHitStore';
import { NOTCH_H } from './glyphs';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChartHotspotFocusOverlayProps {
  /** Clusters emitted by ChartCanvas.onNotchClustersChange (left-to-right). */
  clusters: NotchCluster[];
  /** Called when a button is activated (Enter/click). Mirrors handleChartClick. */
  onOpenPopover: (req: EventPopoverRequest) => void;
  /**
   * Right boundary (CSS px, wrap-relative) past which buttons must not extend.
   * Set to chartSize.w − 48 (rail width) to avoid overlapping the right rail.
   */
  rightBoundary: number;
}

// ---------------------------------------------------------------------------
// Imperative handle — focus-return from EventListPopover on Esc
// ---------------------------------------------------------------------------

export interface ChartHotspotFocusOverlayHandle {
  /**
   * Return focus to the button whose cluster key matches `key`. Called by
   * EventListPopover on Esc so focus returns to the originating notch button
   * rather than the chart canvas fallback.
   */
  focusByKey: (key: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChartHotspotFocusOverlay = forwardRef<
  ChartHotspotFocusOverlayHandle,
  ChartHotspotFocusOverlayProps
>(function ChartHotspotFocusOverlay({ clusters, onOpenPopover, rightBoundary }, ref) {
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useImperativeHandle(ref, () => ({
    focusByKey(key: string) {
      btnRefs.current.get(key)?.focus();
    },
  }));

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // Sit above the canvas pixel layer but below the popover tier.
        zIndex: 'var(--z-chart-crosshair)',
        // No background — purely structural.
      }}
    >
      {clusters.map((cluster) => {
        // Clamp so the button never extends past the right rail.
        const clampedX = Math.min(cluster.x, rightBoundary - 1);
        // cluster.y is the BOTTOM spine y (notch rides above the time axis); the
        // notch top is NOTCH_H above it. Position the focus ring over the notch.
        const notchTop = Math.max(0, cluster.y - NOTCH_H - 4);

        const ariaLabel =
          cluster.count === 1
            ? `Open event: ${cluster.label || 'untitled'}`
            : `Open ${cluster.count} events at this point${cluster.label ? ` (first: ${cluster.label})` : ''}`;

        return (
          <button
            key={cluster.key}
            ref={(el) => {
              if (el) {
                btnRefs.current.set(cluster.key, el);
              } else {
                btnRefs.current.delete(cluster.key);
              }
            }}
            type="button"
            className="chart-hotspot-btn"
            aria-label={ariaLabel}
            style={{
              position: 'absolute',
              // Anchor at the notch's x; y at the relocated BOTTOM notch so the
              // focus ring shows on the marker. Centered on the notch center x.
              left: Math.max(0, clampedX - 12),
              top: notchTop,
              // Width/height satisfy the 24×24 minimum touch/click target spec.
              width: 24,
              height: 24,
              // Visually hidden but focusable — NOT display:none / visibility:hidden
              // which would remove it from the tab order.
              opacity: 0,
              // pointer-events:none so the wide column never swallows a chart pan;
              // Tab focus + Enter activation work regardless (keyboard path). Mouse
              // clicks fall through to the canvas hit-test (drag-safe stationary click).
              pointerEvents: 'none',
            }}
            onClick={() => {
              onOpenPopover({
                kind: cluster.kind,
                eventIds: cluster.eventIds,
                paneIndex: cluster.paneIndex,
                anchorX: cluster.x,
                anchorY: cluster.y,
              });
            }}
          />
        );
      })}
    </div>
  );
});

export default ChartHotspotFocusOverlay;
