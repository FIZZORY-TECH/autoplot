/**
 * src/panels/recomputeRecipe.test.ts — Step 7 unit tests for the saved-indicator
 * reuse feature.
 *
 * Three concerns:
 *   1. Schema recipe round-trip + backward-compat — a ResearchOverlay carrying
 *      a `recipe` survives parse→stringify→parse, and old blobs WITHOUT a recipe
 *      still validate (the field is additive/optional).
 *   2. The `recomputeRecipe` pure helper — RSI / SMA / Bollinger / Donchian
 *      element shapes, pane routing, oscillator-guide re-emission, the stable
 *      id + re-attached recipe, the 500-cap, and the all-null / not-enough-
 *      history signal. Every recomputed overlay must itself `safeParse`.
 *
 * The panel render (cards / empty-state / provenance badge) lives in the sibling
 * `IndicatorPanel.savedIndicators.test.tsx` (jsdom + Testing Library).
 */

import { describe, it, expect } from 'vitest';
import type { Bar } from '../data/MarketDataProvider';
import {
  ResearchOverlay,
  RecipeSpec,
  type ResearchOverlay as ResearchOverlayType,
} from '../ai/schemas';
import { recomputeRecipe } from './recomputeRecipe';

// ---------------------------------------------------------------------------
// Synthetic bars — a deterministic, gently-trending OHLCV series so indicator
// engines produce real (non-null) values once warmed up. `n` controls history
// length so we can exercise both the warmed-up and not-enough-history paths.
// ---------------------------------------------------------------------------
function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    // A small sinusoid on top of a slow uptrend → varied highs/lows/closes.
    const base = 100 + i * 0.5 + Math.sin(i / 5) * 4;
    const o = base;
    const c = base + Math.cos(i / 7) * 2;
    const h = Math.max(o, c) + 1.5;
    const l = Math.min(o, c) - 1.5;
    bars.push({ ts: 1_700_000_000_000 + i * 3_600_000, o, h, l, c, v: 1000 + i });
  }
  return bars;
}

// One canonical saved overlay carrying a recipe — the RSI(14) sub-pane case.
function makeRsiOverlay(): ResearchOverlayType {
  return {
    id: 'rsi-14',
    sym: 'BTC',
    tf: '1h',
    label: 'RSI(14)',
    source: 'pine',
    recipe: {
      source: 'pine',
      series: [{ kind: 'rsi', params: { period: 14 }, pane: 'series', color: '#a855f7', width: 2 }],
    },
    // A single (stale) line element — recompute should regenerate this.
    elements: [
      { type: 'line', values: [50, 51, 52], align: 'right', pane: 'series' },
    ],
  };
}

// ===========================================================================
// 1. Schema — recipe round-trip + old-blob backward-compat
// ===========================================================================

describe('schema: recipe round-trip + backward-compat', () => {
  it('a ResearchOverlay with a recipe survives parse → stringify → parse', () => {
    const overlay = makeRsiOverlay();
    const first = ResearchOverlay.safeParse(overlay);
    expect(first.success).toBe(true);
    if (!first.success) return;

    const roundTripped = ResearchOverlay.safeParse(JSON.parse(JSON.stringify(first.data)));
    expect(roundTripped.success).toBe(true);
    if (roundTripped.success) {
      expect(roundTripped.data.recipe).toEqual(overlay.recipe);
    }
  });

  it('RecipeSpec accepts the bollinger / donchian logical aliases', () => {
    const boll = RecipeSpec.safeParse({
      source: 'pine',
      series: [{ kind: 'bollinger', params: { period: 20, k: 2 } }],
    });
    const donch = RecipeSpec.safeParse({
      source: 'nl',
      series: [{ kind: 'donchian', params: { period: 20 } }],
    });
    expect(boll.success).toBe(true);
    expect(donch.success).toBe(true);
  });

  it('an old overlay blob WITHOUT a recipe still validates (additive field)', () => {
    const oldBlob = {
      id: 'legacy-1',
      sym: 'ETH',
      tf: '1d',
      label: 'Legacy overlay',
      elements: [{ type: 'line', values: [1, 2, 3], align: 'right' }],
    };
    const r = ResearchOverlay.safeParse(oldBlob);
    expect(r.success).toBe(true);
    if (r.success) {
      // Field is absent from the parsed object — no default injected.
      expect('recipe' in r.data).toBe(false);
    }
  });

  it('rejects a recipe with an unknown series kind', () => {
    const r = RecipeSpec.safeParse({
      source: 'pine',
      series: [{ kind: 'macd', params: { fast: 12 } }],
    });
    expect(r.success).toBe(false);
  });
});

