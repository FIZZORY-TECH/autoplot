/**
 * src/stores/useSettingsStore.ts — Durable AI / app settings.
 *
 * Persisted via `dbAppStateSet('settings', JSON.stringify({ schema_version, ...}))`
 * through `src/lib/hydrate.ts`. Runtime-only AI fields live in `useAIStore`.
 *
 * Schema version is bumped only when an actual breaking change ships;
 * forward-compat reads ignore unknown keys (additive changes are free).
 */

import { create } from 'zustand';
import type { Mode, PermissionMode } from '../ai/types';

/** Strict settings schema version — incremented on breaking changes. */
export const SETTINGS_SCHEMA_VERSION = 1 as const;

/** Privacy policy for the outgoing AI payload. Default: summary-only. */
export type PrivacyMode = 'summary-only' | 'full-bars';

interface SettingsState {
  // ---- CLI binary --------------------------------------------------------
  cliPath: string | null;

  // ---- Models ------------------------------------------------------------
  defaultModel: string | null;
  modelByMode: { research: string | null; strategy: string | null };

  // ---- Permissions / tools ----------------------------------------------
  permissionModeByMode: Record<Mode, PermissionMode>;
  allowedToolsByMode: Record<Mode, string[]>;
  disallowedToolsByMode: Record<Mode, string[]>;

  // ---- Logging / privacy -------------------------------------------------
  verboseLogging: boolean;
  privacyMode: PrivacyMode;
  auditLogEnabled: boolean;
  stripPiiFromLogs: boolean;

  // ---- General -----------------------------------------------------------
  /** Data refresh interval (seconds). Bound by General tab; 5–600s, default 30. */
  dataRefreshIntervalSec: number;

  // ---- Internal seeding flag --------------------------------------------
  /**
   * True once the per-mode default tool allow/disallow lists have been seeded
   * (W2-A). Persisted so re-seeding never fights an explicit user clear.
   */
  settingsSeededV1: boolean;

  // ---- Bypass-permissions one-time confirm (W2-D3) ----------------------
  /**
   * True once the user has confirmed the `bypassPermissions` warning dialog.
   * Persisted so the dialog only appears once per install. W2-G provides the
   * Privacy-tab "Clear bypass-confirmed flag" button that resets this to
   * false. Audit logging respects the user's `auditLogEnabled` toggle
   * uniformly — confirming bypass does NOT auto-enable audit log.
   */
  bypassConfirmed: boolean;

  // ---- Skills (W2-C) -----------------------------------------------------
  /**
   * Names of skills the user has explicitly disabled. Skills not present in
   * this list are treated as enabled by default. The list is also mirrored
   * into the app-managed `settings.json` (Rust-side) so the CLI sees the same
   * enable/disable state via `--settings`.
   */
  disabledSkills: string[];

  // ---- Setters ----------------------------------------------------------
  setCliPath: (v: string | null) => void;
  setDefaultModel: (v: string | null) => void;
  setModelForMode: (mode: Mode, v: string | null) => void;
  setPermissionMode: (mode: Mode, v: PermissionMode) => void;
  setAllowedTools: (mode: Mode, v: string[]) => void;
  setDisallowedTools: (mode: Mode, v: string[]) => void;
  setVerboseLogging: (v: boolean) => void;
  setPrivacyMode: (v: PrivacyMode) => void;
  setAuditLogEnabled: (v: boolean) => void;
  setStripPiiFromLogs: (v: boolean) => void;
  setDataRefreshIntervalSec: (v: number) => void;
  setSettingsSeededV1: (v: boolean) => void;
  setBypassConfirmed: (v: boolean) => void;
  setDisabledSkills: (v: string[]) => void;
  /** Bulk replace from a hydrated SQLite blob. */
  hydrateFrom: (slots: Partial<HydratedSlots>) => void;
}

/** The persistable subset (no setters, no schema_version). */
export interface HydratedSlots {
  cliPath: string | null;
  defaultModel: string | null;
  modelByMode: { research: string | null; strategy: string | null };
  permissionModeByMode: Record<Mode, PermissionMode>;
  allowedToolsByMode: Record<Mode, string[]>;
  disallowedToolsByMode: Record<Mode, string[]>;
  verboseLogging: boolean;
  privacyMode: PrivacyMode;
  auditLogEnabled: boolean;
  stripPiiFromLogs: boolean;
  dataRefreshIntervalSec: number;
  settingsSeededV1: boolean;
  bypassConfirmed: boolean;
  disabledSkills: string[];
}

