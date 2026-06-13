/**
 * src/engine/backtest.ts — Wave 5 / W5-A
 *
 * Pure-TypeScript backtest engine for the P7 Co-Strategy lane.
 *
 * Semantics (frozen by the W5-A master plan; do not adjust without an ADR):
 *   - Position sizing: 1 unit, notional = bar close at entry. Fees / slippage
 *     ignored in v1.
 *   - Bar evaluation order: exits FIRST on any open position, then entries
 *     (only if flat). Avoids same-bar entry → exit races.
 *   - `crossesAbove/Below`: prior-bar sign cache; condition fires when
 *     sign(current - threshold) differs from prior bar's. Cold-start (no
 *     prior value yet) → no fire.
 *   - Indicator cold-start: bars before all referenced indicators yield are
 *     skipped (no entry/exit evaluated). Not an error.
 *   - Sharpe annualisation by tf:
 *       1h → √(24·252)   4h → √(6·252)   1d → √252   1w → √52
 *     Sharpe = mean(returns) / stdev(returns) * factor; stdev=0 → 0.
 *   - Max DD: peak-to-trough on the equity curve (cumulative returns,
 *     starting at 1). Reported as a non-positive number.
 *   - N=0 trades → perf = null.
 *   - Open trailing position at end-of-bars: closed at last bar's close,
 *     marked `openAtEnd: true`, counted in N and perf.
 *   - Win rate: winners (pnl > 0) / total trades. 0 when no trades.
 */
import type { Bar, Tf } from '../data/MarketDataProvider';
import type {
  Indicator,
  IndicatorRef,
  Op,
  StrategyCondition,
  Strategy,
  PerfStats,
} from '../ai/schemas';
import {
  sma,
  ema,
  rsi,
  atr,
  bollinger,
  donchian,
} from './indicators';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Trade {
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  openAtEnd?: boolean;
}

export interface BacktestResult {
  trades: Trade[];
  perf: PerfStats | null;
  equityCurve: number[];
}

export interface BacktestOptions {
  tf?: Tf;
}

// ---------------------------------------------------------------------------
// Sharpe annualisation factors (W5-A)
// ---------------------------------------------------------------------------

export const SHARPE_FACTOR: Record<Tf, number> = {
  '1h': Math.sqrt(24 * 252),
  '4h': Math.sqrt(6 * 252),
  '1d': Math.sqrt(252),
  '1w': Math.sqrt(52),
};

// ---------------------------------------------------------------------------
// Indicator series resolution
// ---------------------------------------------------------------------------

type Series = (number | null)[];

/** Stable cache key for `(indicator, params)` so we compute each one once. */
function indKey(ind: Indicator, params?: Record<string, number>): string {
  if (!params) return ind;
  const keys = Object.keys(params).sort();
  return ind + '|' + keys.map((k) => `${k}=${params[k]}`).join(',');
}

function pickPeriod(params: Record<string, number> | undefined, fallback: number): number {
  if (!params) return fallback;
  if (typeof params.period === 'number') return params.period;
  if (typeof params.length === 'number') return params.length;
  if (typeof params.n === 'number') return params.n;
  return fallback;
}

