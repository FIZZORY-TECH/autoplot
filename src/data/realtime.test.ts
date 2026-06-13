/**
 * src/data/realtime.test.ts — Unit tests for `mergeTick` and the orchestrator
 * basic lifecycle (P4.5).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Bar } from './MarketDataProvider';
import { mergeTick, realtime } from './realtime';

const bar = (ts: number, c: number): Bar => ({ ts, o: c, h: c, l: c, c, v: 1 });

describe('mergeTick', () => {
  it('appends a tick newer than the last bar', () => {
    const bars = [bar(1, 100), bar(2, 110)];
    const out = mergeTick(bars, bar(3, 120));
    expect(out).toHaveLength(3);
    expect(out[2].c).toBe(120);
  });

  it('replaces the last bar when ts matches (in-progress update)', () => {
    const bars = [bar(1, 100), bar(2, 110)];
    const out = mergeTick(bars, bar(2, 115));
    expect(out).toHaveLength(2);
    expect(out[1].c).toBe(115);
    // Should be a new array (mutation safety).
    expect(out).not.toBe(bars);
  });

  it('ignores stale ticks older than the last bar', () => {
    const bars = [bar(1, 100), bar(2, 110)];
    const out = mergeTick(bars, bar(1, 999));
    // Same reference returned — caller can short-circuit.
    expect(out).toBe(bars);
  });

  it('seeds an empty array with the first tick', () => {
    const out = mergeTick([], bar(1, 100));
    expect(out).toEqual([bar(1, 100)]);
  });
});

describe('realtime orchestrator', () => {
  beforeEach(() => {
    realtime.unsubscribe();
  });

  it('exposes onTick add/remove', () => {
    const cb = vi.fn();
    const off = realtime.onTick(cb);
    expect(realtime.listenerCount).toBe(1);
    off();
    expect(realtime.listenerCount).toBe(0);
  });
});
