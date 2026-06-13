/**
 * MockMarketDataProvider — deterministic test/dev fixture.
 *
 * Implements MarketDataProvider using a mulberry32 PRNG seeded from the asset
 * symbol so that:
 *   - Each asset produces the same bar series on every call.
 *   - Different assets produce different bar series.
 *
 * Ported verbatim from app-design/project/data.js (mulberry32 + generateOHLC).
 * The mock is used in tests and offline dev; P4 replaces it with real adapters.
 *
 * The mock provider only synthesises quote/history data now. The in-process
 * symbol-catalog fixture and its search/list helpers were removed in the
 * live-catalog pivot: symbol resolution must come from the real SQLite catalog
 * under the Tauri runtime, never from a duplicate in-process fixture.
 */
import type { Bar, Tf, AssetMeta, MarketDataProvider } from './MarketDataProvider';
import type { SymbolRow } from '../lib/db';
import { tfToMs } from './tf';

// ---------------------------------------------------------------------------
// PRNG (verbatim port from data.js)
// ---------------------------------------------------------------------------

/** mulberry32 seeded PRNG — returns a function that yields [0, 1) floats. */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a numeric seed from a symbol string (verbatim port of data.js symSeed). */
function symSeed(sym: string): number {
  let s = 0;
  for (let i = 0; i < sym.length; i++) {
    s = (s * 31 + sym.charCodeAt(i)) | 0;
  }
  return (s * 7919) || 1;
}

// ---------------------------------------------------------------------------
// Per-asset config (mirrors data.js ASSETS but only for crypto assets we ship)
// ---------------------------------------------------------------------------

interface AssetConfig {
  seed: number; // price seed (starting price level)
  vol: number;  // volatility factor
}

const ASSET_CONFIG: Record<string, AssetConfig> = {
  // Crypto fixtures (price in USD, crypto-typical vol)
  BTC:  { seed: 67400, vol: 0.022 },
  ETH:  { seed: 3420,  vol: 0.025 },
  SOL:  { seed: 178,   vol: 0.040 },
  AVAX: { seed: 38,    vol: 0.045 },
  LINK: { seed: 14.6,  vol: 0.038 },
  DOGE: { seed: 0.142, vol: 0.055 },
  MATIC:{ seed: 0.84,  vol: 0.042 },
  ADA:  { seed: 0.42,  vol: 0.040 },
  XRP:  { seed: 0.58,  vol: 0.038 },
  DOT:  { seed: 7.2,   vol: 0.044 },
  ATOM: { seed: 9.4,   vol: 0.040 },
  NEAR: { seed: 4.8,   vol: 0.045 },
  APT:  { seed: 9.1,   vol: 0.048 },
  // US Equity fixtures — base prices in $100–$500 range, ~1.5% daily vol
  // (equity vol is materially lower than crypto; 0.015 ≈ 1.5% per-bar noise).
  // Seeds are chosen to produce visually distinct starting price levels.
  // RNG: mulberry32(symSeed(sym)) — deterministic from symbol, same PRNG as crypto.
  AAPL: { seed: 185,   vol: 0.015 }, // ~$185 large-cap, low vol
  MSFT: { seed: 420,   vol: 0.014 }, // ~$420 large-cap, low vol
  NVDA: { seed: 480,   vol: 0.020 }, // ~$480 large-cap, higher vol
  TSLA: { seed: 175,   vol: 0.025 }, // ~$175 mid-vol consumer
  SPY:  { seed: 510,   vol: 0.010 }, // ~$510 broad index ETF, low vol
  QQQ:  { seed: 440,   vol: 0.012 }, // ~$440 tech index ETF
};

// ---------------------------------------------------------------------------
// mockSymbolCatalogList — retired stub (live-catalog pivot)
// ---------------------------------------------------------------------------

/**
 * Retired mock equivalent of `symbolCatalogList(provider, limit, offset)`.
 *
 * The duplicate in-process symbol fixture was removed: symbol resolution now
 * flows exclusively through the real SQLite catalog under the Tauri runtime.
 * This stub returns an empty result and is retained only so the
 * out-of-scope MCP bridge import keeps compiling; browser-only / mock contexts
 * have no curated symbol source.
 */
export function mockSymbolCatalogList(
  _provider: string,
  _limit: number,
  _offset: number,
): { rows: SymbolRow[]; total: number } {
  return { rows: [], total: 0 };
}

// ---------------------------------------------------------------------------
// Bar generator (verbatim port of data.js generateOHLC)
// ---------------------------------------------------------------------------

/**
 * Generate `count` deterministic OHLCV bars for `sym` at timeframe `tf`.
 *
 * @param sym      Canonical asset token (e.g. 'BTC').
 * @param count    Number of bars to produce.
 * @param tf       Timeframe bucket size.
 * @param anchorMs Optional epoch-ms anchor; the newest bar's timestamp will be
 *                 the largest multiple of `tfMs` that is ≤ `anchorMs`.
 *                 Defaults to `Date.now()` when omitted — preserving the
 *                 original behaviour of the pre-Step-3 implementation.
 *
 * Bars are returned in ascending `ts` order (oldest first, newest last).
 */
