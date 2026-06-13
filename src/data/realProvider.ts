/**
 * src/data/realProvider.ts — Production `MarketDataProvider` (P4.1 substrate).
 *
 * This class implements the FROZEN `MarketDataProvider` interface (A3). After
 * the P4.5 providerRegistry refactor, `providerRegistry.getProvider(provider)`
 * is the canonical path for REST + WS: it pins the provider explicitly and
 * routes WS through the per-provider TS adapters. `RealMarketDataProvider`
 * survives only as the `search` delegate for the registry (Step 5b retains the
 * frozen interface shape; Step 7 widens the modal/palette to call
 * `searchSymbols` from `providerRegistry` directly).
 *
 * ADR-0009 — Step 5b removed the unsound `providerFor(sym)` helper that
 * looked up the canonical provider from the 19-row `ASSETS` constant. With a
 * dynamic multi-quote catalog, a `sym` no longer maps to a single
 * `(provider, quote)` tuple. Callers must thread `(provider, quote)`
 * explicitly via `useAppStore.activeAsset` (Step 5b) or `getProvider(provider,
 * quote)` (Step 5b.5). The dead `fetchHistory` and `subscribeRealtime` paths
 * below now delegate straight to the mock so any stray caller still resolves
 * without hitting a removed code path.
 */
import type {
  AssetMeta,
  Bar,
  MarketDataProvider,
  Tf,
} from './MarketDataProvider';
import { MockMarketDataProvider } from './mockProvider';

export class RealMarketDataProvider implements MarketDataProvider {
  /** Mock fallback — used for `search` until/unless a provider exposes a real
   *  symbol-search endpoint, and as the safety net for the unused REST/WS
   *  methods that the providerRegistry routes around. */
  private readonly mock: MockMarketDataProvider;

  constructor(mock: MockMarketDataProvider = new MockMarketDataProvider()) {
    this.mock = mock;
  }

  /**
   * Retained for `MarketDataProvider` interface conformance only — the
   * providerRegistry now routes REST through Rust directly with an explicit
   * `(provider, quote)` pair. Any direct caller falls through to mock so the
   * frozen contract still holds.
   */
  async fetchHistory(sym: string, tf: Tf, count: number): Promise<Bar[]> {
    return this.mock.fetchHistory(sym, tf, count);
  }

  /**
   * Retained for interface conformance — the providerRegistry routes WS
   * through per-provider TS adapters. Returning a noop unsubscribe keeps the
   * frozen contract honoured for any direct caller.
   */
  subscribeRealtime(_sym: string, _tf: Tf, _cb: (bar: Bar) => void): () => void {
    return () => {};
  }

  /** Local registry search until/unless a provider exposes a real one. */
  async search(query: string): Promise<AssetMeta[]> {
    return this.mock.search(query);
  }
}
