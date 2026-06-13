/**
 * src/ai/tools/computeIndicator.test.ts — W4-A — compute_indicator handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, isMockForcedMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isMockForcedMock: vi.fn(() => true),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../data/providerRegistry', () => ({
  isMockForced: isMockForcedMock,
}));

import { computeIndicator } from './computeIndicator';

describe('computeIndicator', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isMockForcedMock.mockReset();
    isMockForcedMock.mockReturnValue(true);
  });

  it('rejects an indicator outside the pinned enum', async () => {
    await expect(
      computeIndicator({ sym: 'BTC', tf: '1h', kind: 'macd' }),
    ).rejects.toThrow();
  });

  it('sma cold-start positions remain null and the rest are numbers', async () => {
    const out = await computeIndicator({
      sym: 'BTC',
      tf: '1h',
      kind: 'sma',
      params: { period: 5 },
      count: 20,
    });
    expect(out.align).toBe('right');
    expect(out.values.length).toBe(20);
    // First (period - 1) = 4 entries must be null.
    for (let i = 0; i < 4; i++) {
      expect(out.values[i]).toBeNull();
    }
    // Remaining entries must be finite numbers.
    for (let i = 4; i < 20; i++) {
      expect(typeof out.values[i]).toBe('number');
      expect(Number.isFinite(out.values[i] as number)).toBe(true);
    }
  });

  it('passthrough indicators return the close-series length', async () => {
    const out = await computeIndicator({
      sym: 'BTC',
      tf: '1h',
      kind: 'close',
      count: 10,
    });
    expect(out.values.length).toBe(10);
    for (const v of out.values) {
      expect(typeof v).toBe('number');
    }
  });

  it('unimplemented indicator (atr) returns null series w/o throwing', async () => {
    const out = await computeIndicator({
      sym: 'BTC',
      tf: '1h',
      kind: 'atr',
      count: 8,
    });
    expect(out.values.length).toBe(8);
    expect(out.values.every((v) => v === null)).toBe(true);
  });

  it('rejects a tf outside the locked 4-tier set', async () => {
    await expect(
      computeIndicator({ sym: 'BTC', tf: '15m', kind: 'sma' }),
    ).rejects.toThrow();
  });
});