const DEFAULTS: HydratedSlots = {
  cliPath: null,
  defaultModel: null,
  modelByMode: { research: null, strategy: null },
  permissionModeByMode: { research: 'acceptEdits', strategy: 'acceptEdits' },
  allowedToolsByMode: { research: [], strategy: [] },
  disallowedToolsByMode: { research: [], strategy: [] },
  verboseLogging: false,
  privacyMode: 'summary-only',
  auditLogEnabled: false,
  stripPiiFromLogs: false,
  dataRefreshIntervalSec: 30,
  settingsSeededV1: false,
  bypassConfirmed: false,
  disabledSkills: [],
};

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULTS,

  setCliPath: (v) => set({ cliPath: v }),
  setDefaultModel: (v) => set({ defaultModel: v }),
  setModelForMode: (mode, v) =>
    set((s) => ({ modelByMode: { ...s.modelByMode, [mode]: v } })),
  setPermissionMode: (mode, v) =>
    set((s) => ({ permissionModeByMode: { ...s.permissionModeByMode, [mode]: v } })),
  setAllowedTools: (mode, v) =>
    set((s) => ({ allowedToolsByMode: { ...s.allowedToolsByMode, [mode]: v } })),
  setDisallowedTools: (mode, v) =>
    set((s) => ({ disallowedToolsByMode: { ...s.disallowedToolsByMode, [mode]: v } })),
  setVerboseLogging: (v) => set({ verboseLogging: v }),
  setPrivacyMode: (v) => set({ privacyMode: v }),
  setAuditLogEnabled: (v) => set({ auditLogEnabled: v }),
  setStripPiiFromLogs: (v) => set({ stripPiiFromLogs: v }),
  setDataRefreshIntervalSec: (v) => set({ dataRefreshIntervalSec: v }),
  setSettingsSeededV1: (v) => set({ settingsSeededV1: v }),
  setBypassConfirmed: (v) => set({ bypassConfirmed: v }),
  setDisabledSkills: (v) => set({ disabledSkills: v }),

  hydrateFrom: (slots) =>
    set((prev) => ({
      cliPath: slots.cliPath ?? prev.cliPath,
      defaultModel: slots.defaultModel ?? prev.defaultModel,
      modelByMode: slots.modelByMode ?? prev.modelByMode,
      permissionModeByMode: slots.permissionModeByMode ?? prev.permissionModeByMode,
      allowedToolsByMode: slots.allowedToolsByMode ?? prev.allowedToolsByMode,
      disallowedToolsByMode: slots.disallowedToolsByMode ?? prev.disallowedToolsByMode,
      verboseLogging: slots.verboseLogging ?? prev.verboseLogging,
      privacyMode: slots.privacyMode ?? prev.privacyMode,
      auditLogEnabled: slots.auditLogEnabled ?? prev.auditLogEnabled,
      stripPiiFromLogs: slots.stripPiiFromLogs ?? prev.stripPiiFromLogs,
      dataRefreshIntervalSec: slots.dataRefreshIntervalSec ?? prev.dataRefreshIntervalSec,
      settingsSeededV1: slots.settingsSeededV1 ?? prev.settingsSeededV1,
      bypassConfirmed: slots.bypassConfirmed ?? prev.bypassConfirmed,
      disabledSkills: slots.disabledSkills ?? prev.disabledSkills,
    })),
}));

/** Snapshot the persistable slots from the current store state. */
export function snapshotSettings(state: SettingsState): HydratedSlots {
  return {
    cliPath: state.cliPath,
    defaultModel: state.defaultModel,
    modelByMode: state.modelByMode,
    permissionModeByMode: state.permissionModeByMode,
    allowedToolsByMode: state.allowedToolsByMode,
    disallowedToolsByMode: state.disallowedToolsByMode,
    verboseLogging: state.verboseLogging,
    privacyMode: state.privacyMode,
    auditLogEnabled: state.auditLogEnabled,
    stripPiiFromLogs: state.stripPiiFromLogs,
    dataRefreshIntervalSec: state.dataRefreshIntervalSec,
    settingsSeededV1: state.settingsSeededV1,
    bypassConfirmed: state.bypassConfirmed,
    disabledSkills: state.disabledSkills,
  };
}
