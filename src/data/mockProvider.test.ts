/**
 * src/data/mockProvider.test.ts
 *
 * Covers what the mock provider does AFTER the live-catalog pivot:
 *   - MockMarketDataProvider.fetchHistory  — deterministic OHLC generation
 *   - MockMarketDataProvider.subscribeRealtime — emits ticks, returns unsub
 *   - MockMarketDataProvider.search        — retired → always returns []
 *   - mockSymbolCatalogList                — retired stub → empty result
 *
 * The duplicate in-process symbol fixture and its search/list-over-fixture
 * helpers were removed: symbol resolution now flows exclusively through the
 * real SQLite catalog under the Tauri runtime.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockSymbolCatalogList, MockMarketDataProvider } from './mockProvider';
import type { Bar } from './MarketDataProvider';

// ---------------------------------------------------------------------------
// MockMarketDataProvider.fetchHistory — deterministic OHLC
// ---------------------------------------------------------------------------

describe('MockMarketDataProvider.fetchHistory', () => {
  const provider = new MockMarketDataProvider();

  it('returns the requested number of bars', async () => {
    const bars = await provider.fetchHistory('BTC', '1h', 50);
    expect(bars.length).toBe(50);
  });

  it('is deterministic for the same symbol', async () => {
    const a = await provider.fetchHistory('BTC', '1d', 20);
    const b = await provider.fetchHistory('BTC', '1d', 20);
    expect(a).toEqual(b);
  });

  it('produces different series for different symbols', async () => {
    const btc = await provider.fetchHistory('BTC', '1d', 20);
    const eth = await provider.fetchHistory('ETH', '1d', 20);
    // Closing prices should not be identical across the whole series.
    const sameCloses = btc.every((bar, i) => bar.c === eth[i].c);
    expect(sameCloses).toBe(false);
  });

  it('emits well-formed OHLC bars (h ≥ max(o,c), l ≤ min(o,c))', async () => {
    const bars = await provider.fetchHistory('SOL', '4h', 30);
    for (const bar of bars) {
      expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c));
      expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c));
      expect(bar.ts).toBeTypeOf('number');
    }
  });

  it('works for an equity symbol seed (AAPL) even without a catalog row', async () => {
    // ASSET_CONFIG still carries equity price seeds for deterministic history.
    const bars = await provider.fetchHistory('AAPL', '1d', 10);
    expect(bars.length).toBe(10);
    expect(bars[0].c).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MockMarketDataProvider.subscribeRealtime — emits ticks + returns unsub
// ---------------------------------------------------------------------------

describe('MockMarketDataProvider.subscribeRealtime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a tick on the interval and unsubscribe stops further ticks', () => {
    vi.useFakeTimers();
    const provider = new MockMarketDataProvider();
    const ticks: Bar[] = [];
    const unsub = provider.subscribeRealtime('BTC', '1h', (bar) => ticks.push(bar));

    vi.advanceTimersByTime(1000);
    expect(ticks.length).toBe(1);

    unsub();
    vi.advanceTimersByTime(3000);
    // No further ticks after unsubscribe.
    expect(ticks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MockMarketDataProvider.search — retired (always [])
// ---------------------------------------------------------------------------

describe('MockMarketDataProvider.search — retired', () => {
  const provider = new MockMarketDataProvider();

  it('returns [] for any query (no in-process symbol fixture)', async () => {
    expect(await provider.search('btc')).toEqual([]);
    expect(await provider.search('aapl')).toEqual([]);
    expect(await provider.search('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mockSymbolCatalogList — retired stub (empty result)
// ---------------------------------------------------------------------------

describe('mockSymbolCatalogList — retired stub', () => {
  it('returns an empty result for any provider', () => {
    expect(mockSymbolCatalogList('binance', 50, 0)).toEqual({ rows: [], total: 0 });
    expect(mockSymbolCatalogList('alpaca', 50, 0)).toEqual({ rows: [], total: 0 });
    expect(mockSymbolCatalogList('nonexistent', 50, 0)).toEqual({ rows: [], total: 0 });
  });
});
