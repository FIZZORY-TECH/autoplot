/**
 * src/stores/usePortfolioStore.test.ts — Vitest unit tests for usePortfolioStore
 * and the extracted portfolioMath helpers.
 *
 * Strategy:
 *   - vi.mock '../lib/db' to replace portfolio IPC wrappers with spies.
 *   - Call store actions, assert spy call args and resulting `holdings` state.
 *   - Test portfolioMath pure functions directly with crafted inputs.
 *
 * The store is reset to empty before each test so state doesn't leak.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them.
// ---------------------------------------------------------------------------

const dbPortfolioListMock = vi.fn<() => Promise<import('../lib/db').HoldingRow[]>>();
const dbPortfolioUpsertMock = vi.fn<(h: import('../lib/db').HoldingRow) => Promise<void>>();
const dbPortfolioAddLotMock = vi.fn<(args: unknown) => Promise<void>>();
const dbPortfolioReduceMock = vi.fn<(args: unknown) => Promise<void>>();
const dbPortfolioRemoveMock = vi.fn<(args: unknown) => Promise<void>>();

vi.mock('../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/db')>();
  return {
    ...orig,
    dbPortfolioList: () => dbPortfolioListMock(),
    dbPortfolioUpsert: (h: import('../lib/db').HoldingRow) => dbPortfolioUpsertMock(h),
    dbPortfolioAddLot: (args: unknown) => dbPortfolioAddLotMock(args),
    dbPortfolioReduce: (args: unknown) => dbPortfolioReduceMock(args),
    dbPortfolioRemove: (args: unknown) => dbPortfolioRemoveMock(args),
  };
});

// Import after mocks are registered.
const { usePortfolioStore } = await import('./usePortfolioStore');
import { holdingPnl, portfolioSummary } from '../lib/portfolioMath';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHolding(
  overrides: Partial<import('../lib/db').HoldingRow> = {},
): import('../lib/db').HoldingRow {
  return {
    sym: 'BTC',
    provider: 'coinbase',
    quote: 'USD',
    asset_class: 'crypto',
    qty: 1,
    avg_cost: 40_000,
    currency: 'USD',
    note: null,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  };
}

function resetStore() {
  usePortfolioStore.setState({ holdings: [] });
}

beforeEach(() => {
  resetStore();
  dbPortfolioListMock.mockReset();
  dbPortfolioListMock.mockResolvedValue([]);
  dbPortfolioUpsertMock.mockReset();
  dbPortfolioUpsertMock.mockResolvedValue(undefined);
  dbPortfolioAddLotMock.mockReset();
  dbPortfolioAddLotMock.mockResolvedValue(undefined);
  dbPortfolioReduceMock.mockReset();
  dbPortfolioReduceMock.mockResolvedValue(undefined);
  dbPortfolioRemoveMock.mockReset();
  dbPortfolioRemoveMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// setHoldings — bulk hydrate (no DB write)
// ---------------------------------------------------------------------------

describe('usePortfolioStore — setHoldings', () => {
  it('replaces holdings without calling any DB fn', () => {
    const rows = [makeHolding(), makeHolding({ sym: 'ETH', qty: 5 })];
    usePortfolioStore.getState().setHoldings(rows);

    expect(usePortfolioStore.getState().holdings).toEqual(rows);
    expect(dbPortfolioListMock).not.toHaveBeenCalled();
    expect(dbPortfolioUpsertMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upsertHolding
// ---------------------------------------------------------------------------

describe('usePortfolioStore — upsertHolding', () => {
  it('calls dbPortfolioUpsert with the full row then refreshes holdings', async () => {
    const row = makeHolding({ sym: 'ETH', qty: 2, avg_cost: 2_000 });
    const refreshed = [row];
    dbPortfolioListMock.mockResolvedValueOnce(refreshed);

    await usePortfolioStore.getState().upsertHolding(row);

    expect(dbPortfolioUpsertMock).toHaveBeenCalledTimes(1);
    expect(dbPortfolioUpsertMock).toHaveBeenCalledWith(row);
    expect(dbPortfolioListMock).toHaveBeenCalledTimes(1);
    expect(usePortfolioStore.getState().holdings).toEqual(refreshed);
  });

  it('propagates the write error and does NOT refresh when upsert rejects', async () => {
    dbPortfolioUpsertMock.mockRejectedValueOnce(new Error('no Tauri'));
    const row = makeHolding();

    await expect(usePortfolioStore.getState().upsertHolding(row)).rejects.toThrow('no Tauri');

    // Write failure must surface to the caller (modal), not be swallowed; the
    // refresh read is skipped so a failed write can't masquerade as success.
    expect(dbPortfolioListMock).not.toHaveBeenCalled();
    expect(usePortfolioStore.getState().holdings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// addLot — defaults + now_ms injection
// ---------------------------------------------------------------------------

describe('usePortfolioStore — addLot', () => {
  it('calls dbPortfolioAddLot with injected now_ms and defaults asset_class/currency', async () => {
    const before = Date.now();
    await usePortfolioStore.getState().addLot({
      sym: 'BTC',
      provider: 'coinbase',
      add_qty: 0.5,
      add_price: 50_000,
    });
    const after = Date.now();

    expect(dbPortfolioAddLotMock).toHaveBeenCalledTimes(1);
    const args = dbPortfolioAddLotMock.mock.calls[0][0] as Record<string, unknown>;

    expect(args.sym).toBe('BTC');
    expect(args.provider).toBe('coinbase');
    expect(args.quote).toBe('USD');            // defaultQuoteForProvider('coinbase')
    expect(args.asset_class).toBe('crypto');   // default
    expect(args.currency).toBe('USD');         // default
    expect(args.add_qty).toBe(0.5);
    expect(args.add_price).toBe(50_000);
    expect(typeof args.now_ms).toBe('number');
    expect(args.now_ms as number).toBeGreaterThanOrEqual(before);
    expect(args.now_ms as number).toBeLessThanOrEqual(after);
  });

  it('honours explicit asset_class and currency when supplied', async () => {
    await usePortfolioStore.getState().addLot({
      sym: 'AAPL',
      provider: 'alpaca',
      asset_class: 'equity',
      add_qty: 10,
      add_price: 180,
      currency: 'USD',
    });

    const args = dbPortfolioAddLotMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.asset_class).toBe('equity');
    expect(args.currency).toBe('USD');
    expect(args.quote).toBe('USD');            // alpaca default
  });

  it('uses binance default quote (USDT) when provider is binance', async () => {
    await usePortfolioStore.getState().addLot({
      sym: 'BTC',
      provider: 'binance',
      add_qty: 1,
      add_price: 42_000,
    });

    const args = dbPortfolioAddLotMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.quote).toBe('USDT');
  });

  it('refreshes holdings from dbPortfolioList after addLot', async () => {
    const refreshed = [makeHolding()];
    dbPortfolioListMock.mockResolvedValueOnce(refreshed);

    await usePortfolioStore.getState().addLot({
      sym: 'BTC', provider: 'coinbase', add_qty: 1, add_price: 40_000,
    });

    expect(dbPortfolioListMock).toHaveBeenCalledTimes(1);
    expect(usePortfolioStore.getState().holdings).toEqual(refreshed);
  });

  it('propagates the write error and does NOT refresh when addLot rejects', async () => {
    dbPortfolioAddLotMock.mockRejectedValueOnce(new Error('no Tauri'));

    await expect(
      usePortfolioStore.getState().addLot({
        sym: 'BTC', provider: 'coinbase', add_qty: 1, add_price: 40_000,
      }),
    ).rejects.toThrow('no Tauri');

    expect(dbPortfolioListMock).not.toHaveBeenCalled();
    expect(usePortfolioStore.getState().holdings).toEqual([]);
  });

  it('preserves existing holdings when the post-write refresh read fails', async () => {
    const existing = [makeHolding()];
    usePortfolioStore.setState({ holdings: existing });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Write succeeds, but the refresh read throws — the panel must NOT be blanked.
    dbPortfolioListMock.mockRejectedValueOnce(new Error('list failed'));

    await usePortfolioStore.getState().addLot({
      sym: 'ETH', provider: 'coinbase', add_qty: 1, add_price: 2_000,
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(usePortfolioStore.getState().holdings).toEqual(existing);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// reduceHolding
// ---------------------------------------------------------------------------

describe('usePortfolioStore — reduceHolding', () => {
  it('calls dbPortfolioReduce with the right args including injected now_ms', async () => {
    const before = Date.now();
    await usePortfolioStore.getState().reduceHolding({
      sym: 'ETH', provider: 'coinbase', quote: 'USD', sell_qty: 1,
    });
    const after = Date.now();

    expect(dbPortfolioReduceMock).toHaveBeenCalledTimes(1);
    const args = dbPortfolioReduceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.sym).toBe('ETH');
    expect(args.provider).toBe('coinbase');
    expect(args.quote).toBe('USD');
    expect(args.sell_qty).toBe(1);
    expect(args.now_ms as number).toBeGreaterThanOrEqual(before);
    expect(args.now_ms as number).toBeLessThanOrEqual(after);
  });

  it('resolves quote via default when omitted', async () => {
    await usePortfolioStore.getState().reduceHolding({
      sym: 'BTC', provider: 'binance', sell_qty: 0.1,
    });

    const args = dbPortfolioReduceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.quote).toBe('USDT');
  });

  it('refreshes holdings from dbPortfolioList after reduceHolding', async () => {
    const refreshed = [makeHolding({ qty: 0.9 })];
    dbPortfolioListMock.mockResolvedValueOnce(refreshed);

    await usePortfolioStore.getState().reduceHolding({
      sym: 'BTC', provider: 'coinbase', sell_qty: 0.1,
    });

    expect(usePortfolioStore.getState().holdings).toEqual(refreshed);
  });
});

// ---------------------------------------------------------------------------
// removeHolding
// ---------------------------------------------------------------------------

describe('usePortfolioStore — removeHolding', () => {
  it('calls dbPortfolioRemove with (sym, provider, quote) then refreshes', async () => {
    const refreshed: import('../lib/db').HoldingRow[] = [];
    dbPortfolioListMock.mockResolvedValueOnce(refreshed);

    await usePortfolioStore.getState().removeHolding({
      sym: 'BTC', provider: 'coinbase', quote: 'USD',
    });

    expect(dbPortfolioRemoveMock).toHaveBeenCalledTimes(1);
    expect(dbPortfolioRemoveMock).toHaveBeenCalledWith({ sym: 'BTC', provider: 'coinbase', quote: 'USD' });
    expect(dbPortfolioListMock).toHaveBeenCalledTimes(1);
    expect(usePortfolioStore.getState().holdings).toEqual([]);
  });

  it('propagates the write error and does NOT refresh when remove rejects', async () => {
    dbPortfolioRemoveMock.mockRejectedValueOnce(new Error('no Tauri'));

    await expect(
      usePortfolioStore.getState().removeHolding({
        sym: 'BTC', provider: 'coinbase', quote: 'USD',
      }),
    ).rejects.toThrow('no Tauri');

    expect(dbPortfolioListMock).not.toHaveBeenCalled();
    expect(usePortfolioStore.getState().holdings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// portfolioMath — holdingPnl
// ---------------------------------------------------------------------------

describe('holdingPnl', () => {
  it('computes value = price × qty', () => {
    const r = holdingPnl(50_000, 2, 40_000, 100_000);
    expect(r.value).toBeCloseTo(100_000);
  });

  it('computes cost = avg_cost × qty', () => {
    const r = holdingPnl(50_000, 2, 40_000, 100_000);
    expect(r.cost).toBeCloseTo(80_000);
  });

  it('computes unrealized = value − cost when avg_cost > 0', () => {
    const r = holdingPnl(50_000, 2, 40_000, 100_000);
    expect(r.unrealized).toBeCloseTo(20_000);
  });

  it('unrealized = 0 when avg_cost = 0 (guard)', () => {
    const r = holdingPnl(50_000, 2, 0, 100_000);
    expect(r.unrealized).toBe(0);
  });

  it('computes unrealizedPct = (price − avg_cost) / avg_cost', () => {
    const r = holdingPnl(50_000, 2, 40_000, 100_000);
    expect(r.unrealizedPct).toBeCloseTo(0.25);
  });

  it('unrealizedPct = 0 when avg_cost = 0 (guard)', () => {
    const r = holdingPnl(50_000, 2, 0, 100_000);
    expect(r.unrealizedPct).toBe(0);
  });

  it('computes weightPct = value / totalValue', () => {
    const r = holdingPnl(50_000, 2, 40_000, 200_000);
    // value = 100_000; totalValue = 200_000 → 0.5
    expect(r.weightPct).toBeCloseTo(0.5);
  });

  it('weightPct = 0 when totalValue = 0 (guard)', () => {
    const r = holdingPnl(50_000, 2, 40_000, 0);
    expect(r.weightPct).toBe(0);
  });

  it('negative unrealized when price < avg_cost', () => {
    const r = holdingPnl(30_000, 1, 40_000, 30_000);
    expect(r.unrealized).toBeCloseTo(-10_000);
    expect(r.unrealizedPct).toBeCloseTo(-0.25);
  });
});

// ---------------------------------------------------------------------------
// portfolioMath — portfolioSummary
// ---------------------------------------------------------------------------

describe('portfolioSummary', () => {
  it('returns zeros for empty portfolio', () => {
    const s = portfolioSummary([]);
    expect(s.totalValue).toBe(0);
    expect(s.totalCost).toBe(0);
    expect(s.unrealized).toBe(0);
    expect(s.unrealizedPct).toBe(0);
    expect(s.cryptoPct).toBe(0);
    expect(s.equityPct).toBe(0);
  });

  it('sums value and cost across holdings', () => {
    const s = portfolioSummary([
      { qty: 1, avg_cost: 40_000, asset_class: 'crypto', price: 50_000 },
      { qty: 10, avg_cost: 150, asset_class: 'equity', price: 180 },
    ]);
    // value: 50_000 + 1_800 = 51_800
    expect(s.totalValue).toBeCloseTo(51_800);
    // cost: 40_000 + 1_500 = 41_500
    expect(s.totalCost).toBeCloseTo(41_500);
    expect(s.unrealized).toBeCloseTo(10_300);
  });

  it('unrealizedPct = unrealized / totalCost when cost > 0', () => {
    const s = portfolioSummary([
      { qty: 1, avg_cost: 100, asset_class: 'crypto', price: 120 },
    ]);
    expect(s.unrealizedPct).toBeCloseTo(0.2);
  });

  it('unrealizedPct = 0 when totalCost = 0', () => {
    const s = portfolioSummary([
      { qty: 1, avg_cost: 0, asset_class: 'crypto', price: 120 },
    ]);
    expect(s.unrealizedPct).toBe(0);
  });

  it('cryptoPct + equityPct = 1 for mixed portfolio', () => {
    const s = portfolioSummary([
      { qty: 1, avg_cost: 50_000, asset_class: 'crypto', price: 50_000 },
      { qty: 1, avg_cost: 50_000, asset_class: 'equity', price: 50_000 },
    ]);
    expect(s.cryptoPct).toBeCloseTo(0.5);
    expect(s.equityPct).toBeCloseTo(0.5);
    expect(s.cryptoPct + s.equityPct).toBeCloseTo(1);
  });

  it('equityPct = 0 for all-crypto portfolio', () => {
    const s = portfolioSummary([
      { qty: 2, avg_cost: 40_000, asset_class: 'crypto', price: 50_000 },
    ]);
    expect(s.equityPct).toBe(0);
    expect(s.cryptoPct).toBeCloseTo(1);
  });
});
