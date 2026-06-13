/**
 * src/data/providerRegistry.ts — Provider registry (P4.5 + ADR-0009).
 *
 * Picks a `MarketDataProvider` for a given provider tag. Combines:
 *   - Rust REST history via the `market_fetch_history` Tauri command (A2).
 *   - TS WebSocket subscriptions via per-provider adapters (P4.2/3/4; A2).
 *
 * Mock fallback:
 *   - In tests / offline dev, set `localStorage.setItem('use-mock-provider','1')`
 *     to force `MockMarketDataProvider` everywhere. Useful for Playwright.
 *
 * The FROZEN `MarketDataProvider` interface (A3) keys methods by `sym`. The
 * canonical instrument identity is `(provider, sym, quote)` per ADR-0009, so
 * `getProvider(provider, quote?)` captures both in closure. `quote` defaults
 * to the per-provider default (`defaultQuoteForProvider`) when omitted so
 * legacy single-arg callers keep compiling during the Step 5b→7 transition.
 *
 * Searches now hit the SQLite-backed catalog via `searchSymbols` (5b.1).
 */
import type { MarketDataProvider, Provider, Tf, Bar, AssetMeta } from './MarketDataProvider';
import { MockMarketDataProvider } from './mockProvider';
import { RealMarketDataProvider } from './realProvider';
import { ohlcCache } from './ohlcCache';
import { tfToMs } from './tf';
import { marketFetchHistory, marketFetchHistoryBefore, symbolCatalogSearch } from '../lib/db';
import type { SymbolRow } from '../lib/db';
import { useToastStore } from '../stores/useToastStore';

/**
 * PaginatedProvider — local extension of the FROZEN `MarketDataProvider`.
 *
 * Adds `fetchHistoryBefore` for scroll-back pagination without touching
 * `MarketDataProvider.ts` (ADR-0001 safe). `getProvider()` returns this type
 * so callers (e.g. the `useScrollBack` hook in Step 4) get full type-safety
 * on the paging method without needing `as any` or unsafe casts.
 *
 * This interface is intentionally local to `providerRegistry.ts`; it is NOT
 * part of the frozen public contract, only of the registry's return type.
 */
export interface PaginatedProvider extends MarketDataProvider {
  /**
   * Fetch `count` bars whose `ts < before` (epoch-ms), in ascending `ts` order.
   *
   * - Does NOT consult the in-memory `ohlcCache` early-return — this is a
   *   range request, not "last N"; results must come from the provider/Rust.
   * - For crypto providers: calls `marketFetchHistoryBefore` (Rust v2 + `before`).
   * - For Alpaca: RE-THROWS (same hard-fail policy as `fetchHistory`).
   * - For mock: delegates to `MockMarketDataProvider.fetchHistoryBefore`.
   */
  fetchHistoryBefore(sym: string, tf: Tf, before: number, count: number): Promise<Bar[]>;
}
import { subscribeBinance } from './adapters/binance';
import { subscribeCoinbase } from './adapters/coinbase';
import { subscribeKraken } from './adapters/kraken';
import { subscribeAlpaca } from './adapters/alpaca';
import { setMockActive } from './mockStatus';
import { setEquityCredFailed } from './equityCredStatus';
import { isTauriRuntime } from '../lib/runtime';
import { defaultQuoteForProvider } from '../stores/useWatchlistStore';
import { isCapable, resolveEffectiveProvider, CRYPTO_FALLBACK_CHAIN } from './providerCapabilities';

/**
 * Re-export the pure resolver so the data layer has one import surface for
 * "which provider actually serves this (sym, tf, quote)?". Both the fetch
 * reroute below and the WS subscribe site in `AppShell.tsx` resolve through
 * this same function — keeping history (cache key) and realtime (WS target)
 * routed to the SAME effective provider.
 */
export { resolveEffectiveProvider };

const realProvider = new RealMarketDataProvider();
const mockProvider = new MockMarketDataProvider();

