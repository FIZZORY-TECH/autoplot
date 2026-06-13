/**
 * src/data/paginatedProvider.test.ts — Step 3 (Part A) unit tests.
 *
 * Covers:
 *   1. MockMarketDataProvider.fetchHistoryBefore — older-window determinism,
 *      all `ts < before`, ascending order.
 *   2. PaginatedProvider.fetchHistoryBefore (real/Tauri path) — calls
 *      marketFetchHistoryBefore with correct args; does NOT call
 *      marketFetchHistory (the "last N" path).
 *   3. Alpaca fetchHistoryBefore re-throws in Tauri runtime (hard-fail parity).
 *   4. Cache-not-masking: fetchHistoryBefore does NOT short-circuit even when
 *      the ohlcCache has a warm "last N" hit for the same key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Bar } from './MarketDataProvider';
import { MockMarketDataProvider } from './mockProvider';

// ---------------------------------------------------------------------------
// Control isTauriRuntime and the DB invoke wrappers.
// ---------------------------------------------------------------------------

let mockTauri = false;

vi.mock('../lib/runtime', () => ({
  isTauriRuntime: () => mockTauri,
}));

// Separate mocks for the two DB functions so we can assert each in isolation.
const marketFetchHistoryMock = vi.fn<() => Promise<Bar[]>>();
const marketFetchHistoryBeforeMock = vi.fn<() => Promise<Bar[]>>();

vi.mock('../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/db')>();
  return {
    ...orig,
    marketFetchHistory: (...args: unknown[]) =>
      marketFetchHistoryMock(...(args as [])),
    marketFetchHistoryBefore: (...args: unknown[]) =>
      marketFetchHistoryBeforeMock(...(args as [])),
    symbolCatalogSearch: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./adapters/alpaca', () => ({
  subscribeAlpaca: vi.fn(() => ({ unsubscribe: () => {} })),
  hasAlpacaCredentials: vi.fn(() => false),
  mapSymbol: (s: string) => s.toUpperCase(),
}));

// Import after mocks are registered.
const { getProvider, __providerRegistryInternals } = await import('./providerRegistry');
const { setEquityCredFailed } = await import('./equityCredStatus');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TF_MS = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
} as const;

function sampleBars(n: number, startTs = 1_700_000_000_000): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: startTs + i * 3_600_000,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100.5 + i,
    v: 10 + i,
  }));
}

// ---------------------------------------------------------------------------
// 1. MockMarketDataProvider.fetchHistoryBefore — determinism + boundary checks
// ---------------------------------------------------------------------------

describe('MockMarketDataProvider.fetchHistoryBefore', () => {
  const mock = new MockMarketDataProvider();

  it('returns the requested number of bars', async () => {
    const before = Date.now();
    const bars = await mock.fetchHistoryBefore('BTC', '1h', before, 50);
    expect(bars.length).toBe(50);
  });

  it('all returned bars have ts strictly less than `before`', async () => {
    const before = 1_720_000_000_000; // fixed epoch-ms
    const bars = await mock.fetchHistoryBefore('BTC', '1h', before, 30);
    for (const bar of bars) {
      expect(bar.ts).toBeLessThan(before);
    }
  });

  it('bars are in ascending ts order (oldest first)', async () => {
    const before = 1_720_000_000_000;
    const bars = await mock.fetchHistoryBefore('BTC', '1h', before, 20);
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].ts).toBeGreaterThan(bars[i - 1].ts);
    }
  });

  it('is deterministic for the same (sym, tf, before)', async () => {
    const before = 1_720_000_000_000;
    const a = await mock.fetchHistoryBefore('BTC', '1d', before, 20);
    const b = await mock.fetchHistoryBefore('BTC', '1d', before, 20);
    expect(a).toEqual(b);
  });

  it('produces a different window for a different `before` value', async () => {
    const before1 = 1_720_000_000_000;
    const before2 = before1 - TF_MS['1h'] * 10; // 10 bars earlier
    const a = await mock.fetchHistoryBefore('BTC', '1h', before1, 10);
    const b = await mock.fetchHistoryBefore('BTC', '1h', before2, 10);
    // The newest bar in b must be older than the newest bar in a.
    expect(b[b.length - 1].ts).toBeLessThan(a[a.length - 1].ts);
  });

  it('different symbols produce different bar series', async () => {
    const before = 1_720_000_000_000;
    const btc = await mock.fetchHistoryBefore('BTC', '1d', before, 10);
    const eth = await mock.fetchHistoryBefore('ETH', '1d', before, 10);
    const allSame = btc.every((bar, i) => bar.c === eth[i].c);
    expect(allSame).toBe(false);
  });

  it('emits well-formed OHLC bars (h ≥ max(o,c), l ≤ min(o,c))', async () => {
    const before = 1_720_000_000_000;
    const bars = await mock.fetchHistoryBefore('ETH', '4h', before, 20);
    for (const bar of bars) {
      expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c));
      expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c));
    }
  });

  it('newest bar ts equals floor(before/tfMs)*tfMs − tfMs (one slot before before)', async () => {
    const tfMs = TF_MS['1h'];
    const before = 1_720_080_000_000; // arbitrary aligned epoch
    const bars = await mock.fetchHistoryBefore('BTC', '1h', before, 5);
    const expectedNewest = Math.floor(before / tfMs) * tfMs - tfMs;
    expect(bars[bars.length - 1].ts).toBe(expectedNewest);
  });
});

// ---------------------------------------------------------------------------
// 2. getProvider().fetchHistoryBefore — real path (Tauri present, crypto)
// ---------------------------------------------------------------------------

describe('getProvider().fetchHistoryBefore — real crypto path', () => {
  beforeEach(() => {
    marketFetchHistoryMock.mockReset();
    marketFetchHistoryBeforeMock.mockReset();
    setEquityCredFailed(false);
    // Suppress internal touch (avoid tree-shake).
    void __providerRegistryInternals;
  });

  afterEach(() => {
    mockTauri = false;
  });

  it('calls marketFetchHistoryBefore (NOT marketFetchHistory) with correct args', async () => {
    mockTauri = true;
    const fakeBars = sampleBars(5);
    marketFetchHistoryBeforeMock.mockResolvedValueOnce(fakeBars);

    const p = getProvider('binance', 'USDT');
    const before = 1_720_000_000_000;
    const result = await p.fetchHistoryBefore('BTC', '1h', before, 5);

    expect(result).toEqual(fakeBars);
    expect(marketFetchHistoryBeforeMock).toHaveBeenCalledTimes(1);
    // marketFetchHistoryBefore(provider, sym, tf, count, quote, before)
    const args = marketFetchHistoryBeforeMock.mock.calls[0] as unknown as [
      string, string, string, number, string, number,
    ];
    expect(args[0]).toBe('binance');
    expect(args[1]).toBe('BTC');
    expect(args[2]).toBe('1h');
    expect(args[3]).toBe(5);
    expect(args[4]).toBe('USDT');
    expect(args[5]).toBe(before);

    // The "last N" path must NOT have been called.
    expect(marketFetchHistoryMock).not.toHaveBeenCalled();
  });

  it('threads the explicit quote argument through to marketFetchHistoryBefore', async () => {
    mockTauri = true;
    marketFetchHistoryBeforeMock.mockResolvedValueOnce(sampleBars(3));

    const p = getProvider('kraken', 'USD');
    await p.fetchHistoryBefore('ETH', '4h', 1_720_000_000_000, 3);

    const args = marketFetchHistoryBeforeMock.mock.calls[0] as unknown as [
      string, string, string, number, string, number,
    ];
    expect(args[0]).toBe('kraken');
    expect(args[4]).toBe('USD');
  });

  it('falls through to mock on adapter-not-registered (Tauri present, crypto)', async () => {
    mockTauri = true;
    marketFetchHistoryBeforeMock.mockRejectedValueOnce(
      new Error('adapter not registered: binance'),
    );

    const p = getProvider('binance', 'USDT');
    const before = 1_720_000_000_000;
    // Should NOT throw — falls through to mock.
    const bars = await p.fetchHistoryBefore('BTC', '1h', before, 10);
    expect(bars.length).toBeGreaterThan(0);
    // All bars must satisfy the before constraint via the mock.
    for (const bar of bars) {
      expect(bar.ts).toBeLessThan(before);
    }
  });

  it('falls through to mock when Tauri command is missing (vite dev)', async () => {
    mockTauri = false;
    marketFetchHistoryBeforeMock.mockRejectedValueOnce(
      new Error('window.__TAURI not available'),
    );

    const p = getProvider('coinbase', 'USD');
    const before = 1_720_000_000_000;
    const bars = await p.fetchHistoryBefore('BTC', '1h', before, 5);
    expect(bars.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Alpaca fetchHistoryBefore — hard-fail re-throw (Tauri present)
// ---------------------------------------------------------------------------

describe('getProvider().fetchHistoryBefore — Alpaca hard-fail', () => {
  beforeEach(() => {
    marketFetchHistoryBeforeMock.mockReset();
    setEquityCredFailed(false);
  });

  afterEach(() => {
    mockTauri = false;
  });

  it('re-throws on adapter-not-registered when Tauri is present', async () => {
    mockTauri = true;
    marketFetchHistoryBeforeMock.mockRejectedValueOnce(
      new Error('adapter not registered: alpaca'),
    );

    const p = getProvider('alpaca');
    await expect(p.fetchHistoryBefore('TSLA', '1h', 1_720_000_000_000, 10)).rejects.toThrow(
      'adapter not registered',
    );

    const { getEquityCredStatus } = await import('./equityCredStatus');
    expect(getEquityCredStatus().failed).toBe(true);
    expect(getEquityCredStatus().reason).toBe('no_credentials');
  });

  it('re-throws on auth_failed when Tauri is present', async () => {
    mockTauri = true;
    marketFetchHistoryBeforeMock.mockRejectedValueOnce(
      new Error('error[Alpaca]: authentication failed: forbidden'),
    );

    const p = getProvider('alpaca');
    await expect(p.fetchHistoryBefore('TSLA', '1h', 1_720_000_000_000, 10)).rejects.toThrow(
      'authentication failed',
    );

    const { getEquityCredStatus } = await import('./equityCredStatus');
    expect(getEquityCredStatus().failed).toBe(true);
    expect(getEquityCredStatus().reason).toBe('auth_failed');
    expect(getEquityCredStatus().detail).toBe('forbidden');
  });

  it('re-throws on generic fetch error when Tauri is present', async () => {
    mockTauri = true;
    marketFetchHistoryBeforeMock.mockRejectedValueOnce(new Error('rate limited'));

    const p = getProvider('alpaca');
    await expect(p.fetchHistoryBefore('AAPL', '1d', 1_720_000_000_000, 5)).rejects.toThrow(
      'rate limited',
    );

    const { getEquityCredStatus } = await import('./equityCredStatus');
    expect(getEquityCredStatus().failed).toBe(true);
    expect(getEquityCredStatus().reason).toBe('fetch_failed');
  });

  it('clears equityCredFailed on a successful alpaca fetchHistoryBefore', async () => {
    mockTauri = true;
    setEquityCredFailed(true, 'no_credentials');
    const fakeBars = sampleBars(5);
    marketFetchHistoryBeforeMock.mockResolvedValueOnce(fakeBars);

    const p = getProvider('alpaca');
    const bars = await p.fetchHistoryBefore('AAPL', '1d', 1_720_000_000_000, 5);
    expect(bars).toEqual(fakeBars);

    const { getEquityCredStatus } = await import('./equityCredStatus');
    expect(getEquityCredStatus().failed).toBe(false);
  });

  it('falls through to mock for alpaca when Tauri is NOT present (vite dev)', async () => {
    mockTauri = false;
    // No mock needed on marketFetchHistoryBeforeMock — should not be called.

    const p = getProvider('alpaca');
    const before = 1_720_000_000_000;
    // Should NOT throw — vite dev path falls to mock.
    const bars = await p.fetchHistoryBefore('TSLA', '1h', before, 10);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.ts).toBeLessThan(before);
    }
    expect(marketFetchHistoryBeforeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Cache-not-masking: fetchHistoryBefore bypasses ohlcCache early-return
// ---------------------------------------------------------------------------

describe('fetchHistoryBefore — does not short-circuit on warm ohlcCache', () => {
  beforeEach(() => {
    marketFetchHistoryMock.mockReset();
    marketFetchHistoryBeforeMock.mockReset();
    setEquityCredFailed(false);
  });

  afterEach(() => {
    mockTauri = false;
  });

  it('calls the Rust layer even when ohlcCache has >= count bars for the same key', async () => {
    mockTauri = true;

    // Pre-warm the ohlcCache with enough bars that fetchHistory *would* early-return.
    // We inject the cache directly to avoid a live Rust call.
    // (The cache singleton is module-level; here we just verify the paged path
    //  ignores it by asserting marketFetchHistoryBefore is always called.)
    const warmBars = sampleBars(200);
    // Simulate the cache being warm by pre-configuring the regular fetchHistory mock.
    marketFetchHistoryMock.mockResolvedValueOnce(warmBars);

    // Warm the cache via fetchHistory (this exercises the "length >= count" early-return path).
    const p = getProvider('binance', 'USDT');
    await p.fetchHistory('BTC', '1h', 200);
    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);

    // Now call fetchHistoryBefore — it must go to the Rust layer, not the cache.
    const olderBars = sampleBars(10, 1_600_000_000_000);
    marketFetchHistoryBeforeMock.mockResolvedValueOnce(olderBars);

    const before = 1_700_000_000_000;
    const result = await p.fetchHistoryBefore('BTC', '1h', before, 10);

    // Must have reached the real Rust path.
    expect(marketFetchHistoryBeforeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(olderBars);

    // And the "last N" path must not have been called a second time.
    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);
  });

  it('fetching the same before-window twice calls Rust both times (no caching of paged results)', async () => {
    mockTauri = true;
    const olderBars = sampleBars(5, 1_600_000_000_000);
    marketFetchHistoryBeforeMock
      .mockResolvedValueOnce(olderBars)
      .mockResolvedValueOnce(olderBars);

    const p = getProvider('kraken', 'USD');
    const before = 1_700_000_000_000;

    await p.fetchHistoryBefore('ETH', '4h', before, 5);
    await p.fetchHistoryBefore('ETH', '4h', before, 5);

    // Both calls hit Rust — paged results are not cached.
    expect(marketFetchHistoryBeforeMock).toHaveBeenCalledTimes(2);
  });
});
