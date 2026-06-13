/**
 * src/engine/p7.integration.test.ts — Wave 5 / W5-D
 *
 * P7 integration vitest: exercises end-to-end scenarios that bridge the seeded
 * strategies, the backtest engine, the strategy store, and the migration gate.
 *
 * Three test suites:
 *   1. Full pipeline integration — RSI mean-revert SEED preset + 200-bar
 *      synthetic series → `backtest()` → deterministic trade count & perf shape.
 *   2. Edit-flow round-trip — synthesise a `strategy_returned` event with the
 *      same id but a different exit value → assert store preserves id+createdAt,
 *      updates JSON, fires the diff toast. (Extends W5-C3 coverage with the
 *      seed-preset integration path.)
 *   3. Migration scaffold no-op — assert running the seed function twice on a
 *      fresh store (gate already set on second run) does NOT double-insert rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Bar } from '../data/MarketDataProvider';
import { backtest } from './backtest';
import { SEED_STRATEGY_DEFS } from '../ai/seedStrategies';

// ---------------------------------------------------------------------------
// Mock Tauri invoke — mirrors useStrategyStore.test.ts pattern.
// ---------------------------------------------------------------------------

import type { StrategyRow } from '../lib/db';

const _dbRows: StrategyRow[] = [];
let _seedGate: string | null = null;

const mockInvoke = vi.fn((cmd: string, args?: unknown) => {
  if (cmd === 'db_strategies_list') return Promise.resolve([..._dbRows]);
  if (cmd === 'db_strategies_upsert') {
    const row = (args as { row: StrategyRow }).row;
    const idx = _dbRows.findIndex((r) => r.id === row.id);
    if (idx >= 0) {
      _dbRows[idx] = { ..._dbRows[idx], json: row.json };
    } else {
      _dbRows.push({ ...row });
    }
    return Promise.resolve(undefined);
  }
  if (cmd === 'db_strategies_delete') {
    const id = (args as { id: string }).id;
    const idx = _dbRows.findIndex((r) => r.id === id);
    if (idx >= 0) _dbRows.splice(idx, 1);
    return Promise.resolve(undefined);
  }
  if (cmd === 'db_app_state_get') return Promise.resolve(_seedGate);
  if (cmd === 'db_app_state_set') {
    if ((args as { key: string; value: string }).key === 'library.strategies_seeded') {
      _seedGate = (args as { key: string; value: string }).value;
    }
    return Promise.resolve(undefined);
  }
  return Promise.resolve(null);
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

// Import AFTER the mock.
import {
  useStrategyStore,
  selectStrategiesList,
  type PersistedStrategy,
} from '../stores/useStrategyStore';
import {
  seedDefaultStrategiesIfNeeded,
} from '../ai/seedStrategies';

// ---------------------------------------------------------------------------
// Bar factory — hand-rolled, no MockMarketDataProvider.
// ---------------------------------------------------------------------------

const TF_MS_1D = 24 * 60 * 60 * 1000;

function makeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ ts: i * TF_MS_1D, o: c, h: c, l: c, c, v: 1 }));
}

/**
 * Build a 200-bar synthetic series that triggers RSI(14) < 30 followed by
 * RSI > 70 at least once, so the seed RSI preset fires at least one trade.
 *
 * Pattern: 80-bar downtrend (pushes RSI < 30), then 80-bar uptrend (pushes
 * RSI > 70), then 40 bars of noise.
 */
function makeRsiCycleBars(n = 200): Bar[] {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < 80; i++) { p -= 0.8; closes.push(p); }
  for (let i = 0; i < 80; i++) { p += 0.8; closes.push(p); }
  for (let i = 0; i < n - 160; i++) { p += (i % 3 === 0 ? 0.2 : -0.1); closes.push(p); }
  return makeBars(closes);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function resetAll() {
  useStrategyStore.setState({ strategies: {}, hydrated: false });
  _dbRows.length = 0;
  _seedGate = null;
}

