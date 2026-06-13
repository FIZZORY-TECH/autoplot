/**
 * src/stores/useWatchlistStore.ts — Watchlist state
 *
 * ADR-0009 — canonical identity widens from (sym, provider) to (sym, provider, quote).
 * All reads/writes route through `watchlist_v2` Tauri commands; the legacy v1 table
 * is preserved by migration 0015 for audit but never written to from here.
 *
 * Transitional `quote?: string` — Step 11 of the rollout tightens to required.
 */

import { create } from 'zustand';
import { dbWatchlistV2Add, dbWatchlistV2Remove } from '../lib/db';
import type { WatchlistEntryV2 } from '../lib/db';

/**
 * Per-provider default quote used when a legacy caller (pre-ADR-0009) omits
 * `quote`. Matches the migration 0015 backfill exactly so the in-memory and
 * persisted views stay consistent.
 */
export function defaultQuoteForProvider(provider: string): string {
  switch (provider) {
    case 'binance':
      return 'USDT';
    case 'coinbase':
    case 'kraken':
    case 'alpaca':
      return 'USD';
    default:
      return 'USD';
  }
}

/** Minimal asset descriptor mirroring the watchlist_v2 row. */
export interface AssetMeta {
  sym: string;
  provider: string;
  /** Canonical quote (ADR-0009). */
  quote: string;
}

interface WatchlistState {
  assets: AssetMeta[];

  /**
   * Bulk-replace the asset list. Called once by `hydrateAppState()` on boot.
   * Converts raw `WatchlistEntryV2` rows to `AssetMeta`.
   */
  setWatchlist: (entries: WatchlistEntryV2[]) => void;

  /**
   * Add an asset to v2. Duplicate (sym, provider, quote) adds are safe no-ops.
   * `quote` defaults to the per-provider quote so legacy callsites still work
   * during the transition window.
   */
  addAsset: (sym: string, provider: string, quote?: string) => Promise<void>;

  /**
   * Remove an asset from v2. Removing a non-existent entry is a safe no-op.
   * `quote` defaults to the per-provider quote so legacy callsites still work.
   */
  removeAsset: (sym: string, provider: string, quote?: string) => Promise<void>;
}

export const useWatchlistStore = create<WatchlistState>((set, get) => ({
  assets: [],

  setWatchlist: (entries) =>
    set({
      assets: entries.map(({ sym, provider, quote }) => ({ sym, provider, quote })),
    }),

  addAsset: async (sym, provider, quote) => {
    const q = quote ?? defaultQuoteForProvider(provider);
    try {
      await dbWatchlistV2Add(sym, provider, q);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[watchlist] dbWatchlistV2Add failed (outside Tauri?)', err);
    }
    const already = get().assets.some(
      (a) => a.sym === sym && a.provider === provider && a.quote === q,
    );
    if (!already) {
      set((s) => ({ assets: [...s.assets, { sym, provider, quote: q }] }));
    }
  },

  removeAsset: async (sym, provider, quote) => {
    const q = quote ?? defaultQuoteForProvider(provider);
    try {
      await dbWatchlistV2Remove(sym, provider, q);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[watchlist] dbWatchlistV2Remove failed (outside Tauri?)', err);
    }
    set((s) => ({
      assets: s.assets.filter(
        (a) => !(a.sym === sym && a.provider === provider && a.quote === q),
      ),
    }));
  },
}));
