/**
 * src/ai/tools/computeIndicator.ts — W4-A — `compute_indicator` tool handler.
 *
 * Fetches bars (via the same path as `fetchOhlc`) and dispatches to the
 * existing `src/engine/indicators.ts` helpers. Cold-start positions are
 * preserved as `null` (we do NOT pad / interpolate). Indicator names that
 * exist in the pinned `Indicator` enum but are not yet implemented in the
 * indicator engine return `null` series with a `[TODO P6 indicator: …]`
 * console marker so W5 can fill them in.
 */
import { z } from 'zod';
import { TfSchema, Indicator } from '../schemas';
import { COUNT_MAX, COUNT_DEFAULT, fetchBars } from './_barFetcher';
import { sma, ema, rsi, bollinger, donchian, atr } from '../../engine/indicators';

const InputSchema = z.object({
  sym: z.string().min(1),
  tf: TfSchema,
  kind: Indicator,
  params: z.record(z.string(), z.number()).optional(),
  /** Optional: how many bars to compute over. Defaults to 500. */
  count: z.number().int().positive().optional(),
});

export type ComputeIndicatorInput = z.infer<typeof InputSchema>;

export interface ComputeIndicatorOutput {
  values: (number | null)[];
  align: 'right' | 'index';
}

function paramOr(
  params: Record<string, number> | undefined,
  key: string,
  fallback: number,
): number {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function computeIndicator(
  input: unknown,
): Promise<ComputeIndicatorOutput> {
  const parsed = InputSchema.parse(input);
  const count = Math.min(parsed.count ?? COUNT_DEFAULT, COUNT_MAX);

  const bars = await fetchBars(parsed.sym, parsed.tf, count);
  const closes = bars.map((b) => b.c);
  const opens = bars.map((b) => b.o);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const vols = bars.map((b) => b.v);

  let values: (number | null)[];

  switch (parsed.kind) {
    case 'close':
      values = closes;
      break;
    case 'open':
      values = opens;
      break;
    case 'high':
      values = highs;
      break;
    case 'low':
      values = lows;
      break;
    case 'volume':
      values = vols;
      break;
    case 'sma':
      values = sma(closes, paramOr(parsed.params, 'period', 20));
      break;
    case 'ema':
      values = ema(closes, paramOr(parsed.params, 'period', 20));
      break;
    case 'rsi':
      values = rsi(closes, paramOr(parsed.params, 'period', 14));
      break;
    case 'bollinger_upper': {
      const r = bollinger(
        closes,
        paramOr(parsed.params, 'period', 20),
        paramOr(parsed.params, 'k', 2),
      );
      values = r.upper;
      break;
    }
    case 'bollinger_middle': {
      const r = bollinger(
        closes,
        paramOr(parsed.params, 'period', 20),
        paramOr(parsed.params, 'k', 2),
      );
      values = r.mid;
      break;
    }
    case 'bollinger_lower': {
      const r = bollinger(
        closes,
        paramOr(parsed.params, 'period', 20),
        paramOr(parsed.params, 'k', 2),
      );
      values = r.lower;
      break;
    }
    case 'atr':
      values = atr(bars, paramOr(parsed.params, 'period', 14));
      break;
    case 'donchian_high':
      values = donchian(bars, paramOr(parsed.params, 'period', 20)).high;
      break;
    case 'donchian_low':
      values = donchian(bars, paramOr(parsed.params, 'period', 20)).low;
      break;
    case 'realized_vol':
      // Pinned in the Indicator enum (system prompt) but the engine does
      // not implement realized vol yet. Return an all-null series so the
      // model's dataset slot is preserved; extend in a later phase.
      // eslint-disable-next-line no-console
      console.warn(
        `[TODO P6 indicator: ${parsed.kind}] not yet implemented in indicators.ts; returning null series`,
      );
      values = new Array(closes.length).fill(null);
      break;
    default: {
      // Exhaustiveness guard — Zod has already rejected unknowns above, but
      // keep the compiler honest if the enum grows.
      const _exhaustive: never = parsed.kind;
      void _exhaustive;
      values = new Array(closes.length).fill(null);
    }
  }

  // Cold-start bars are silently skipped — we propagate the `null` slots
  // produced by the indicator engine through to the caller verbatim.
  return { values, align: 'right' };
}
