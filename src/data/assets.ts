/**
 * Asset registry — crypto + US equities (ADR-0008).
 * Provider tags reflect the most-likely listing; adapter-internal symbol mapping is separate.
 */
import type { AssetMeta, Provider } from './MarketDataProvider';

// ADR-0009 / Step 11 — `quote` is required on every AssetMeta. The curated
// crypto rows below carry their per-provider default (USDT for binance, USD
// for coinbase/kraken) so existing callsites keep producing canonical
// `(sym, provider, quote)` tuples without a backfill at the consumer.
//
// Live-catalog pivot: the 6 hardcoded equity rows (AAPL/MSFT/NVDA/TSLA/SPY/QQQ)
// were removed. Equity (Alpaca) symbols must resolve through the live SQLite
// catalog with real credentials — there is no curated/duplicate equity source
// here anymore. Crypto remains key-free and curated below.
export const ASSETS: AssetMeta[] = [
  // Crypto (13) — Coinbase / Binance / Kraken
  { sym: 'BTC',  name: 'Bitcoin',   provider: 'coinbase', quote: 'USD',  class: 'crypto' },
  { sym: 'ETH',  name: 'Ethereum',  provider: 'coinbase', quote: 'USD',  class: 'crypto' },
  { sym: 'SOL',  name: 'Solana',    provider: 'binance',  quote: 'USDT', class: 'crypto' },
  { sym: 'AVAX', name: 'Avalanche', provider: 'binance',  quote: 'USDT', class: 'crypto' },
  { sym: 'LINK', name: 'Chainlink', provider: 'coinbase', quote: 'USD',  class: 'crypto' },
  { sym: 'DOGE', name: 'Dogecoin',  provider: 'binance',  quote: 'USDT', class: 'crypto' },
  { sym: 'MATIC',name: 'Polygon',   provider: 'kraken',   quote: 'USD',  class: 'crypto' },
  { sym: 'ADA',  name: 'Cardano',   provider: 'kraken',   quote: 'USD',  class: 'crypto' },
  { sym: 'XRP',  name: 'Ripple',    provider: 'binance',  quote: 'USDT', class: 'crypto' },
  { sym: 'DOT',  name: 'Polkadot',  provider: 'kraken',   quote: 'USD',  class: 'crypto' },
  { sym: 'ATOM', name: 'Cosmos',    provider: 'coinbase', quote: 'USD',  class: 'crypto' },
  { sym: 'NEAR', name: 'NEAR',      provider: 'binance',  quote: 'USDT', class: 'crypto' },
  { sym: 'APT',  name: 'Aptos',     provider: 'coinbase', quote: 'USD',  class: 'crypto' },
];
// Total: 13 crypto assets (equities now resolve via the live catalog only)

/**
 * Per-symbol brand hues in OKLCH, tuned to the dark-glass palette
 * (L 0.70–0.80, C 0.14–0.20 — same range as --accent/--up/--down/--violet).
 * Hue picks are brand-recognizable where a convention exists; otherwise a
 * distinct slot on the wheel that isn't already used.
 */
export const ASSET_COLORS: Record<string, string> = {
  // Crypto — hues tuned to brand conventions on the dark-glass palette.
  BTC:   'oklch(0.78 0.16 65)',   // amber-orange
  ETH:   'oklch(0.74 0.18 280)',  // indigo-violet
  SOL:   'oklch(0.76 0.16 175)',  // teal-green
  AVAX:  'oklch(0.72 0.20 25)',   // avalanche red
  LINK:  'oklch(0.76 0.16 240)',  // chainlink blue
  DOGE:  'oklch(0.82 0.16 90)',   // doge yellow
  MATIC: 'oklch(0.74 0.18 300)',  // polygon purple
  ADA:   'oklch(0.74 0.16 250)',  // cardano blue
  XRP:   'oklch(0.78 0.014 260)', // ripple ink-grey (within ink ramp)
  DOT:   'oklch(0.74 0.18 350)',  // polkadot pink
  ATOM:  'oklch(0.74 0.16 215)',  // cosmos cyan-blue
  NEAR:  'oklch(0.78 0.14 195)',  // near aqua
  APT:   'oklch(0.76 0.16 155)',  // aptos green
  // Equity (Alpaca) brand hues were removed with the hardcoded equity rows
  // (live-catalog pivot). Equity symbols resolved from the live catalog fall
  // back to `hashToOklch(`${sym}/${quote}`)` for a deterministic color.
};

/**
 * Deterministic, contrast-safe OKLCH color for symbols not in `ASSET_COLORS`.
 * FNV-1a 32-bit over the UTF-16 codepoints of `key`; hue mapped onto the
 * safe band [0, 70) ∪ [110, 360) to avoid the yellow-green minimum-luminance
 * region against dark-glass `--bg-0`. Output is L=0.74 C=0.16 — same palette
 * anchors as the curated brand hues in ASSET_COLORS.
 *
 * Callers: `Headline`, `AssetPanel`, `AddAssetModal` rows for non-curated symbols.
 * Use as `ASSET_COLORS[sym] ?? hashToOklch(`${sym}/${quote}`)`.
 *
 * ADR-0009 — color fallback for the dynamic symbol catalog.
 */
export function hashToOklch(key: string): string {
  // FNV-1a 32-bit hash
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Convert to unsigned 32-bit
  h = h >>> 0;

  // Map to safe hue band [0, 70) ∪ [110, 360) — 320 values total.
  // [0, 70) contributes 70 values; [110, 360) contributes 250 values.
  const r = h % 320;
  const hue = r < 70 ? r : r + 40;

  return `oklch(0.74 0.16 ${hue})`;
}

/**
 * Human-readable display names for each provider.
 * Used in asset row badges so the badge renders "Alpaca" not lowercase "alpaca".
 * Add new providers here when they are added to the Provider union (ADR-0008).
 */
export const PROVIDER_DISPLAY_NAME: Record<Provider, string> = {
  binance:  'Binance',
  coinbase: 'Coinbase',
  kraken:   'Kraken',
  alpaca:   'Alpaca',
};
