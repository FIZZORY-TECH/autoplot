/**
 * src/ai/tools/backtestStrategy.ts — W5-B — `backtest_strategy` tool handler.
 *
 * Validates the Strategy with Zod, fetches OHLC bars (mock-mode aware), and
 * runs the pure W5-A backtest engine. Returns `{ ok, perf, trades, equityCurve }`
 * or `{ ok: false, error }`. Non-Zod runtime errors (e.g. NaN math from a
 * malformed indicator path that snuck past the schema) are caught and
 * surfaced as `{ ok: false, error }` so the dispatcher's validate-retry
 * pipeline can react.
 */
import { z } from 'zod';
import type { Tf } from '../../data/MarketDataProvider';
import { TfSchema, Strategy } from '../schemas';
import { COUNT_MAX, COUNT_DEFAULT, fetchBars } from './_barFetcher';
import { backtest, type BacktestResult } from '../../engine/backtest';

const InputSchema = z.object({
  strategy: z.unknown(),
  sym: z.string().min(1),
  tf: TfSchema,
  count: z.number().int().positive().optional(),
});

export type BacktestStrategyOutput =
  | {
      ok: true;
      perf: BacktestResult['perf'];
      trades: BacktestResult['trades'];
      equityCurve: BacktestResult['equityCurve'];
    }
  | { ok: false; error: string };

export async function backtestStrategy(input: unknown): Promise<BacktestStrategyOutput> {
  const inputParsed = InputSchema.safeParse(input);
  if (!inputParsed.success) {
    return {
      ok: false,
      error: inputParsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }
  const stratParsed = Strategy.safeParse(inputParsed.data.strategy);
  if (!stratParsed.success) {
    return {
      ok: false,
      error: stratParsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }
  const tf: Tf = inputParsed.data.tf;
  const count = Math.min(inputParsed.data.count ?? COUNT_DEFAULT, COUNT_MAX);

  try {
    const bars = await fetchBars(inputParsed.data.sym, tf, count);
    const result = backtest(bars, stratParsed.data, { tf });
    return {
      ok: true,
      perf: result.perf,
      trades: result.trades,
      equityCurve: result.equityCurve,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[backtest] engine failure:', err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