// ===========================================================================
// 2. recomputeRecipe — element shapes, pane routing, guides, id, cap, history
// ===========================================================================

describe('recomputeRecipe: RSI(14) → line + guide hlines on sub-pane', () => {
  const bars = makeBars(300);
  const result = recomputeRecipe(makeRsiOverlay(), bars, 'ETH', '4h');

  it('retargets the overlay to the live (sym, tf)', () => {
    expect(result.overlay.sym).toBe('ETH');
    expect(result.overlay.tf).toBe('4h');
  });

  it('emits one line (pane:series) + two guide hlines (70 / 30)', () => {
    const lines = result.overlay.elements.filter((e) => e.type === 'line');
    const hlines = result.overlay.elements.filter((e) => e.type === 'hline');
    expect(lines).toHaveLength(1);
    expect(hlines).toHaveLength(2);

    const line = lines[0];
    expect(line.type === 'line' && line.pane).toBe('series');
    // Carry-overs from the spec.
    expect(line.type === 'line' && line.color).toBe('#a855f7');
    expect(line.type === 'line' && line.width).toBe(2);

    const prices = hlines.map((e) => (e.type === 'hline' ? e.price : NaN)).sort((a, b) => b - a);
    expect(prices).toEqual([70, 30]);
    for (const h of hlines) {
      expect(h.type === 'hline' && h.pane).toBe('series');
      expect(h.type === 'hline' && h.dash).toBe('4 4');
    }
    // Labels match the skill's exact output.
    const labels = hlines.map((e) => (e.type === 'hline' ? e.label : '')).sort();
    expect(labels).toEqual(['Oversold', 'Overbought'].sort());
  });

  it('the RSI line is actually computed (not all-null) on 300 bars', () => {
    const line = result.overlay.elements.find((e) => e.type === 'line');
    expect(line && line.type === 'line' && line.values.some((v) => v !== null)).toBe(true);
    expect(result.notEnoughHistory).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it('derives a stable id and re-attaches the recipe', () => {
    expect(result.overlay.id).toBe('rsi-14:recompute');
    expect(result.overlay.recipe).toBeDefined();
    expect(result.overlay.recipe?.series[0].kind).toBe('rsi');
  });

  it('re-applying produces the SAME id (replace, not stack)', () => {
    const again = recomputeRecipe(makeRsiOverlay(), bars, 'ETH', '4h');
    expect(again.overlay.id).toBe(result.overlay.id);
  });

  it('produces a schema-valid ResearchOverlay', () => {
    expect(ResearchOverlay.safeParse(result.overlay).success).toBe(true);
  });
});

describe('recomputeRecipe: SMA(50) → single price line', () => {
  const overlay: ResearchOverlayType = {
    id: 'sma-50',
    sym: 'BTC',
    tf: '1d',
    label: 'SMA(50)',
    source: 'nl',
    recipe: { source: 'nl', series: [{ kind: 'sma', params: { period: 50 } }] },
    elements: [],
  };
  const result = recomputeRecipe(overlay, makeBars(200), 'SOL', '1d');

  it('emits exactly one line element with no pane (price axis)', () => {
    expect(result.overlay.elements).toHaveLength(1);
    const line = result.overlay.elements[0];
    expect(line.type).toBe('line');
    // pane omitted ⇒ renderer treats as price.
    expect(line.type === 'line' && 'pane' in line).toBe(false);
  });

  it('is computed and history-sufficient on 200 bars', () => {
    expect(result.notEnoughHistory).toBe(false);
    const line = result.overlay.elements[0];
    expect(line.type === 'line' && line.values.some((v) => v !== null)).toBe(true);
  });
});

describe('recomputeRecipe: Bollinger alias → band + middle line on price', () => {
  const overlay: ResearchOverlayType = {
    id: 'bb-20-2',
    sym: 'BTC',
    tf: '1h',
    label: 'BB(20,2)',
    source: 'pine',
    recipe: { source: 'pine', series: [{ kind: 'bollinger', params: { period: 20, k: 2 }, color: '#5b8def' }] },
    elements: [],
  };
  const result = recomputeRecipe(overlay, makeBars(120), 'BTC', '1h');

  it('expands into one band + one line, both on the price pane', () => {
    const bands = result.overlay.elements.filter((e) => e.type === 'band');
    const lines = result.overlay.elements.filter((e) => e.type === 'line');
    expect(bands).toHaveLength(1);
    expect(lines).toHaveLength(1);

    const band = bands[0];
    expect(band.type === 'band' && 'pane' in band).toBe(false); // price pane
    expect(band.type === 'band' && band.color).toBe('#5b8def');
    // Band carries both edges.
    expect(band.type === 'band' && Array.isArray(band.upper)).toBe(true);
    expect(band.type === 'band' && Array.isArray(band.lower)).toBe(true);

    const mid = lines[0];
    expect(mid.type === 'line' && 'pane' in mid).toBe(false); // price pane
  });

  it('emits no guide hlines for Bollinger', () => {
    expect(result.overlay.elements.some((e) => e.type === 'hline')).toBe(false);
  });

  it('produces a schema-valid ResearchOverlay', () => {
    expect(ResearchOverlay.safeParse(result.overlay).success).toBe(true);
  });
});

describe('recomputeRecipe: Donchian alias → single band', () => {
  const overlay: ResearchOverlayType = {
    id: 'dc-20',
    sym: 'BTC',
    tf: '1d',
    label: 'Donchian(20)',
    recipe: { source: 'nl', series: [{ kind: 'donchian', params: { period: 20 } }] },
    elements: [],
  };
  const result = recomputeRecipe(overlay, makeBars(100), 'BTC', '1d');

  it('emits exactly one band element', () => {
    const bands = result.overlay.elements.filter((e) => e.type === 'band');
    expect(bands).toHaveLength(1);
    expect(result.overlay.elements.filter((e) => e.type === 'line')).toHaveLength(0);
  });
});

describe('recomputeRecipe: not-enough-history', () => {
  it('flags SMA(200) on 120 bars but still returns the (all-null) element', () => {
    const overlay: ResearchOverlayType = {
      id: 'sma-200',
      sym: 'BTC',
      tf: '1d',
      label: 'SMA(200)',
      recipe: { source: 'nl', series: [{ kind: 'sma', params: { period: 200 } }] },
      elements: [],
    };
    const result = recomputeRecipe(overlay, makeBars(120), 'BTC', '1d');

    expect(result.notEnoughHistory).toBe(true);
    expect(result.note).toBe('not enough history for SMA(200)');
    // Render-what-we-can: the line element is still present (all-null values).
    expect(result.overlay.elements).toHaveLength(1);
    const line = result.overlay.elements[0];
    expect(line.type === 'line' && line.values.every((v) => v === null)).toBe(true);
    // Still schema-valid (empty/null values are allowed).
    expect(ResearchOverlay.safeParse(result.overlay).success).toBe(true);
  });

  it('does not throw on zero bars', () => {
    const overlay: ResearchOverlayType = {
      id: 'sma-20',
      sym: 'BTC',
      tf: '1d',
      label: 'SMA(20)',
      recipe: { source: 'nl', series: [{ kind: 'sma', params: { period: 20 } }] },
      elements: [],
    };
    expect(() => recomputeRecipe(overlay, [], 'BTC', '1d')).not.toThrow();
    const result = recomputeRecipe(overlay, [], 'BTC', '1d');
    expect(result.notEnoughHistory).toBe(true);
  });
});

describe('recomputeRecipe: output cap (≤ 500)', () => {
  it('clamps line/band value arrays to the last 500 even with ~600 bars', () => {
    const overlay: ResearchOverlayType = {
      id: 'multi',
      sym: 'BTC',
      tf: '1h',
      label: 'Multi',
      recipe: {
        source: 'pine',
        series: [
          { kind: 'sma', params: { period: 20 } },
          { kind: 'bollinger', params: { period: 20, k: 2 } },
        ],
      },
      elements: [],
    };
    const result = recomputeRecipe(overlay, makeBars(600), 'BTC', '1h');

    for (const el of result.overlay.elements) {
      if (el.type === 'line') expect(el.values.length).toBeLessThanOrEqual(500);
      if (el.type === 'band') {
        expect(el.upper.length).toBeLessThanOrEqual(500);
        expect(el.lower.length).toBeLessThanOrEqual(500);
      }
    }
    // And the whole overlay must still satisfy the .max(500) schema constraint.
    expect(ResearchOverlay.safeParse(result.overlay).success).toBe(true);
  });
});

describe('recomputeRecipe: recipe-less overlay', () => {
  it('retargets to (sym, tf) verbatim without flagging history', () => {
    const overlay: ResearchOverlayType = {
      id: 'manual-1',
      sym: 'BTC',
      tf: '1d',
      label: 'Manual overlay',
      elements: [{ type: 'line', values: [1, 2, 3], align: 'right' }],
    };
    const result = recomputeRecipe(overlay, makeBars(50), 'ETH', '4h');

    expect(result.notEnoughHistory).toBe(false);
    expect(result.overlay.id).toBe('manual-1:recompute');
    expect(result.overlay.sym).toBe('ETH');
    expect(result.overlay.tf).toBe('4h');
    // Elements carried over unchanged (no recompute happened).
    expect(result.overlay.elements).toEqual(overlay.elements);
    expect(result.overlay.recipe).toBeUndefined();
  });
});

// ===========================================================================
// 3. pickPeriod / pickMult tolerance — `length`/`n` key aliases
// ===========================================================================

describe('recomputeRecipe: pickPeriod tolerates `length` key (RSI)', () => {
  const bars = makeBars(300);

  it('RSI recipe with params:{length:14} recomputes identically to params:{period:14}', () => {
    const withPeriod: ResearchOverlayType = {
      id: 'rsi-period',
      sym: 'BTC',
      tf: '1h',
      label: 'RSI period key',
      source: 'pine',
      recipe: { source: 'pine', series: [{ kind: 'rsi', params: { period: 14 }, pane: 'series' }] },
      elements: [],
    };
    const withLength: ResearchOverlayType = {
      id: 'rsi-length',
      sym: 'BTC',
      tf: '1h',
      label: 'RSI length key',
      source: 'pine',
      recipe: { source: 'pine', series: [{ kind: 'rsi', params: { length: 14 }, pane: 'series' }] },
      elements: [],
    };

    const resPeriod = recomputeRecipe(withPeriod, bars, 'ETH', '4h');
    const resLength = recomputeRecipe(withLength, bars, 'ETH', '4h');

    // Both should not fall back to the default 14 (they ARE 14 here, but the
    // key point: the length-key result must not silently differ).
    expect(resLength.notEnoughHistory).toBe(false);
    expect(resPeriod.notEnoughHistory).toBe(false);

    // The RSI line values must be identical — same period was used.
    const lineP = resPeriod.overlay.elements.find((e) => e.type === 'line');
    const lineL = resLength.overlay.elements.find((e) => e.type === 'line');
    expect(lineP).toBeDefined();
    expect(lineL).toBeDefined();
    expect(lineP?.type === 'line' && lineL?.type === 'line' && lineP.values).toEqual(
      lineL?.type === 'line' ? lineL.values : undefined,
    );
  });

  it('RSI recipe with params:{n:14} also resolves correctly', () => {
    const withN: ResearchOverlayType = {
      id: 'rsi-n',
      sym: 'BTC',
      tf: '1h',
      label: 'RSI n key',
      source: 'pine',
      recipe: { source: 'pine', series: [{ kind: 'rsi', params: { n: 14 }, pane: 'series' }] },
      elements: [],
    };
    const withPeriod: ResearchOverlayType = {
      id: 'rsi-period2',
      sym: 'BTC',
      tf: '1h',
      label: 'RSI period key',
      source: 'pine',
      recipe: { source: 'pine', series: [{ kind: 'rsi', params: { period: 14 }, pane: 'series' }] },
      elements: [],
    };

    const resN = recomputeRecipe(withN, bars, 'ETH', '4h');
    const resPeriod = recomputeRecipe(withPeriod, bars, 'ETH', '4h');

    const lineN = resN.overlay.elements.find((e) => e.type === 'line');
    const lineP = resPeriod.overlay.elements.find((e) => e.type === 'line');
    expect(lineN?.type === 'line' && lineP?.type === 'line' && lineN.values).toEqual(
      lineP?.type === 'line' ? lineP.values : undefined,
    );
  });
});

describe('recomputeRecipe: pickPeriod tolerates `length` key (SMA)', () => {
  const bars = makeBars(200);

  it('SMA recipe with params:{length:50} recomputes as SMA(50), NOT the default 20', () => {
    const withLength: ResearchOverlayType = {
      id: 'sma-length-50',
      sym: 'BTC',
      tf: '1d',
      label: 'SMA length=50',
      recipe: { source: 'pine', series: [{ kind: 'sma', params: { length: 50 } }] },
      elements: [],
    };
    const withDefault: ResearchOverlayType = {
      id: 'sma-default-20',
      sym: 'BTC',
      tf: '1d',
      label: 'SMA default 20',
      recipe: { source: 'nl', series: [{ kind: 'sma', params: {} }] },
      elements: [],
    };
    const withPeriod50: ResearchOverlayType = {
      id: 'sma-period-50',
      sym: 'BTC',
      tf: '1d',
      label: 'SMA period=50',
      recipe: { source: 'nl', series: [{ kind: 'sma', params: { period: 50 } }] },
      elements: [],
    };

    const resLength = recomputeRecipe(withLength, bars, 'SOL', '1d');
    const resDefault = recomputeRecipe(withDefault, bars, 'SOL', '1d');
    const resPeriod50 = recomputeRecipe(withPeriod50, bars, 'SOL', '1d');

    const lineLength = resLength.overlay.elements.find((e) => e.type === 'line');
    const lineDefault = resDefault.overlay.elements.find((e) => e.type === 'line');
    const linePeriod50 = resPeriod50.overlay.elements.find((e) => e.type === 'line');

    expect(lineLength).toBeDefined();
    expect(lineDefault).toBeDefined();
    expect(linePeriod50).toBeDefined();

    // length:50 must match period:50 (same computation).
    expect(lineLength?.type === 'line' && lineLength.values).toEqual(
      linePeriod50?.type === 'line' ? linePeriod50.values : undefined,
    );

    // length:50 must NOT match the default-20 series (different periods → different values).
    expect(lineLength?.type === 'line' && lineLength.values).not.toEqual(
      lineDefault?.type === 'line' ? lineDefault.values : undefined,
    );
  });
});

describe('recomputeRecipe: pickMult tolerates `mult` key (Bollinger)', () => {
  const bars = makeBars(120);

  it('Bollinger recipe with params:{period:20, mult:2} recomputes the same as {period:20, k:2}', () => {
    const withK: ResearchOverlayType = {
      id: 'bb-k',
      sym: 'BTC',
      tf: '1h',
      label: 'BB k key',
      source: 'pine',
      recipe: { source: 'pine', series: [{ kind: 'bollinger', params: { period: 20, k: 2 }, color: '#5b8def' }] },
      elements: [],
    };
    const withMult: ResearchOverlayType = {
      id: 'bb-mult',
      sym: 'BTC',
      tf: '1h',
      label: 'BB mult key',
      source: 'pine',
      recipe: { source: 'pine', series: [{ kind: 'bollinger', params: { period: 20, mult: 2 }, color: '#5b8def' }] },
      elements: [],
    };

    const resK = recomputeRecipe(withK, bars, 'BTC', '1h');
    const resMult = recomputeRecipe(withMult, bars, 'BTC', '1h');

    // Both produce one band + one line, no hlines.
    expect(resK.overlay.elements.filter((e) => e.type === 'band')).toHaveLength(1);
    expect(resMult.overlay.elements.filter((e) => e.type === 'band')).toHaveLength(1);

    const bandK = resK.overlay.elements.find((e) => e.type === 'band');
    const bandMult = resMult.overlay.elements.find((e) => e.type === 'band');

    // The band values must be identical — same period and multiplier.
    expect(bandK?.type === 'band' && bandK.upper).toEqual(
      bandMult?.type === 'band' ? bandMult.upper : undefined,
    );
    expect(bandK?.type === 'band' && bandK.lower).toEqual(
      bandMult?.type === 'band' ? bandMult.lower : undefined,
    );
  });
});