/**
 * Mock toggle — set `localStorage.use-mock-provider = '1'` in dev / tests to
 * force the mock path. Reads on every access; flipping the flag at runtime
 * takes effect on the next call.
 */
export function isMockForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem('use-mock-provider') === '1';
  } catch {
    return false;
  }
}

/**
 * Surface a mock-fallback condition both via the legacy `console.warn` (kept
 * for debug grep-ability) and via the live status broadcaster so the
 * `<MockBadge />` can render. Inputs are formatted into a single human-
 * readable reason for the tooltip.
 */
function reportMockFallback(provider: Provider, sym: string, tf: Tf, err: unknown): void {
  const reason = `History fallback to mock for ${provider}:${sym}@${tf}`;
  // eslint-disable-next-line no-console
  console.warn(`[providerRegistry] ${reason}:`, err);
  setMockActive(true, reason);
}

/**
 * Detect the "no Tauri runtime" case — running in plain `vite dev` without
 * the desktop shell. The Rust REST path is unavailable; fall back to mock so
 * the app keeps working in browser dev sessions.
 */
function isMissingTauriCommand(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return /not (?:found|registered)|window\.__TAURI|invoke/i.test(msg);
}

/** Detect the P4.1 "adapter not registered" sentinel — mock fallback path. */
function isAdapterNotRegistered(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return msg.includes('adapter not registered');
}

/** Detect an authentication failure (HTTP 401/403) from the Rust adapter. */
function isAuthFailed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /authentication failed/i.test(msg);
}

/** Extract the server-supplied detail from an auth failure message. */
function extractAuthDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/authentication failed:\s*(.+)$/i);
  return m ? m[1].trim() : msg;
}

/**
 * Classify a non-mock-fallback provider error into one of:
 *   - 'unsupported-interval' — the provider does not support the requested tf
 *   - 'pair-not-listed'      — the symbol/quote combo is not available
 *   - 'other'                — everything else
 *
 * Used by the retry loop to emit a toast warning via useToastStore.
 */
function classifyProviderError(err: unknown): 'unsupported-interval' | 'pair-not-listed' | 'other' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unsupported.*interval|interval.*not.*supported|malformed.*interval|granularity/i.test(msg)) {
    return 'unsupported-interval';
  }
  if (/pair.*not.*found|symbol.*not.*found|not.*listed|unknown.*symbol|invalid.*symbol|product.*not.*found/i.test(msg)) {
    return 'pair-not-listed';
  }
  return 'other';
}

/**
 * Crypto-only fallback chain: returns providers (excluding `tried`) that are
 * capable of serving the given (tf, quote) but have not been attempted yet.
 * Alpaca is never included (equity-only, hard-fail path).
 *
 * Draws the chain order from `CRYPTO_FALLBACK_CHAIN` in `providerCapabilities`
 * so the fetch-path reroute and `resolveEffectiveProvider` (used by the WS
 * subscribe site) stay in lock-step — a single source of truth for the order.
 */
function capableFallbacks(tf: Tf, quote: string, tried: Provider[]): Provider[] {
  return CRYPTO_FALLBACK_CHAIN.filter((p) => !tried.includes(p) && isCapable(p, tf, quote));
}

/**
 * Shared capability-reroute loop for crypto history fetches. On a capability
 * error (unsupported interval / pair-not-listed) from the pinned `provider`,
 * retry each remaining capable crypto provider via `attempt` before giving up;
 * a non-capability error (or no capable fallback) re-throws unchanged. The
 * per-provider fetch is injected so the latest-page caller (which warms the
 * cache) and the older-page caller (which bypasses it) can differ. `label`
 * tags the log lines for the originating call.
 */
