/**
 * src/ai/tools/validateStrategy.test.ts — W5-B — `validate_strategy` handler.
 */
import { describe, it, expect } from 'vitest';
import { validateStrategy } from './validateStrategy';

const validStrategy = {
  id: 'rsi-mr-14',
  name: 'RSI(14) mean-revert',
  thesis: 'Buy oversold, sell mean-revert',
  rules: {
    entry: [{ indicator: 'rsi', op: '<', value: 30, params: { period: 14 } }],
    exit: [{ indicator: 'rsi', op: '>', value: 55, params: { period: 14 } }],
  },
  version: 1,
  createdAt: 1700000000000,
};

describe('validateStrategy', () => {
  it('returns ok:true with parsed strategy on valid input', async () => {
    const out = await validateStrategy({ json: validStrategy });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.strategy.id).toBe('rsi-mr-14');
  });

  it('accepts the strategy object directly (no `json` envelope)', async () => {
    const out = await validateStrategy(validStrategy);
    expect(out.ok).toBe(true);
  });

  it('returns ok:false with path when a required field is missing', async () => {
    const bad = { ...validStrategy };
    // @ts-expect-error -- intentional missing field
    delete bad.thesis;
    const out = await validateStrategy({ json: bad });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('thesis');
  });

  it('rejects bad version literal', async () => {
    const bad = { ...validStrategy, version: 2 };
    const out = await validateStrategy({ json: bad });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('version');
  });

  it('rejects an OR-group attempt (Condition shape that does not match StrategyCondition)', async () => {
    const bad = {
      ...validStrategy,
      rules: {
        // Wrap LHS in `left: { ref }` like a Dataset Condition — should fail
        // StrategyCondition's `indicator` requirement.
        entry: [{ left: { ref: 'rsi' }, op: '<', value: 30 }],
        exit: validStrategy.rules.exit,
      },
    };
    const out = await validateStrategy({ json: bad });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/indicator|entry/);
  });

  it('rejects when entry is empty (must be at least 1)', async () => {
    const bad = {
      ...validStrategy,
      rules: { entry: [], exit: validStrategy.rules.exit },
    };
    const out = await validateStrategy({ json: bad });
    expect(out.ok).toBe(false);
  });
});
