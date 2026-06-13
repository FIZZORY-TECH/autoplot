/**
 * src/stores/useStrategyStore.ts — In-memory mirror of the `strategies` SQLite
 * table (P7 W5-C3). Hydrated from `dbStrategiesList()` on app boot, then
 * mutated via `addStrategy` / `removeStrategy` / `updateStrategy` which fan
 * out to SQLite via `dbStrategies*`.
 *
 * The `Strategy` shape is owned by W5-A (`src/ai/schemas.ts`). On parse
 * failure (e.g. a future-version row), we log a `[legacy-strategy]` warning
 * and skip the row — do NOT crash.
 *
 * Edits-flow (P7-17):
 *   When a `strategy_returned` event arrives with an `id` matching an existing
 *   row, the store preserves `id` and `createdAt` from the old row, only
 *   updating the JSON body. The caller (W5-C12 or dispatchTools) should call
 *   `updateStrategy(id, newStrategy)`.
 */

import { create } from 'zustand';
import { Strategy } from '../ai/schemas';
import {
  dbStrategiesList,
  dbStrategiesUpsert,
  dbStrategiesDelete,
  type StrategyRow,
} from '../lib/db';
import { useToastStore } from './useToastStore';

// ---------------------------------------------------------------------------
// Persisted-row envelope
// ---------------------------------------------------------------------------

