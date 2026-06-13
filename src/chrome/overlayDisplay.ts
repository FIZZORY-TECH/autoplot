/**
 * src/chrome/overlayDisplay.ts — shared display helpers for bridge/research
 * overlay chrome (LegendHUD rows).
 *
 * Pure functions only — no store imports beyond type-only ones, so this module
 * stays dependency-light and safe to share across chrome components.
 */

import type { StrategyOverlay, TimelineLayer } from '../stores/useChartMutationStore';

/** Parse a display name out of a StrategyOverlay's raw bodyJson, or fall back
 *  to the overlay id. */
export function strategyOverlayDisplayName(overlay: Pick<StrategyOverlay, 'id' | 'bodyJson'>): string {
  try {
    const parsed: unknown = JSON.parse(overlay.bodyJson);
    if (parsed && typeof parsed === 'object') {
      const name = (parsed as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.trim()) return name;
    }
  } catch {
    /* fall through to id */
  }
  return overlay.id;
}

/** Display color for a timeline layer — the first event that carries a color,
 *  else the supplied fallback. */
export function timelineLayerColor(layer: Pick<TimelineLayer, 'events'>, fallback: string): string {
  return layer.events.find((e) => e.color)?.color ?? fallback;
}
