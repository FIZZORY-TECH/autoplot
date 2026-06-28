/**
 * src/stores/useAiSessionStore.ts — In-memory mirror of the `ai_sessions`
 * SQLite table. Hydrated from `dbAiSessionsList()` on app boot, then mutated
 * via `recordSpawn` / `rename` / `remove` which fan out to SQLite via the
 * `dbAiSessions*` wrappers.
 *
 * Optimistic-write-first-then-SQLite-with-toast-fallback idiom — mirrors
 * `useResearchOverlayLibraryStore` exactly.
 *
 * Busy state is purely in-memory / transient:
 *   - `busyUntil[id]` is a future ms timestamp (set by `markActivity`).
 *   - `isBusy(id)` returns `Date.now() < busyUntil[id]`.
 *   - A per-session `setTimeout` fires after ~700ms to flip the store so the
 *     panel re-renders when busy lapses.
 *   - `markIdle` and `remove` always synchronously clearTimeout + delete
 *     busyUntil so a stale timer can never show a busy indicator after the
 *     session is gone / idle.
 *   - `busyUntil` is in Zustand state (triggers re-render on update); the
 *     `setTimeout` handles live in a module-level map (never serialised).
 */

import { create } from 'zustand';
import {
  dbAiSessionsList,
  dbAiSessionsUpsert,
  dbAiSessionsDelete,
  type AiSession,
} from '../lib/db';
import type { Mode } from '../ai/types';

// ---------------------------------------------------------------------------
// Running-state per session
// ---------------------------------------------------------------------------

export type SessionRunState = 'RUNNING' | 'IDLE';

// ---------------------------------------------------------------------------
// Module-level timer map — kept OUTSIDE persisted state; never written to SQLite.
// ---------------------------------------------------------------------------

const busyTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

interface AiSessionState {
  /** All persisted sessions (newest-first mirrors SQLite `last_used_at DESC`). */
  sessions: AiSession[];
  /** True once `hydrate()` has completed at least one successful or failed attempt. */
  hydrated: boolean;
  /**
   * Per-session future-ms "busy until" timestamp. Busy when `Date.now() <
   * busyUntil[id]`. Stored in Zustand so mutations here trigger re-renders.
   */
  busyUntil: Record<string, number>;
  /**
   * Per-session running state. Sessions are IDLE after hydration (no PTY
   * survives an app restart).
   */
  runState: Record<string, SessionRunState>;

  // ---- Actions ----------------------------------------------------------------

  /** Load rows from SQLite; mark all IDLE and clear any stale busy state. */
  hydrate: () => Promise<void>;
  /** Re-list from SQLite (same as hydrate, minus resetting hydrated flag logic). */
  refresh: () => Promise<void>;

  /**
   * Insert a new session record (RUNNING state). Constructs the full 8-field
   * wire row. `title` defaults to null if not supplied.
   */
  recordSpawn: (meta: {
    id: string;
    mode: Mode;
    cwd_path: string;
    model?: string | null;
    title?: string | null;
  }) => Promise<void>;

  /** Update the `title` field of an existing session. Preserves `created_at`. */
  rename: (id: string, title: string) => Promise<void>;

  /**
   * Remove a session from memory + SQLite. Synchronously clears the busy
   * timer and `busyUntil` for the id before/at removal.
   */
  remove: (id: string) => Promise<void>;

  /**
   * Flip a session to IDLE. Synchronously clears the busy timer and resets
   * `busyUntil[id]` unconditionally (a dead row can never show busy indicator).
   */
  markIdle: (id: string) => void;

  /**
   * Extend the busy window for a session to `Date.now() + 700ms` and arm (or
   * re-arm) the per-session 700ms timer that clears it on fire.
   */
  markActivity: (id: string) => void;

  /**
   * Returns true when the session should be shown as busy. Reads the in-store
   * `busyUntil` timestamp and compares against `Date.now()`.
   *
   * Note: this is a method on the store, not a Zustand selector, so the panel
   * can call `useAiSessionStore.getState().isBusy(id)` outside of hooks as well.
   * Inside components, subscribe to `busyUntil` in the selector and derive the
   * boolean in the component, so React re-renders when the timer fires.
   */
  isBusy: (id: string) => boolean;

  /**
   * Returns true when ANY session is currently busy. Used by the rail badge.
   */
  isAnyBusy: () => boolean;
}

// ---------------------------------------------------------------------------
// Private helper — shared by hydrate and refresh.
// ---------------------------------------------------------------------------

