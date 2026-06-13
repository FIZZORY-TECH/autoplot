/**
 * src/data/providerCapabilities.ts — Static capability table for market-data providers.
 *
 * Encodes which timeframes and quote currencies each provider supports so the
 * registry can reroute a history request that the pinned provider cannot serve.
 *
 * IMPORTANT: Keep this file in sync with the Rust `map_interval` functions.
 * Each provider entry links to its Rust counterpart below.
 */

import type { Provider, Tf } from './MarketDataProvider';
import { useToastStore } from '../stores/useToastStore';

/** Static capability descriptor for a single provider. */
export interface ProviderCap {
  /** Timeframes the provider's REST history endpoint supports. */
  tfs: Tf[];
  /** Quote currencies the provider supports (upper-case). */
  quotes: string[];
}

/**
 * CAP — static provider capability table.
 *
 * Timeframe sets mirror the Rust `map_interval` functions; quote sets mirror
 * the catalog discovery logic for each adapter.
 *
 * Rules:
 *   - coinbase: only '1h' and '1d' (4h/1w return ProviderError::Malformed).
 *     Accepts USD and USDC; does NOT accept USDT.
 *   - binance: all four tiers; accepts USDT and USDC.
 *   - kraken: all four tiers; accepts USD (primary), USDT and USDC via the
 *     un-prefixed base+quote concatenation path.
 *   - alpaca: all four tiers; USD only (equity provider — never rerouted).
 */
export const CAP: Record<Provider, ProviderCap> = {
  // mirror of src-tauri/src/providers/coinbase.rs map_interval — keep in sync
  // Supported: 1h (3600 s), 1d (86400 s). 4h and 1w are rejected errors.
  coinbase: {
    tfs: ['1h', '1d'],
    quotes: ['USD', 'USDC'],
  },

  // mirror of src-tauri/src/providers/binance.rs map_interval — keep in sync
  // Supported: all four tiers ("1h", "4h", "1d", "1w"). USDT and USDC pairs.
  binance: {
    tfs: ['1h', '4h', '1d', '1w'],
    quotes: ['USDT', 'USDC'],
  },

  // mirror of src-tauri/src/providers/kraken.rs map_interval — keep in sync
  // Supported: all four tiers (60, 240, 1440, 10080 minutes). USD primary;
  // USDT and USDC via the un-prefixed base+quote concatenation path.
  kraken: {
    tfs: ['1h', '4h', '1d', '1w'],
    quotes: ['USD', 'USDT', 'USDC'],
  },

  // mirror of src-tauri/src/providers/alpaca.rs map_interval — keep in sync
  // Equity provider — all tiers, USD only. Never rerouted by pickCapableProvider.
  alpaca: {
    tfs: ['1h', '4h', '1d', '1w'],
    quotes: ['USD'],
  },
};

/**
 * Return true when `provider` can serve history for the given `tf` and `quote`.
 */
export function isCapable(provider: Provider, tf: Tf, quote: string): boolean {
  const cap = CAP[provider];
  return cap.tfs.includes(tf) && cap.quotes.includes(quote.toUpperCase());
}

/**
 * CRYPTO_FALLBACK_CHAIN — the ordered crypto reroute chain (ADR-0009).
 *
 * Mirrors the inline chain previously embedded in `providerRegistry.ts`
 * (`capableFallbacks`): when the pinned crypto provider can't serve a
 * `(tf, quote)`, history fetches walk this chain in order. Alpaca is
 * intentionally absent — equities never reroute (they hard-fail).
 *
 * Exported so the registry's fallback loop and the resolver share one source
 * of truth for the chain order.
 */
export const CRYPTO_FALLBACK_CHAIN: Provider[] = ['binance', 'kraken'];

/**
 * Pick the first provider from `[preferred, ...CRYPTO_FALLBACK_CHAIN]` that is
 * capable of serving history for the given `(tf, quote)` combination.
 *
 * - Equities (alpaca) are out of scope — if `preferred` is 'alpaca', it is
 *   returned as-is without capability checks (alpaca hard-fails elsewhere).
 * - Only crypto providers are considered for fallback.
 *
 * @param _sym  Canonical token (e.g. 'BTC'). Reserved for future per-symbol
 *              routing; unused at this revision.
 * @param tf    Requested timeframe.
 * @param quote Requested quote currency (e.g. 'USDT', 'USD', 'USDC').
 * @param preferred  The caller's preferred provider (stored on the active asset).
 * @returns A capable `Provider`, falling back to 'binance' → 'kraken' in order.
 *          Throws if no capable provider exists (should never happen with the
 *          current capability table — binance covers all four tiers + USDT/USDC).
 */
export function pickCapableProvider(
  _sym: string,
  tf: Tf,
  quote: string,
  preferred: Provider,
): Provider {
  // Equity provider — never rerouted.
  if (preferred === 'alpaca') return preferred;

  // `preferred` is non-alpaca here (early-returned above), so the chain is
  // crypto-only — no equity skip needed.
  const candidates: Provider[] = [preferred, ...CRYPTO_FALLBACK_CHAIN];
  for (const candidate of candidates) {
    if (isCapable(candidate, tf, quote)) return candidate;
  }

  // Exhausted — should not occur given the current table (binance covers
  // all tfs + USDT/USDC). Surface a loud warning so we notice if the table
  // drifts, then return the preferred provider so the error propagates normally.
  // eslint-disable-next-line no-console
  console.warn(
    `[providerCapabilities] pickCapableProvider: no capable provider found for tf=${tf} quote=${quote}; using preferred=${preferred}`,
  );
  useToastStore.getState().push({ kind: 'error', title: 'Alpaca request failed', detail: `No capable provider for ${tf}/${quote}` });
  return preferred;
}

/**
 * resolveEffectiveProvider — the provider that will ACTUALLY serve
 * `(sym, tf, quote)` once reroute is taken into account.
 *
 * This is the single, pure, unit-testable answer to "where does this data
 * really come from?" — consulted by BOTH the history fetch path
 * (`providerRegistry.ts`, which caches under the effective provider's key) and
 * the realtime WS subscribe site (`AppShell.tsx`, which must target the
 * effective provider so live ticks keep flowing after a reroute).
 *
 * Behaviour:
 *   - If `pinnedProvider` is already capable of `(tf, quote)`, it is returned
 *     unchanged (no reroute).
 *   - Otherwise the crypto fallback chain (`CRYPTO_FALLBACK_CHAIN`) is walked
 *     and the first capable provider is returned — identical order to the
 *     fetch-path reroute.
 *   - For equities (`pinnedProvider === 'alpaca'`) the pinned provider is
 *     ALWAYS returned unchanged: equities never reroute (they hard-fail when
 *     they can't serve, surfacing an explicit error rather than a wrong price).
 *
 * Note: argument order is `(pinnedProvider, sym, tf, quote)` — pinned-provider
 * first, matching how callers think ("given this pinned provider, who serves
 * it?"). It delegates to `pickCapableProvider`, which keeps `sym` reserved for
 * future per-symbol routing.
 */
export function resolveEffectiveProvider(
  pinnedProvider: Provider,
  sym: string,
  tf: Tf,
  quote: string,
): Provider {
  return pickCapableProvider(sym, tf, quote, pinnedProvider);
}