beforeEach(() => {
  resetAll();
  mockInvoke.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Suite 1 — Full backtest pipeline with RSI mean-revert seed preset
// ===========================================================================

describe('P7 integration — full backtest pipeline (seed preset end-to-end)', () => {
  it('RSI(14) mean-revert preset produces at least 1 trade on 200 synthetic bars', () => {
    // Locate the seed preset definition (not seeded via DB; used directly as
    // a pure backtest input to test the engine ↔ preset shape compatibility).
    const rsiPreset = SEED_STRATEGY_DEFS.find((d) => d.id === 'seed-rsi-revert-v1');
    expect(rsiPreset).toBeDefined();

    const bars = makeRsiCycleBars(200);
    // Reconstruct a full Strategy object from the seed def.
    const strategy = {
      ...rsiPreset!,
      createdAt: Date.now(),
      perf: undefined,
    };

    const result = backtest(bars, strategy as Parameters<typeof backtest>[1], { tf: '1d' });

    // Determinism: the preset + this synthetic series must produce >= 1 trade.
    expect(result.trades.length).toBeGreaterThanOrEqual(1);

    // Perf shape: non-null with the expected numeric fields.
    expect(result.perf).not.toBeNull();
    const perf = result.perf!;
    expect(typeof perf.winRate).toBe('number');
    expect(typeof perf.sharpe).toBe('number');
    expect(typeof perf.maxDrawdown).toBe('number');
    expect(typeof perf.trades).toBe('number');
    expect(perf.trades).toBe(result.trades.length);

    // All trades must have valid financial shape.
    for (const t of result.trades) {
      expect(t.entryBar).toBeLessThan(t.exitBar);
      expect(t.entryPrice).toBeGreaterThan(0);
      expect(t.exitPrice).toBeGreaterThan(0);
      expect(typeof t.pnl).toBe('number');
      expect(typeof t.pnlPct).toBe('number');
    }

    // The RSI preset buys on oversold and exits on overbought.
    // With a downtrend-then-uptrend series, the entry should occur while price
    // is still declining (RSI < 30 fires in the downtrend) and exit fires
    // in the uptrend (RSI > 70). The exact direction depends on RSI convergence
    // timing, so we only assert the trade is valid and perf is populated.
    const first = result.trades[0];
    expect(first.entryPrice).toBeGreaterThan(0);
    expect(first.exitPrice).toBeGreaterThan(0);
  });

  it('RSI preset produces deterministic trade count across 3 identical runs', () => {
    const rsiPreset = SEED_STRATEGY_DEFS.find((d) => d.id === 'seed-rsi-revert-v1')!;
    const strategy = { ...rsiPreset, createdAt: 0, perf: undefined } as Parameters<typeof backtest>[1];
    const bars = makeRsiCycleBars(200);

    const counts = [
      backtest(bars, strategy, { tf: '1d' }).trades.length,
      backtest(bars, strategy, { tf: '1d' }).trades.length,
      backtest(bars, strategy, { tf: '1d' }).trades.length,
    ];
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBe(counts[2]);
  });

  it('Donchian 20/10 breakout preset runs without throwing on synthetic bars', () => {
    const dchPreset = SEED_STRATEGY_DEFS.find((d) => d.id === 'seed-donchian-breakout-v1')!;
    const strategy = { ...dchPreset, createdAt: 0, perf: undefined } as Parameters<typeof backtest>[1];
    // 60-bar series with a clear breakout.
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 30; i++) { p += (i % 5); closes.push(p); }
    for (let i = 0; i < 15; i++) { p += 3; closes.push(p); }   // breakout
    for (let i = 0; i < 15; i++) { p -= 3; closes.push(p); }   // reversal
    const bars = makeBars(closes);

    expect(() => backtest(bars, strategy, { tf: '1d' })).not.toThrow();
  });
});

// ===========================================================================
// Suite 2 — Edit-flow round-trip (seed-preset integration path)
// ===========================================================================

describe('P7 integration — edit-flow round-trip with seed-preset id', () => {
  it('updateStrategy with same id as a seeded preset preserves id + createdAt', async () => {
    // First run: seed the two presets.
    await seedDefaultStrategiesIfNeeded();

    const list = selectStrategiesList(useStrategyStore.getState());
    expect(list).toHaveLength(2);

    const rsiPreset = list.find((s) => s.id === 'seed-rsi-revert-v1');
    expect(rsiPreset).toBeDefined();
    const originalCreatedAt = rsiPreset!.createdAt;

    // Simulate a `strategy_returned` event with the same id but a changed exit value.
    const editedStrategy: PersistedStrategy = {
      ...rsiPreset!,
      name: 'RSI(14) Mean Reversion — Tightened',
      rules: {
        ...rsiPreset!.rules,
        exit: [
          // Changed: >70 → >65 (tightened exit)
          { indicator: 'rsi', op: '>' as const, value: 65, params: { period: 14 } },
        ],
      },
      createdAt: 9_999_999_999_999, // must be overridden by the store
    };

    await useStrategyStore.getState().updateStrategy('seed-rsi-revert-v1', editedStrategy);

    const stored = useStrategyStore.getState().strategies['seed-rsi-revert-v1'];
    expect(stored).toBeDefined();

    // id and createdAt preserved.
    expect(stored!.id).toBe('seed-rsi-revert-v1');
    expect(stored!.createdAt).toBe(originalCreatedAt);

    // JSON updated — exit value is now 65.
    expect(stored!.rules.exit[0].value).toBe(65);
    expect(stored!.name).toBe('RSI(14) Mean Reversion — Tightened');
  });

  it('updateStrategy fires diff warning when exit condition changes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await seedDefaultStrategiesIfNeeded();
    const rsiPreset = selectStrategiesList(useStrategyStore.getState()).find(
      (s) => s.id === 'seed-rsi-revert-v1',
    )!;

    await useStrategyStore.getState().updateStrategy('seed-rsi-revert-v1', {
      ...rsiPreset,
      rules: {
        ...rsiPreset.rules,
        exit: [{ indicator: 'rsi', op: '>' as const, value: 65, params: { period: 14 } }],
      },
    });

    const toastCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('[strategy] edit diff'),
    );
    expect(toastCalls.length).toBeGreaterThan(0);

    // Summary must mention exit[0] since only that changed.
    const msg = toastCalls[0][0] as string;
    expect(msg).toContain('exit[0]');
  });
});

