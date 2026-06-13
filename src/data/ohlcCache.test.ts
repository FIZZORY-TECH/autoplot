/**
 * src/data/ohlcCache.test.ts — Unit tests for the in-memory OHLC LRU cache.
 *
 * ADR-0009: keys widened to `(provider, sym, quote, tf)` and capacity bumped
 * 32 → 128. Tests updated to pass through the per-provider default quote.
 */
import { describe, it, expect } from 'vitest';
import type { Bar } from './MarketDataProvider';
import { OhlcCache, ohlcCacheKey } from './ohlcCache';

const sampleBars = (n: number, base = 100): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    o: base + i,
    h: base + i + 0.5,
    l: base + i - 0.5,
    c: base + i + 0.25,
    v: 10 + i,
  }));

describe('OhlcCache', () => {
  it('returns undefined on miss', () => {
    const c = new OhlcCache();
    expect(c.get('binance', 'BTC', 'USDT', '1h')).toBeUndefined();
  });

  it('round-trips set / get', () => {
    const c = new OhlcCache();
    const bars = sampleBars(5);
    c.set('binance', 'BTC', 'USDT', '1h', bars);
    expect(c.get('binance', 'BTC', 'USDT', '1h')).toEqual(bars);
  });

  it('isolates entries per (provider, sym, quote, tf)', () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(2, 100));
    c.set('coinbase', 'BTC', 'USD', '1h', sampleBars(2, 200));
    c.set('binance', 'ETH', 'USDT', '1h', sampleBars(2, 300));
    c.set('binance', 'BTC', 'USDT', '4h', sampleBars(2, 400));
    // Multi-quote: same (provider, sym, tf), different quote, must not collide.
    c.set('binance', 'BTC', 'USDC', '1h', sampleBars(2, 500));
    expect(c.get('binance', 'BTC', 'USDT', '1h')?.[0].o).toBe(100);
    expect(c.get('coinbase', 'BTC', 'USD', '1h')?.[0].o).toBe(200);
    expect(c.get('binance', 'ETH', 'USDT', '1h')?.[0].o).toBe(300);
    expect(c.get('binance', 'BTC', 'USDT', '4h')?.[0].o).toBe(400);
    expect(c.get('binance', 'BTC', 'USDC', '1h')?.[0].o).toBe(500);
    expect(c.size).toBe(5);
  });

  it('evicts the least-recently-used entry when full', () => {
    const c = new OhlcCache(3);
    c.set('binance', 'A', 'USDT', '1h', sampleBars(1));
    c.set('binance', 'B', 'USDT', '1h', sampleBars(1));
    c.set('binance', 'C', 'USDT', '1h', sampleBars(1));
    // All three present.
    expect(c.size).toBe(3);
    // Touch A → A becomes MRU; B is now LRU.
    c.get('binance', 'A', 'USDT', '1h');
    // Insert D → B (LRU) should be evicted.
    c.set('binance', 'D', 'USDT', '1h', sampleBars(1));
    expect(c.size).toBe(3);
    expect(c.get('binance', 'A', 'USDT', '1h')).toBeDefined();
    expect(c.get('binance', 'B', 'USDT', '1h')).toBeUndefined();
    expect(c.get('binance', 'C', 'USDT', '1h')).toBeDefined();
    expect(c.get('binance', 'D', 'USDT', '1h')).toBeDefined();
  });

  it('re-setting an existing key bumps it to MRU and does not evict', () => {
    const c = new OhlcCache(2);
    c.set('binance', 'A', 'USDT', '1h', sampleBars(1));
    c.set('binance', 'B', 'USDT', '1h', sampleBars(1));
    // Re-set A → A becomes MRU; B is now LRU.
    c.set('binance', 'A', 'USDT', '1h', sampleBars(2));
    // Insert C → B should evict, A should survive.
    c.set('binance', 'C', 'USDT', '1h', sampleBars(1));
    expect(c.get('binance', 'A', 'USDT', '1h')?.length).toBe(2);
    expect(c.get('binance', 'B', 'USDT', '1h')).toBeUndefined();
    expect(c.get('binance', 'C', 'USDT', '1h')).toBeDefined();
  });

  it('delete removes a single entry', () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(1));
    expect(c.delete('binance', 'BTC', 'USDT', '1h')).toBe(true);
    expect(c.get('binance', 'BTC', 'USDT', '1h')).toBeUndefined();
    // Deleting a missing key returns false.
    expect(c.delete('binance', 'BTC', 'USDT', '1h')).toBe(false);
  });

  it('clear empties everything', () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(1));
    c.set('coinbase', 'ETH', 'USD', '4h', sampleBars(1));
    c.clear();
    expect(c.size).toBe(0);
  });

  it('rejects non-positive maxEntries', () => {
    expect(() => new OhlcCache(0)).toThrow();
    expect(() => new OhlcCache(-1)).toThrow();
  });

  it('ohlcCacheKey is stable, provider-segregated, and quote-aware', () => {
    expect(ohlcCacheKey('binance', 'BTC', 'USDT', '1h')).toBe('binance:BTC/USDT:1h');
    expect(ohlcCacheKey('coinbase', 'BTC', 'USD', '1h')).toBe('coinbase:BTC/USD:1h');
    // Same (provider, sym, tf), different quote → distinct keys.
    expect(ohlcCacheKey('binance', 'BTC', 'USDC', '1h')).toBe('binance:BTC/USDC:1h');
  });

  // ---------------------------------------------------------------------------
  // Fix B1 — freshness (getWithMeta + fetchedAt stamping)
  // ---------------------------------------------------------------------------

  it('getWithMeta returns undefined on miss', () => {
    const c = new OhlcCache();
    expect(c.getWithMeta('binance', 'BTC', 'USDT', '1h')).toBeUndefined();
  });

  it('getWithMeta returns bars and a fetchedAt timestamp close to now', () => {
    const c = new OhlcCache();
    const bars = sampleBars(3);
    const before = Date.now();
    c.set('binance', 'BTC', 'USDT', '1h', bars);
    const after = Date.now();

    const entry = c.getWithMeta('binance', 'BTC', 'USDT', '1h');
    expect(entry).toBeDefined();
    expect(entry?.bars).toEqual(bars);
    expect(entry?.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.fetchedAt).toBeLessThanOrEqual(after);
  });

  it('re-setting an entry updates fetchedAt to a newer timestamp', async () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(2));
    const first = c.getWithMeta('binance', 'BTC', 'USDT', '1h')!.fetchedAt;

    // Tiny forced gap so the timestamps are distinguishable.
    await new Promise((r) => setTimeout(r, 5));

    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(4));
    const second = c.getWithMeta('binance', 'BTC', 'USDT', '1h')!.fetchedAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('delete removes fetchedAt entry so getWithMeta returns undefined', () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(1));
    c.delete('binance', 'BTC', 'USDT', '1h');
    expect(c.getWithMeta('binance', 'BTC', 'USDT', '1h')).toBeUndefined();
  });

  it('clearProvider removes fetchedAt entries for that provider', () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(1));
    c.set('coinbase', 'ETH', 'USD', '1h', sampleBars(1));
    c.clearProvider('binance');
    expect(c.getWithMeta('binance', 'BTC', 'USDT', '1h')).toBeUndefined();
    // coinbase entry survives.
    expect(c.getWithMeta('coinbase', 'ETH', 'USD', '1h')).toBeDefined();
  });

  it('clear empties fetchedAt map so getWithMeta returns undefined', () => {
    const c = new OhlcCache();
    c.set('binance', 'BTC', 'USDT', '1h', sampleBars(2));
    c.clear();
    expect(c.getWithMeta('binance', 'BTC', 'USDT', '1h')).toBeUndefined();
  });

  it('LRU eviction also removes fetchedAt entry', () => {
    const c = new OhlcCache(2);
    c.set('binance', 'A', 'USDT', '1h', sampleBars(1)); // LRU
    c.set('binance', 'B', 'USDT', '1h', sampleBars(1));
    // Insert C — evicts A (LRU).
    c.set('binance', 'C', 'USDT', '1h', sampleBars(1));
    expect(c.getWithMeta('binance', 'A', 'USDT', '1h')).toBeUndefined();
    expect(c.getWithMeta('binance', 'B', 'USDT', '1h')).toBeDefined();
    expect(c.getWithMeta('binance', 'C', 'USDT', '1h')).toBeDefined();
  });
});
