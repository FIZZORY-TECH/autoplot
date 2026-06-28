/**
 * src/lib/hydrate.ts — SQLite → Zustand hydration + debounced write-back (P3.1)
 *
 * Flow on app boot (called once from AppShell useEffect):
 *   1. hydrateAppState() reads watchlist + app_state from SQLite.
 *   2. Populates useWatchlistStore and useAppStore.
 *   3. Sets useAppStore.hydrated = true.
 *   4. Caller mounts the debounced write-back subscription via
 *      mountAppStateSync() (separate export so it can be unmounted on cleanup).
 *
 * Write-back (debounced 200ms):
 *   - Subscribes to useAppStore changes.
 *   - On any change, schedules a write of activeSym / chartType / tf / viewport.
 *   - Skips writes while hydrated === false (avoids persisting defaults).
 *   - Single shared 200ms debounce timer across all keys (simplest approach).
 *
 * Per A9: all DB access goes through Tauri commands via src/lib/db.ts.
 */

import { useAppStore } from '../stores/useAppStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { usePortfolioStore } from '../stores/usePortfolioStore';
import { useAiSessionStore } from '../stores/useAiSessionStore';
import {
  useSettingsStore,
  snapshotSettings,
  SETTINGS_SCHEMA_VERSION,
  type HydratedSlots as SettingsSlots,
} from '../stores/useSettingsStore';
import {
  dbWatchlistV2List,
  dbPortfolioList,
  dbAppStateGet,
  dbAppStateSet,
} from './db';
import type { ChartType } from '../chart/ChartCanvas';
import type { Tf } from '../data/MarketDataProvider';
import type { Viewport, ActiveAsset } from '../stores/useAppStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CHART_TYPES: ChartType[] = [
  'candles', 'heikin', 'bars', 'line', 'area', 'mountain',
];
const VALID_TF: Tf[] = ['1h', '4h', '1d', '1w'];

function isChartType(v: unknown): v is ChartType {
  return typeof v === 'string' && (VALID_CHART_TYPES as string[]).includes(v);
}

function isTf(v: unknown): v is Tf {
  return typeof v === 'string' && (VALID_TF as string[]).includes(v);
}

/**
 * Parse the JSON blob persisted under `activeAsset` (ADR-0009). Returns
 * `undefined` for malformed payloads so the caller can fall back to the
 * legacy `activeSym` migration shim.
 */
function parseActiveAsset(raw: string | null): ActiveAsset | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'sym' in parsed &&
      'provider' in parsed &&
      'quote' in parsed &&
      typeof (parsed as Record<string, unknown>).sym === 'string' &&
      typeof (parsed as Record<string, unknown>).provider === 'string' &&
      typeof (parsed as Record<string, unknown>).quote === 'string'
    ) {
      return parsed as ActiveAsset;
    }
  } catch {
    console.warn('[hydrate] malformed activeAsset JSON in app_state; falling back');
  }
  return undefined;
}

function parseViewport(raw: string | null): Viewport | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'start' in parsed &&
      'end' in parsed &&
      typeof (parsed as Record<string, unknown>).start === 'number' &&
      typeof (parsed as Record<string, unknown>).end === 'number'
    ) {
      return parsed as Viewport;
    }
  } catch {
    // malformed JSON — fall through to default
    console.warn('[hydrate] malformed viewport JSON in app_state; using default');
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// hydrateAppState
// ---------------------------------------------------------------------------

/**
 * Read all persisted state from SQLite and push it into Zustand stores.
 * Sets `hydrated = true` when done so the debounced write-back can begin.
 *
 * Safe to call outside Tauri (dev-server): all DB calls are wrapped in
 * try/catch; failures fall back to in-store defaults.
 */
export async function hydrateAppState(): Promise<void> {
  // ---- Watchlist (ADR-0009 — reads from watchlist_v2) ----------------------
  try {
    const entries = await dbWatchlistV2List();
    useWatchlistStore.getState().setWatchlist(entries);
  } catch (err) {
    console.warn('[hydrate] dbWatchlistV2List failed (outside Tauri?)', err);
  }

  // ---- Portfolio (paper-trading holdings) ----------------------------------
  const holdings = await dbPortfolioList().catch(() => []);
  usePortfolioStore.getState().setHoldings(holdings);

  // ---- AI sessions ----------------------------------------------------------
  // Hydrate independently — failures are toast-guarded inside the store.
  void useAiSessionStore.getState().hydrate();

  // ---- App state keys ------------------------------------------------------
  // Independent reads from the same KV table — fan out in parallel so app
  // hydration doesn't pay sequential IPC round-trip latency before the FAB
  // becomes clickable. Each `dbAppStateGet` already swallows missing-key as
  // null; we wrap the whole thing in try/catch for the outside-Tauri case.
  const appStore = useAppStore.getState();
  const KEYS = [
    'activeSym',
    'activeAsset', // ADR-0009 — canonical (sym, provider, quote) tuple
    'chartType',
    'tf',
    'viewport',
    'settings',
  ] as const;
  let raws: (string | null)[] = [];
  try {
    raws = await Promise.all(KEYS.map((k) => dbAppStateGet(k).catch(() => null)));
  } catch {
    raws = KEYS.map(() => null);
  }
  const [rawSym, rawActiveAsset, rawCt, rawTf, rawViewport, rawSettings] = raws;

  if (rawSym) appStore.setActiveSym(rawSym);
  if (isChartType(rawCt)) appStore.setChartType(rawCt);
  if (isTf(rawTf)) appStore.setTf(rawTf);
  const vp = parseViewport(rawViewport);
  if (vp) appStore.setViewport(vp);

  // ---- activeAsset hydration + legacy `activeSym` shim (ADR-0009) ---------
  // Preferred read: the new `activeAsset` JSON blob. When that's missing but
  // a legacy `activeSym` string is persisted, look the symbol up in the v2
  // watchlist we just hydrated and derive `(provider, quote)` from the first
  // match. If no match (the user's pinned symbol got delisted from their
  // watchlist), leave `activeAsset` undefined — legacy `activeSym` stays as
  // the fallback so UX doesn't regress.
  const parsedActive = parseActiveAsset(rawActiveAsset);
  if (parsedActive) {
    appStore.setActiveAsset(parsedActive);
  } else if (rawSym) {
    const match = useWatchlistStore.getState().assets.find((a) => a.sym === rawSym);
    if (match) {
      appStore.setActiveAsset({
        sym: match.sym,
        provider: match.provider,
        quote: match.quote,
      });
    }
  }

  // Settings live as a single JSON blob keyed `settings` so a future schema
  // migrator only needs to bump `schema_version` and dispatch on it.
  if (rawSettings) {
    const parsed = parseSettingsBlob(rawSettings);
    if (parsed) useSettingsStore.getState().hydrateFrom(parsed);
  }

  // Mark hydration complete — debounced writes will start from here.
  appStore.setHydrated(true);
}

// ---------------------------------------------------------------------------
// Settings parsing — additive forward-compat for unknown future keys.
// ---------------------------------------------------------------------------

function parseSettingsBlob(raw: string): Partial<SettingsSlots> | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.schema_version === 'number' &&
      obj.schema_version > SETTINGS_SCHEMA_VERSION
    ) {
      console.warn('[hydrate] settings schema_version newer than supported', obj.schema_version);
      return null;
    }
    return obj as Partial<SettingsSlots>;
  } catch {
    console.warn('[hydrate] malformed settings JSON; using defaults');
    return null;
  }
}

