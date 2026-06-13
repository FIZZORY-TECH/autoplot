/**
 * src/ai/tools/backtestStrategy.test.ts — W5-B — `backtest_strategy` handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, isMockForcedMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isMockForcedMock: vi.fn(() => false),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../data/providerRegistry', () => ({
  isMockForced: isMockForcedMock,
}));

import { backtestStrategy } from './backtestStrategy';

const validStrategy = {
  id: 'rsi-mr-14',
  name: 'RSI(14) mean-revert',
  thesis: 'Buy oversold',
  rules: {
    entry: [{ indicator: 'rsi', op: '<', value: 30, params: { period: 14 } }],
    exit: [{ indicator: 'rsi', op: '>', value: 55, params: { period: 14 } }],
  },
  version: 1,
  createdAt: 1700000000000,
};

function synthBars(n: number) {
  // Sine-ish closes so RSI(14) crosses thresholds.
  const out: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + 20 * Math.sin(i / 5);
    out.push({ ts: i * 3600_000, o: c, h: c + 1, l: c - 1, c, v: 1000 });
  }
  return out;
}

describe('backtestStrategy', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isMockForcedMock.mockReset();
    isMockForcedMock.mockReturnValue(false);
  });

  it('returns ok:true with perf shape on a valid strategy + bars', async () => {
    invokeMock.mockResolvedValue(synthBars(200));
    const out = await backtestStrategy({
      strategy: validStrategy,
      sym: 'BTC',
      tf: '1h',
      count: 200,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(Array.isArray(out.trades)).toBe(true);
      expect(Array.isArray(out.equityCurve)).toBe(true);
      // perf is null when N=0; otherwise it's a PerfStats object.
      if (out.perf !== null) {
        expect(out.perf).toHaveProperty('winRate');
        expect(out.perf).toHaveProperty('sharpe');
        expect(out.perf).toHaveProperty('maxDrawdown');
        expect(out.perf).toHaveProperty('trades');
      }
    }
  });

  it('returns ok:false on Zod-invalid strategy', async () => {
    const bad = { ...validStrategy, version: 99 };
    const out = await backtestStrategy({
      strategy: bad,
      sym: 'BTC',
      tf: '1h',
      count: 200,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/version/);
  });

  it('returns ok:false on engine throw (NaN bar synthesis)', async () => {
    // NaN bars cause indicator math to NaN out; engine itself throws on
    // `donchian` / `realized_vol` paths in some configurations. To
    // deterministically force a throw we mock fetchBars with bars that have
    // NaN closes — Math.log(NaN/NaN) cascades; the engine uses ** and
    // Math.sqrt over the variance, which produces NaN but does NOT throw.
    // Instead, force `marketFetchHistory` to reject so the catch-block in
    // backtestStrategy fires.
    invokeMock.mockRejectedValue(new Error('network down'));
    const out = await backtestStrategy({
      strategy: validStrategy,
      sym: 'BTC',
      tf: '1h',
      count: 200,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('network down');
  });

  it('clamps count to 1500', async () => {
    invokeMock.mockResolvedValue(synthBars(50));
    await backtestStrategy({
      strategy: validStrategy,
      sym: 'BTC',
      tf: '1h',
      count: 9999,
    });
    const [, args] = invokeMock.mock.calls[0];
    expect(args.count).toBe(1500);
  });
});
