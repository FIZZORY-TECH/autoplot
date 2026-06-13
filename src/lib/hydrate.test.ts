/**
 * src/lib/hydrate.test.ts — Unit tests for hydrateAppState() (P3.1) + ADR-0009.
 *
 * Strategy: vi.mock('@tauri-apps/api/core') so `invoke` returns canned values.
 * We then call hydrateAppState() / mountAppStateSync() and assert that
 * useAppStore and useWatchlistStore are populated correctly.
 *
 * Step 11 (ADR-0009) — the hydration path now reads from `watchlist_v2` and
 * understands the new `activeAsset` JSON blob in addition to the legacy
 * `activeSym` migration shim. These tests exercise both code paths.
 *
 * Edge cases:
 *   - Empty watchlist
 *   - Missing app_state keys (never set)
 *   - Malformed viewport JSON (should fall back to undefined, not crash)
 *   - Malformed activeAsset JSON
 *   - activeAsset preferred over legacy activeSym
 *   - Legacy activeSym shim derives provider/quote from watchlist_v2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hydrateAppState, mountAppStateSync } from './hydrate';
import { useAppStore } from '../stores/useAppStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';

// ---------------------------------------------------------------------------
// Mock Tauri invoke
// ---------------------------------------------------------------------------

// We mock at the module level so all imports of '@tauri-apps/api/core'
// get the fake implementation. The actual per-test data is set via
// mockInvokeImpl below.
let mockInvokeImpl: (cmd: string, args?: unknown) => unknown = () =>
  Promise.resolve(null);
/** Records every `db_app_state_set` write so mountAppStateSync tests can
 *  inspect the persisted key/value pairs. */