async function rerouteCapable(
  err: unknown,
  provider: Provider,
  sym: string,
  tf: Tf,
  quote: string,
  label: string,
  attempt: (fallback: Provider) => Promise<Bar[]>,
): Promise<Bar[]> {
  const errorClass = classifyProviderError(err);
  const fallbacks = capableFallbacks(tf, quote, [provider]);
  if (fallbacks.length > 0 && (errorClass === 'unsupported-interval' || errorClass === 'pair-not-listed')) {
    const tried: Provider[] = [provider];
    let lastErr: unknown = err;
    for (const fallback of fallbacks) {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[providerRegistry] ${label} rerouting ${sym}@${tf}/${quote} from ${tried[tried.length - 1]} to ${fallback} (${errorClass})`,
        );
        return await attempt(fallback);
      } catch (retryErr) {
        tried.push(fallback);
        lastErr = retryErr;
      }
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[providerRegistry] ${label} failed for ${sym}@${tf}/${quote}: all capable providers exhausted (tried: ${tried.join(', ')}); reason=${errorClass}`,
    );
    useToastStore.getState().push({ kind: 'warn', title: 'Market data unavailable', detail: `${label} failed for ${sym} — all providers exhausted` });
    throw lastErr;
  }
  // eslint-disable-next-line no-console
  console.warn(`[providerRegistry] ${label} failed for ${provider}:${sym}@${tf}:`, err);
  throw err;
}

/**
 * Pick the WS subscriber for a provider. Each adapter exposes a slightly
 * different signature; this thin shim normalises to `(sym, tf, cb) => unsub`
 * and threads the `quote` argument through (ADR-0009).
 */
function wsSubscribe(
  provider: Provider,
  sym: string,
  tf: Tf,
  cb: (bar: Bar) => void,
  quote: string,
): () => void {
  if (provider === 'binance') {
    return subscribeBinance(sym, tf, cb, quote).unsubscribe;
  }
  if (provider === 'coinbase') {
    // Coinbase ticker is timeframe-agnostic at the wire level, but the adapter
    // uses `tf` to bucket consecutive ticks into a running aggregated bar
    // (o = first tick in bucket, h/l = running max/min, c = latest tick).
    return subscribeCoinbase(sym, tf, cb, quote).unsubscribe;
  }
  if (provider === 'alpaca') {
    // Alpaca emits 1-minute bars; the adapter aggregates them into the active
    // tf-bucket using UTC-floor alignment (ADR-0008 §5). Quote is USD-only.
    return subscribeAlpaca(sym, tf, cb, quote).unsubscribe;
  }
  return subscribeKraken(sym, tf, cb, quote).unsubscribe;
}

/**
 * Get a `MarketDataProvider` bound to a specific provider tag + quote.
 *
 * - REST history runs through the Rust orchestrator (`market_fetch_history`)
 *   with the provider explicitly pinned, falling back to mock in browser dev
 *   or before adapters are wired.
 * - WS realtime calls the right per-provider TS adapter with `quote`.
 * - `search` delegates to `searchSymbols` (FTS5-backed catalog).
 *
 * `quote` is optional; when omitted, the per-provider default (`USDT` for
 * binance, `USD` everywhere else) is used so single-arg callsites keep
 * working during the Step 5b→7 transition.
 */
