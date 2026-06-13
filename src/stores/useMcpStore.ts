/**
 * src/stores/useMcpStore.ts — Runtime MCP-server state (W2-B).
 *
 * Holds:
 *   - `servers`              — merged list from `mcp_list_merged()`. Refreshed
 *                              every 5s while the Settings → MCP tab is active.
 *   - `statuses`             — most recent health-check result per server.
 *   - `disabledByConversation` — RUNTIME-ONLY map (sessionId → disabled names).
 *                              Per spec: never persisted.
 *
 * The 5-second poller is mounted as an effect inside `SettingsPanel.tsx`'s
 * MCP tab body, not here — keeping the cadence opt-in to "panel open + tab
 * active" avoids a global background timer.
 */

import { create } from 'zustand';
import type { McpServer, McpStatus } from '../lib/db';

interface McpState {
  servers: McpServer[];
  statuses: Record<string, McpStatus>;
  /** sessionId → set of server names disabled for that conversation. */
  disabledByConversation: Record<string, string[]>;

  setServers: (rows: McpServer[]) => void;
  setStatus: (name: string, status: McpStatus) => void;
  toggleConversationDisabled: (sessionId: string, name: string) => void;
  /** Clear runtime state (used by tests / mode reset). */
  reset: () => void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  statuses: {},
  disabledByConversation: {},

  setServers: (rows) => set({ servers: rows }),

  setStatus: (name, status) =>
    set((s) => ({ statuses: { ...s.statuses, [name]: status } })),

  toggleConversationDisabled: (sessionId, name) =>
    set((s) => {
      const current = s.disabledByConversation[sessionId] ?? [];
      const next = current.includes(name)
        ? current.filter((n) => n !== name)
        : [...current, name];
      return {
        disabledByConversation: {
          ...s.disabledByConversation,
          [sessionId]: next,
        },
      };
    }),

  reset: () =>
    set({ servers: [], statuses: {}, disabledByConversation: {} }),
}));

/**
 * Pure selector helper — returns the names disabled for a sessionId, or `[]`.
 * Stable empty array to avoid spurious re-renders.
 */
const EMPTY: readonly string[] = [];
export function selectDisabledNames(
  state: { disabledByConversation: Record<string, string[]> },
  sessionId: string | null,
): readonly string[] {
  if (!sessionId) return EMPTY;
  return state.disabledByConversation[sessionId] ?? EMPTY;
}
