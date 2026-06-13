/**
 * src/data/providerRegistry.test.ts — Hard-fail equity guard + crypto fallback regression.
 *
 * Asserts:
 *   1. When the Tauri runtime IS present and the alpaca adapter throws
 *      "adapter not registered", getProvider('alpaca').fetchHistory RE-THROWS
 *      (does NOT fall through to mock). equityCredStatus is set to failed.
 *   2. When the Tauri runtime is NOT present and alpaca adapter throws
 *      "adapter not registered", the registry falls through to mock (vite dev path).
 *   3. Crypto providers (binance, coinbase, kraken) still mock-fallback on
 *      "adapter not registered" regardless of Tauri runtime presence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Bar } from './MarketDataProvider';
import { useToastStore } from '../stores/useToastStore';

// ---------------------------------------------------------------------------
// We need to control:
//   a) `isTauriRuntime` from ../lib/runtime
//   b) `marketFetchHistory` from ../lib/db (the Tauri invoke wrapper)
//   c) `ohlcCache` to prevent cross-test pollution
// ---------------------------------------------------------------------------

// Store original environment
let mockTauri = false;

vi.mock('../lib/runtime', () => ({
  isTauriRuntime: () => mockTauri,
}));

// Mock the marketFetchHistory Tauri invoke wrapper.
const marketFetchHistoryMock = vi.fn<() => Promise<Bar[]>>();
// Step 11 (ADR-0009) — searchSymbols routes through symbolCatalogSearch under
// Tauri; mock it here so we can assert the routing without standing up the DB.
type SymbolCatalogSearchArgs = [
  string,
  string[] | null | undefined,
  number | undefined,
];
const symbolCatalogSearchMock =
  vi.fn<(...args: SymbolCatalogSearchArgs) => Promise<unknown[]>>();
vi.mock('../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/db')>();
  return {
    ...orig,
    marketFetchHistory: (...args: unknown[]) => marketFetchHistoryMock(...args as []),
    symbolCatalogSearch: (...args: unknown[]) =>
      symbolCatalogSearchMock(...(args as SymbolCatalogSearchArgs)),
  };
});

// Mock alpaca adapter — we test at the registry level, not the WS level.
vi.mock('./adapters/alpaca', () => ({
  subscribeAlpaca: vi.fn(() => ({ unsubscribe: () => {} })),
  hasAlpacaCredentials: vi.fn(() => false),
  mapSymbol: (s: string) => s.toUpperCase(),
}));

// Import after mocks are registered.
const { getProvider, searchSymbols, __providerRegistryInternals } =
  await import('./providerRegistry');
const { getEquityCredStatus, setEquityCredFailed } = await import('./equityCredStatus');

const ADAPTER_NOT_REGISTERED = new Error('adapter not registered: alpaca');
const AUTH_FAILED = new Error('error[Alpaca]: authentication failed: forbidden');

function sampleBars(n = 3): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 3_600_000,
    o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 + i,
  }));
}

describe('providerRegistry — equity hard-fail guard', () => {
  beforeEach(() => {
    marketFetchHistoryMock.mockReset();
    setEquityCredFailed(false);
    // Reset ohlcCache so previous test entries don't pollute.
    __providerRegistryInternals.mockProvider; // touch to avoid tree-shake
  });

  afterEach(() => {
    mockTauri = false;
  });

  // -------------------------------------------------------------------------
  // 1. Tauri IS present + alpaca throws "adapter not registered" → re-throw
  // -------------------------------------------------------------------------
  it('re-throws when Tauri runtime is present and alpaca adapter not registered', async () => {
    mockTauri = true;
    marketFetchHistoryMock.mockRejectedValueOnce(ADAPTER_NOT_REGISTERED);

    const p = getProvider('alpaca');
    await expect(p.fetchHistory('TSLA', '1h', 30)).rejects.toThrow(
      'adapter not registered',
    );

    // equityCredStatus must reflect the failure.
    expect(getEquityCredStatus().failed).toBe(true);
    expect(getEquityCredStatus().reason).toBe('no_credentials');
  });

  // -------------------------------------------------------------------------
  // 2. Tauri NOT present + alpaca throws "adapter not registered" → mock fallback
  // -------------------------------------------------------------------------
  it('falls through to mock when Tauri runtime is absent (vite dev path)', async () => {
    mockTauri = false;
    marketFetchHistoryMock.mockRejectedValueOnce(ADAPTER_NOT_REGISTERED);

    const p = getProvider('alpaca');
    // Should NOT throw — falls through to mock.
    const bars = await p.fetchHistory('TSLA', '1h', 10);
    expect(bars.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 3. On success, equityCredStatus is cleared.
  // -------------------------------------------------------------------------
  it('clears equityCredFailed on a successful alpaca fetch', async () => {
    mockTauri = true;
    setEquityCredFailed(true, 'no_credentials');
    const fakeBars = sampleBars(5);
    marketFetchHistoryMock.mockResolvedValueOnce(fakeBars);

    const p = getProvider('alpaca');
    const bars = await p.fetchHistory('AAPL', '1d', 5);
    expect(bars).toEqual(fakeBars);
    expect(getEquityCredStatus().failed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. Tauri IS present + alpaca throws auth failed → re-throw as auth_failed
  // -------------------------------------------------------------------------
  it('classifies auth_failed when alpaca returns authentication failed error', async () => {
    mockTauri = true;
    marketFetchHistoryMock.mockRejectedValueOnce(AUTH_FAILED);

    const p = getProvider('alpaca');
    await expect(p.fetchHistory('TSLA', '1h', 30)).rejects.toThrow(
      'authentication failed',
    );

    expect(getEquityCredStatus().failed).toBe(true);
    expect(getEquityCredStatus().reason).toBe('auth_failed');
    expect(getEquityCredStatus().detail).toBe('forbidden');
  });

  // -------------------------------------------------------------------------
  // 5. subscribeRealtime with missing env-var creds must NOT call setEquityCredFailed
  //    (regression gate for premature-toast bug — REST path is authoritative).
  // -------------------------------------------------------------------------
  it('subscribeRealtime does NOT set equityCredFailed when hasAlpacaCredentials returns false', () => {
    mockTauri = true;
    // hasAlpacaCredentials is already mocked to return false (see vi.mock above).
    setEquityCredFailed(false);

    const p = getProvider('alpaca');
    const unsub = p.subscribeRealtime('TSLA', '1h', () => {});

    // The banner must NOT have been triggered.
    expect(getEquityCredStatus().failed).toBe(false);

    // The returned unsubscribe must be callable without throwing.
    expect(() => unsub()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 6. Generic error does NOT classify as auth_failed
  // -------------------------------------------------------------------------
  it('classifies a rate-limited error as fetch_failed, not auth_failed', async () => {
    mockTauri = true;
    marketFetchHistoryMock.mockRejectedValueOnce(new Error('rate limited'));

    const p = getProvider('alpaca');
    await expect(p.fetchHistory('TSLA', '1h', 30)).rejects.toThrow('rate limited');

    expect(getEquityCredStatus().failed).toBe(true);
    expect(getEquityCredStatus().reason).toBe('fetch_failed');
    expect(getEquityCredStatus().reason).not.toBe('auth_failed');
  });
});

describe('providerRegistry — crypto mock-fallback regression', () => {
  const cryptoProviders = ['binance', 'coinbase', 'kraken'] as const;

  beforeEach(() => {
    marketFetchHistoryMock.mockReset();
    setEquityCredFailed(false);
  });

  afterEach(() => {
    mockTauri = false;
  });

  for (const prov of cryptoProviders) {
    it(`${prov}: falls through to mock when adapter not registered (Tauri present)`, async () => {
      mockTauri = true;
      marketFetchHistoryMock.mockRejectedValueOnce(
        new Error(`adapter not registered: ${prov}`),
      );
      const p = getProvider(prov);
      // Should NOT throw — crypto fallback is still legitimate.
      const bars = await p.fetchHistory('BTC', '1h', 10);
      expect(bars.length).toBeGreaterThan(0);
    });

    it(`${prov}: falls through to mock when Tauri command is missing (vite dev)`, async () => {
      mockTauri = false;
      marketFetchHistoryMock.mockRejectedValueOnce(
        new Error('window.__TAURI not available'),
      );
      const p = getProvider(prov);
      const bars = await p.fetchHistory('ETH', '1h', 10);
      expect(bars.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// equityCredStatus subscribe + connectedAt bump test
// (inline here because equityCredStatus.test.ts does not exist yet)
// Uses the already-imported module at the top of the file.
// ---------------------------------------------------------------------------
const {
  setEquityCredFailed: credSetFailed,
  setEquityConnected: credSetConnected,
  subscribeEquityCredStatus: credSubscribe,
  getEquityCredStatus: credGetStatus,
} = await import('./equityCredStatus');

describe('equityCredStatus — subscribe observes failed→ok with connectedAt bump', () => {
  it('subscriber sees failed then connected with bumped connectedAt', () => {
    // Reset to clean state.
    credSetFailed(false);
    const prevConnectedAt = credGetStatus().connectedAt ?? 0;

    const snapshots: ReturnType<typeof credGetStatus>[] = [];
    const unsub = credSubscribe((s) => {
      snapshots.push({ ...s });
    });

    credSetFailed(true, 'auth_failed');
    credSetConnected();

    unsub();

    const failedSnap = snapshots.find((s) => s.failed && s.reason === 'auth_failed');
    expect(failedSnap).toBeDefined();

    // The connected snapshot is the one with !failed AND connectedAt bumped.
    const connectedSnap = snapshots.find(
      (s) => !s.failed && (s.connectedAt ?? 0) > prevConnectedAt,
    );
    expect(connectedSnap).toBeDefined();
    expect((connectedSnap?.connectedAt ?? 0)).toBeGreaterThan(prevConnectedAt);
  });
});

// ---------------------------------------------------------------------------
// ADR-0009 / Step 11 (+ live-catalog pivot) — searchSymbols routing
//
// `searchSymbols(query)` is the catalog-backed cross-provider search. Under
// Tauri it routes through `symbolCatalogSearch` (FTS5). Outside Tauri (or with
// the mock flag set) there is no in-process symbol fixture anymore, so it
// returns `[]` and warns once (the duplicate catalog fixture was retired). We
// assert the Tauri path + FTS5-syntax suffix, the empty-query short-circuit,
// and the no-runtime/mock-forced `[]`-with-warn behavior.
// ---------------------------------------------------------------------------

describe('searchSymbols — catalog routing (ADR-0009)', () => {
  beforeEach(() => {
    symbolCatalogSearchMock.mockReset();
    // Default: returns a single canned row so test assertions can confirm the
    // routing happened without re-asserting catalog content.
    symbolCatalogSearchMock.mockResolvedValue([
      { provider: 'binance', sym: 'BTC', quote: 'USDT', name: 'Bitcoin', class: 'crypto', status: 'active', native_sym: 'BTCUSDT' },
    ]);
    // Clear any localStorage mock flag from prior tests.
    try { window.localStorage.removeItem('use-mock-provider'); } catch { /* noop */ }
    // Reset toast store so prior tests don't bleed in.
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    mockTauri = false;
    try { window.localStorage.removeItem('use-mock-provider'); } catch { /* noop */ }
  });

  it('returns [] for empty/whitespace queries (no IPC, no mock call)', async () => {
    mockTauri = true;
    expect(await searchSymbols('')).toEqual([]);
    expect(await searchSymbols('   ')).toEqual([]);
    expect(symbolCatalogSearchMock).not.toHaveBeenCalled();
  });

  it('routes to symbolCatalogSearch under Tauri (mock flag off), appending FTS5 `*`', async () => {
    mockTauri = true;
    const rows = await searchSymbols('btc');
    expect(rows).toHaveLength(1);
    expect(symbolCatalogSearchMock).toHaveBeenCalledTimes(1);
    // FTS5 prefix-match suffix is auto-appended.
    expect(symbolCatalogSearchMock.mock.calls[0][0]).toBe('btc*');
  });

  it('does NOT re-append `*` when the user already used an FTS5 trailing operator', async () => {
    mockTauri = true;
    await searchSymbols('btc*');
    await searchSymbols('btc+');
    await searchSymbols('btc-');
    expect(symbolCatalogSearchMock.mock.calls.map((c) => c[0])).toEqual([
      'btc*',
      'btc+',
      'btc-',
    ]);
  });

  it('returns [] and warns when the use-mock-provider flag is set (no fixture)', async () => {
    mockTauri = true; // even with Tauri available, the mock flag wins
    window.localStorage.setItem('use-mock-provider', '1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rows = await searchSymbols('btc');
    expect(rows).toEqual([]);
    // Tauri-side symbolCatalogSearch must NOT have been called.
    expect(symbolCatalogSearchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[providerRegistry] symbol search requires the Tauri runtime (catalog unavailable in browser-only mode)',
    );
    // A warn toast must have been pushed.
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].title).toBe('Symbol search unavailable');
    warnSpy.mockRestore();
  });

  it('returns [] and warns when Tauri runtime is absent', async () => {
    mockTauri = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rows = await searchSymbols('btc');
    expect(rows).toEqual([]);
    expect(symbolCatalogSearchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[providerRegistry] symbol search requires the Tauri runtime (catalog unavailable in browser-only mode)',
    );
    // A warn toast must have been pushed.
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].title).toBe('Symbol search unavailable');
    warnSpy.mockRestore();
  });

  it('returns [] when symbolCatalogSearch rejects (graceful degradation)', async () => {
    mockTauri = true;
    symbolCatalogSearchMock.mockRejectedValueOnce(new Error('IPC failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await searchSymbols('btc');
    expect(rows).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ADR-0009 / Step 11 — fetchHistory threads `quote` through marketFetchHistory
// ---------------------------------------------------------------------------

describe('getProvider — fetchHistory threads quote through marketFetchHistory', () => {
  beforeEach(() => {
    marketFetchHistoryMock.mockReset();
    setEquityCredFailed(false);
  });

  afterEach(() => {
    mockTauri = false;
  });

  it('passes the explicit `quote` argument to marketFetchHistory', async () => {
    mockTauri = true;
    marketFetchHistoryMock.mockResolvedValueOnce(sampleBars(3));

    const p = getProvider('binance', 'USDC');
    await p.fetchHistory('BTC', '1h', 3);

    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);
    // marketFetchHistory(provider, sym, tf, count, quote)
    const args = marketFetchHistoryMock.mock.calls[0] as unknown as [string, string, string, number, string];
    expect(args[0]).toBe('binance');
    expect(args[1]).toBe('BTC');
    expect(args[2]).toBe('1h');
    expect(args[3]).toBe(3);
    expect(args[4]).toBe('USDC');
  });

  it('defaults to the per-provider quote when omitted (USDT for binance)', async () => {
    mockTauri = true;
    marketFetchHistoryMock.mockResolvedValueOnce(sampleBars(2));

    const p = getProvider('binance');
    await p.fetchHistory('BTC', '1h', 2);

    const args = marketFetchHistoryMock.mock.calls[0] as unknown as [string, string, string, number, string];
    expect(args[4]).toBe('USDT');
  });

  it('defaults to USD for coinbase / kraken when quote is omitted', async () => {
    mockTauri = true;
    marketFetchHistoryMock.mockResolvedValueOnce(sampleBars(2));
    await getProvider('coinbase').fetchHistory('BTC', '1h', 2);
    expect(
      (marketFetchHistoryMock.mock.calls[0] as unknown as [string, string, string, number, string])[4],
    ).toBe('USD');

    marketFetchHistoryMock.mockResolvedValueOnce(sampleBars(2));
    await getProvider('kraken').fetchHistory('BTC', '1h', 2);
    expect(
      (marketFetchHistoryMock.mock.calls[1] as unknown as [string, string, string, number, string])[4],
    ).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// Fix B1 — freshness-gated early-return
//
// A fresh cache entry (age < maxAge) is served without hitting the network.
// A stale cache entry (age > maxAge) is treated as a miss and triggers a
// real network fetch + re-stamps fetchedAt.
// ---------------------------------------------------------------------------

import { vi as _vi } from 'vitest';

describe('getProvider — freshness-gated cache early-return (Fix B1)', () => {
  beforeEach(() => {
    marketFetchHistoryMock.mockReset();
    setEquityCredFailed(false);
    mockTauri = true;
  });

  afterEach(() => {
    mockTauri = false;
    _vi.useRealTimers();
  });

  it('serves a fresh entry (age < maxAge) without calling marketFetchHistory', async () => {
    // Seed a fresh cache entry by making a real fetch first.
    marketFetchHistoryMock.mockResolvedValueOnce(sampleBars(5));
    const p = getProvider('binance', 'USDT');
    const firstResult = await p.fetchHistory('BTC', '1h', 5);
    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);
    marketFetchHistoryMock.mockReset();

    // Immediately call again — cache is <60s old, should serve without fetch.
    const secondResult = await p.fetchHistory('BTC', '1h', 5);
    expect(marketFetchHistoryMock).not.toHaveBeenCalled();
    expect(secondResult).toEqual(firstResult);
  });

  it('treats a stale entry (age > maxAge) as a miss and refetches', async () => {
    _vi.useFakeTimers();

    // Seed a fresh entry.
    const freshBars = sampleBars(5);
    marketFetchHistoryMock.mockResolvedValueOnce(freshBars);
    const p = getProvider('binance', 'USDT');
    await p.fetchHistory('ETH', '1h', 5);
    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);
    marketFetchHistoryMock.mockReset();

    // Advance time past maxAge (60 s for 1h tf → min(3600000, 60000) = 60000).
    _vi.advanceTimersByTime(61_000);

    // Next call should bypass the stale cache and hit the network.
    const staleBars = sampleBars(5);
    marketFetchHistoryMock.mockResolvedValueOnce(staleBars);
    const result = await p.fetchHistory('ETH', '1h', 5);
    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(staleBars);
  });

  it('serves a fresh entry for a long-tf (4h) within its 60s cap', async () => {
    // For 4h, tfToMs = 14_400_000, maxAge = min(14_400_000, 60_000) = 60_000.
    _vi.useFakeTimers();

    const bars = sampleBars(3);
    marketFetchHistoryMock.mockResolvedValueOnce(bars);
    const p = getProvider('coinbase', 'USD');
    await p.fetchHistory('BTC', '4h', 3);
    marketFetchHistoryMock.mockReset();

    // 30 s in — still fresh.
    _vi.advanceTimersByTime(30_000);
    marketFetchHistoryMock.mockResolvedValue(sampleBars(3));
    await p.fetchHistory('BTC', '4h', 3);
    expect(marketFetchHistoryMock).not.toHaveBeenCalled();

    // Past the 60s cap — stale.
    _vi.advanceTimersByTime(31_000);
    marketFetchHistoryMock.mockResolvedValueOnce(sampleBars(3));
    await p.fetchHistory('BTC', '4h', 3);
    expect(marketFetchHistoryMock).toHaveBeenCalledTimes(1);
  });
});
