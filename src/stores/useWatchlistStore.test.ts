/**
 * src/stores/useWatchlistStore.test.ts — ADR-0009 multi-quote watchlist tests.
 *
 * Covers the canonical-identity widening from `(sym, provider)` to
 * `(sym, provider, quote)` for the v2 store:
 *   - Adding BTC/USDT then BTC/USDC produces two distinct entries (multi-quote
 *     isolation — same provider+symbol, different quote).
 *   - Removing one quote leaves the other untouched.
 *   - Adds without an explicit `quote` default to `defaultQuoteForProvider`.
 *   - Wire args to `dbWatchlistV2Add` / `dbWatchlistV2Remove` match the
 *     canonical tuple.
 *
 * Strategy: vi.mock '../lib/db' so the v2 invoke wrappers become spies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbWatchlistV2AddMock = vi.fn<(sym: string, provider: string, quote: string) => Promise<void>>();
const dbWatchlistV2RemoveMock = vi.fn<(sym: string, provider: string, quote: string) => Promise<void>>();

vi.mock('../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/db')>();
  return {
    ...orig,
    dbWatchlistV2Add: (sym: string, provider: string, quote: string) =>
      dbWatchlistV2AddMock(sym, provider, quote),
    dbWatchlistV2Remove: (sym: string, provider: string, quote: string) =>
      dbWatchlistV2RemoveMock(sym, provider, quote),
  };
});

// Import after the mock is registered.
const { useWatchlistStore, defaultQuoteForProvider } = await import('./useWatchlistStore');

function resetStore() {
  useWatchlistStore.setState({ assets: [] });
}

beforeEach(() => {
  resetStore();
  dbWatchlistV2AddMock.mockReset();
  dbWatchlistV2AddMock.mockResolvedValue(undefined);
  dbWatchlistV2RemoveMock.mockReset();
  dbWatchlistV2RemoveMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Multi-quote isolation
// ---------------------------------------------------------------------------

describe('useWatchlistStore — multi-quote isolation (ADR-0009)', () => {
  it('addAsset BTC/USDT then BTC/USDC persists as two distinct entries', async () => {
    const store = useWatchlistStore.getState();
    await store.addAsset('BTC', 'binance', 'USDT');
    await store.addAsset('BTC', 'binance', 'USDC');

    const assets = useWatchlistStore.getState().assets;
    expect(assets).toHaveLength(2);
    expect(assets).toContainEqual({ sym: 'BTC', provider: 'binance', quote: 'USDT' });
    expect(assets).toContainEqual({ sym: 'BTC', provider: 'binance', quote: 'USDC' });

    // Wire args reach the v2 IPC layer with the right quote each time.
    expect(dbWatchlistV2AddMock).toHaveBeenNthCalledWith(1, 'BTC', 'binance', 'USDT');
    expect(dbWatchlistV2AddMock).toHaveBeenNthCalledWith(2, 'BTC', 'binance', 'USDC');
  });

  it('removeAsset BTC/USDT leaves BTC/USDC intact', async () => {
    const store = useWatchlistStore.getState();
    await store.addAsset('BTC', 'binance', 'USDT');
    await store.addAsset('BTC', 'binance', 'USDC');
    await store.removeAsset('BTC', 'binance', 'USDT');

    const assets = useWatchlistStore.getState().assets;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual({ sym: 'BTC', provider: 'binance', quote: 'USDC' });

    expect(dbWatchlistV2RemoveMock).toHaveBeenCalledTimes(1);
    expect(dbWatchlistV2RemoveMock).toHaveBeenCalledWith('BTC', 'binance', 'USDT');
  });

  it('duplicate addAsset for the same (sym, provider, quote) is a no-op', async () => {
    const store = useWatchlistStore.getState();
    await store.addAsset('BTC', 'binance', 'USDT');
    await store.addAsset('BTC', 'binance', 'USDT');

    const assets = useWatchlistStore.getState().assets;
    expect(assets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Default-quote behaviour
// ---------------------------------------------------------------------------

describe('useWatchlistStore — default quote behaviour', () => {
  it('defaultQuoteForProvider matches the migration backfill rule', () => {
    expect(defaultQuoteForProvider('binance')).toBe('USDT');
    expect(defaultQuoteForProvider('coinbase')).toBe('USD');
    expect(defaultQuoteForProvider('kraken')).toBe('USD');
    expect(defaultQuoteForProvider('alpaca')).toBe('USD');
    // Unknown provider safely falls back to USD.
    expect(defaultQuoteForProvider('bitstamp')).toBe('USD');
  });

  it('addAsset without an explicit quote uses defaultQuoteForProvider', async () => {
    const store = useWatchlistStore.getState();
    await store.addAsset('BTC', 'binance');
    await store.addAsset('BTC', 'coinbase');

    const assets = useWatchlistStore.getState().assets;
    expect(assets).toContainEqual({ sym: 'BTC', provider: 'binance', quote: 'USDT' });
    expect(assets).toContainEqual({ sym: 'BTC', provider: 'coinbase', quote: 'USD' });

    // Wire args still go through with the resolved quote (not undefined).
    expect(dbWatchlistV2AddMock).toHaveBeenCalledWith('BTC', 'binance', 'USDT');
    expect(dbWatchlistV2AddMock).toHaveBeenCalledWith('BTC', 'coinbase', 'USD');
  });

  it('removeAsset without an explicit quote uses defaultQuoteForProvider', async () => {
    const store = useWatchlistStore.getState();
    await store.addAsset('BTC', 'binance', 'USDT');
    await store.removeAsset('BTC', 'binance');

    expect(useWatchlistStore.getState().assets).toHaveLength(0);
    expect(dbWatchlistV2RemoveMock).toHaveBeenCalledWith('BTC', 'binance', 'USDT');
  });
});

// ---------------------------------------------------------------------------
// setWatchlist (bulk hydrate)
// ---------------------------------------------------------------------------

describe('useWatchlistStore — setWatchlist', () => {
  it('maps WatchlistEntryV2 rows to AssetMeta, dropping added_at', () => {
    useWatchlistStore.getState().setWatchlist([
      { sym: 'BTC', provider: 'binance', quote: 'USDT', added_at: 1 },
      { sym: 'ETH', provider: 'coinbase', quote: 'USD', added_at: 2 },
    ]);

    const assets = useWatchlistStore.getState().assets;
    expect(assets).toEqual([
      { sym: 'BTC', provider: 'binance', quote: 'USDT' },
      { sym: 'ETH', provider: 'coinbase', quote: 'USD' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// IPC failure swallow
// ---------------------------------------------------------------------------

describe('useWatchlistStore — IPC failure swallow (outside Tauri)', () => {
  it('addAsset still updates in-memory state when dbWatchlistV2Add rejects', async () => {
    dbWatchlistV2AddMock.mockRejectedValueOnce(new Error('no Tauri'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useWatchlistStore.getState().addAsset('BTC', 'binance', 'USDT');

    expect(useWatchlistStore.getState().assets).toEqual([
      { sym: 'BTC', provider: 'binance', quote: 'USDT' },
    ]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
