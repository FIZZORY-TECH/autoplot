/**
 * src/panels/recomputeRecipe.ts — Step 5 (saved-indicator reuse).
 *
 * Pure helper: takes a saved overlay's `recipe` plus the chart's current bars
 * and RECOMPUTES a fresh `ResearchOverlay` for the on-screen `(sym, tf)`. This
 * is what makes a saved indicator reusable across symbols/timeframes — the
 * recipe is re-run against new history rather than the old static values being
 * stretched onto a different instrument.
 *
 * The per-`kind` dispatch mirrors `src/ai/tools/computeIndicator.ts` (the
 * `compute_indicator` handler) one-for-one — same engine fns, same param
 * defaults — so the recomputed series matches what the agent would have
 * produced. We do NOT re-implement any indicator math here.
 *
 * Oscillator guide lines (RSI 70/30) are NOT stored in the recipe; they are
 * re-emitted deterministically from a tiny per-kind default map that matches
 * what the Pine→indicator skill emits (label + dash + pane:'series').
 *
 * Pure: no React, no store reads, no side-effects. The panel (Step 6) is what
 * calls `applyResearchOverlay` with the result.
 */
import type { Bar, Tf } from '../data/MarketDataProvider';
import type {
  Element,
  ResearchOverlay,
  SeriesSpec,
} from '../ai/schemas';
import { sma, ema, rsi, bollinger, donchian, atr } from '../engine/indicators';

// ---------------------------------------------------------------------------
// Result shape — surfaces the recomputed overlay plus a "not enough history"
// signal so the panel can warn instead of silently rendering an empty series.
// `note` is set only when `notEnoughHistory` is true.
// ---------------------------------------------------------------------------
export interface RecomputeResult {
  overlay: ResearchOverlay;
  notEnoughHistory: boolean;
  note?: string;
}

/**
 * Tolerant period resolver — chains period → length → n → fallback.
 * Mirrors `pickPeriod` in src/engine/backtest.ts and the `params.period ??
 * params.length ?? params.n` pattern in RuleGraph.tsx. The AI emits both
 * `period` and `length` depending on the Pine source; recipes must accept
 * whichever key arrives.
 */
function pickPeriod(
  params: Record<string, number> | undefined,
  fallback: number,
): number {
  if (!params) return fallback;
  if (typeof params.period === 'number' && Number.isFinite(params.period)) return params.period;
  if (typeof params.length === 'number' && Number.isFinite(params.length)) return params.length;
  if (typeof params.n === 'number' && Number.isFinite(params.n)) return params.n;
  return fallback;
}

/**
 * Tolerant Bollinger multiplier resolver — chains k → mult → stddev →
 * multiplier → fallback. Pine uses `mult`; some recipes use `k`; both must
 * produce the correct bands after round-trip through the AI.
 */
function pickMult(
  params: Record<string, number> | undefined,
  fallback: number,
): number {
  if (!params) return fallback;
  if (typeof params.k === 'number' && Number.isFinite(params.k)) return params.k;
  if (typeof params.mult === 'number' && Number.isFinite(params.mult)) return params.mult;
  if (typeof params.stddev === 'number' && Number.isFinite(params.stddev)) return params.stddev;
  if (typeof params.multiplier === 'number' && Number.isFinite(params.multiplier)) return params.multiplier;
  return fallback;
}

/** True when an engine series is empty or entirely null (couldn't compute). */
function allNull(values: ReadonlyArray<number | null>): boolean {
  return values.length === 0 || values.every((v) => v === null);
}

// ---------------------------------------------------------------------------
// Output cap. Schema constrains element value arrays to `.max(500)`
// (schemas.ts: LineElement.values / BandElement.upper / .lower), and the
// skill's own snapshot convention is "most recent 500 bars". AppShell may load
// up to ~600 bars, so we compute each series over the FULL bars (preserving
// warmup — e.g. SMA(200) stays valid across the visible window) and then keep
// only the LAST 500 entries. Every element is `align:'right'`, so tail-slicing
// preserves alignment (last value = last bar). `allNull` / `primaryNull` are
// always evaluated on the PRE-clamp series so history detection is unaffected.
// ---------------------------------------------------------------------------
const CAP = 500;
function clampTail(values: (number | null)[]): (number | null)[] {
  return values.length > CAP ? values.slice(-CAP) : values;
}

// ---------------------------------------------------------------------------
// Oscillator guide-line defaults. The recipe does not store guide hlines; we
// re-emit them deterministically per oscillator kind. Mirrors the skill's
// output exactly: pane:'series', dash '4 4', the same labels. Keep this a
// small local map — add a kind only when the skill emits guides for it.
// ---------------------------------------------------------------------------
interface GuideHLine {
  price: number;
  label: string;
}

const OSCILLATOR_GUIDES: Partial<Record<SeriesSpec['kind'], GuideHLine[]>> = {
  rsi: [
    { price: 70, label: 'Overbought' },
    { price: 30, label: 'Oversold' },
  ],
};

