/**
 * src/ai/schemas.test.ts — W4-A — Zod schema fixtures.
 */
import { describe, it, expect } from 'vitest';
import { Dataset, Indicator, Op, IndicatorRef, Condition, Strategy, StrategyCondition, PerfStats } from './schemas';

const validDataset = {
  id: 'ds-1',
  label: 'SMA(20) on BTC 1h',
  kind: 'overlay' as const,
  align: 'right' as const,
  sym: 'BTC',
  tf: '1h' as const,
  conditions: [
    {
      left: { ref: 'close' as const },
      op: '>' as const,
      value: { ref: 'sma' as const, params: { period: 20 } },
    },
  ],
  values: [null, null, 100.5, 101.25, 102],
};

describe('Dataset schema', () => {
  it('parses a valid dataset', () => {
    const r = Dataset.safeParse(validDataset);
    expect(r.success).toBe(true);
  });

  it('right alignment validates', () => {
    const r = Dataset.safeParse({ ...validDataset, align: 'right' });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid Indicator name in a condition', () => {
    const bad = {
      ...validDataset,
      conditions: [
        { left: { ref: 'macd' }, op: '>', value: 0 },
      ],
    };
    const r = Dataset.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('rejects an OR group (no such field exists)', () => {
    const bad = {
      ...validDataset,
      conditions: [{ or: [{ left: { ref: 'close' }, op: '>', value: 0 }] }],
    };
    const r = Dataset.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('rejects a tf outside the locked 4-tier set', () => {
    const r = Dataset.safeParse({ ...validDataset, tf: '5m' });
    expect(r.success).toBe(false);
  });

  it('IndicatorRef accepts numeric params', () => {
    const r = IndicatorRef.safeParse({ ref: 'rsi', params: { period: 14 } });
    expect(r.success).toBe(true);
  });

  it('Condition.value accepts a literal number', () => {
    const r = Condition.safeParse({
      left: { ref: 'rsi', params: { period: 14 } },
      op: '<',
      value: 30,
    });
    expect(r.success).toBe(true);
  });

  it('Op enum is pinned', () => {
    expect(Op.options).toEqual([
      '<',
      '>',
      '<=',
      '>=',
      '==',
      'crossesAbove',
      'crossesBelow',
    ]);
  });

  it('Indicator enum has exactly 15 members', () => {
    expect(Indicator.options.length).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// W5-A — Strategy / StrategyCondition / PerfStats
// ---------------------------------------------------------------------------

describe('W5-A schemas', () => {
  it('StrategyCondition accepts a literal-number RHS with params', () => {
    const r = StrategyCondition.safeParse({
      indicator: 'rsi',
      op: '<',
      value: 30,
      params: { period: 14 },
    });
    expect(r.success).toBe(true);
  });

  it('StrategyCondition accepts an IndicatorRef RHS', () => {
    const r = StrategyCondition.safeParse({
      indicator: 'close',
      op: '>',
      value: { ref: 'sma', params: { period: 50 } },
    });
    expect(r.success).toBe(true);
  });

  it('PerfStats requires all four keys', () => {
    expect(
      PerfStats.safeParse({ winRate: 0.5, sharpe: 1, maxDrawdown: -0.1, trades: 4 }).success,
    ).toBe(true);
    expect(PerfStats.safeParse({ winRate: 0.5 }).success).toBe(false);
  });

  it('Strategy requires version=1 and rules.entry/exit non-empty', () => {
    const ok = Strategy.safeParse({
      id: 's1',
      name: 'RSI mean revert',
      thesis: 'Buy oversold, sell overbought.',
      rules: {
        entry: [{ indicator: 'rsi', op: '<', value: 30, params: { period: 14 } }],
        exit: [{ indicator: 'rsi', op: '>', value: 70, params: { period: 14 } }],
      },
      perf: null,
      version: 1,
      createdAt: 1234567890,
    });
    expect(ok.success).toBe(true);

    const wrongVersion = Strategy.safeParse({
      id: 's1',
      name: 'x',
      thesis: 'x',
      rules: {
        entry: [{ indicator: 'rsi', op: '<', value: 30 }],
        exit: [{ indicator: 'rsi', op: '>', value: 70 }],
      },
      version: 2,
      createdAt: 0,
    });
    expect(wrongVersion.success).toBe(false);

    const emptyEntry = Strategy.safeParse({
      id: 's1',
      name: 'x',
      thesis: 'x',
      rules: {
        entry: [],
        exit: [{ indicator: 'rsi', op: '>', value: 70 }],
      },
      version: 1,
      createdAt: 0,
    });
    expect(emptyEntry.success).toBe(false);
  });
});
