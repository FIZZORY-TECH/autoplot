/**
 * src/stores/useChartMutationStore.ts — Step 6 (MCP bridge mutations)
 *
 * Holds chart-layer state that the MCP bridge can mutate via the
 * bridge:request round-trip protocol. These are the three new slice types:
 *
 *   - `overlays`        — Dataset overlays applied by `apply_dataset`.
 *   - `timelineLayers`  — Named event layers applied by `apply_timeline_events`.
 *   - `strategyOverlays`— Strategy overlays applied by `apply_strategy`.
 *
 * Step 11b will consume these slices in the chart canvas.
 * Step 11b will also add a TimelineEventsLayer component that reads `timelineLayers`.
 *
 * @see src/ai/bridgeRoundtrip.ts for the dispatcher that writes to this store.
 * @see src/panels/MCPConsentToast.tsx for the consent gate in the UI.
 */

import { create } from 'zustand';
import type { Dataset, ResearchOverlay } from '../ai/schemas';

// ---------------------------------------------------------------------------
// Overlay-key convention
//
// Every legend / hidden-set entry is keyed `<family>:<id>` so a single Set can
// hold ids drawn from all overlay families without collision. This store owns
// the family notion, so the union + the key builder live here and are reused
// at every call site (AppShell renderer closures + LegendHUD rows).
// ---------------------------------------------------------------------------

/** The overlay families that contribute legend rows / hidden-set keys. */
export type OverlayFamily = 'flag' | 'dataset' | 'strategy' | 'timeline' | 'research';

/** Build the canonical `<family>:<id>` key used by the legend + hidden set. */
export function overlayKey(family: OverlayFamily, id: string): string {
  return `${family}:${id}`;
}

// ---------------------------------------------------------------------------
// Timeline event types
// ---------------------------------------------------------------------------

export type TimelineEventKind = 'pin' | 'vline' | 'range';

export interface TimelineEvent {
  /** Unix milliseconds — aligns to the time axis. */
  ts: number;
  label: string;
  color?: string;
  kind: TimelineEventKind;
}

export interface TimelineLayer {
  id: string;
  name: string;
  events: TimelineEvent[];
}

// ---------------------------------------------------------------------------
// Strategy overlay type (minimal — Step 11b fills in rendering detail)
// ---------------------------------------------------------------------------

export interface StrategyOverlay {
  id: string;
  /** Raw strategy JSON loaded from the DB */
  bodyJson: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ChartMutationState {
  /** Dataset overlays keyed by dataset id. */
  overlays: Record<string, Dataset>;
  /** Timeline event layers keyed by layer id. */
  timelineLayers: Record<string, TimelineLayer>;
  /** Strategy overlays keyed by strategy id. */
  strategyOverlays: Record<string, StrategyOverlay>;
  /** Generic research overlays keyed by overlay id (Step 4). */
  researchOverlays: Record<string, ResearchOverlay>;
  /**
   * Monotonically-incrementing counter. Bumped on every mutation to
   * `researchOverlays` so downstream `useMemo` deps can detect that the
   * overlay set changed even when the object reference is the same shape.
   * Starts at 0; Step 3 consumers add it as a dep to force repaint.
   */
  researchOverlayVersion: number;

  /** Apply a dataset overlay — adds or replaces by id. */
  applyDataset: (dataset: Dataset) => void;
  /** Remove a dataset overlay by id. No-op if not found. */
  removeDataset: (id: string) => void;

  /** Apply (or replace) a timeline layer. */
  applyTimelineLayer: (layer: TimelineLayer) => void;
  /** Remove a timeline layer by id. No-op if not found. */
  removeTimelineLayer: (id: string) => void;

  /** Apply a strategy overlay. */
  applyStrategyOverlay: (overlay: StrategyOverlay) => void;
  /** Remove a strategy overlay by id. No-op if not found. */
  removeStrategyOverlay: (id: string) => void;

  /** Apply (or replace) a research overlay by id. */
  applyResearchOverlay: (overlay: ResearchOverlay) => void;
  /** Remove a research overlay by id. No-op if not found. */
  removeResearchOverlay: (id: string) => void;
  /**
   * Clear-on-switch prune (D8): drop every research overlay whose (sym, tf) no
   * longer matches the active context so stale agent overlays never paint on
   * the wrong instrument. Sym match is case-insensitive (mirrors the catalog
   * match in bridgeRoundtrip.ts); tf is the FROZEN 4-tier set so an exact
   * compare is fine. Single setState — no intermediate per-id removes.
   */
  pruneResearchOverlays: (sym: string, tf: string) => void;
}

export const useChartMutationStore = create<ChartMutationState>((set) => ({
  overlays: {},
  timelineLayers: {},
  strategyOverlays: {},
  researchOverlays: {},
  researchOverlayVersion: 0,

  applyDataset: (dataset) =>
    set((s) => ({ overlays: { ...s.overlays, [dataset.id]: dataset } })),

  removeDataset: (id) =>
    set((s) => {
      const next = { ...s.overlays };
      delete next[id];
      return { overlays: next };
    }),

  applyTimelineLayer: (layer) =>
    set((s) => ({ timelineLayers: { ...s.timelineLayers, [layer.id]: layer } })),

  removeTimelineLayer: (id) =>
    set((s) => {
      const next = { ...s.timelineLayers };
      delete next[id];
      return { timelineLayers: next };
    }),

  applyStrategyOverlay: (overlay) =>
    set((s) => ({ strategyOverlays: { ...s.strategyOverlays, [overlay.id]: overlay } })),

  removeStrategyOverlay: (id) =>
    set((s) => {
      const next = { ...s.strategyOverlays };
      delete next[id];
      return { strategyOverlays: next };
    }),

  // Research overlay mutations bump researchOverlayVersion in the same
  // setState so downstream useMemo deps see a fresh primitive on every change.
  applyResearchOverlay: (overlay) =>
    set((s) => ({
      researchOverlays: { ...s.researchOverlays, [overlay.id]: overlay },
      researchOverlayVersion: s.researchOverlayVersion + 1,
    })),

  removeResearchOverlay: (id) =>
    set((s) => {
      const next = { ...s.researchOverlays };
      delete next[id];
      return { researchOverlays: next, researchOverlayVersion: s.researchOverlayVersion + 1 };
    }),

  pruneResearchOverlays: (sym, tf) =>
    set((s) => {
      const symLc = sym.toLowerCase();
      let changed = false;
      const next: Record<string, ResearchOverlay> = {};
      for (const ro of Object.values(s.researchOverlays)) {
        if (ro.sym.toLowerCase() === symLc && ro.tf === tf) {
          next[ro.id] = ro;
        } else {
          changed = true;
        }
      }
      // Keep the same reference when nothing was pruned (no needless render).
      // Only bump the version counter when overlays were actually removed.
      return changed
        ? { researchOverlays: next, researchOverlayVersion: s.researchOverlayVersion + 1 }
        : {};
    }),
}));