// ---------------------------------------------------------------------------
// Per-spec expansion. Returns the elements produced and a human label for the
// spec (used in the not-enough-history note), or flags the primary series as
// uncomputable. `primaryNull` true ⇒ the spec's main series came back all-null.
// ---------------------------------------------------------------------------
interface SpecResult {
  elements: Element[];
  /** Human label for this spec, e.g. "SMA(200)" — used in the note. */
  describe: string;
  /** The spec's primary series could not be computed (all-null). */
  primaryNull: boolean;
}

function expandSpec(spec: SeriesSpec, bars: Bar[]): SpecResult {
  const closes = bars.map((b) => b.c);
  const opens = bars.map((b) => b.o);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const vols = bars.map((b) => b.v);

  // Carry-overs shared by the simple line kinds.
  const pane = spec.pane; // absent ⇒ price (renderer default); osc kinds set 'series' in the recipe.
  const lineExtras = {
    ...(spec.color !== undefined ? { color: spec.color } : {}),
    ...(spec.width !== undefined ? { width: spec.width } : {}),
    ...(pane !== undefined ? { pane } : {}),
  };

  /** Build a single `line` element from an engine series (tail-clamped to CAP). */
  const lineEl = (values: (number | null)[]): Element => ({
    type: 'line',
    values: clampTail(values),
    align: 'right',
    ...lineExtras,
  });

  switch (spec.kind) {
    // --- raw OHLCV passthroughs --------------------------------------------
    case 'close':
      return { elements: [lineEl(closes)], describe: 'close', primaryNull: allNull(closes) };
    case 'open':
      return { elements: [lineEl(opens)], describe: 'open', primaryNull: allNull(opens) };
    case 'high':
      return { elements: [lineEl(highs)], describe: 'high', primaryNull: allNull(highs) };
    case 'low':
      return { elements: [lineEl(lows)], describe: 'low', primaryNull: allNull(lows) };
    case 'volume':
      return { elements: [lineEl(vols)], describe: 'volume', primaryNull: allNull(vols) };

    // --- moving averages / momentum ----------------------------------------
    case 'sma': {
      const period = pickPeriod(spec.params, 20);
      const values = sma(closes, period);
      return { elements: [lineEl(values)], describe: `SMA(${period})`, primaryNull: allNull(values) };
    }
    case 'ema': {
      const period = pickPeriod(spec.params, 20);
      const values = ema(closes, period);
      return { elements: [lineEl(values)], describe: `EMA(${period})`, primaryNull: allNull(values) };
    }
    case 'rsi': {
      const period = pickPeriod(spec.params, 14);
      const values = rsi(closes, period);
      return { elements: [lineEl(values)], describe: `RSI(${period})`, primaryNull: allNull(values) };
    }
    case 'atr': {
      const period = pickPeriod(spec.params, 14);
      const values = atr(bars, period);
      return { elements: [lineEl(values)], describe: `ATR(${period})`, primaryNull: allNull(values) };
    }

    // --- individual Bollinger bands (pinned Indicator members) -------------
    case 'bollinger_upper': {
      const period = pickPeriod(spec.params, 20);
      const k = pickMult(spec.params, 2);
      const values = bollinger(closes, period, k).upper;
      return { elements: [lineEl(values)], describe: `Bollinger upper(${period},${k})`, primaryNull: allNull(values) };
    }
    case 'bollinger_middle': {
      const period = pickPeriod(spec.params, 20);
      const k = pickMult(spec.params, 2);
      const values = bollinger(closes, period, k).mid;
      return { elements: [lineEl(values)], describe: `Bollinger middle(${period},${k})`, primaryNull: allNull(values) };
    }
    case 'bollinger_lower': {
      const period = pickPeriod(spec.params, 20);
      const k = pickMult(spec.params, 2);
      const values = bollinger(closes, period, k).lower;
      return { elements: [lineEl(values)], describe: `Bollinger lower(${period},${k})`, primaryNull: allNull(values) };
    }

    // --- individual Donchian edges (pinned Indicator members) -------------
    case 'donchian_high': {
      const period = pickPeriod(spec.params, 20);
      const values = donchian(bars, period).high;
      return { elements: [lineEl(values)], describe: `Donchian high(${period})`, primaryNull: allNull(values) };
    }
    case 'donchian_low': {
      const period = pickPeriod(spec.params, 20);
      const values = donchian(bars, period).low;
      return { elements: [lineEl(values)], describe: `Donchian low(${period})`, primaryNull: allNull(values) };
    }

    // --- channel aliases: expand into a band (+ middle line for Bollinger) -
    case 'bollinger': {
      const period = pickPeriod(spec.params, 20);
      const k = pickMult(spec.params, 2);
      const r = bollinger(closes, period, k);
      const band: Element = {
        type: 'band',
        upper: clampTail(r.upper),
        lower: clampTail(r.lower),
        align: 'right',
        ...(spec.color !== undefined ? { color: spec.color } : {}),
      };
      const mid: Element = { type: 'line', values: clampTail(r.mid), align: 'right' };
      // Bollinger is a price-axis study; pane is omitted (renderer default 'price').
      return {
        elements: [band, mid],
        describe: `Bollinger(${period},${k})`,
        primaryNull: allNull(r.upper),
      };
    }
    case 'donchian': {
      const period = pickPeriod(spec.params, 20);
      const r = donchian(bars, period);
      const band: Element = {
        type: 'band',
        upper: clampTail(r.high),
        lower: clampTail(r.low),
        align: 'right',
        ...(spec.color !== undefined ? { color: spec.color } : {}),
      };
      return { elements: [band], describe: `Donchian(${period})`, primaryNull: allNull(r.high) };
    }

    case 'realized_vol': {
      // Not implemented in the engine (mirrors computeIndicator). Emit an
      // all-null line so the slot is preserved and flag it as uncomputable.
      const values = new Array<number | null>(closes.length).fill(null);
      return { elements: [lineEl(values)], describe: 'realized vol', primaryNull: true };
    }

    default: {
      // Exhaustiveness guard — every SeriesSpec kind is handled above.
      const _exhaustive: never = spec.kind;
      void _exhaustive;
      return { elements: [], describe: 'unknown', primaryNull: true };
    }
  }
}