// ---------------------------------------------------------------------------
// mountAppStateSync — debounced write-back
// ---------------------------------------------------------------------------

/**
 * Subscribe to useAppStore changes and debounce-write persisted keys to
 * SQLite every 200ms.  Returns an `unmount` function that clears the
 * subscription and any pending timer — call it in the useEffect cleanup.
 *
 * Must be called AFTER hydrateAppState() so the initial hydrated=true write
 * doesn't trigger a redundant flush.
 */
export function mountAppStateSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    const s = useAppStore.getState();
    if (!s.hydrated) return; // guard: skip writes during hydration

    const writes: Array<Promise<void>> = [];

    if (s.activeSym !== undefined) {
      writes.push(dbAppStateSet('activeSym', s.activeSym).catch(console.warn));
    }
    // ADR-0009 — persist the canonical (sym, provider, quote) tuple as JSON.
    // Boot hydration prefers this key over the legacy `activeSym` migration.
    if (s.activeAsset !== undefined) {
      writes.push(
        dbAppStateSet('activeAsset', JSON.stringify(s.activeAsset)).catch(console.warn),
      );
    }
    writes.push(dbAppStateSet('chartType', s.chartType).catch(console.warn));
    writes.push(dbAppStateSet('tf', s.tf).catch(console.warn));
    if (s.viewport !== undefined) {
      writes.push(
        dbAppStateSet('viewport', JSON.stringify(s.viewport)).catch(console.warn),
      );
    }

    // Fire-and-forget; errors are logged, not re-thrown.
    void Promise.all(writes);
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };

  // Subscribe to the whole store — Zustand's subscribe fires on any mutation.
  // We only care about the persisted keys, so we check them inside flush().
  const unsub = useAppStore.subscribe(schedule);

  return () => {
    unsub();
    if (timer !== null) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// mountSettingsSync — debounced write-back for AI settings + last-session map
// ---------------------------------------------------------------------------

/**
 * Subscribe to `useSettingsStore` changes and debounce-write through
 * `dbAppStateSet`. Mirrors the pattern of `mountAppStateSync` — single 200ms
 * debounce, skipped while `useAppStore.hydrated === false`.
 *
 * Composes alongside `mountAppStateSync`; AppShell mounts both.
 */
export function mountSettingsSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSettingsBlob: string | null = null;

  const flush = () => {
    if (!useAppStore.getState().hydrated) return;

    const settings = snapshotSettings(useSettingsStore.getState());
    const settingsPayload = JSON.stringify({
      schema_version: SETTINGS_SCHEMA_VERSION,
      ...settings,
    });
    if (settingsPayload !== lastSettingsBlob) {
      lastSettingsBlob = settingsPayload;
      void dbAppStateSet('settings', settingsPayload).catch(console.warn);
    }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };

  const unsubSettings = useSettingsStore.subscribe(schedule);

  return () => {
    unsubSettings();
    if (timer !== null) clearTimeout(timer);
  };
}
