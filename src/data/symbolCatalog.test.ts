/**
 * src/data/symbolCatalog.test.ts — Unit tests for `ensureFreshCatalog`.
 *
 * Fake-timer / Promise-dedupe interaction notes
 * ---------------------------------------------
 * `vi.useFakeTimers()` replaces `Date.now()` (used internally for TTL
 * comparisons) but does NOT intercept microtask scheduling. All `await`
 * expressions still resolve on the real microtask queue, so the standard
 * pattern is:
 *
 *   1. Set system time via `vi.setSystemTime(epoch)`.
 *   2. Call `ensureFreshCatalog(...)` — DO NOT await yet.
 *   3. Await the promise — microtasks flush normally.
 *
 * For the concurrent in-flight test we hold two un-awaited Promises, then
 * await them together. Because the underlying mock resolves synchronously
 * via `mockResolvedValue`, awaiting either of them flushes all pending
 * microtasks that were already queued, so both resolve before the
 * `symbolCatalogFetch` call-count assertion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CatalogFetchResult, SymbolsMeta } from '../lib/db';

// ---------------------------------------------------------------------------
// Mocks — must be registered before the module under test is imported.
// ---------------------------------------------------------------------------

const mockSymbolCatalogFetch = vi.fn<(provider: string) => Promise<CatalogFetchResult>>();
const mockSymbolCatalogMeta = vi.fn<() => Promise<SymbolsMeta[]>>();

vi.mock('../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/db')>();
  return {
    ...orig,
    symbolCatalogFetch: (...args: unknown[]) =>
      mockSymbolCatalogFetch(...(args as [string])),
    symbolCatalogMeta: () => mockSymbolCatalogMeta(),
  };
});

let mockCredFailed = false;

vi.mock('./equityCredStatus', () => ({
  isEquityCredFailed: () => mockCredFailed,
}));

// Import the module under test AFTER mocks are registered.
const { ensureFreshCatalog, __resetInFlightForTest, CATALOG_TTL_MS } =
  await import('./symbolCatalog');
const { useToastStore } = await import('../stores/useToastStore');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed epoch for determinism

function makeMeta(
  provider: string,
  fetchedAtOffset: number,
  rowCount = 42,
): SymbolsMeta {
  return {
    provider,
    fetched_at: NOW + fetchedAtOffset,
    row_count: rowCount,
  };
}

function makeFetchResult(provider: string, rowCount = 100): CatalogFetchResult {
  return {
    provider,
    fetched_at: NOW,
    row_count: rowCount,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockCredFailed = false;
  mockSymbolCatalogFetch.mockReset();
  mockSymbolCatalogMeta.mockReset();
  __resetInFlightForTest();
});

afterEach(() => {
  __resetInFlightForTest();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test 1 — First call fetches when cache is empty
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — first call fetches when cache is empty', () => {
  it('calls symbolCatalogFetch exactly once when meta returns empty array', async () => {
    mockSymbolCatalogMeta.mockResolvedValue([]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('binance'));

    const result = await ensureFreshCatalog('binance');

    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
    expect(mockSymbolCatalogFetch).toHaveBeenCalledWith('binance');
    expect(result.provider).toBe('binance');
    expect(result.row_count).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — TTL gating
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — TTL gating', () => {
  it('skips fetch when meta is fresh, then fetches after TTL expires', async () => {
    // Fresh meta: fetched 1 second ago.
    mockSymbolCatalogMeta.mockResolvedValue([
      makeMeta('binance', -1_000),
    ]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('binance'));

    // First call — catalog is fresh, no fetch.
    await ensureFreshCatalog('binance');
    expect(mockSymbolCatalogFetch).not.toHaveBeenCalled();

    // Advance clock by 25 hours (past the 24h TTL).
    vi.setSystemTime(NOW + 25 * 60 * 60 * 1000);
    // The meta mock will still return the old fetched_at — it's now stale.

    // Second call — catalog is now stale, fetch should fire.
    await ensureFreshCatalog('binance');
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
    expect(mockSymbolCatalogFetch).toHaveBeenCalledWith('binance');
  });

  it('does not fetch when catalog was fetched exactly at TTL boundary minus 1ms', async () => {
    mockSymbolCatalogMeta.mockResolvedValue([
      makeMeta('binance', -(CATALOG_TTL_MS - 1)),
    ]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('binance'));

    await ensureFreshCatalog('binance');
    expect(mockSymbolCatalogFetch).not.toHaveBeenCalled();
  });

  it('fetches when catalog is exactly at TTL (not stale yet boundary)', async () => {
    // fetched_at === NOW - CATALOG_TTL_MS → age === TTL_MS → NOT fresh (age < TTL required)
    mockSymbolCatalogMeta.mockResolvedValue([
      makeMeta('binance', -CATALOG_TTL_MS),
    ]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('binance'));

    await ensureFreshCatalog('binance');
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — force: true bypasses TTL
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — force: true bypasses TTL', () => {
  it('fetches even when meta is fresh when force: true is passed', async () => {
    // Perfectly fresh catalog — fetched 1 second ago.
    mockSymbolCatalogMeta.mockResolvedValue([
      makeMeta('coinbase', -1_000),
    ]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('coinbase'));

    const result = await ensureFreshCatalog('coinbase', { force: true });

    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
    expect(mockSymbolCatalogFetch).toHaveBeenCalledWith('coinbase');
    expect(result.provider).toBe('coinbase');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — In-flight dedupe
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — in-flight dedupe', () => {
  it('concurrent calls share one in-flight fetch; third call within TTL skips', async () => {
    // Cache is empty → both concurrent calls would normally trigger a fetch.
    mockSymbolCatalogMeta.mockResolvedValue([]);

    // Use a manually-controlled promise so both concurrent calls queue up
    // against the same in-flight entry.
    let resolveFirst!: (v: CatalogFetchResult) => void;
    const firstFetchResult = makeFetchResult('binance', 55);
    const controlledFetch = new Promise<CatalogFetchResult>((res) => {
      resolveFirst = res;
    });
    mockSymbolCatalogFetch.mockReturnValueOnce(controlledFetch);

    // Launch two concurrent calls — neither awaited yet.
    const p1 = ensureFreshCatalog('binance');
    const p2 = ensureFreshCatalog('binance');

    // Resolve the underlying fetch.
    resolveFirst(firstFetchResult);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Only ONE actual fetch should have been made.
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
    expect(r1.row_count).toBe(55);
    expect(r2.row_count).toBe(55);

    // Third call within the TTL window: meta now shows a fresh row.
    // After the fetch completed, the next call reads meta from the mock.
    // We update the mock to reflect the freshly-fetched catalog.
    mockSymbolCatalogMeta.mockResolvedValue([
      makeMeta('binance', 0, 55), // fetched_at === NOW → fresh
    ]);

    await ensureFreshCatalog('binance');
    // Still only 1 total fetch.
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Alpaca guard
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — alpaca guard', () => {
  it('returns synthetic zero-row meta and never calls fetch when isEquityCredFailed is true', async () => {
    mockCredFailed = true;
    mockSymbolCatalogMeta.mockResolvedValue([]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('alpaca'));

    const result = await ensureFreshCatalog('alpaca');

    expect(mockSymbolCatalogFetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('alpaca');
    expect(result.row_count).toBe(0);
    expect(result.fetched_at).toBe(0);
  });

  it('does not guard non-alpaca providers even when isEquityCredFailed is true', async () => {
    mockCredFailed = true;
    mockSymbolCatalogMeta.mockResolvedValue([]);
    mockSymbolCatalogFetch.mockResolvedValue(makeFetchResult('binance'));

    await ensureFreshCatalog('binance');
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Error path
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — error path', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('emits warning, pushes a toast, and re-throws when symbolCatalogFetch rejects', async () => {
    mockSymbolCatalogMeta.mockResolvedValue([]);
    const boom = new Error('network timeout');
    mockSymbolCatalogFetch.mockRejectedValue(boom);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureFreshCatalog('kraken')).rejects.toThrow('network timeout');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnCall = warnSpy.mock.calls[0];
    expect(warnCall[0]).toBe('[symbolCatalog] catalog refresh failed for kraken:');
    expect(warnCall[1]).toBe(boom);

    // A warn toast must have been pushed.
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].title).toBe('Symbol search unavailable');

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Concurrent force-refresh during in-flight
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — concurrent force-refresh during in-flight', () => {
  it('force: true during an in-flight call triggers a second independent fetch', async () => {
    mockSymbolCatalogMeta.mockResolvedValue([]);

    // First fetch: controlled so it stays pending while the second call fires.
    let resolveFirst!: (v: CatalogFetchResult) => void;
    const firstResult = makeFetchResult('kraken', 200);
    const firstFetch = new Promise<CatalogFetchResult>((res) => {
      resolveFirst = res;
    });

    let resolveSecond!: (v: CatalogFetchResult) => void;
    const secondResult = makeFetchResult('kraken', 201);
    const secondFetch = new Promise<CatalogFetchResult>((res) => {
      resolveSecond = res;
    });

    mockSymbolCatalogFetch
      .mockReturnValueOnce(firstFetch)
      .mockReturnValueOnce(secondFetch);

    // Start both calls without awaiting. Because ensureFreshCatalog is async
    // and must await symbolCatalogMeta() first, we must flush the microtask
    // queue (via a resolved Promise tick) before the mock fetch calls are
    // actually dispatched. We use Promise.resolve() ticks to advance past the
    // meta-await before asserting on fetch call counts.
    const p1 = ensureFreshCatalog('kraken');
    const p2 = ensureFreshCatalog('kraken', { force: true });

    // Flush the pending meta-await microtasks so both ensureFreshCatalog
    // calls reach their symbolCatalogFetch() dispatch point.
    await Promise.resolve();
    await Promise.resolve();

    // Both fetches should have been initiated now.
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(2);

    // Resolve both controlled fetches.
    resolveFirst(firstResult);
    resolveSecond(secondResult);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.row_count).toBe(200);
    expect(r2.row_count).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — __resetInFlightForTest clears state
// ---------------------------------------------------------------------------
describe('ensureFreshCatalog — __resetInFlightForTest', () => {
  it('clears in-flight map so subsequent calls start fresh', async () => {
    mockSymbolCatalogMeta.mockResolvedValue([]);

    // Hold an in-flight promise without resolving it.
    let resolveHanging!: (v: CatalogFetchResult) => void;
    const hangingFetch = new Promise<CatalogFetchResult>((res) => {
      resolveHanging = res;
    });
    mockSymbolCatalogFetch
      .mockReturnValueOnce(hangingFetch)
      .mockResolvedValue(makeFetchResult('binance', 77));

    // Start an in-flight request (don't await).
    void ensureFreshCatalog('binance');

    // Flush the meta-await so the first call reaches symbolCatalogFetch().
    await Promise.resolve();
    await Promise.resolve();

    // Confirm it's in-flight: a second un-forced call should share the same
    // promise (fetch count still 1).
    void ensureFreshCatalog('binance');
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(1);

    // Reset — clears the in-flight map.
    __resetInFlightForTest();
    // Resolve the hanging fetch so the dangling promise doesn't bleed.
    resolveHanging(makeFetchResult('binance', 0));

    // After reset a new cache-miss call must spawn a fresh fetch.
    const result = await ensureFreshCatalog('binance');
    // Total calls: 1 (original in-flight) + 1 (after reset) = 2.
    expect(mockSymbolCatalogFetch).toHaveBeenCalledTimes(2);
    expect(result.row_count).toBe(77);
  });
});