/**
 * Strip undefined props / normalize a fresh overlay before it is applied.
 * Mirrors the intent of ResearchLibrary's `cleanOverlay()` (drop non-canonical
 * fields); here the helper already builds a canonical object, so this is a
 * thin pass that omits an absent optional `color`.
 */
function cleanOverlay(ro: ResearchOverlay): ResearchOverlay {
  const out: ResearchOverlay = {
    id: ro.id,
    sym: ro.sym,
    tf: ro.tf,
    label: ro.label,
    elements: ro.elements,
    ...(ro.color !== undefined ? { color: ro.color } : {}),
    ...(ro.source !== undefined ? { source: ro.source } : {}),
    ...(ro.recipe !== undefined ? { recipe: ro.recipe } : {}),
  };
  return out;
}

/**
 * Recompute a saved overlay's `recipe` against `bars` for the on-screen
 * `(sym, tf)`. Produces a fresh `ResearchOverlay` with a STABLE id derived from
 * the source overlay (so re-applying replaces rather than stacks) and the
 * recipe re-attached (so the result is itself recompute-able).
 *
 * If the overlay carries no recipe, returns a copy retargeted to `(sym, tf)`
 * unchanged — there is nothing to recompute (the panel should not offer reuse
 * for recipe-less overlays, but we never throw).
 *
 * Never throws. When a spec's primary series comes back all-null (e.g. SMA(200)
 * on 120 bars) the elements that DID compute are still returned, with
 * `notEnoughHistory=true` and a `note` naming the offending spec(s).
 */
export function recomputeRecipe(
  overlay: ResearchOverlay,
  bars: Bar[],
  sym: string,
  tf: Tf,
): RecomputeResult {
  // Deterministic id so re-applying replaces the prior recomputed copy rather
  // than stacking a new one each time. Derived from the source overlay id.
  const id = `${overlay.id}:recompute`;

  if (!overlay.recipe) {
    // No recipe to run — return the overlay retargeted to (sym, tf) verbatim.
    return {
      overlay: cleanOverlay({ ...overlay, id, sym, tf }),
      notEnoughHistory: false,
    };
  }

  const elements: Element[] = [];
  const shortfalls: string[] = [];

  for (const spec of overlay.recipe.series) {
    const res = expandSpec(spec, bars);
    elements.push(...res.elements);
    if (res.primaryNull) shortfalls.push(res.describe);

    // Re-emit oscillator guide lines on the same sub-pane the recipe targets.
    const guides = OSCILLATOR_GUIDES[spec.kind];
    if (guides) {
      for (const g of guides) {
        elements.push({
          type: 'hline',
          price: g.price,
          label: g.label,
          dash: '4 4',
          pane: 'series',
        });
      }
    }
  }

  const notEnoughHistory = shortfalls.length > 0;
  const note = notEnoughHistory
    ? `not enough history for ${shortfalls.join(', ')}`
    : undefined;

  const fresh: ResearchOverlay = {
    id,
    sym,
    tf,
    label: overlay.label,
    elements,
    ...(overlay.color !== undefined ? { color: overlay.color } : {}),
    ...(overlay.source !== undefined ? { source: overlay.source } : {}),
    // Re-attach the recipe so the recomputed overlay is itself recompute-able.
    recipe: overlay.recipe,
  };

  return {
    overlay: cleanOverlay(fresh),
    notEnoughHistory,
    ...(note !== undefined ? { note } : {}),
  };
}