/** Extended strategy as stored in memory — canonical Strategy + row metadata. */
export interface PersistedStrategy extends Omit<import('../ai/schemas').Strategy, 'createdAt'> {
  /** From the Strategy's own `createdAt` field (preserved across edits). */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface StrategyState {
  /** All persisted strategies (mirror of SQLite), keyed by id for O(1) lookup. */
  strategies: Record<string, PersistedStrategy>;
  /** True once `hydrate()` has run successfully. */
  hydrated: boolean;

  /** Load all rows from SQLite into the in-memory mirror. */
  hydrate: () => Promise<void>;
  /** Replace the entire mirror — used by tests. */
  setStrategies: (map: Record<string, PersistedStrategy>) => void;
  /** Insert/replace one strategy (in-memory + SQLite). */
  addStrategy: (s: PersistedStrategy) => Promise<void>;
  /**
   * Update an existing strategy's JSON body while preserving `id` and
   * `createdAt`. If the row doesn't exist, behaves like `addStrategy`.
   */
  updateStrategy: (id: string, updated: PersistedStrategy) => Promise<void>;
  /** Remove from in-memory + SQLite. */
  removeStrategy: (id: string) => Promise<void>;
}

export const useStrategyStore = create<StrategyState>((set, get) => ({
  strategies: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const rows = await dbStrategiesList();
      const map: Record<string, PersistedStrategy> = {};
      for (const r of rows) {
        const parsed = parseStrategyRow(r);
        if (parsed) {
          map[parsed.id] = parsed;
        }
      }
      set({ strategies: map, hydrated: true });
    } catch (err) {
      console.warn('[strategy] dbStrategiesList failed', err);
      useToastStore.getState().push({
        kind: 'warn',
        title: 'Strategies unavailable',
        detail: 'Could not read saved strategies from disk',
      });
      set({ hydrated: true });
    }
  },

  setStrategies: (map) => set({ strategies: map }),

  addStrategy: async (s) => {
    // Optimistic local update.
    set((state) => ({ strategies: { ...state.strategies, [s.id]: s } }));
    try {
      await dbStrategiesUpsert({
        id: s.id,
        json: JSON.stringify(s),
        created_at: s.createdAt,
      });
    } catch (err) {
      console.warn('[strategy] dbStrategiesUpsert failed', err);
      useToastStore.getState().push({
        kind: 'error',
        title: 'Strategy not saved',
        detail: 'Kept locally, but could not persist to disk',
      });
    }
  },

  updateStrategy: async (id, updated) => {
    // Preserve createdAt from the existing row; fall through to addStrategy if
    // the row doesn't exist.
    const existing = get().strategies[id];
    const merged: PersistedStrategy = existing
      ? { ...updated, id, createdAt: existing.createdAt }
      : updated;

    // Emit a shallow diff toast marker between old and new rules.
    if (existing) {
      const oldRules = existing.rules ?? {};
      const newRules = updated.rules ?? {};
      const diffs: string[] = [];

      // Check entry conditions.
      const oldEntry = oldRules.entry ?? [];
      const newEntry = newRules.entry ?? [];
      if (oldEntry.length !== newEntry.length) {
        diffs.push(
          `entry conditions: ${oldEntry.length} → ${newEntry.length}`,
        );
      } else {
        oldEntry.forEach((c, i) => {
          const nc = newEntry[i];
          if (nc && (c.indicator !== nc.indicator || c.op !== nc.op || c.value !== nc.value)) {
            diffs.push(
              `entry[${i}]: ${c.indicator} ${c.op} ${JSON.stringify(c.value)} → ${nc.indicator} ${nc.op} ${JSON.stringify(nc.value)}`,
            );
          }
        });
      }

      // Check exit conditions.
      const oldExit = oldRules.exit ?? [];
      const newExit = newRules.exit ?? [];
      if (oldExit.length !== newExit.length) {
        diffs.push(
          `exit conditions: ${oldExit.length} → ${newExit.length}`,
        );
      } else {
        oldExit.forEach((c, i) => {
          const nc = newExit[i];
          if (nc && (c.indicator !== nc.indicator || c.op !== nc.op || c.value !== nc.value)) {
            diffs.push(
              `exit[${i}]: ${c.indicator} ${c.op} ${JSON.stringify(c.value)} → ${nc.indicator} ${nc.op} ${JSON.stringify(nc.value)}`,
            );
          }
        });
      }

      if (diffs.length > 0) {
        // Diff summary kept on console for debug; visible toast for the user.
        console.warn(
          `[strategy] edit diff for "${id}": ${diffs.join('; ')}`,
        );
        useToastStore.getState().push({
          kind: 'info',
          title: 'Strategy updated',
          detail: diffs.slice(0, 2).join('; '),
        });
      } else {
        console.warn(
          `[strategy] edit for "${id}": no rule changes detected (metadata/thesis may have changed)`,
        );
        useToastStore.getState().push({
          kind: 'info',
          title: 'Strategy updated',
          detail: 'No rule changes — metadata only',
        });
      }
    }

    // Optimistic update.
    set((state) => ({
      strategies: { ...state.strategies, [id]: merged },
    }));
    try {
      await dbStrategiesUpsert({
        id: merged.id,
        json: JSON.stringify(merged),
        created_at: merged.createdAt,
      });
    } catch (err) {
      console.warn('[strategy] dbStrategiesUpsert (update) failed', err);
      useToastStore.getState().push({
        kind: 'error',
        title: 'Strategy update not saved',
        detail: 'Local state kept; disk write failed',
      });
    }
  },

  removeStrategy: async (id) => {
    set((state) => {
      const next = { ...state.strategies };
      delete next[id];
      return { strategies: next };
    });
    try {
      await dbStrategiesDelete(id);
    } catch (err) {
      console.warn('[strategy] dbStrategiesDelete failed', err);
      useToastStore.getState().push({
        kind: 'error',
        title: 'Strategy not deleted',
        detail: 'Disk row could not be removed',
      });
    }
  },
}));

// ---------------------------------------------------------------------------
// Row parsing — silently skip malformed JSON / Zod failures so a single bad
// row doesn't poison the whole hydrate.
// ---------------------------------------------------------------------------

function parseStrategyRow(r: StrategyRow): PersistedStrategy | null {
  try {
    const obj = JSON.parse(r.json) as unknown;
    const result = Strategy.safeParse(obj);
    if (!result.success) {
      console.warn(
        '[legacy-strategy] Zod parse failed for row',
        r.id,
        result.error.issues,
      );
      return null;
    }
    const s = result.data;
    return {
      ...s,
      createdAt: s.createdAt ?? r.created_at,
    };
  } catch {
    console.warn(
      '[legacy-strategy] malformed JSON in strategies table, skipping',
      r.id,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience selector — ordered list (stable sort by createdAt then id).
// ---------------------------------------------------------------------------

export function selectStrategiesList(
  s: StrategyState,
): PersistedStrategy[] {
  return Object.values(s.strategies).sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}