function generateOHLC(sym: string, count: number, tf: Tf, anchorMs?: number): Bar[] {
  const cfg: AssetConfig = ASSET_CONFIG[sym] ?? { seed: 100, vol: 0.03 };
  const rng = mulberry32(symSeed(sym));

  const out: Bar[] = [];
  let price = cfg.seed;
  let trend = 0;
  let regimeTimer = 0;

  // Anchor timestamps: newest bar ends at a round epoch multiple
  const tfMs = tfToMs(tf);
  const resolvedAnchor = anchorMs !== undefined ? anchorMs : Date.now();
  const newestTs = Math.floor(resolvedAnchor / tfMs) * tfMs;
  const startTs = newestTs - (count - 1) * tfMs;

  for (let i = 0; i < count; i++) {
    if (regimeTimer <= 0) {
      trend = (rng() - 0.5) * cfg.vol * 2.4;
      regimeTimer = 20 + Math.floor(rng() * 60);
    }
    regimeTimer--;
    trend *= 0.985;
    const noise = (rng() - 0.5) * cfg.vol;
    const drift = trend + noise;
    const open = price;
    const close = Math.max(open * (1 + drift), open * 0.001);
    const wick =
      Math.abs(rng()) * cfg.vol * 0.6 + Math.abs(drift) * 0.4;
    const high =
      Math.max(open, close) * (1 + wick * (0.4 + rng() * 0.6));
    const low =
      Math.min(open, close) * (1 - wick * (0.4 + rng() * 0.6));
    const v = (0.4 + rng()) * (1 + Math.abs(drift) * 18);

    out.push({ ts: startTs + i * tfMs, o: open, h: high, l: low, c: close, v });
    price = close;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MockMarketDataProvider
// ---------------------------------------------------------------------------

export class MockMarketDataProvider implements MarketDataProvider {
  private readonly defaultCount: number;

  constructor(defaultCount = 600) {
    this.defaultCount = defaultCount;
  }

  /**
   * Returns `count` deterministic bars for `sym` at timeframe `tf`.
   * The seed is derived from `sym` so each asset is consistent across calls.
   */
  async fetchHistory(sym: string, tf: Tf, count: number): Promise<Bar[]> {
    return generateOHLC(sym, count > 0 ? count : this.defaultCount, tf);
  }

  /**
   * Returns `count` deterministic bars whose timestamps are strictly older than
   * `before` (epoch-ms). Bars are in ascending `ts` order.
   *
   * The anchor is `before - tfMs` (the bar slot immediately preceding `before`),
   * so the newest returned bar satisfies `ts < before`. The same PRNG seed as
   * `fetchHistory` is used for consistency across calls with the same `before`.
   *
   * Step 3 (Part A) — consumed by the `fetchHistoryBefore` in providerRegistry
   * and exercised directly by unit tests for determinism and boundary assertions.
   */
  async fetchHistoryBefore(sym: string, tf: Tf, before: number, count: number): Promise<Bar[]> {
    const tfMs = tfToMs(tf);
    // The newest bar in this window is the slot immediately before `before`.
    const anchorMs = before - tfMs;
    return generateOHLC(sym, count > 0 ? count : this.defaultCount, tf, anchorMs);
  }

  /**
   * Emits a synthetic tick approximately every 1 second using `setInterval`.
   * Each tick produces the next bar extrapolated deterministically from the
   * last bar in the history so overlays can track it.
   *
   * Returns an unsubscribe function — callers MUST call it on cleanup.
   */
  subscribeRealtime(sym: string, tf: Tf, cb: (bar: Bar) => void): () => void {
    const lastBars = generateOHLC(sym, this.defaultCount, tf);
    let lastBar = lastBars[lastBars.length - 1];
    const tfMs = tfToMs(tf);
    const cfg: AssetConfig = ASSET_CONFIG[sym] ?? { seed: 100, vol: 0.03 };

    const rng = mulberry32((symSeed(sym) + Date.now()) | 0);

    const id = setInterval(() => {
      const drift = (rng() - 0.5) * cfg.vol * 0.1;
      const newClose = Math.max(lastBar.c * (1 + drift), lastBar.c * 0.001);
      const newBar: Bar = {
        ts: lastBar.ts + tfMs,
        o: lastBar.c,
        h: Math.max(lastBar.c, newClose) * (1 + Math.abs(rng()) * 0.002),
        l: Math.min(lastBar.c, newClose) * (1 - Math.abs(rng()) * 0.002),
        c: newClose,
        v: (0.4 + rng()) * cfg.vol * 1000,
      };
      lastBar = newBar;
      cb(newBar);
    }, 1000);

    return () => clearInterval(id);
  }

  /**
   * Symbol search — retired in the live-catalog pivot.
   *
   * The duplicate in-process symbol fixture this used to read was removed;
   * symbol resolution now flows exclusively through the real SQLite catalog under the
   * Tauri runtime. The mock provider only synthesises quote/history data, so
   * its `search` returns `[]` to satisfy the FROZEN MarketDataProvider
   * interface without inventing fake symbols.
   */
  async search(_query: string): Promise<AssetMeta[]> {
    return [];
  }
}