/** Compute (or fetch from cache) the time series for a single indicator+params. */
function resolveSeries(
  bars: Bar[],
  ind: Indicator,
  params: Record<string, number> | undefined,
  cache: Map<string, Series>,
): Series {
  const key = indKey(ind, params);
  const hit = cache.get(key);
  if (hit) return hit;

  const closes = bars.map((b) => b.c);
  let series: Series;
  switch (ind) {
    case 'close':
      series = closes;
      break;
    case 'open':
      series = bars.map((b) => b.o);
      break;
    case 'high':
      series = bars.map((b) => b.h);
      break;
    case 'low':
      series = bars.map((b) => b.l);
      break;
    case 'volume':
      series = bars.map((b) => b.v);
      break;
    case 'sma':
      series = sma(closes, pickPeriod(params, 20));
      break;
    case 'ema':
      series = ema(closes, pickPeriod(params, 20));
      break;
    case 'rsi':
      series = rsi(closes, pickPeriod(params, 14));
      break;
    case 'atr':
      series = atr(bars, pickPeriod(params, 14));
      break;
    case 'bollinger_upper':
      series = bollinger(closes, pickPeriod(params, 20), params?.k ?? 2).upper;
      break;
    case 'bollinger_middle':
      series = bollinger(closes, pickPeriod(params, 20), params?.k ?? 2).mid;
      break;
    case 'bollinger_lower':
      series = bollinger(closes, pickPeriod(params, 20), params?.k ?? 2).lower;
      break;
    case 'donchian_high':
      series = donchian(bars, pickPeriod(params, 20)).high;
      break;
    case 'donchian_low':
      series = donchian(bars, pickPeriod(params, 20)).low;
      break;
    case 'realized_vol': {
      const period = pickPeriod(params, 20);
      const out: Series = new Array(bars.length).fill(null);
      const rets: number[] = new Array(bars.length).fill(0);
      for (let i = 1; i < bars.length; i++) {
        const prev = bars[i - 1].c;
        rets[i] = prev > 0 ? Math.log(bars[i].c / prev) : 0;
      }
      for (let i = period; i < bars.length; i++) {
        let mean = 0;
        for (let j = i - period + 1; j <= i; j++) mean += rets[j];
        mean /= period;
        let variance = 0;
        for (let j = i - period + 1; j <= i; j++) {
          variance += (rets[j] - mean) ** 2;
        }
        out[i] = Math.sqrt(variance / period);
      }
      series = out;
      break;
    }
    default: {
      // Exhaustiveness — should be unreachable given the pinned enum.
      const _exhaustive: never = ind;
      throw new Error(`Unknown indicator: ${String(_exhaustive)}`);
    }
  }
  cache.set(key, series);
  return series;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/** Resolve the RHS to a numeric series of the same length as bars. */
function resolveRhs(
  bars: Bar[],
  value: number | IndicatorRef,
  cache: Map<string, Series>,
): Series {
  if (typeof value === 'number') {
    return new Array(bars.length).fill(value);
  }
  return resolveSeries(bars, value.ref, value.params, cache);
}

interface CompiledCondition {
  lhs: Series;
  rhs: Series;
  op: Op;
  /** Prior bar's `lhs - rhs` value (null on cold-start). Mutated each bar. */
  priorDelta: number | null;
}

function compileConditions(
  bars: Bar[],
  conds: StrategyCondition[],
  cache: Map<string, Series>,
): CompiledCondition[] {
  return conds.map((c) => ({
    lhs: resolveSeries(bars, c.indicator, c.params, cache),
    rhs: resolveRhs(bars, c.value, cache),
    op: c.op,
    priorDelta: null,
  }));
}

/**
 * Evaluate one compiled condition at bar `i` and update its prior-delta cache.
 * Returns `null` if either side is cold-start at this bar (caller treats null
 * as "do not fire and do not even consider the rule group satisfied").
 */
function evalAt(c: CompiledCondition, i: number): boolean | null {
  const a = c.lhs[i];
  const b = c.rhs[i];
  if (a == null || b == null) {
    c.priorDelta = null;
    return null;
  }
  const delta = a - b;
  let fired = false;
  switch (c.op) {
    case '<':
      fired = a < b;
      break;
    case '>':
      fired = a > b;
      break;
    case '<=':
      fired = a <= b;
      break;
    case '>=':
      fired = a >= b;
      break;
    case '==':
      fired = a === b;
      break;
    case 'crossesAbove':
      fired = c.priorDelta != null && c.priorDelta <= 0 && delta > 0;
      break;
    case 'crossesBelow':
      fired = c.priorDelta != null && c.priorDelta >= 0 && delta < 0;
      break;
  }
  c.priorDelta = delta;
  return fired;
}

/**
 * AND-eval a rule group at bar `i`. Returns:
 *   - `true`  → all conditions fired, group is satisfied
 *   - `false` → at least one condition was ready but did not fire
 *   - `null`  → at least one condition is cold-start at this bar (skip)
 */
function evalGroup(group: CompiledCondition[], i: number): boolean | null {
  if (group.length === 0) return false;
  let allFired = true;
  let anyCold = false;
  for (const c of group) {
    const r = evalAt(c, i);
    if (r === null) anyCold = true;
    else if (r === false) allFired = false;
  }
  if (anyCold) return null;
  return allFired;
}

// ---------------------------------------------------------------------------
// Perf computation
// ---------------------------------------------------------------------------

function computePerf(
  trades: Trade[],
  equityCurve: number[],
  tf: Tf,
): PerfStats | null {
  if (trades.length === 0) return null;

  const winners = trades.reduce((acc, t) => acc + (t.pnl > 0 ? 1 : 0), 0);
  const winRate = winners / trades.length;

  const rets = trades.map((t) => t.pnlPct);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let variance = 0;
  for (const r of rets) variance += (r - mean) ** 2;
  variance /= rets.length;
  const stdev = Math.sqrt(variance);
  const factor = SHARPE_FACTOR[tf];
  const sharpe = stdev === 0 ? 0 : (mean / stdev) * factor;

  // Max DD on the equity curve.
  let peak = equityCurve[0] ?? 1;
  let maxDd = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = e / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }

  return {
    winRate,
    sharpe,
    maxDrawdown: maxDd,
    trades: trades.length,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a strategy against an OHLCV series and return realised trades plus
 * perf stats. Pure function — no IO, no globals.
 */
export function backtest(
  bars: Bar[],
  strategy: Strategy,
  opts: BacktestOptions = {},
): BacktestResult {
  const tf: Tf = opts.tf ?? '1d';
  const cache = new Map<string, Series>();

  const entry = compileConditions(bars, strategy.rules.entry, cache);
  const exit = compileConditions(bars, strategy.rules.exit, cache);
  const filters = compileConditions(bars, strategy.rules.filters ?? [], cache);

  const trades: Trade[] = [];
  let openEntryBar = -1;
  let openEntryPrice = 0;

  // Equity curve = cumulative returns across bars where a trade closed.
  // Starts at 1 and updates on each closed trade.
  let equity = 1;
  const equityCurve: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    // 1. Exit pass — always advance exit-group prior deltas. Only act if a
    //    position is open AND the group evaluates to true.
    let closedThisBar = false;
    const exitFired = evalGroup(exit, i);
    if (openEntryBar >= 0 && exitFired === true) {
      const exitPrice = bars[i].c;
      const pnl = exitPrice - openEntryPrice;
      const pnlPct = openEntryPrice === 0 ? 0 : pnl / openEntryPrice;
      trades.push({
        entryBar: openEntryBar,
        exitBar: i,
        entryPrice: openEntryPrice,
        exitPrice,
        pnl,
        pnlPct,
      });
      equity *= 1 + pnlPct;
      openEntryBar = -1;
      openEntryPrice = 0;
      closedThisBar = true;
    }

    // 2. Entry pass — always advance entry/filter prior deltas. Only act if
    //    flat AND we did not just close on this bar (avoid same-bar
    //    exit→entry race).
    const entryFired = evalGroup(entry, i);
    const filterFired = filters.length === 0 ? true : evalGroup(filters, i);
    if (
      openEntryBar < 0 &&
      !closedThisBar &&
      entryFired === true &&
      filterFired === true
    ) {
      openEntryBar = i;
      openEntryPrice = bars[i].c;
    }

    equityCurve.push(equity);
  }

  // Close any trailing open position at the last bar's close.
  if (openEntryBar >= 0 && bars.length > 0) {
    const lastIdx = bars.length - 1;
    const exitPrice = bars[lastIdx].c;
    const pnl = exitPrice - openEntryPrice;
    const pnlPct = openEntryPrice === 0 ? 0 : pnl / openEntryPrice;
    trades.push({
      entryBar: openEntryBar,
      exitBar: lastIdx,
      entryPrice: openEntryPrice,
      exitPrice,
      pnl,
      pnlPct,
      openAtEnd: true,
    });
    equity *= 1 + pnlPct;
    // Reflect the trailing close in the equity curve's last point.
    equityCurve[equityCurve.length - 1] = equity;
  }

  const perf = computePerf(trades, equityCurve, tf);
  return { trades, perf, equityCurve };
}
