/**
 * src/stores/useSettingsUiStore.ts — Runtime UI state for the Settings panel
 * (W2-A). Pure runtime — nothing here is persisted; durable settings live in
 * `useSettingsStore`.
 */

import { create } from 'zustand';

export type SettingsTab =
  | 'general'
  | 'models'
  | 'tools'
  | 'mcp'
  | 'skills'
  | 'hooks'
  | 'privacy';

interface SettingsUiState {
  activeTab: SettingsTab;
  setActiveTab: (t: SettingsTab) => void;
  /**
   * W2-G follow-up — Inspect-payload modal open state. Toggled by clicking
   * the Privacy chip in the AgentsPanel header; closed by the modal itself,
   * Esc (routed through `src/stores/keyboard.ts`), or backdrop click.
   * Runtime-only — never persisted.
   */
  inspectOpen: boolean;
  setInspectOpen: (v: boolean) => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  activeTab: 'general',
  setActiveTab: (t) => set({ activeTab: t }),
  inspectOpen: false,
  setInspectOpen: (v) => set({ inspectOpen: v }),
}));
