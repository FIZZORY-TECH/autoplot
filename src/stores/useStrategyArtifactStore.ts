/**
 * src/stores/useStrategyArtifactStore.ts — Step 6 (MCP bridge + Step 11b)
 *
 * Minimal store for the Strategy Artifact Panel.
 * Opened by Claude via `open_strategy_artifact(id)` (MCP) or by the user (FAB).
 * Step 11b will flesh out the full CodeMirror editor panel.
 *
 * Step 2b: drawer open-state now lives in `useDockStore` ('strategy'). This
 * store owns ONLY the selected strategy id — callers drive the dock open/close
 * alongside `set`/`close` (kept decoupled here to avoid a circular import).
 *
 * Shape:
 *   selectedId  — the strategy currently loaded in the panel (null = empty state).
 *   set(id)     — select a strategy (caller opens the dock drawer).
 *   close()     — clear the selection (caller closes the dock drawer).
 */

import { create } from 'zustand';

interface StrategyArtifactState {
  selectedId: string | null;

  /** Select the given strategy. */
  set: (id: string) => void;
  /** Clear the current selection. */
  close: () => void;
}

export const useStrategyArtifactStore = create<StrategyArtifactState>((set) => ({
  selectedId: null,

  set: (id) => set({ selectedId: id }),
  close: () => set({ selectedId: null }),
}));