export function getProvider(provider: Provider, quote?: string): PaginatedProvider {
  if (isMockForced()) {
    setMockActive(true, 'use-mock-provider flag is set in localStorage');
    return mockProvider;
  }

  const q = quote ?? defaultQuoteForProvider(provider);

  return {
    fetchHistory: async (sym: string, tf: Tf, count: number): Promise<Bar[]> => {
      // Memory-cache hit — serve only if the entry is fresh enough.
      // maxAge = min(tf bucket duration, 60 s) so the most granular live
      // timeframe (1h) never serves a snapshot older than 60 s.
      const maxAge = Math.min(tfToMs(tf), 60_000);
      const cached = ohlcCache.getWithMeta(provider, sym, q, tf);
      if (cached && cached.bars.length >= count && Date.now() - cached.fetchedAt <= maxAge) {
        return cached.bars.slice(-count);
      }
      try {
        // Step 7 (ADR-0009): pass `quote` so Rust dispatches via
        // `market_fetch_history_v2` → adapter `fetch_history_pair`. Warm cache
        // writes go to `bars_v2`; the in-memory cache is keyed by the full
        // (provider, sym, quote, tf) tuple.
        const bars = await marketFetchHistory(provider, sym, tf, count, q);
        ohlcCache.set(provider, sym, q, tf, bars);
        // On success, clear any previously-reported equity cred failure.
        if (provider === 'alpaca') setEquityCredFailed(false);
        return bars;
      } catch (err) {
        // ----------------------------------------------------------------
        // Hard-fail path for equity (alpaca) when Tauri IS present.
        // We must NOT silently show mock prices for equity — a user would
        // read TSLA at $160 thinking it's live when the real price is $303.
        // ----------------------------------------------------------------
        if (provider === 'alpaca' && isTauriRuntime()) {
          let reason: 'no_credentials' | 'fetch_failed' | 'auth_failed';
          let detail: string;
          if (isAdapterNotRegistered(err)) {
            reason = 'no_credentials';
            detail = 'Alpaca adapter not registered — credentials may be missing';
          } else if (isAuthFailed(err)) {
            reason = 'auth_failed';
            detail = extractAuthDetail(err);
          } else {
            reason = 'fetch_failed';
            detail = `Equity fetch failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          setEquityCredFailed(true, reason, detail);
          // eslint-disable-next-line no-console
          console.warn(`[providerRegistry] alpaca: ${detail}`);
          useToastStore.getState().push({ kind: 'warn', title: 'Market data unavailable', detail });
          throw err; // re-throw — callers handle the empty-state rendering
        }

        if (isAdapterNotRegistered(err) || isMissingTauriCommand(err)) {
          // Degraded mode — keep the app usable with deterministic mock data.
          // Surface a toast for repeated failures via the AppShell catch handler.
          reportMockFallback(provider, sym, tf, err);
          return mockProvider.fetchHistory(sym, tf, count);
        }

        // Crypto reroute: if the pinned provider cannot serve this (tf, quote)
        // — e.g. coinbase for 4h/1w or USDT — retry the next capable crypto
        // provider before re-throwing (alpaca hard-fails above). The latest
        // page warms the in-memory cache on success.
        return rerouteCapable(err, provider, sym, tf, q, 'history fetch', async (fallback) => {
          const bars = await marketFetchHistory(fallback, sym, tf, count, q);
          ohlcCache.set(fallback, sym, q, tf, bars);
          return bars;
        });
      }
    },
    subscribeRealtime: (sym: string, tf: Tf, cb: (bar: Bar) => void): (() => void) => {
      // The alpaca adapter handles missing env creds gracefully — it returns a
      // noop unsubscribe + warns. No early-return guard needed here; letting
      // the call flow through means file-saved creds (invisible to
      // hasAlpacaCredentials()) still activate WS after a modal save.
      try {
        return wsSubscribe(provider, sym, tf, cb, q);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[providerRegistry] WS subscribe failed for ${provider}:${sym}@${tf}:`, err);
        return () => {};
      }
    },
    search: async (query: string): Promise<AssetMeta[]> => {
      return realProvider.search(query);
    },
    fetchHistoryBefore: async (sym: string, tf: Tf, before: number, count: number): Promise<Bar[]> => {
      // ------------------------------------------------------------------
      // Hard-fail path for equity (alpaca) — identical policy as fetchHistory.
      // Never silently return [] for equities; the caller renders an error state.
      // ------------------------------------------------------------------
      if (provider === 'alpaca') {
        if (isTauriRuntime()) {
          // Attempt the real fetch; classify and re-throw on failure.
          try {
            const bars = await marketFetchHistoryBefore(provider, sym, tf, count, q, before);
            setEquityCredFailed(false); // already in the alpaca-only branch
            return bars;
          } catch (err) {
            let reason: 'no_credentials' | 'fetch_failed' | 'auth_failed';
            let detail: string;
            if (isAdapterNotRegistered(err)) {
              reason = 'no_credentials';
              detail = 'Alpaca adapter not registered — credentials may be missing';
            } else if (isAuthFailed(err)) {
              reason = 'auth_failed';
              detail = extractAuthDetail(err);
            } else {
              reason = 'fetch_failed';
              detail = `Equity fetch failed: ${err instanceof Error ? err.message : String(err)}`;
            }
            setEquityCredFailed(true, reason, detail);
            // eslint-disable-next-line no-console
            console.warn(`[providerRegistry] alpaca fetchHistoryBefore: ${detail}`);
            useToastStore.getState().push({ kind: 'warn', title: 'Market data unavailable', detail });
            throw err; // re-throw — callers handle the empty-state rendering
          }
        }
        // No Tauri runtime → fall through to mock (vite dev path).
        return mockProvider.fetchHistoryBefore(sym, tf, before, count);
      }

      // ------------------------------------------------------------------
      // Crypto path: pick a capable provider (Step 1 reroute logic),
      // bypass ohlcCache early-return, call Rust directly.
      // ------------------------------------------------------------------
      try {
        const bars = await marketFetchHistoryBefore(provider, sym, tf, count, q, before);
        return bars;
      } catch (err) {
        if (isAdapterNotRegistered(err) || isMissingTauriCommand(err)) {
          // Degraded mode — fall back to mock for pagination too.
          reportMockFallback(provider, sym, tf, err);
          return mockProvider.fetchHistoryBefore(sym, tf, before, count);
        }

        // Capability reroute (paged): bypass the cache early-return and try the
        // next capable crypto provider before giving up.
        return rerouteCapable(err, provider, sym, tf, q, 'fetchHistoryBefore', (fallback) =>
          marketFetchHistoryBefore(fallback, sym, tf, count, q, before),
        );
      }
    },
  };
}

/**
 * Cross-provider symbol search (ADR-0009 §4).
 *
 * Routes the user's query through the SQLite FTS5 catalog via
 * `symbol_catalog_search`. For non-empty queries that don't already use FTS5
 * syntax, we append `*` for prefix matching (so typing `btc` matches `BTC`
 * rows) and strip a few characters that would otherwise break the MATCH
 * parser (quotes, parens). Empty/whitespace queries return `[]` — callers
 * fall back to the browse list (`symbolCatalogList`) for that case.
 *
 * Mock / browser-only path: there is no in-process symbol fixture anymore
 * (the duplicate catalog was retired in the live-catalog pivot). Symbol
 * search requires the real SQLite catalog, which only exists under the Tauri
 * runtime — so without it we return `[]` and warn once.
 */
export async function searchSymbols(
  query: string,
  opts?: { providers?: Provider[]; limit?: number },
): Promise<SymbolRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (isMockForced() || !isTauriRuntime()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[providerRegistry] symbol search requires the Tauri runtime (catalog unavailable in browser-only mode)',
    );
    useToastStore.getState().push({ kind: 'warn', title: 'Symbol search unavailable', detail: 'Catalog requires the Tauri runtime' });
    return [];
  }

  // Sanitize for FTS5: strip characters that break the MATCH grammar (quotes,
  // parens). Leave intra-word punctuation (e.g. `1000PEPE`) alone — FTS5
  // tokenises on whitespace by default.
  const sanitised = trimmed.replace(/[()"]/g, '').trim();
  if (!sanitised) return [];

  // Append `*` for prefix matching unless the user already used an FTS5
  // operator at the tail (`*`, `+`, `-`).
  const fts = /[*+-]$/.test(sanitised) ? sanitised : `${sanitised}*`;

  try {
    return await symbolCatalogSearch(fts, opts?.providers ?? null, opts?.limit ?? 50);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[providerRegistry] searchSymbols failed', err);
    return [];
  }
}

/** Test/diagnostic helper — exposes the underlying singletons. */
export const __providerRegistryInternals = {
  realProvider,
  mockProvider,
};
