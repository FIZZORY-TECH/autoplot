/**
 * src/ai/types.ts — Public AI types (bridge/terminal surface only).
 *
 * Trimmed after removal of the chat UI (claudeClient, dispatchTools, Composer).
 * Surviving consumers: useSettingsStore, SettingsPanel, bridgeRoundtrip (indirect).
 */

/** Two AI work modes; retained for per-mode settings in useSettingsStore. */
export type Mode = 'research' | 'strategy';

/** Claude CLI permission modes — see `claude --permission-mode`. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';
