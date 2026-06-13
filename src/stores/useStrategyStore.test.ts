/**
 * src/stores/useStrategyStore.test.ts — W5-C3 vitest cases.
 *
 * Covers:
 *   1. DB wrapper round-trip via mocked `invoke`.
 *   2. Store hydrate: Zod-valid rows are parsed; invalid rows log [legacy-strategy]
 *      and are skipped (no crash).
 *   3. Seed runs once → 2 strategies inserted; second run is a no-op.
 *   4. Edits-flow: `updateStrategy` with same id preserves `id` + `createdAt`,
 *      updates JSON, and emits the diff warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StrategyRow } from '../lib/db';

// ---------------------------------------------------------------------------
// Mock Tauri invoke — capture calls so we can assert round-trips.
// ---------------------------------------------------------------------------

const dbRows: StrategyRow[] = [];
const mockInvoke = vi.fn((cmd: string, args?: unknown) => {
  if (cmd === 'db_strategies_list') return Promise.resolve([...dbRows]);
  if (cmd === 'db_strategies_upsert') {
    const row = (args as { row: StrategyRow }).row;
    const idx = dbRows.findIndex((r) => r.id === row.id);
    if (idx >= 0) {
      dbRows[idx] = { ...dbRows[idx], json: row.json }; // ON CONFLICT: update json only
    } else {
      dbRows.push({ ...row });
    }
    return Promise.resolve(undefined);
  }
  if (cmd === 'db_strategies_delete') {
    const id = (args as { id: string }).id;
    const idx = dbRows.findIndex((r) => r.id === id);
    if (idx >= 0) dbRows.splice(idx, 1);
    return Promise.resolve(undefined);
  }
  if (cmd === 'db_app_state_get') return Promise.resolve(null);
  if (cmd === 'db_app_state_set') return Promise.resolve(undefined);
  return Promise.resolve(null);
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

// Import AFTER mock.
import { useStrategyStore, selectStrategiesList, type PersistedStrategy } from './useStrategyStore';
import {
  seedDefaultStrategiesIfNeeded,
  SEED_STRATEGY_DEFS,
} from '../ai/seedStrategies';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useStrategyStore.setState({ strategies: {}, hydrated: false });
}

function makePersistedStrategy(id: string, name: string): PersistedStrategy {
  return {
    id,
    name,
    thesis: 'Test thesis for ' + name,
    rules: {
      entry: [{ indicator: 'rsi', op: '<', value: 30, params: { period: 14 } }],
      exit:  [{ indicator: 'rsi', op: '>', value: 70, params: { period: 14 } }],
    },
    perf: undefined,
    version: 1,
    createdAt: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
  dbRows.length = 0;
  mockInvoke.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useStrategyStore — DB round-trip', () => {
  it('addStrategy writes to SQLite and updates in-memory map', async () => {
    const s = makePersistedStrategy('s1', 'RSI Mean Revert');
    await useStrategyStore.getState().addStrategy(s);
    // In-memory map contains the strategy.
    expect(useStrategyStore.getState().strategies['s1']).toMatchObject({ id: 's1', name: 'RSI Mean Revert' });
    // SQLite mock received upsert.
    expect(mockInvoke).toHaveBeenCalledWith('db_strategies_upsert', expect.objectContaining({
      row: expect.objectContaining({ id: 's1' }),
    }));
  });

  it('removeStrategy removes from in-memory and SQLite', async () => {
    await useStrategyStore.getState().addStrategy(makePersistedStrategy('s1', 'Test'));
    await useStrategyStore.getState().removeStrategy('s1');
    expect(useStrategyStore.getState().strategies['s1']).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith('db_strategies_delete', { id: 's1' });
  });

  it('hydrate populates in-memory from SQLite rows', async () => {
    // Seed the mock DB directly.
    const s = makePersistedStrategy('s-hydrate', 'Hydration Test');
    dbRows.push({ id: s.id, json: JSON.stringify(s), created_at: s.createdAt });

    await useStrategyStore.getState().hydrate();
    const map = useStrategyStore.getState().strategies;
    expect(map['s-hydrate']).toBeDefined();
    expect(map['s-hydrate'].name).toBe('Hydration Test');
    expect(useStrategyStore.getState().hydrated).toBe(true);
  });

  it('hydrate skips malformed rows and logs [legacy-strategy]', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbRows.push({ id: 'bad-row', json: '{ "not": "a strategy" }', created_at: 1 });

    await useStrategyStore.getState().hydrate();
    expect(useStrategyStore.getState().strategies['bad-row']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[legacy-strategy]'),
      'bad-row',
      expect.anything(),
    );
  });
});

describe('useStrategyStore — selectStrategiesList', () => {
  it('returns ordered list by createdAt', async () => {
    const s1 = { ...makePersistedStrategy('a', 'A'), createdAt: 200 };
    const s2 = { ...makePersistedStrategy('b', 'B'), createdAt: 100 };
    await useStrategyStore.getState().addStrategy(s1);
    await useStrategyStore.getState().addStrategy(s2);
    const list = selectStrategiesList(useStrategyStore.getState());
    expect(list[0].id).toBe('b'); // createdAt 100 first
    expect(list[1].id).toBe('a'); // createdAt 200 second
  });
});

describe('seedDefaultStrategiesIfNeeded', () => {
  it('seeds 2 strategies on first run', async () => {
    // Gate is unset (mockInvoke returns null for db_app_state_get).
    await seedDefaultStrategiesIfNeeded();
    const list = selectStrategiesList(useStrategyStore.getState());
    expect(list).toHaveLength(SEED_STRATEGY_DEFS.length);
    expect(list.map((s) => s.id)).toContain('seed-rsi-revert-v1');
    expect(list.map((s) => s.id)).toContain('seed-donchian-breakout-v1');
  });

  it('is a no-op on second run when gate is set', async () => {
    // First run — gate not set.
    await seedDefaultStrategiesIfNeeded();
    const listAfterFirst = selectStrategiesList(useStrategyStore.getState());
    expect(listAfterFirst).toHaveLength(2);

    // Set gate in mock — override only db_app_state_get to return '1'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockInvoke as any).mockImplementation((cmd: string, _args?: unknown) => {
      if (cmd === 'db_app_state_get') return Promise.resolve('1');
      return Promise.resolve(undefined);
    });

    // Second run — must be a no-op (store unchanged).
    resetStore();
    await seedDefaultStrategiesIfNeeded();
    const listAfterSecond = selectStrategiesList(useStrategyStore.getState());
    expect(listAfterSecond).toHaveLength(0); // store was reset; seed skipped
  });
});

describe('useStrategyStore — edits-flow (updateStrategy)', () => {
  it('preserves id and createdAt when updating JSON', async () => {
    const original = makePersistedStrategy('edit-id', 'Original');
    await useStrategyStore.getState().addStrategy(original);

    const updated: PersistedStrategy = {
      ...original,
      name: 'Updated',
      createdAt: 9_999_999_999_999, // MUST be ignored — old createdAt preserved
      rules: {
        entry: [{ indicator: 'rsi', op: '<', value: 25, params: { period: 14 } }],
        exit:  [{ indicator: 'rsi', op: '>', value: 75, params: { period: 14 } }],
      },
    };

    await useStrategyStore.getState().updateStrategy('edit-id', updated);

    const stored = useStrategyStore.getState().strategies['edit-id'];
    expect(stored).toBeDefined();
    expect(stored!.id).toBe('edit-id');
    expect(stored!.createdAt).toBe(1_700_000_000_000); // original createdAt preserved
    expect(stored!.name).toBe('Updated');

    // JSON in SQLite also updated.
    const dbRow = dbRows.find((r) => r.id === 'edit-id');
    expect(dbRow).toBeDefined();
    const parsed = JSON.parse(dbRow!.json) as PersistedStrategy;
    expect(parsed.createdAt).toBe(1_700_000_000_000); // NOT 9_999_999_999_999
    // SQLite row created_at also preserves original.
    expect(dbRow!.created_at).toBe(1_700_000_000_000);
  });

  it('emits diff warning on rule change', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = makePersistedStrategy('diff-id', 'DiffTest');
    await useStrategyStore.getState().addStrategy(original);

    const updated: PersistedStrategy = {
      ...original,
      rules: {
        entry: original.rules.entry,
        exit:  [{ indicator: 'rsi', op: '>', value: 75, params: { period: 14 } }], // changed: 70 → 75
      },
    };

    await useStrategyStore.getState().updateStrategy('diff-id', updated);

    // Must have emitted a diff summary on the console.
    const toastCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('diff-id'),
    );
    expect(toastCalls.length).toBeGreaterThan(0);
    // The summary should mention the exit condition change.
    const summaryMsg = toastCalls[0][0] as string;
    expect(summaryMsg).toContain('exit[0]');
  });

  it('behaves like addStrategy when id does not exist yet', async () => {
    const fresh = makePersistedStrategy('brand-new', 'New Strategy');
    await useStrategyStore.getState().updateStrategy('brand-new', fresh);
    expect(useStrategyStore.getState().strategies['brand-new']).toBeDefined();
    expect(useStrategyStore.getState().strategies['brand-new'].createdAt).toBe(1_700_000_000_000);
  });
});