async function fetchAndSortSessions(): Promise<AiSession[]> {
  const [research, strategy] = await Promise.all([
    dbAiSessionsList('research'),
    dbAiSessionsList('strategy'),
  ]);
  return [...research, ...strategy].sort((a, b) => b.last_used_at - a.last_used_at);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAiSessionStore = create<AiSessionState>((set, get) => ({
  sessions: [],
  hydrated: false,
  busyUntil: {},
  runState: {},

  // ---- hydrate ---------------------------------------------------------------

  hydrate: async () => {
    try {
      // Fetch all modes in parallel — we mirror the full table in one store.
      const all = await fetchAndSortSessions();
      // All sessions are IDLE after restart — no PTY survives.
      const runState: Record<string, SessionRunState> = {};
      for (const s of all) runState[s.id] = 'IDLE';
      // Clear any stale busy timers that should not persist across boots.
      for (const [timerId, handle] of busyTimers) {
        clearTimeout(handle);
        busyTimers.delete(timerId);
      }
      set({ sessions: all, hydrated: true, runState, busyUntil: {} });
    } catch (err) {
      console.warn('[TODO P8 toast] dbAiSessionsList failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'warn',
          title: 'AI sessions unavailable',
          detail: 'Could not read saved sessions from disk',
        }),
      );
      set({ hydrated: true });
    }
  },

  // ---- refresh ---------------------------------------------------------------

  refresh: async () => {
    try {
      const all = await fetchAndSortSessions();
      // Preserve existing runState / busyUntil for any row that's already tracked.
      const prevRun = get().runState;
      const runState: Record<string, SessionRunState> = {};
      for (const s of all) runState[s.id] = prevRun[s.id] ?? 'IDLE';
      set({ sessions: all, runState });
    } catch (err) {
      console.warn('[TODO P8 toast] dbAiSessionsList (refresh) failed', err);
    }
  },

  // ---- recordSpawn -----------------------------------------------------------

  recordSpawn: async (meta) => {
    const now = Date.now();
    // On resume, the session already exists in memory — preserve its created_at
    // (and summary/title unless an override is provided) so the tab's timestamp
    // stays stable. Only a genuinely new id gets created_at: now.
    const existing = get().sessions.find((s) => s.id === meta.id);
    const row: AiSession = {
      id: meta.id,
      mode: meta.mode,
      cwd_path: meta.cwd_path,
      model: meta.model ?? null,
      created_at: existing?.created_at ?? now,
      last_used_at: now,
      summary: existing?.summary ?? null,
      title: meta.title ?? existing?.title ?? null,
    };

    // Optimistic: prepend to list (newest-first); mark RUNNING.
    const prev = get().sessions.filter((s) => s.id !== row.id);
    set((state) => ({
      sessions: [row, ...prev],
      runState: { ...state.runState, [row.id]: 'RUNNING' },
    }));

    try {
      await dbAiSessionsUpsert(row);
    } catch (err) {
      console.warn('[TODO P8 toast] dbAiSessionsUpsert failed (recordSpawn)', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Session not saved',
          detail: 'Kept locally; disk write failed',
        }),
      );
    }
  },

  // ---- rename ----------------------------------------------------------------

  rename: async (id, title) => {
    const existing = get().sessions.find((s) => s.id === id);
    if (!existing) return;

    // Optimistic update.
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    }));

    try {
      await dbAiSessionsUpsert({ ...existing, title });
    } catch (err) {
      console.warn('[TODO P8 toast] dbAiSessionsUpsert failed (rename)', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Rename not saved',
          detail: 'Disk write failed; name may revert on reload',
        }),
      );
    }
  },

  // ---- remove ----------------------------------------------------------------

  remove: async (id) => {
    // Synchronously clear the busy timer BEFORE the optimistic remove so the
    // timer callback can never fire on a deleted row.
    const handle = busyTimers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      busyTimers.delete(id);
    }

    set((state) => {
      const { [id]: _bu, ...restBusy } = state.busyUntil;
      const { [id]: _rs, ...restRun } = state.runState;
      return {
        sessions: state.sessions.filter((s) => s.id !== id),
        busyUntil: restBusy,
        runState: restRun,
      };
    });

    try {
      await dbAiSessionsDelete(id);
    } catch (err) {
      console.warn('[TODO P8 toast] dbAiSessionsDelete failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Session not deleted',
          detail: 'Disk row could not be removed',
        }),
      );
    }
  },

  // ---- markIdle --------------------------------------------------------------

  markIdle: (id) => {
    // Synchronously clear the busy timer unconditionally.
    const handle = busyTimers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      busyTimers.delete(id);
    }
    set((state) => {
      const { [id]: _bu, ...restBusy } = state.busyUntil;
      return {
        runState: { ...state.runState, [id]: 'IDLE' },
        busyUntil: restBusy,
      };
    });
  },

  // ---- markActivity ----------------------------------------------------------

  markActivity: (id) => {
    const until = Date.now() + 700;

    // Clear any existing timer for this id before arming a new one.
    const prev = busyTimers.get(id);
    if (prev !== undefined) clearTimeout(prev);

    const handle = setTimeout(() => {
      busyTimers.delete(id);
      // Only clear if the timestamp hasn't been refreshed past this expiry.
      const current = useAiSessionStore.getState().busyUntil[id];
      if (current !== undefined && Date.now() >= current) {
        set((state) => {
          const { [id]: _bu, ...restBusy } = state.busyUntil;
          return { busyUntil: restBusy };
        });
      }
    }, 700);

    busyTimers.set(id, handle);
    set((state) => ({
      busyUntil: { ...state.busyUntil, [id]: until },
    }));
  },

  // ---- isBusy ----------------------------------------------------------------

  isBusy: (id) => {
    const until = get().busyUntil[id];
    return until !== undefined && Date.now() < until;
  },

  // ---- isAnyBusy -------------------------------------------------------------

  isAnyBusy: () => {
    const { busyUntil } = get();
    const now = Date.now();
    return Object.values(busyUntil).some((until) => now < until);
  },
}));
