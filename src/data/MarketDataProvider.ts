// FROZEN INTERFACE — see docs/adr/0001-market-data-provider-frozen.md (Architectural Decision A3).
// No phase after P1.1 may mutate this file. P3 consumes via the mock; P4 implements for real adapters.
// If a real gap is found, STOP and surface for explicit user review.

/** Canonical 4-tier timeframe set. User-locked per G-4 resolution. Do NOT add 5m or 15m. */
export type Tf = '1h' | '4h' | '1d' | '1w';

/** Supported real-data providers. Provider-specific symbol mapping (e.g. BTC→BTCUSDT) is adapter-internal. */
export type Provider = 'coinbase' | 'binance' | 'kraken' | 'alpaca';

/** Asset classes. ADR-0008 widened this from crypto-only to include equities. */
export type AssetClass = 'crypto' | 'equity';

/**
 * A single OHLCV bar.
 * `ts` is unix epoch in milliseconds (UTC).
 * `sym` is the canonical provider-agnostic token (e.g. 'BTC').
 */
export interface Bar {
  ts: number; // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Metadata for a tradeable asset.
 * `sym` is always the canonical provider-agnostic token (e.g. 'BTC', 'ETH').
 * Provider-specific strings (BTCUSDT / BTC-USD / XBT/USD) are adapter concerns.
 *
 * ADR-0009: `quote` widens the canonical identity from (provider, sym) to
 * (provider, sym, quote). Step 11 of the rollout closed the transition window
 * — `quote` is now **required** on every `AssetMeta`. Legacy fixtures and
 * test factories that pre-dated multi-quote should supply
 * `defaultQuoteForProvider(provider)` from `useWatchlistStore.ts`.
 */
export interface AssetMeta {
  sym: string;      // e.g. 'BTC'
  /** Canonical quote token, e.g. 'USDT', 'USDC', 'USD' (ADR-0009 / Step 11). */
  quote: string;
  name: string;     // e.g. 'Bitcoin'
  provider: Provider;
  class: AssetClass;
}

/**
 * MarketDataProvider — FROZEN INTERFACE (A3).
 *
 * Implement this for:
 *   - MockMarketDataProvider (P1.1 — deterministic test fixture)
 *   - CoinbaseProvider       (P4.3 — real REST + WS)
 *   - BinanceProvider        (P4.2 — real REST + WS)
 *   - KrakenProvider         (P4.4 — real REST + WS)
 *
 * Constraints:
 *   - `sym` is always the canonical token (e.g. 'BTC'). Adapters map to provider-specific symbols internally.
 *   - `tf` is always one of the 4-tier set: '1h' | '4h' | '1d' | '1w'.
 *   - `count` is the requested bar count; adapters may paginate internally to fulfil large requests.
 *   - `subscribeRealtime` returns an unsubscribe callback; callers MUST call it on cleanup.
 */
export interface MarketDataProvider {
  /**
   * Fetch historical OHLCV bars for `sym` at timeframe `tf`, newest bar last.
   * Returns exactly `count` bars (or fewer if not enough history exists).
   */
  fetchHistory(sym: string, tf: Tf, count: number): Promise<Bar[]>;

  /**
   * Subscribe to real-time bar updates for `sym` at timeframe `tf`.
   * `cb` is called with each new/updated bar.
   * Returns an unsubscribe function — MUST be called to stop the subscription.
   */
  subscribeRealtime(sym: string, tf: Tf, cb: (bar: Bar) => void): () => void;

  /**
   * Search the asset registry by query string (matches sym or name, case-insensitive).
   * Returns ranked matches.
   */
  search(query: string): Promise<AssetMeta[]>;
}
