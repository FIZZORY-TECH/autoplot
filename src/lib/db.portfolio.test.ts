/**
 * src/lib/db.portfolio.test.ts — IPC contract test for portfolio invoke() keys.
 *
 * Tauri v2's default `#[tauri::command]` (no `rename_all`) maps **camelCase** JS
 * argument keys → snake_case Rust params. Multi-word invoke keys MUST therefore
 * be camelCase, matching the `sinceTs`/`untilTs` convention used elsewhere in
 * db.ts. Sending snake_case keys (`add_qty`, `now_ms`, …) silently fails arg
 * deserialization at the Rust boundary — which is exactly the "Failed to save
 * holding" bug this test guards against.
 *
 * This test sits at the `invoke` boundary (it mocks `@tauri-apps/api/core`),
 * the one layer the store unit tests (which mock db.ts) and the Rust DAO tests
 * (which bypass the command macro) never exercise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every invoke call before importing db.ts.
const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const { dbPortfolioAddLot, dbPortfolioReduce, dbPortfolioRemove } = await import('./db');

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

/** Snake_case detector: matches a lowercase-underscore-lowercase boundary. */
const SNAKE = /[a-z0-9]_[a-z0-9]/;

describe('portfolio invoke arg keys — must be camelCase (Tauri v2 default)', () => {
  it('dbPortfolioAddLot sends camelCase keys (no snake_case)', async () => {
    await dbPortfolioAddLot({
      sym: 'BTC',
      provider: 'coinbase',
      quote: 'USD',
      asset_class: 'crypto',
      add_qty: 1,
      add_price: 50_000,
      currency: 'USD',
      note: null,
      now_ms: 1_000_000,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe('db_portfolio_add_lot');

    // Required camelCase keys present.
    expect(args).toHaveProperty('assetClass', 'crypto');
    expect(args).toHaveProperty('addQty', 1);
    expect(args).toHaveProperty('addPrice', 50_000);
    expect(args).toHaveProperty('nowMs', 1_000_000);

    // No snake_case key may leak through (would fail at the Rust boundary).
    for (const key of Object.keys(args ?? {})) {
      expect(key, `arg key "${key}" must not be snake_case`).not.toMatch(SNAKE);
    }
  });

  it('dbPortfolioReduce sends camelCase keys (no snake_case)', async () => {
    await dbPortfolioReduce({
      sym: 'BTC',
      provider: 'coinbase',
      quote: 'USD',
      sell_qty: 0.5,
      now_ms: 1_000_001,
    });

    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe('db_portfolio_reduce');
    expect(args).toHaveProperty('sellQty', 0.5);
    expect(args).toHaveProperty('nowMs', 1_000_001);
    for (const key of Object.keys(args ?? {})) {
      expect(key, `arg key "${key}" must not be snake_case`).not.toMatch(SNAKE);
    }
  });

  it('dbPortfolioRemove sends only single-word keys', async () => {
    await dbPortfolioRemove({ sym: 'BTC', provider: 'coinbase', quote: 'USD' });
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe('db_portfolio_remove');
    for (const key of Object.keys(args ?? {})) {
      expect(key).not.toMatch(SNAKE);
    }
  });
});
