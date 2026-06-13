/**
 * Vitest golden tests for src/engine/backtest.ts (Wave 5 / W5-A).
 *
 * Synthetic bar fixtures are hand-rolled; the engine is a pure function so
 * determinism is straightforward. Helper `makeBars(closes)` turns a price
 * array into deterministic Bars with `o=h=l=c=close, v=1, ts=i*tfMs`.
 */
import { describe, it, expect } from 'vitest';
import type { Bar } from '../data/MarketDataProvider';
import type { Strategy } from '../ai/schemas';
import { backtest, SHARPE_FACTOR } from './backtest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TF_MS_1D = 24 * 60 * 60 * 1000;

function makeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    ts: i * TF_MS_1D,
    o: c,
    h: c,
    l: c,
    c,
    v: 1,
  }));
}

/** Bars with explicit highs/lows — needed for Donchian breakout test. */
function makeOhlcBars(rows: Array<{ o: number; h: number; l: number; c: number }>): Bar[] {
  return rows.map((r, i) => ({ ts: i * TF_MS_1D, ...r, v: 1 }));
}

function makeStrategy(
  entry: Strategy['rules']['entry'],
  exit: Strategy['rules']['exit'],
  filters?: Strategy['rules']['filters'],
): Strategy {
  return {
    id: 't',
    name: 't',
    thesis: 't',
    rules: { entry, exit, ...(filters ? { filters } : {}) },
    version: 1,
    createdAt: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. RSI(14) <30 buy / >70 sell on a synthetic series
// ---------------------------------------------------------------------------

describe('backtest — RSI(14) reversal', () => {
  it('fires on a hand-crafted oversold→overbought series', () => {
    // 30 bars: a long downtrend (push RSI <30), then strong uptrend (push >70).
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 16; i++) {
      p -= 2;
      closes.push(p);
    }
    for (let i = 0; i < 30; i++) {
      p += 2;
      closes.push(p);
    }
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [{ indicator: 'rsi', op: '<', value: 30, params: { period: 14 } }],
      [{ indicator: 'rsi', op: '>', value: 70, params: { period: 14 } }],
    );
    const res = backtest(bars, strat, { tf: '1d' });
    expect(res.trades.length).toBeGreaterThanOrEqual(1);
    const t = res.trades[0];
    expect(t.entryBar).toBeGreaterThanOrEqual(14); // RSI cold-start
    expect(t.exitBar).toBeGreaterThan(t.entryBar);
    expect(t.exitPrice).toBeGreaterThan(t.entryPrice); // bought low, sold high
    expect(t.pnl).toBeGreaterThan(0);
    expect(res.perf).not.toBeNull();
    expect(res.perf!.winRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Donchian 20/10 breakout
// ---------------------------------------------------------------------------

describe('backtest — Donchian 20/10 breakout', () => {
  it('enters on close > donchian_high(20), exits on close < donchian_low(10)', () => {
    // Construct bars with LAGGING highs/lows so a close-vs-current-donchian
    // comparison fires only when the current bar's close prints a fresh
    // window-high (or window-low). We set
    //   h_i = max(closes[i-19..i-1]),  l_i = min(closes[i-9..i-1])
    // so donchian_high(20) at bar i == prior-20-close-max (excluding bar i)
    // and donchian_low(10) at bar i == prior-10-close-min. Then
    //   close > donchian_high(20) <=> close prints a 20-bar new high
    //   close < donchian_low(10)  <=> close prints a 10-bar new low.
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + (i % 5));        // 0..29 base
    for (let i = 0; i < 5;  i++) closes.push(110 + i * 2);          // 30..34 breakout
    for (let i = 0; i < 15; i++) closes.push(118 + (i % 3));        // 35..49 plateau
    for (let i = 0; i < 5;  i++) closes.push(105 - i * 5);          // 50..54 drop
    const rows: Array<{ o: number; h: number; l: number; c: number }> = [];
    for (let i = 0; i < closes.length; i++) {
      const lo20 = Math.max(0, i - 20);
      const lo10 = Math.max(0, i - 10);
      const priorWin20 = closes.slice(lo20, i);
      const priorWin10 = closes.slice(lo10, i);
      const h = priorWin20.length === 0 ? closes[i] : Math.max(...priorWin20);
      const l = priorWin10.length === 0 ? closes[i] : Math.min(...priorWin10);
      rows.push({ o: closes[i], h, l, c: closes[i] });
    }
    const bars = makeOhlcBars(rows);
    const strat = makeStrategy(
      [
        {
          indicator: 'close',
          op: '>',
          value: { ref: 'donchian_high', params: { period: 20 } },
        },
      ],
      [
        {
          indicator: 'close',
          op: '<',
          value: { ref: 'donchian_low', params: { period: 10 } },
        },
      ],
    );
    const res = backtest(bars, strat, { tf: '1d' });
    expect(res.trades.length).toBeGreaterThanOrEqual(1);
    const t = res.trades[0];
    // Entry must be in/after the breakout window (>=30) and before the drop.
    expect(t.entryBar).toBeGreaterThanOrEqual(30);
    expect(t.entryBar).toBeLessThan(50);
    // Exit must be in or after the drop window.
    expect(t.exitBar).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// 3. Cold-start skip — RSI(14) → no entries on first 14 bars
// ---------------------------------------------------------------------------

describe('backtest — cold-start', () => {
  it('does not evaluate entry/exit before all referenced indicators yield', () => {
    // RSI(14) yields its first value at bar index 14. Use a series that, even
    // if RSI were defined earlier, would trigger; assert no trade on bars
    // 0..13.
    const closes = [
      100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87,
      // Bar 14 onwards: will have RSI defined — but we only assert cold-start.
    ];
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [{ indicator: 'rsi', op: '<', value: 999, params: { period: 14 } }], // would always fire
      [{ indicator: 'rsi', op: '>', value: -1, params: { period: 14 } }],   // would always fire
    );
    const res = backtest(bars, strat, { tf: '1d' });
    // Only 14 bars; RSI has at most one defined value (at index 13). No
    // sustained entry+exit pair possible — but more importantly no entry
    // before bar 13.
    for (const t of res.trades) {
      expect(t.entryBar).toBeGreaterThanOrEqual(13);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Same-bar exit-before-entry race
// ---------------------------------------------------------------------------

describe('backtest — same-bar exit/entry race', () => {
  it('closes on this bar but does not re-enter on the same bar', () => {
    // Strategy: entry when close > 50, exit when close > 50.
    // Both rules trigger on every bar where close > 50 → exit beats entry,
    // so once a position is open we close it and do NOT re-enter same bar.
    const closes = [40, 41, 60, 61, 62, 63];
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [{ indicator: 'close', op: '>', value: 50 }],
      [{ indicator: 'close', op: '>', value: 50 }],
    );
    const res = backtest(bars, strat, { tf: '1d' });
    // Bar 2: flat → entry. Bar 3: open & exit fires → close. Bar 4: flat &
    // entry. Bar 5: close. Bars 0..1 are flat (close <= 50).
    const entryBars = res.trades.map((t) => t.entryBar);
    const exitBars = res.trades.map((t) => t.exitBar);
    // No trade may have entryBar === exitBar (same-bar entry+exit forbidden).
    for (const t of res.trades) {
      expect(t.entryBar).toBeLessThan(t.exitBar);
    }
    // We expect alternating enter/exit on consecutive bars.
    expect(entryBars).toEqual([2, 4]);
    expect(exitBars).toEqual([3, 5]);
  });
});

// ---------------------------------------------------------------------------
// 5. N=0 case → perf null, equityCurve all 1s
// ---------------------------------------------------------------------------

describe('backtest — no trades', () => {
  it('returns perf=null and equityCurve full of 1s', () => {
    const bars = makeBars([10, 10, 10, 10, 10]);
    const strat = makeStrategy(
      [{ indicator: 'close', op: '>', value: 1e9 }],
      [{ indicator: 'close', op: '>', value: 1e9 }],
    );
    const res = backtest(bars, strat, { tf: '1d' });
    expect(res.trades).toEqual([]);
    expect(res.perf).toBeNull();
    expect(res.equityCurve).toEqual([1, 1, 1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// 6. Open-position-at-end
// ---------------------------------------------------------------------------

describe('backtest — open position at end', () => {
  it('forces close at last bar with openAtEnd: true', () => {
    // Entry triggers on bar 1; exit never triggers.
    const bars = makeBars([10, 20, 21, 22, 23]);
    const strat = makeStrategy(
      [{ indicator: 'close', op: '>', value: 15 }],
      [{ indicator: 'close', op: '<', value: -1 }], // never fires
    );
    const res = backtest(bars, strat, { tf: '1d' });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.openAtEnd).toBe(true);
    expect(t.entryBar).toBe(1);
    expect(t.exitBar).toBe(4);
    expect(t.exitPrice).toBe(23);
    expect(t.entryPrice).toBe(20);
    expect(t.pnl).toBe(3);
    expect(t.pnlPct).toBeCloseTo(0.15, 12);
    expect(res.perf).not.toBeNull();
    expect(res.perf!.trades).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Sharpe annualisation per tf — same trades, four runs
// ---------------------------------------------------------------------------

describe('backtest — Sharpe annualisation', () => {
  // Build a strategy producing >=2 trades so stdev > 0.
  function fixture() {
    // Closes: rise / fall / rise / fall — entry > 50, exit < 50 toggles trades.
    const closes = [40, 60, 70, 40, 30, 65, 80, 45, 35];
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [{ indicator: 'close', op: '>', value: 50 }],
      [{ indicator: 'close', op: '<', value: 50 }],
    );
    return { bars, strat };
  }

  it('Sharpe scales by SHARPE_FACTOR[tf]', () => {
    const { bars, strat } = fixture();
    const r1d = backtest(bars, strat, { tf: '1d' });
    const r1h = backtest(bars, strat, { tf: '1h' });
    const r4h = backtest(bars, strat, { tf: '4h' });
    const r1w = backtest(bars, strat, { tf: '1w' });
    expect(r1d.trades.length).toBeGreaterThanOrEqual(2);
    expect(r1d.perf).not.toBeNull();
    const base = r1d.perf!.sharpe / SHARPE_FACTOR['1d'];
    expect(r1h.perf!.sharpe).toBeCloseTo(base * SHARPE_FACTOR['1h'], 9);
    expect(r4h.perf!.sharpe).toBeCloseTo(base * SHARPE_FACTOR['4h'], 9);
    expect(r1w.perf!.sharpe).toBeCloseTo(base * SHARPE_FACTOR['1w'], 9);
  });
});

// ---------------------------------------------------------------------------
// 8. Max DD on equity curve — hand-computed
// ---------------------------------------------------------------------------

describe('backtest — max drawdown', () => {
  it('matches a hand-computed peak-to-trough on the equity curve', () => {
    // Engineered series where every trade enters at 100 and exits at 50 →
    // pnlPct = -0.5 each. Closes dip to 50 between trades to re-arm entry.
    //
    //   Trade 1: entry@100 → exit@50  (pnlPct = -0.5)
    //   Trade 2: entry@100 → exit@50
    //   Trade 3: entry@100 → exit@50
    //   Trade 4: entry@100 → exit@50
    //
    //   Equity: 1 → 0.5 → 0.25 → 0.125 → 0.0625
    //   Peak = 1, trough = 0.0625, DD = 0.0625 - 1 = -0.9375.
    // Inter-trade closes use 100 so they never cross above 99 to re-enter
    // on the wrong bar. Each "exit" hits exactly once at 50.
    const closes = [50, 100, 110, 50, 100, 105, 50, 100, 105, 50, 100, 105, 50];
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [{ indicator: 'close', op: '>', value: 99 }],
      [{ indicator: 'close', op: '<', value: 99 }],
    );
    const res = backtest(bars, strat, { tf: '1d' });
    expect(res.trades.length).toBe(4);
    for (const t of res.trades) {
      expect(t.pnlPct).toBeCloseTo(-0.5, 12);
    }
    expect(res.perf!.maxDrawdown).toBeCloseTo(-0.9375, 9);
  });

  it('reports DD=0 on a monotonically rising equity curve', () => {
    // Three winning trades — equity strictly increases. Entry < 50 below;
    // exit > 199 above. Closes: 100 (flat-pre, no entry — close>50), oops.
    // Use entry close > 99, exit close > 199. Inter-trade dip below 99 to
    // re-enter; pump above 199 to exit.
    const closes = [50, 100, 200, 50, 100, 200, 50, 100, 200];
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [{ indicator: 'close', op: '<', value: 99 }],   // entry on dip
      [{ indicator: 'close', op: '>', value: 150 }],  // exit on pump
    );
    // Trace:
    //  B0 c=50 flat. entry (50<99) → open@50.
    //  B1 c=100 open. exit (100>150)? false.
    //  B2 c=200 open. exit true → close@200. pnlPct=+3.0. flat.
    //  B3 c=50 flat. entry → open@50.
    //  B4 c=100 open. no exit.
    //  B5 c=200 open. exit → close@200.
    //  B6 c=50 flat. entry → open@50.
    //  B7 c=100 open.
    //  B8 c=200 open. exit → close@200.
    const res = backtest(bars, strat, { tf: '1d' });
    expect(res.trades.length).toBe(3);
    for (const t of res.trades) expect(t.pnlPct).toBeCloseTo(3, 12);
    expect(res.perf!.maxDrawdown).toBe(0);
    expect(res.perf!.winRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Perf benchmark — 5000 bars, 4-condition strategy, <250ms avg over 3 runs
// ---------------------------------------------------------------------------

describe('backtest — perf', () => {
  it('runs <250ms on 5000 bars', () => {
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 5000; i++) {
      p += Math.sin(i * 0.05) * 0.5 + (i % 7 === 0 ? 1 : -0.1);
      closes.push(p);
    }
    const bars = makeBars(closes);
    const strat = makeStrategy(
      [
        { indicator: 'rsi', op: '<', value: 35, params: { period: 14 } },
        {
          indicator: 'close',
          op: '>',
          value: { ref: 'sma', params: { period: 50 } },
        },
      ],
      [
        { indicator: 'rsi', op: '>', value: 65, params: { period: 14 } },
        {
          indicator: 'close',
          op: '<',
          value: { ref: 'ema', params: { period: 20 } },
        },
      ],
    );
    // Warmup
    backtest(bars, strat, { tf: '1d' });
    const runs = 3;
    let total = 0;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      backtest(bars, strat, { tf: '1d' });
      total += performance.now() - t0;
    }
    const avg = total / runs;
    // Hard gate per W5-A acceptance criteria.
    expect(avg).toBeLessThan(250);
  });
});
