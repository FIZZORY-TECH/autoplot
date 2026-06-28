/**
 * src/ai/pineIndicator.test.ts — Pine→indicator skill contracts.
 *
 * Covers:
 *  1. Schema accept/default/reject for the new `pane?` field on
 *     LineElement, BandElement, HLineElement.
 *  2. Schema accept/reject for the new `source?` field on ResearchOverlay.
 *  3. Recipe-contract validation: full ResearchOverlay shapes for the RSI
 *     recipe (pane:'series') and the Bollinger recipe (pane omitted → price).
 *
 * NOTE on "absent ⇒ price": the schema declares `pane` optional with no
 * default. When `pane` is absent the parsed object simply omits the field.
 * The "absent ⇒ price" semantic is renderer behavior, not a schema default.
 */
import { describe, it, expect } from 'vitest';
import { LineElement, BandElement, HLineElement, ResearchOverlay } from './schemas';

// ---------------------------------------------------------------------------
// LineElement — pane? field
// ---------------------------------------------------------------------------

describe('LineElement pane field', () => {
  const base = {
    type: 'line' as const,
    values: [1, 2, 3],
    align: 'right' as const,
  };

  it('accepts pane:"series"', () => {
    const r = LineElement.safeParse({ ...base, pane: 'series' });
    expect(r.success).toBe(true);
  });

  it('accepts pane:"price"', () => {
    const r = LineElement.safeParse({ ...base, pane: 'price' });
    expect(r.success).toBe(true);
  });

  it('parses with NO pane (absent ⇒ omitted from object; price semantics are renderer behavior)', () => {
    const r = LineElement.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      // pane is absent from the parsed output — the schema applies no default
      expect('pane' in r.data).toBe(false);
    }
  });

  it('rejects an invalid pane value', () => {
    const r = LineElement.safeParse({ ...base, pane: 'sub' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BandElement — pane? field
// ---------------------------------------------------------------------------

describe('BandElement pane field', () => {
  const base = {
    type: 'band' as const,
    upper: [21, 22, 23],
    lower: [19, 18, 17],
    align: 'right' as const,
  };

  it('accepts pane:"series"', () => {
    const r = BandElement.safeParse({ ...base, pane: 'series' });
    expect(r.success).toBe(true);
  });

  it('accepts pane:"price"', () => {
    const r = BandElement.safeParse({ ...base, pane: 'price' });
    expect(r.success).toBe(true);
  });

  it('parses with NO pane (field absent from parsed object)', () => {
    const r = BandElement.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect('pane' in r.data).toBe(false);
    }
  });

  it('rejects an invalid pane value', () => {
    const r = BandElement.safeParse({ ...base, pane: 'sub' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HLineElement — pane? field
// ---------------------------------------------------------------------------

describe('HLineElement pane field', () => {
  const base = {
    type: 'hline' as const,
    price: 70,
  };

  it('accepts pane:"series"', () => {
    const r = HLineElement.safeParse({ ...base, pane: 'series' });
    expect(r.success).toBe(true);
  });

  it('accepts pane:"price"', () => {
    const r = HLineElement.safeParse({ ...base, pane: 'price' });
    expect(r.success).toBe(true);
  });

  it('parses with NO pane (field absent from parsed object)', () => {
    const r = HLineElement.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect('pane' in r.data).toBe(false);
    }
  });

  it('rejects an invalid pane value', () => {
    const r = HLineElement.safeParse({ ...base, pane: 'oscillator' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ResearchOverlay — source? field
// ---------------------------------------------------------------------------

describe('ResearchOverlay source field', () => {
  const baseOverlay = {
    id: 'overlay-1',
    sym: 'BTC',
    tf: '1h' as const,
    label: 'Test overlay',
    elements: [],
  };

  it('accepts source:"pine"', () => {
    const r = ResearchOverlay.safeParse({ ...baseOverlay, source: 'pine' });
    expect(r.success).toBe(true);
  });

  it('accepts source:"nl"', () => {
    const r = ResearchOverlay.safeParse({ ...baseOverlay, source: 'nl' });
    expect(r.success).toBe(true);
  });

  it('parses with NO source (field absent from parsed object; no legend badge)', () => {
    const r = ResearchOverlay.safeParse(baseOverlay);
    expect(r.success).toBe(true);
    if (r.success) {
      expect('source' in r.data).toBe(false);
    }
  });

  it('rejects an invalid source value', () => {
    const r = ResearchOverlay.safeParse({ ...baseOverlay, source: 'manual' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recipe-contract: RSI overlay (pane:'series')
//
// A full ResearchOverlay with one LineElement on pane:'series' must validate.
// This mirrors the shape the Pine→indicator skill assembles for RSI(14).
// ---------------------------------------------------------------------------

describe('Recipe contract: RSI overlay', () => {
  it('validates a full RSI ResearchOverlay with pane:"series"', () => {
    const rsiOverlay = {
      id: 'rsi-14-btc-1h',
      sym: 'BTC',
      tf: '1h' as const,
      label: 'RSI(14)',
      color: '#9c27b0',
      source: 'pine' as const,
      elements: [
        {
          type: 'line' as const,
          values: [null, null, null, 45.2, 52.1, 67.8, 71.3, 55.0],
          align: 'right' as const,
          color: '#9c27b0',
          width: 1.5,
          pane: 'series' as const,
        },
        // Overbought hline at 70 — also in series pane
        {
          type: 'hline' as const,
          price: 70,
          label: 'Overbought',
          color: '#e53935',
          dash: '4,2',
          pane: 'series' as const,
        },
        // Oversold hline at 30 — also in series pane
        {
          type: 'hline' as const,
          price: 30,
          label: 'Oversold',
          color: '#43a047',
          dash: '4,2',
          pane: 'series' as const,
        },
      ],
    };
    const r = ResearchOverlay.safeParse(rsiOverlay);
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recipe-contract: Bollinger Bands overlay (pane omitted → price)
//
// One BandElement (upper+lower) plus a middle LineElement, both on the price
// pane (pane omitted). Mirrors what the Pine→indicator skill emits for BB(20,2).
// ---------------------------------------------------------------------------

describe('Recipe contract: Bollinger Bands overlay', () => {
  it('validates a Bollinger overlay with pane omitted (price pane)', () => {
    const closes = [100, 101, 99, 102, 103, 101, 104, 102, 100, 103];
    const midValues = closes.map((_, i) => (i < 4 ? null : closes.slice(i - 4, i + 1).reduce((s, v) => s + v, 0) / 5));

    const bollingerOverlay = {
      id: 'bb-20-2-btc-1h',
      sym: 'BTC',
      tf: '1h' as const,
      label: 'BB(20,2)',
      color: '#2196f3',
      source: 'pine' as const,
      elements: [
        // Band element carries upper + lower; pane omitted → price pane
        {
          type: 'band' as const,
          upper: midValues.map((v) => (v !== null ? v + 2 : null)),
          lower: midValues.map((v) => (v !== null ? v - 2 : null)),
          align: 'right' as const,
          color: '#2196f3',
          opacity: 0.15,
          // pane deliberately omitted — renderer treats as 'price'
        },
        // Middle line (SMA)
        {
          type: 'line' as const,
          values: midValues,
          align: 'right' as const,
          color: '#2196f3',
          width: 1,
          // pane deliberately omitted — renderer treats as 'price'
        },
      ],
    };
    const r = ResearchOverlay.safeParse(bollingerOverlay);
    expect(r.success).toBe(true);
  });
});
