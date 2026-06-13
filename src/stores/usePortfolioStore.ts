/**
 * src/stores/usePortfolioStore.ts — Paper-trading portfolio state
 *
 * Mirrors the shape of useWatchlistStore: Zustand `create`, async actions that
 * call Tauri then refresh in-memory state via a full re-read, a bulk `setHoldings`
 * hydrate action (no DB write), and re-uses `defaultQuoteForProvider` from the
 * watchlist store for default quote resolution.
 *
 * All DB access flows through `src/lib/db.ts` per A9.
 */

import { create } from 'zustand';
import {
  dbPortfolioList,
  dbPortfolioUpsert,
  dbPortfolioAddLot,
  dbPortfolioReduce,
  dbPortfolioRemove,
} from '../lib/db';
import type { HoldingRow } from '../lib/db';
import { defaultQuoteForProvider } from './useWatchlistStore';

export type { HoldingRow };
export { defaultQuoteForProvider };

interface PortfolioState {
  holdings: HoldingRow[];

  /**
   * Bulk-replace the holdings list. Called once by `hydrateAppState()` on boot.
   * Does NOT write to the DB — hydrate only.
   */
  setHoldings(rows: HoldingRow[]): void;

  /**
   * Full-row upsert (overwrites an existing `(sym, provider, quote)` row),
   * then refreshes in-memory state from the DB.
   */
  upsertHolding(h: HoldingRow): Promise<void>;

  /**
   * Add a lot (new position or increase existing), then refresh.
   * `now_ms` is supplied automatically — callers need not pass it.
   * `asset_class` defaults to `'crypto'`; `currency` defaults to `'USD'`.
   */
  addLot(args: {
    sym: string;
    provider: string;
    quote?: string;
    asset_class?: string;
    add_qty: number;
    add_price: number;
    currency?: string;
    note?: string | null;
  }): Promise<void>;

  /**
   * Reduce a position by `sell_qty`, then refresh.
   * `now_ms` is supplied automatically — callers need not pass it.
   */
  reduceHolding(args: {
    sym: string;
    provider: string;
    quote?: string;
    sell_qty: number;
  }): Promise<void>;

  /**
   * Remove a holding entirely, then refresh.
   */
  removeHolding(args: { sym: string; provider: string; quote: string }): Promise<void>;

  /**
   * Re-fetch holdings from the DB and update in-memory state.
   * Called internally after every write action. Also exposed publicly so
   * AppShell can trigger a refresh when a CLI/MCP-originated mutation is
   * signalled via the `portfolio:changed` Tauri event.
   */
  refresh(): Promise<void>;
}

export const usePortfolioStore = create<PortfolioState>((set) => {
  /**
   * Re-read holdings from the DB after a mutation. A read failure is logged but
   * does NOT blank the panel — the prior list is preserved (a transient list
   * error must not wipe a portfolio that may have persisted fine).
   *
   * Write failures, by contrast, are NOT swallowed here: the mutating actions
   * below `await` their DB write directly so the error propagates to the caller
   * (e.g. AddHoldingModal), which surfaces an error toast and keeps the modal
   * open instead of showing a false "added" success.
   */
  const refresh = async (): Promise<void> => {
    try {
      set({ holdings: await dbPortfolioList() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[portfolio] holdings refresh failed', err);
    }
  };

  return {
    holdings: [],

    setHoldings: (rows) => set({ holdings: rows }),

    upsertHolding: async (h) => {
      await dbPortfolioUpsert(h);
      await refresh();
    },

    addLot: async (args) => {
      const quote = args.quote ?? defaultQuoteForProvider(args.provider);
      await dbPortfolioAddLot({
        sym: args.sym,
        provider: args.provider,
        quote,
        asset_class: args.asset_class ?? 'crypto',
        add_qty: args.add_qty,
        add_price: args.add_price,
        currency: args.currency ?? 'USD',
        note: args.note ?? null,
        now_ms: Date.now(),
      });
      await refresh();
    },

    reduceHolding: async (args) => {
      const quote = args.quote ?? defaultQuoteForProvider(args.provider);
      await dbPortfolioReduce({
        sym: args.sym,
        provider: args.provider,
        quote,
        sell_qty: args.sell_qty,
        now_ms: Date.now(),
      });
      await refresh();
    },

    removeHolding: async (args) => {
      await dbPortfolioRemove(args);
      await refresh();
    },

    refresh,
  };
});
