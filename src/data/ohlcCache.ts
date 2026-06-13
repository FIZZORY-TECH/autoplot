/**
 * src/data/ohlcCache.ts — In-memory LRU for OHLCV bar arrays (P4-12).
 *
 * Cache keying: `${provider}:${sym}/${quote}:${tf}` → `{ bars, fetchedAt }` (the
 * latest fetched range, ordered ascending by `ts`). LRU semantics are implemented
 * on top of a `Map`'s insertion-order property: a `get` re-inserts to bump the
 * entry to the most-recently-used position; `set` evicts the oldest when full.
 *
 * ADR-0009: keying widens from `(provider, sym, tf)` to
 * `(provider, sym, quote, tf)` because the canonical instrument identity is now
 * `(provider, sym, quote)` — SOL/USDT and SOL/USDC are different markets and
 * must not collide in the warm cache.
 *
 * Capacity bumped from 32 → 128 because multi-quote inflates the per-symbol
 * entry count (a watchlist with BTC/USDT + BTC/USDC + ETH/USDT across two
 * timeframes is already 6 entries instead of 2 in the pre-ADR-0009 world).
 * Still hot working-set sized — the SQLite warm cache (`bars_v2`, ADR-0009)
 * handles persistent history; this module is the in-process front line.
 *
 * Fix B1 (freshness): each entry records `Date.now()` as `fetchedAt` on every
 * `set`. `getWithMeta` exposes bars + fetchedAt for freshness-gated early-returns
 * in providerRegistry; the existing `get` API returns bars only so `useScrollBack`
 * and all other callers keep compiling unchanged.
 */
import type { Bar, Provider, Tf } from './MarketDataProvider';

/** Build the cache key. Centralised so future changes (e.g. range-scoped
 *  keys) only touch this file. ADR-0009: `quote` is part of the identity. */
export function ohlcCacheKey(
  provider: Provider,
  sym: string,
  quote: string,
  tf: Tf,
): string {
  return `${provider}:${sym}/${quote}:${tf}`;
}

/** Stored value / shape returned by `getWithMeta` — bars plus the wall-clock stamp of the last `set`. */
export interface CacheEntry {
  bars: Bar[];
  fetchedAt: number;
}

export class OhlcCache {
  private readonly map: Map<string, CacheEntry>;
  private readonly maxEntries: number;

  constructor(maxEntries = 128) {
    if (maxEntries <= 0) {
      throw new Error('OhlcCache maxEntries must be positive');
    }
    this.map = new Map();
    this.maxEntries = maxEntries;
  }

  /**
   * Look up bars by key. Returns `undefined` on miss.
   * On hit, the entry is bumped to most-recently-used (re-inserted).
   *
   * NOTE: this returns bars only (no freshness metadata) so all existing
   * callers keep compiling unchanged. Use `getWithMeta` for freshness checks.
   */
  get(provider: Provider, sym: string, quote: string, tf: Tf): Bar[] | undefined {
    return this.touch(ohlcCacheKey(provider, sym, quote, tf))?.bars;
  }

  /**
   * Look up bars + their fetchedAt timestamp. Returns `undefined` on miss.
   * On hit, the entry is bumped to MRU (same as `get`).
   * Used by providerRegistry's freshness-gated early-return.
   */
  getWithMeta(provider: Provider, sym: string, quote: string, tf: Tf): CacheEntry | undefined {
    const entry = this.touch(ohlcCacheKey(provider, sym, quote, tf));
    return entry && { bars: entry.bars, fetchedAt: entry.fetchedAt };
  }

  /** Fetch an entry and bump it to most-recently-used (Map preserves insertion order). */
  private touch(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  /**
   * Store bars under the key. If the cache is full, evicts the
   * least-recently-used entry (Map's first key) before inserting.
   * Re-setting an existing key bumps it to MRU (delete then set).
   * Stamps `fetchedAt = Date.now()` on every call.
   */
  set(provider: Provider, sym: string, quote: string, tf: Tf, bars: Bar[]): void {
    const key = ohlcCacheKey(provider, sym, quote, tf);
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      // Evict the LRU entry — the first key in insertion order.
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, { bars, fetchedAt: Date.now() });
  }

  /** Remove a single entry (e.g. when the user removes a watchlist symbol). */
  delete(provider: Provider, sym: string, quote: string, tf: Tf): boolean {
    return this.map.delete(ohlcCacheKey(provider, sym, quote, tf));
  }

  /**
   * Evict all entries whose key starts with `${provider}:`.
   * Called when credentials for a provider change so the next fetch goes
   * to Rust rather than returning stale cached bars.
   */
  clearProvider(provider: string): void {
    const prefix = `${provider}:`;
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }

  /** Drop everything (e.g. on signed-out / settings change). */
  clear(): void {
    this.map.clear();
  }

  /** Current entry count — exposed for tests + diagnostics. */
  get size(): number {
    return this.map.size;
  }
}

/** Process-wide singleton. Tests should construct their own `OhlcCache`. */
export const ohlcCache = new OhlcCache();