// ===========================================================================
// Suite 3 — Migration scaffold no-op
// ===========================================================================

describe('P7 integration — seed / migration no-op', () => {
  it('first run seeds 2 rows; second run with gate set is a no-op', async () => {
    // First run.
    await seedDefaultStrategiesIfNeeded();
    const afterFirst = selectStrategiesList(useStrategyStore.getState());
    expect(afterFirst).toHaveLength(2);
    expect(_seedGate).toBe('1');

    // Second run — gate is already '1' in mock, store reset to empty to verify
    // no new rows are inserted.
    useStrategyStore.setState({ strategies: {}, hydrated: false });
    await seedDefaultStrategiesIfNeeded();
    const afterSecond = selectStrategiesList(useStrategyStore.getState());
    // Store was reset; seed was gated → still empty.
    expect(afterSecond).toHaveLength(0);
  });

  it('calling seed twice in a row does not double-insert rows', async () => {
    // Both calls see gate=null on first, then gate='1' is set after first run.
    // Simulate by resetting and calling twice but letting mock gate persist.
    await seedDefaultStrategiesIfNeeded();
    const countAfterFirst = _dbRows.length;
    expect(countAfterFirst).toBe(2);

    // Second call — gate is now '1' in _seedGate so it must short-circuit.
    await seedDefaultStrategiesIfNeeded();
    expect(_dbRows.length).toBe(countAfterFirst); // no duplicates
  });

  it('upsert on duplicate id does not create a new row (ON CONFLICT behavior)', async () => {
    await seedDefaultStrategiesIfNeeded();
    const initialCount = _dbRows.length;

    // Re-upsert the same strategy — should update in-place, not insert a new row.
    const existing = useStrategyStore.getState().strategies['seed-rsi-revert-v1'];
    await useStrategyStore.getState().addStrategy(existing);

    expect(_dbRows.length).toBe(initialCount); // still 2 rows, not 3
  });
});
