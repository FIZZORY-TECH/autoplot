/**
 * Shared OHLC bar fetch path for AI tool handlers (`fetch_ohlc`,
 * `compute_indicator`, `backtest_strategy`). Routes to the mock provider when
 * the browser-only `use-mock-provider` flag is set, else to the Rust REST
 * orchestrator via `marketFetchHistory`.
 *
 * ADR-0009 / Step 7 — the canonical instrument identity is
 * `(provider, sym, quote)`. The MCP tool surface still only carries `sym`
 * (a single token); for the implicit provider + quote, we prefer the
 * currently-active asset (`useAppStore.activeAsset`) and fall back to the
 * legacy `ASSETS` lookup + per-provider default quote when no asset is
 * selected. This keeps existing AI handlers working without widening every
 * tool schema in this step.
 */
import type { Bar, Provider, Tf } from '../../data/MarketDataProvider';
import { marketFetchHistory } from '../../lib/db';
import { ASSETS } from '../../data/assets';
import { isMockForced } from '../../data/providerRegistry';
import { MockMarketDataProvider } from '../../data/mockProvider';
import { useAppStore } from '../../stores/useAppStore';
import { defaultQuoteForProvider } from '../../stores/useWatchlistStore';
import { lookupSymbolMeta, peekSymbolMeta } from '../../data/symbolCatalog';
import { pickCapableProvider } from '../../data/providerCapabilities';

export const COUNT_MAX = 1500;
export const COUNT_DEFAULT = 500;

const mockProvider = new MockMarketDataProvider();

export function providerFor(sym: string): string {
  // ADR-0009 — resolution order (canonical → catalog → crypto → default):
  //   1. The active asset, when the requested sym matches it (carries the
  //      authoritative provider+quote).
  //   2. The shared catalog-meta cache, which covers equities that are NOT in
  //      the crypto-only ASSETS table (so an Alpaca symbol is not mis-routed
  //      to a crypto provider).
  //   3. The curated crypto ASSETS table.
  //   4. 'coinbase' as the final crypto default.
  const active = useAppStore.getState().activeAsset;
  if (active?.sym === sym) return active.provider;
  const cached = peekSymbolMeta(sym)?.provider;
  if (cached) return cached;
  return ASSETS.find((a) => a.sym === sym)?.provider ?? 'coinbase';
}

/** ADR-0009 — resolve the canonical quote for a sym. Prefers active asset. */
export function quoteFor(sym: string, provider: string): string {
  const active = useAppStore.getState().activeAsset;
  if (active?.sym === sym && active.provider === provider) return active.quote;
  return defaultQuoteForProvider(provider);
}

export async function fetchBars(sym: string, tf: Tf, count: number): Promise<Bar[]> {
  if (isMockForced()) return mockProvider.fetchHistory(sym, tf, count);
  // Warm the shared catalog-meta cache so `providerFor` can resolve equities
  // (absent from the crypto-only ASSETS table) without mis-routing them to a
  // crypto provider. Best-effort — a miss leaves the ASSETS fallback intact.
  const active = useAppStore.getState().activeAsset;
  if (active?.sym !== sym) await lookupSymbolMeta(sym);
  const storedProvider = providerFor(sym) as Provider;
  const quote = quoteFor(sym, storedProvider);
  // Reroute the fetch to a capable provider for this (tf, quote) combination
  // without mutating the stored activeAsset. Alpaca (equity) bypasses routing.
  const fetchProvider = pickCapableProvider(sym, tf, quote, storedProvider);
  return marketFetchHistory(fetchProvider, sym, tf, count, quote);
}