const appStateSets: Array<{ key: string; value: string }> = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => {
    if (cmd === 'db_app_state_set' && args && typeof args === 'object') {
      const { key, value } = args as { key: string; value: string };
      appStateSets.push({ key, value });
      return Promise.resolve(undefined);
    }
    return Promise.resolve(mockInvokeImpl(cmd, args));
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset both Zustand stores to their initial state before each test. */
function resetStores() {
  useAppStore.setState({
    activeSym: undefined,
    activeAsset: undefined,
    chartType: 'candles',
    tf: '1h',
    hydrated: false,
    viewport: undefined,
  });
  useWatchlistStore.setState({ assets: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hydrateAppState', () => {
  beforeEach(() => {
    resetStores();
    appStateSets.length = 0;
    vi.clearAllMocks();
  });

  it('populates watchlist from db_watchlist_v2_list', async () => {
    // ADR-0009 — hydrate now reads from watchlist_v2 (v2 rows include quote).
    const fakeEntries = [
      { sym: 'BTC', provider: 'coinbase', quote: 'USD', added_at: 1_000 },
      { sym: 'ETH', provider: 'binance', quote: 'USDT', added_at: 2_000 },
    ];
    mockInvokeImpl = (cmd) => {
      if (cmd === 'db_watchlist_v2_list') return fakeEntries;
      return null; // all app_state keys return null
    };

    await hydrateAppState();

    const assets = useWatchlistStore.getState().assets;
    expect(assets).toHaveLength(2);
    expect(assets[0]).toEqual({ sym: 'BTC', provider: 'coinbase', quote: 'USD' });
    expect(assets[1]).toEqual({ sym: 'ETH', provider: 'binance', quote: 'USDT' });
  });

  it('populates activeSym from app_state', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'activeSym') return 'ETH';
      }
      return null;
    };

    await hydrateAppState();

    expect(useAppStore.getState().activeSym).toBe('ETH');
  });

  it('populates chartType and tf from app_state', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'chartType') return 'area';
        if (key === 'tf') return '4h';
      }
      return null;
    };

    await hydrateAppState();

    const s = useAppStore.getState();
    expect(s.chartType).toBe('area');
    expect(s.tf).toBe('4h');
  });

  it('populates viewport from JSON in app_state', async () => {
    const vp = { start: 100, end: 300 };
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'viewport') return JSON.stringify(vp);
      }
      return null;
    };

    await hydrateAppState();

    expect(useAppStore.getState().viewport).toEqual(vp);
  });

  it('sets hydrated = true after completion', async () => {
    mockInvokeImpl = (cmd) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      return null;
    };

    await hydrateAppState();

    expect(useAppStore.getState().hydrated).toBe(true);
  });

  // ---- Edge cases ----------------------------------------------------------

  it('handles empty watchlist gracefully', async () => {
    mockInvokeImpl = (cmd) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      return null;
    };

    await hydrateAppState();

    expect(useWatchlistStore.getState().assets).toHaveLength(0);
    expect(useAppStore.getState().hydrated).toBe(true);
  });

  it('keeps default chartType when key is absent (null)', async () => {
    mockInvokeImpl = (cmd) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      return null; // all keys absent
    };

    await hydrateAppState();

    expect(useAppStore.getState().chartType).toBe('candles');
  });

  it('keeps default tf when returned value is invalid', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'tf') return 'INVALID_TF';
      }
      return null;
    };

    await hydrateAppState();

    // Invalid tf must be rejected; store keeps its default '1h'.
    expect(useAppStore.getState().tf).toBe('1h');
  });

  it('keeps viewport = undefined when JSON is malformed', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'viewport') return '{ NOT VALID JSON %%%';
      }
      return null;
    };

    // Must not throw.
    await expect(hydrateAppState()).resolves.toBeUndefined();

    // Viewport should remain undefined (default), not crash.
    expect(useAppStore.getState().viewport).toBeUndefined();
    // hydrated still becomes true.
    expect(useAppStore.getState().hydrated).toBe(true);
  });

  it('keeps viewport = undefined when JSON is valid but wrong shape', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'viewport') return JSON.stringify({ foo: 'bar' });
      }
      return null;
    };

    await hydrateAppState();

    expect(useAppStore.getState().viewport).toBeUndefined();
  });

  it('does not overwrite activeSym when app_state key is absent', async () => {
    // Pre-set a sym in the store to verify it is preserved.
    useAppStore.setState({ activeSym: 'SOL' });

    mockInvokeImpl = (cmd) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      return null; // activeSym key absent
    };

    await hydrateAppState();

    // activeSym should remain 'SOL' — null from DB is not written.
    expect(useAppStore.getState().activeSym).toBe('SOL');
  });

  // -------------------------------------------------------------------------
  // ADR-0009 — activeAsset hydration + legacy activeSym shim
  // -------------------------------------------------------------------------

  it('hydrates activeAsset from the persisted JSON blob (ADR-0009)', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'activeAsset') {
          return JSON.stringify({ sym: 'BTC', provider: 'binance', quote: 'USDC' });
        }
      }
      return null;
    };

    await hydrateAppState();

    const s = useAppStore.getState();
    expect(s.activeAsset).toEqual({ sym: 'BTC', provider: 'binance', quote: 'USDC' });
    // setActiveAsset mirrors `sym` into the legacy slot.
    expect(s.activeSym).toBe('BTC');
  });

  it('prefers activeAsset over legacy activeSym when both are present', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') return [];
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'activeSym') return 'ETH'; // legacy
        if (key === 'activeAsset') {
          return JSON.stringify({ sym: 'SOL', provider: 'binance', quote: 'USDT' });
        }
      }
      return null;
    };

    await hydrateAppState();

    const s = useAppStore.getState();
    // activeAsset wins; the mirror updates activeSym to match.
    expect(s.activeAsset).toEqual({ sym: 'SOL', provider: 'binance', quote: 'USDT' });
    expect(s.activeSym).toBe('SOL');
  });

  it('falls back to legacy activeSym shim and derives provider/quote from v2 watchlist', async () => {
    // No activeAsset blob, but `activeSym = ETH` and the v2 watchlist contains
    // ETH on binance/USDT — shim should derive (binance, USDT).
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') {
        return [
          { sym: 'ETH', provider: 'binance', quote: 'USDT', added_at: 1 },
          { sym: 'BTC', provider: 'coinbase', quote: 'USD', added_at: 2 },
        ];
      }
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'activeSym') return 'ETH';
      }
      return null;
    };

    await hydrateAppState();

    const s = useAppStore.getState();
    expect(s.activeAsset).toEqual({ sym: 'ETH', provider: 'binance', quote: 'USDT' });
    expect(s.activeSym).toBe('ETH');
  });

  it('leaves activeAsset undefined when legacy activeSym is unknown to the v2 watchlist', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') {
        return [{ sym: 'BTC', provider: 'coinbase', quote: 'USD', added_at: 1 }];
      }
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'activeSym') return 'DOGE'; // not in v2 watchlist
      }
      return null;
    };

    await hydrateAppState();

    const s = useAppStore.getState();
    expect(s.activeAsset).toBeUndefined();
    // Legacy slot retains the persisted sym — UX doesn't regress.
    expect(s.activeSym).toBe('DOGE');
  });

  it('treats malformed activeAsset JSON as missing and falls back to legacy shim', async () => {
    mockInvokeImpl = (cmd, args) => {
      if (cmd === 'db_watchlist_v2_list') {
        return [{ sym: 'BTC', provider: 'binance', quote: 'USDT', added_at: 1 }];
      }
      if (cmd === 'db_app_state_get') {
        const { key } = args as { key: string };
        if (key === 'activeAsset') return '{ NOT VALID JSON %%%';
        if (key === 'activeSym') return 'BTC';
      }
      return null;
    };

    await hydrateAppState();

    // Malformed blob → fall through to the activeSym shim path.
    const s = useAppStore.getState();
    expect(s.activeAsset).toEqual({ sym: 'BTC', provider: 'binance', quote: 'USDT' });
  });
});

// ---------------------------------------------------------------------------
// mountAppStateSync — debounced write-back includes the activeAsset JSON blob.
// ---------------------------------------------------------------------------

describe('mountAppStateSync', () => {
  beforeEach(() => {
    resetStores();
    appStateSets.length = 0;
    // The sync mounts only flush when hydrated === true.
    useAppStore.setState({ hydrated: true });
  });

  it('persists activeAsset as a JSON-stringified blob when set', async () => {
    const unmount = mountAppStateSync();

    useAppStore.getState().setActiveAsset({
      sym: 'SOL',
      provider: 'binance',
      quote: 'USDC',
    });

    // Wait past the 200ms debounce + invoke microtask.
    await new Promise((r) => setTimeout(r, 250));

    const blobWrites = appStateSets.filter((w) => w.key === 'activeAsset');
    expect(blobWrites.length).toBeGreaterThan(0);
    const last = blobWrites[blobWrites.length - 1];
    expect(JSON.parse(last.value)).toEqual({
      sym: 'SOL',
      provider: 'binance',
      quote: 'USDC',
    });

    unmount();
  });

  it('does not write activeAsset when it has never been set', async () => {
    const unmount = mountAppStateSync();

    // Mutate something else to trigger the flush — activeAsset stays undefined.
    useAppStore.getState().setChartType('area');
    await new Promise((r) => setTimeout(r, 250));

    const blobWrites = appStateSets.filter((w) => w.key === 'activeAsset');
    expect(blobWrites).toHaveLength(0);

    unmount();
  });
});
