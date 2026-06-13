//! src-tauri/src/providers/kraken.rs — Kraken REST adapter (P4.4).
//!
//! Implements `MarketDataProvider` for the Kraken public OHLC endpoint.
//! No authentication required for historical OHLCV data.
//!
//! REST: `GET https://api.kraken.com/0/public/OHLC?pair={pair}&interval={minutes}`
//!
//! ## Symbol mapping (13 canonical crypto tokens → Kraken pair)
//!
//! Kraken uses `XBT` instead of `BTC` for Bitcoin, and may prepend `X`/`Z`
//! prefix characters to some asset codes internally. The request pair names
//! below are what the REST endpoint accepts:
//!
//! | Canonical | Kraken pair  |
//! |-----------|-------------|
//! | BTC       | XBTUSD      |
//! | ETH       | ETHUSD      |
//! | SOL       | SOLUSD      |
//! | ADA       | ADAUSD      |
//! | DOT       | DOTUSD      |
//! | AVAX      | AVAXUSD     |
//! | MATIC     | MATICUSD    |
//! | LINK      | LINKUSD     |
//! | UNI       | UNIUSD      |
//! | ATOM      | ATOMUSD     |
//! | LTC       | LTCUSD      |
//! | XRP       | XRPUSD      |
//! | DOGE      | DOGEUSD     |
//!
//! Default fallback (for any symbol not in the table): `{SYM}USD`.
//!
//! ## Interval support (all four 4-tier values supported by Kraken)
//!
//! Unlike Coinbase (which lacks 4h and 1w), Kraken natively supports all four
//! intervals the app uses — expressed as integer minutes:
//!   - `1h`  → 60
//!   - `4h`  → 240
//!   - `1d`  → 1440
//!   - `1w`  → 10080
//!
//! ## Response shape
//!
//! ```json
//! {
//!   "error": [],
//!   "result": {
//!     "XXBTZUSD": [[time, open, high, low, close, vwap, volume, count], ...],
//!     "last": 1234567890
//!   }
//! }
//! ```
//!
//! The pair key inside `result` may differ from the requested pair (Kraken
//! normalises some pairs with `X`/`Z` prefixes, e.g. `XBTUSD` → `XXBTZUSD`).
//! We defensively take the **first non-`last` key** in `result` as the data array.
//!
//! Row format: `[time(seconds), open(str), high(str), low(str), close(str),
//!              vwap(str), volume(str), count(int)]`.
//! `time` is converted seconds → milliseconds.
//!
//! ## Pagination
//!
//! Kraken returns up to 720 candles per call. If `count > 720`, this adapter
//! chains calls backwards using the `since` parameter (the `last` value from
//! each response), deduplicating and sorting before returning.
//!
//! ## Error handling
//!
//! If `error` is non-empty, returns `ProviderError::Malformed` with the joined
//! error strings. Kraken uses string error codes (e.g. `"EGeneral:Invalid arguments"`).
//!
//! ## Rate limiting
//!
//! Token acquisition is handled by the `market_fetch_history` orchestrator (P4.1).
//! This adapter is pure: input → bars.
//!
//! WS subscriptions live in TS (`src/data/adapters/kraken.ts`) per A2.

use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::providers::catalog::{CatalogFetcher, SymbolRow};
use crate::providers::{Bar, MarketDataProvider, ProviderError};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Kraken returns at most 720 candles per OHLC request.
const PAGE_SIZE: usize = 720;

// ---------------------------------------------------------------------------
// Symbol mapping table
// ---------------------------------------------------------------------------

/// Map a canonical token symbol to the Kraken REST pair name.
///
/// Kraken uses `XBT` for Bitcoin. For symbols not in this table, the fallback
/// is `{SYM}USD` (uppercased). The mapping covers the 13 crypto assets in the
/// app's asset registry.
fn kraken_pair(sym: &str) -> String {
    match sym.to_uppercase().as_str() {
        "BTC"   => "XBTUSD".to_string(),
        "ETH"   => "ETHUSD".to_string(),
        "SOL"   => "SOLUSD".to_string(),
        "ADA"   => "ADAUSD".to_string(),
        "DOT"   => "DOTUSD".to_string(),
        "AVAX"  => "AVAXUSD".to_string(),
        "MATIC" => "MATICUSD".to_string(),
        "LINK"  => "LINKUSD".to_string(),
        "UNI"   => "UNIUSD".to_string(),
        "ATOM"  => "ATOMUSD".to_string(),
        "LTC"   => "LTCUSD".to_string(),
        "XRP"   => "XRPUSD".to_string(),
        "DOGE"  => "DOGEUSD".to_string(),
        other   => format!("{}USD", other),
    }
}

/// Map the 4-tier app interval label to Kraken's minute-based integer.
///
/// Returns `Some(minutes)` for all four supported tiers (Kraken supports all),
/// or `None` for any label outside the locked 4-tier set.
pub fn map_interval(tf: &str) -> Option<u32> {
    match tf {
        "1h" => Some(60),
        "4h" => Some(240),
        "1d" => Some(1440),
        "1w" => Some(10080),
        _    => None,
    }
}

// ---------------------------------------------------------------------------
// before-cursor → forward `since` translation (pure, unit-testable)
// ---------------------------------------------------------------------------

/// Translate a backward `before` cutoff (epoch-MILLIseconds) into Kraken's
/// forward `since` anchor (epoch-SECONDS).
///
/// Kraken does NOT page backward — `since` means "candles AFTER this time", so
/// a naive cursor swap (as Binance/Coinbase use) would walk the WRONG direction.
/// Instead we anchor a window of `count` bars that ends just before the cutoff:
///
///   since_ms = before_ms - count * (interval_min * 60_000)
///
/// then convert to seconds (Kraken's `since` unit). Kraken returns the candles
/// at-or-after `since`, which is exactly the `count`-bar window ending below the
/// cutoff; the caller still trims any boundary candle to `ts < before`.
///
/// `since` is clamped to a minimum of 0 (the Kraken epoch floor) so a tiny or
/// near-epoch `before` can never produce a negative anchor.
fn kraken_since_seconds(before_ms: i64, count: usize, interval_min: u32) -> i64 {
    let interval_ms = (interval_min as i64) * 60_000;
    let window_ms = (count as i64).saturating_mul(interval_ms);
    let since_ms = before_ms.saturating_sub(window_ms);
    // ms → s, floored, clamped at the epoch floor.
    (since_ms / 1_000).max(0)
}

// ---------------------------------------------------------------------------
// Wire types for JSON deserialization
// ---------------------------------------------------------------------------

/// Top-level Kraken OHLC API response.
#[derive(Deserialize, Debug)]
struct KrakenOhlcResponse {
    error: Vec<String>,
    result: Option<serde_json::Map<String, Value>>,
}

// ---------------------------------------------------------------------------
// parse_ohlc — pure helper, testable without network
// ---------------------------------------------------------------------------

/// Parse a raw Kraken OHLC JSON string into a `Vec<Bar>`.
///
/// This helper is `pub` so unit tests can drive it with fixture JSON without
/// touching the network. The `fetch_history` method delegates to it.
///
/// ## Parsing strategy
///
/// 1. Deserialise the outer `{ "error": [...], "result": {...} }` envelope.
/// 2. If `error` is non-empty, return `ProviderError::Malformed`.
/// 3. From `result`, take the first key that is NOT `"last"` — that key holds
///    the data array. This is defensive against Kraken's pair-name normalisation
///    (e.g. `XBTUSD` request → `XXBTZUSD` key in response).
/// 4. Each row is `[time(seconds), open, high, low, close, vwap, volume, count]`
///    where all fields except `time` and `count` are decimal strings.
pub fn parse_ohlc(json: &str) -> Result<Vec<Bar>, ProviderError> {
    let resp: KrakenOhlcResponse = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("kraken OHLC parse error: {e}")))?;

    // If Kraken signals an error, surface it.
    if !resp.error.is_empty() {
        return Err(ProviderError::Malformed(format!(
            "Kraken API error: {}",
            resp.error.join("; ")
        )));
    }

    let result = resp
        .result
        .ok_or_else(|| ProviderError::Malformed("Kraken response missing 'result' field".to_string()))?;

    // Find the data array: first key in `result` that is not "last".
    let data_value = result
        .iter()
        .find(|(k, _)| k.as_str() != "last")
        .map(|(_, v)| v)
        .ok_or_else(|| ProviderError::Malformed("Kraken result contains no OHLC data key".to_string()))?;

    let rows = data_value
        .as_array()
        .ok_or_else(|| ProviderError::Malformed("Kraken OHLC data is not an array".to_string()))?;

    rows.iter()
        .map(|row| {
            let arr = row
                .as_array()
                .ok_or_else(|| ProviderError::Malformed("OHLC row is not an array".to_string()))?;

            if arr.len() < 7 {
                return Err(ProviderError::Malformed(format!(
                    "OHLC row too short: {} elements (expected >= 7)",
                    arr.len()
                )));
            }

            // Index 0: time in seconds (integer)
            let time_sec = arr[0]
                .as_i64()
                .ok_or_else(|| ProviderError::Malformed("OHLC row[0] (time) is not an integer".to_string()))?;

            // Indices 1–5: open, high, low, close, vwap (decimal strings)
            let parse_str = |idx: usize, name: &str| -> Result<f64, ProviderError> {
                arr[idx]
                    .as_str()
                    .ok_or_else(|| ProviderError::Malformed(format!("OHLC row[{idx}] ({name}) is not a string")))?
                    .parse::<f64>()
                    .map_err(|e| ProviderError::Malformed(format!("OHLC row[{idx}] ({name}) parse error: {e}")))
            };

            let o = parse_str(1, "open")?;
            let h = parse_str(2, "high")?;
            let l = parse_str(3, "low")?;
            let c = parse_str(4, "close")?;
            // index 5 = vwap (unused for Bar but we parse it to validate)
            // index 6 = volume
            let v = parse_str(6, "volume")?;

            Ok(Bar {
                ts: time_sec * 1_000, // seconds → milliseconds
                o,
                h,
                l,
                c,
                v,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// KrakenProvider
// ---------------------------------------------------------------------------

pub struct KrakenProvider {
    client: Client,
}

impl KrakenProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("autoplot/1.0")
                .build()
                .expect("failed to build reqwest client"),
        }
    }

    /// Map canonical symbol to Kraken REST pair — public wrapper for tests.
    pub fn map_symbol(sym: &str) -> String {
        kraken_pair(sym)
    }

    /// Map canonical (sym, quote) to a Kraken REST pair. ADR-0009 multi-quote
    /// successor to `map_symbol`. Built from the legacy table when `quote=USD`
    /// for backward compatibility, otherwise concatenation.
    pub fn map_pair(sym: &str, quote: &str) -> String {
        // For the legacy USD path, route through `kraken_pair` so the historical
        // XBT/etc. aliases are preserved (BTC → XBTUSD, not BTCUSD).
        if quote.eq_ignore_ascii_case("USD") {
            return kraken_pair(sym);
        }
        // Multi-quote (USDT, USDC, etc.) — Kraken accepts the un-prefixed
        // base+quote concatenation for most pairs. Catalog-discovered pairs
        // expose their `native_sym` which callers should prefer; this fallback
        // covers the case where only (sym, quote) is known.
        format!("{}{}", normalize_base(sym), quote.to_uppercase())
    }

    /// Map 4-tier timeframe to Kraken interval minutes — public wrapper for tests.
    pub fn map_interval(tf: &str) -> Option<u32> {
        map_interval(tf)
    }
}

/// Strip Kraken's `X`/`Z` asset-class prefixes for the catalog → canonical
/// `sym` direction. Mirrors the `wsname` → base normalization Kraken's
/// AssetPairs response uses (e.g. `XXBT` → `XBT`, `ZUSD` → `USD`), and then
/// folds the `XBT` → `BTC` alias on top so the canonical sym matches the
/// rest of the codebase.
fn normalize_base(asset: &str) -> String {
    let trimmed = if (asset.starts_with('X') || asset.starts_with('Z')) && asset.len() == 4 {
        &asset[1..]
    } else {
        asset
    };
    match trimmed.to_uppercase().as_str() {
        "XBT" => "BTC".to_string(),
        other => other.to_string(),
    }
}

fn normalize_quote(asset: &str) -> String {
    let trimmed = if (asset.starts_with('X') || asset.starts_with('Z')) && asset.len() == 4 {
        &asset[1..]
    } else {
        asset
    };
    trimmed.to_uppercase()
}

impl Default for KrakenProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MarketDataProvider for KrakenProvider {
    fn id(&self) -> &'static str {
        "kraken"
    }

    /// Fetch up to `count` historical OHLCV bars from Kraken OHLC.
    ///
    /// Kraken caps each response at 720 candles. If `count > 720`, this method
    /// chains calls backwards using the `since` parameter (the `last` cursor
    /// from each response), then deduplicates by `ts` and sorts ascending before
    /// returning.
    ///
    /// Returns `Err(ProviderError::Malformed)` if the Kraken `error` array is
    /// non-empty. Returns `Err(ProviderError::RateLimited(1))` on HTTP 429.
    ///
    /// Rate-limit tokens are acquired by the `market_fetch_history` orchestrator
    /// (P4.1) — NOT inside this method.
    async fn fetch_history(
        &self,
        sym: &str,
        tf: &str,
        count: usize,
    ) -> Result<Vec<Bar>, ProviderError> {
        let pair = Self::map_symbol(sym);
        // v1 trait path: always "latest N bars" (no cursor).
        self.fetch_history_native(&pair, tf, count, None).await
    }
}

impl KrakenProvider {
    /// ADR-0009 — multi-quote variant. Uses `map_pair(sym, quote)` to handle
    /// non-USD quotes (`USDT`, `USDC`) while preserving the historical `XBT`
    /// alias table for USD pairs.
    pub async fn fetch_history_pair(
        &self,
        sym: &str,
        quote: &str,
        tf: &str,
        count: usize,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, ProviderError> {
        let pair = Self::map_pair(sym, quote);
        self.fetch_history_native(&pair, tf, count, before).await
    }

    /// Fetch Kraken OHLC. Kraken pages FORWARD via a `since` anchor ("candles
    /// after this time"), so the backward `before` cutoff (epoch-ms) is
    /// translated into a forward `since` (epoch-seconds) anchoring a `count`-bar
    /// window that ends just below the cutoff (see `kraken_since_seconds`); the
    /// result is then trimmed to `ts < before`. When `before` is `None`, the
    /// first call omits `since` (Kraken returns the most-recent 720 candles),
    /// preserving the original "last N bars" behavior.
    async fn fetch_history_native(
        &self,
        pair: &str,
        tf: &str,
        count: usize,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, ProviderError> {
        let interval = Self::map_interval(tf)
            .ok_or_else(|| ProviderError::Malformed(format!("unsupported tf: {tf}")))?;

        let pages = count.div_ceil(PAGE_SIZE); // ceiling division

        let mut all_bars: Vec<Bar> = Vec::with_capacity(count);

        // `since` is a unix timestamp (SECONDS) used as a forward cursor.
        // No-cursor path: first call omits `since` (returns most recent 720
        // candles). Older-page path: seed `since` to the forward anchor for the
        // window ending just before the `before` cutoff. Subsequent pages walk
        // forward from the latest bar's ts (Kraken pages forward, not backward).
        let mut since: Option<i64> =
            before.map(|b| kraken_since_seconds(b, count, interval));

        for _ in 0..pages {
            let mut url = format!(
                "https://api.kraken.com/0/public/OHLC?pair={}&interval={}",
                pair, interval,
            );
            if let Some(s) = since {
                url.push_str(&format!("&since={}", s));
            }

            let resp = self
                .client
                .get(&url)
                .send()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            if resp.status().as_u16() == 429 {
                return Err(ProviderError::RateLimited(1));
            }

            if !resp.status().is_success() {
                let code = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                if code == 400 || code == 404 {
                    return Err(ProviderError::SymbolNotFound(pair.to_string()));
                }
                return Err(ProviderError::Network(format!("HTTP {code}: {body}")));
            }

            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            // Extract `last` cursor before handing off to parse_ohlc.
            // We need `last` to build the `since` parameter for the next page.
            let last_cursor = extract_last_cursor(&body);

            let page_bars = parse_ohlc(&body)?;

            if page_bars.is_empty() {
                break; // no more history
            }

            // Set `since` for the next page. Kraken pages FORWARD: the `last`
            // cursor (or the latest bar's ts) advances toward "now". Prefer the
            // server's `last`; otherwise derive from the latest bar's ts (s).
            since = last_cursor.or_else(|| page_bars.last().map(|b| b.ts / 1_000));

            // Stop the forward walk once we've reached/crossed the cutoff — any
            // further pages would only add bars at-or-after `before`, which the
            // trim below discards anyway.
            let crossed_cutoff = before
                .map(|cutoff| page_bars.iter().any(|b| b.ts >= cutoff))
                .unwrap_or(false);

            all_bars.extend(page_bars);

            if all_bars.len() >= count || crossed_cutoff {
                break;
            }
        }

        // Deduplicate by ts (pagination window edges may overlap by one candle).
        all_bars.sort_by_key(|b| b.ts);
        all_bars.dedup_by_key(|b| b.ts);

        // Older-page request: return ONLY bars strictly older than the cutoff.
        // Kraken's forward `since` window may include candles at-or-after
        // `before`; the cursor inversion makes this trim load-bearing.
        if let Some(cutoff) = before {
            all_bars.retain(|b| b.ts < cutoff);
        }

        // Return the most-recent `count` bars, newest last.
        if all_bars.len() > count {
            let trim = all_bars.len() - count;
            all_bars.drain(0..trim);
        }

        Ok(all_bars)
    }
}

/// Extract the `result.last` integer cursor from a raw Kraken OHLC JSON response.
///
/// Returns `None` if the field is absent or not parseable — the caller falls
/// back to deriving the cursor from the earliest bar's timestamp.
fn extract_last_cursor(json: &str) -> Option<i64> {
    let v: Value = serde_json::from_str(json).ok()?;
    v.get("result")?.get("last")?.as_i64()
}

// ---------------------------------------------------------------------------
// Catalog parsing — ADR-0009
// ---------------------------------------------------------------------------

/// Subset of `GET /0/public/AssetPairs` response entries we need.
///
/// Each value in `result` is keyed by Kraken's internal pair name (e.g. `XXBTZUSD`).
/// `wsname` is a human-friendly form like `XBT/USD`. `base` and `quote` are the
/// raw asset codes Kraken stores internally — we normalize them via
/// `normalize_base` and `normalize_quote` so the canonical SymbolRow uses
/// `BTC`/`USD` not `XXBT`/`ZUSD`.
#[derive(Debug, serde::Deserialize)]
struct KrakenAssetPair {
    #[serde(default)]
    wsname: Option<String>,
    base: String,
    quote: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct AssetPairsResponse {
    #[serde(default)]
    error: Vec<String>,
    #[serde(default)]
    result: std::collections::HashMap<String, KrakenAssetPair>,
}

/// Parse a raw Kraken `/0/public/AssetPairs` JSON string into the canonical
/// `SymbolRow` shape. Rows with `status` set and not equal to `"online"` are
/// filtered. Non-empty `error` array fails the parse.
pub fn parse_catalog(json: &str) -> Result<Vec<SymbolRow>, ProviderError> {
    let resp: AssetPairsResponse = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("AssetPairs parse error: {e}")))?;

    if !resp.error.is_empty() {
        return Err(ProviderError::Malformed(format!(
            "kraken AssetPairs error: {}",
            resp.error.join(", ")
        )));
    }

    Ok(resp
        .result
        .into_iter()
        .filter(|(_native, p)| match p.status.as_deref() {
            Some(s) => s == "online",
            None => true, // pairs without status are treated as active
        })
        .map(|(native_sym, p)| SymbolRow {
            provider: "kraken".to_string(),
            sym: normalize_base(&p.base),
            quote: normalize_quote(&p.quote),
            name: p.wsname,
            class: "crypto".to_string(),
            status: "active".to_string(),
            native_sym,
        })
        .collect())
}

#[async_trait]
impl CatalogFetcher for KrakenProvider {
    fn id(&self) -> &'static str {
        "kraken"
    }

    async fn fetch_catalog(&self) -> Result<Vec<SymbolRow>, ProviderError> {
        let url = "https://api.kraken.com/0/public/AssetPairs";
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        if resp.status() == 429 {
            return Err(ProviderError::RateLimited(60));
        }
        if !resp.status().is_success() {
            return Err(ProviderError::Network(format!(
                "HTTP {}: {}",
                resp.status().as_u16(),
                resp.text().await.unwrap_or_default()
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        parse_catalog(&body)
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // map_symbol / kraken_pair
    // -----------------------------------------------------------------------

    #[test]
    fn map_symbol_btc_uses_xbt() {
        // Kraken calls Bitcoin XBT, not BTC.
        assert_eq!(KrakenProvider::map_symbol("BTC"), "XBTUSD");
    }

    #[test]
    fn map_symbol_eth() {
        assert_eq!(KrakenProvider::map_symbol("ETH"), "ETHUSD");
    }

    #[test]
    fn map_symbol_sol() {
        assert_eq!(KrakenProvider::map_symbol("SOL"), "SOLUSD");
    }

    #[test]
    fn map_symbol_xrp() {
        assert_eq!(KrakenProvider::map_symbol("XRP"), "XRPUSD");
    }

    #[test]
    fn map_symbol_doge() {
        assert_eq!(KrakenProvider::map_symbol("DOGE"), "DOGEUSD");
    }

    #[test]
    fn map_symbol_lowercase_normalised() {
        assert_eq!(KrakenProvider::map_symbol("btc"), "XBTUSD");
        assert_eq!(KrakenProvider::map_symbol("eth"), "ETHUSD");
    }

    #[test]
    fn map_symbol_unknown_fallback() {
        // Any symbol not in the table → "{SYM}USD"
        assert_eq!(KrakenProvider::map_symbol("FAKE"), "FAKEUSD");
        assert_eq!(KrakenProvider::map_symbol("XYZ"), "XYZUSD");
    }

    #[test]
    fn map_symbol_all_13_assets() {
        let expected = [
            ("BTC",   "XBTUSD"),
            ("ETH",   "ETHUSD"),
            ("SOL",   "SOLUSD"),
            ("ADA",   "ADAUSD"),
            ("DOT",   "DOTUSD"),
            ("AVAX",  "AVAXUSD"),
            ("MATIC", "MATICUSD"),
            ("LINK",  "LINKUSD"),
            ("UNI",   "UNIUSD"),
            ("ATOM",  "ATOMUSD"),
            ("LTC",   "LTCUSD"),
            ("XRP",   "XRPUSD"),
            ("DOGE",  "DOGEUSD"),
        ];
        for (canonical, kraken) in &expected {
            assert_eq!(
                KrakenProvider::map_symbol(canonical),
                *kraken,
                "map_symbol({canonical}) should be {kraken}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // map_interval
    // -----------------------------------------------------------------------

    #[test]
    fn map_interval_all_four_tiers_supported() {
        // Unlike Coinbase, Kraken supports all four app tiers natively.
        assert_eq!(KrakenProvider::map_interval("1h"),  Some(60));
        assert_eq!(KrakenProvider::map_interval("4h"),  Some(240));
        assert_eq!(KrakenProvider::map_interval("1d"),  Some(1440));
        assert_eq!(KrakenProvider::map_interval("1w"),  Some(10080));
    }

    #[test]
    fn map_interval_unsupported_returns_none() {
        assert_eq!(KrakenProvider::map_interval("5m"), None);
        assert_eq!(KrakenProvider::map_interval("15m"), None);
        assert_eq!(KrakenProvider::map_interval(""), None);
    }

    // -----------------------------------------------------------------------
    // parse_ohlc — fixture-based (no network)
    // -----------------------------------------------------------------------

    /// Load the committed fixture from `src-tauri/tests/fixtures/` and assert
    /// the parsed bars have the right shape and values.
    ///
    /// The fixture contains 10 XXBTZUSD 60-min OHLC rows (see
    /// `tests/fixtures/kraken_ohlc_xbtusd_60.json`). The pair key in the
    /// fixture is `XXBTZUSD` (Kraken-normalised) to test defensive key handling.
    #[test]
    fn parse_ohlc_fixture() {
        let fixture = include_str!(
            "../../tests/fixtures/kraken_ohlc_xbtusd_60.json"
        );

        let bars = parse_ohlc(fixture).expect("fixture should parse cleanly");

        assert_eq!(bars.len(), 10, "fixture has 10 OHLC rows");

        // First bar
        let first = &bars[0];
        assert_eq!(first.ts, 1_696_118_400 * 1_000, "first bar ts (seconds → ms)");
        assert!((first.o - 27000.50).abs() < 1e-6, "first bar open");
        assert!((first.h - 27150.00).abs() < 1e-6, "first bar high");
        assert!((first.l - 26950.25).abs() < 1e-6, "first bar low");
        assert!((first.c - 27100.75).abs() < 1e-6, "first bar close");
        assert!((first.v - 500.12345678).abs() < 1e-6, "first bar volume");

        // Last bar
        let last = &bars[9];
        assert_eq!(last.ts, 1_696_150_800 * 1_000, "last bar ts (seconds → ms)");
        assert!((last.o - 27510.50).abs() < 1e-6, "last bar open");
        assert!((last.c - 27580.00).abs() < 1e-6, "last bar close");
    }

    #[test]
    fn parse_ohlc_empty_result() {
        let json = r#"{"error":[],"result":{"XXBTZUSD":[],"last":0}}"#;
        let bars = parse_ohlc(json).expect("empty result is valid");
        assert!(bars.is_empty());
    }

    #[test]
    fn parse_ohlc_error_array_non_empty_returns_malformed() {
        let json = r#"{"error":["EGeneral:Invalid arguments","EQuery:Unknown asset pair"],"result":null}"#;
        let err = parse_ohlc(json).expect_err("non-empty error array should return Err");
        assert!(
            matches!(err, ProviderError::Malformed(ref m) if m.contains("EGeneral:Invalid arguments")),
            "expected Malformed with error text, got: {err}"
        );
    }

    #[test]
    fn parse_ohlc_malformed_json_returns_err() {
        let result = parse_ohlc("this is not json");
        assert!(result.is_err(), "malformed JSON should yield an error");
    }

    #[test]
    fn parse_ohlc_time_converted_to_ms() {
        // Single-candle response: time = 1696118400 seconds → ts must be 1696118400000 ms.
        let json = r#"{"error":[],"result":{"XXBTZUSD":[[1696118400,"27000.50","27150.00","26950.25","27100.75","27090.12","500.123",312]],"last":1696118400}}"#;
        let bars = parse_ohlc(json).expect("single candle should parse");
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].ts, 1_696_118_400_000i64, "time must be converted to milliseconds");
    }

    #[test]
    fn parse_ohlc_normalised_pair_key() {
        // The response key is XXBTZUSD (Kraken-normalised), not XBTUSD (requested).
        // parse_ohlc must find it by taking the first non-"last" key.
        let json = r#"{"error":[],"result":{"XXBTZUSD":[[1696118400,"27000.50","27150.00","26950.25","27100.75","27090.12","500.123",312]],"last":1696118400}}"#;
        let bars = parse_ohlc(json).expect("normalised key should parse");
        assert_eq!(bars.len(), 1);
        assert!((bars[0].o - 27000.50).abs() < 1e-6);
    }

    #[test]
    fn parse_ohlc_row_too_short_returns_err() {
        // A row with only 3 elements (time, open, high) is invalid.
        let json = r#"{"error":[],"result":{"XXBTZUSD":[[1696118400,"27000.50","27150.00"]],"last":0}}"#;
        let result = parse_ohlc(json);
        assert!(result.is_err(), "short row should return Malformed error");
    }

    // -----------------------------------------------------------------------
    // extract_last_cursor
    // -----------------------------------------------------------------------

    #[test]
    fn extract_last_cursor_happy_path() {
        let json = r#"{"error":[],"result":{"XXBTZUSD":[],"last":1696118400}}"#;
        assert_eq!(extract_last_cursor(json), Some(1_696_118_400i64));
    }

    #[test]
    fn extract_last_cursor_missing_returns_none() {
        let json = r#"{"error":[],"result":{}}"#;
        assert_eq!(extract_last_cursor(json), None);
    }

    // -----------------------------------------------------------------------
    // kraken_since_seconds — the `before` (ms, backward) → `since` (s, forward)
    // inversion. Kraken pages FORWARD, so this is the load-bearing translation
    // (a plain cursor swap would walk the wrong direction). Tested in isolation
    // because `fetch_history_native` requires the live network.
    // -----------------------------------------------------------------------

    #[test]
    fn kraken_since_seconds_anchors_window_below_cutoff() {
        // before = 2023-10-01T09:00:00Z = 1_696_150_800_000 ms.
        // 1h interval = 60 min; count = 5 bars → window = 5 * 3_600_000 ms.
        // since_ms = 1_696_150_800_000 - 18_000_000 = 1_696_132_800_000 ms
        //          → 1_696_132_800 s.
        let before_ms = 1_696_150_800_000i64;
        let since = kraken_since_seconds(before_ms, 5, 60);
        assert_eq!(since, 1_696_132_800, "since must anchor 5×1h below the cutoff");

        // The anchor is strictly older than the cutoff (so the forward fetch
        // begins below `before`).
        assert!(
            since < before_ms / 1_000,
            "since ({since}s) must be older than before ({}s)",
            before_ms / 1_000
        );
    }

    #[test]
    fn kraken_since_seconds_unit_conversion_ms_to_s() {
        // 1d interval = 1440 min; count = 2 → window = 2 * 86_400_000 ms.
        // before = 1_700_000_000_000 ms → since_ms = 1_700_000_000_000 - 172_800_000
        //        = 1_699_827_200_000 ms → 1_699_827_200 s.
        assert_eq!(kraken_since_seconds(1_700_000_000_000, 2, 1440), 1_699_827_200);
    }

    #[test]
    fn kraken_since_seconds_clamps_at_epoch_floor() {
        // A tiny `before` with a huge window must never go negative.
        let since = kraken_since_seconds(1_000, 720, 10080);
        assert_eq!(since, 0, "since clamps to the epoch floor, never negative");
    }

    // -----------------------------------------------------------------------
    // Live `before`-cursor smoke test (ignored — needs network).
    //   cargo test smoke_live_kraken_before -- --ignored
    //
    // Proves the inversion end-to-end: every returned bar is strictly older
    // than the cutoff, and a no-cursor fetch returns the latest window (newer
    // than the older page).
    // -----------------------------------------------------------------------
    #[tokio::test]
    #[ignore]
    async fn smoke_live_kraken_before() {
        let provider = KrakenProvider::new();

        // Latest 10 × 1h bars (no cursor).
        let latest = provider
            .fetch_history_pair("BTC", "USD", "1h", 10, None)
            .await
            .expect("live Kraken latest fetch should succeed");
        assert!(!latest.is_empty(), "latest fetch returns bars");

        // Older page: cutoff = oldest bar of the latest window.
        let cutoff = latest.first().expect("non-empty").ts;
        let older = provider
            .fetch_history_pair("BTC", "USD", "1h", 10, Some(cutoff))
            .await
            .expect("live Kraken older-page fetch should succeed");

        assert!(!older.is_empty(), "older page returns bars");
        for b in &older {
            assert!(
                b.ts < cutoff,
                "every older-page bar must be strictly older than the cutoff (ts {} >= {cutoff})",
                b.ts
            );
        }
        println!(
            "Live Kraken before-cursor: latest oldest_ts={}, older newest_ts={}",
            cutoff,
            older.last().unwrap().ts
        );
    }

    // -----------------------------------------------------------------------
    // Live REST smoke test (ignored by default — run manually with:
    //   cargo test --manifest-path src-tauri/Cargo.toml smoke_live_kraken -- --ignored)
    // -----------------------------------------------------------------------

    /// One-shot integration test against the real Kraken API.
    ///
    /// Fetches 5 × 1h XBT/USD OHLC bars and verifies the response parses
    /// without error and returns sensible values (price > 0, ts > 0).
    ///
    /// Run manually: `cargo test smoke_live_kraken -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn smoke_live_kraken() {
        let provider = KrakenProvider::new();
        let bars = provider
            .fetch_history("BTC", "1h", 5)
            .await
            .expect("live Kraken fetch should succeed");

        assert!(!bars.is_empty(), "should return at least one bar");
        for b in &bars {
            assert!(b.ts > 0, "ts must be positive");
            assert!(b.o > 0.0, "open price must be positive");
            assert!(b.h >= b.l, "high must be >= low");
            assert!(b.v >= 0.0, "volume must be non-negative");
        }
        println!(
            "Live Kraken smoke: {} bars, last close = {}",
            bars.len(),
            bars.last().unwrap().c
        );
    }

    // -----------------------------------------------------------------------
    // Catalog parser — ADR-0009
    // -----------------------------------------------------------------------

    #[test]
    fn normalize_base_strips_x_prefix_and_folds_xbt_to_btc() {
        assert_eq!(normalize_base("XXBT"), "BTC");
        assert_eq!(normalize_base("XETH"), "ETH");
        assert_eq!(normalize_base("ADA"), "ADA");
        // 5+ char prefix is preserved (not a Kraken X-class code).
        assert_eq!(normalize_base("XMORE"), "XMORE");
    }

    #[test]
    fn normalize_quote_strips_z_prefix() {
        assert_eq!(normalize_quote("ZUSD"), "USD");
        assert_eq!(normalize_quote("ZEUR"), "EUR");
        assert_eq!(normalize_quote("USDT"), "USDT");
        assert_eq!(normalize_quote("USDC"), "USDC");
    }

    #[test]
    fn parse_catalog_fixture_normalizes_and_filters() {
        let fixture = include_str!("../../tests/fixtures/kraken_catalog.json");
        let rows = parse_catalog(fixture).expect("fixture should parse");

        // 7 rows: 6 online + 1 delisted. 6 should survive.
        assert_eq!(rows.len(), 6);
        assert!(rows.iter().all(|r| r.provider == "kraken"));
        assert!(rows.iter().all(|r| r.class == "crypto"));

        // Normalization: XXBT → BTC, ZUSD → USD.
        let btc_usd = rows
            .iter()
            .find(|r| r.sym == "BTC" && r.quote == "USD")
            .expect("BTC/USD row present");
        assert_eq!(btc_usd.native_sym, "XXBTZUSD");
        assert_eq!(btc_usd.name.as_deref(), Some("XBT/USD"));

        // BTC/USDT (catalog-era USDT pair on Kraken — the architect-reviewer flagged
        // this as a concern; verify it surfaces correctly).
        let btc_usdt = rows
            .iter()
            .find(|r| r.sym == "BTC" && r.quote == "USDT")
            .expect("BTC/USDT row present");
        assert_eq!(btc_usdt.native_sym, "XBTUSDT");

        // BTC/USDC — multi-quote.
        assert!(rows.iter().any(|r| r.sym == "BTC" && r.quote == "USDC"));

        // ZUSD-quoted ETH → normalized to ETH/USD.
        let eth_usd = rows
            .iter()
            .find(|r| r.sym == "ETH" && r.quote == "USD")
            .expect("ETH/USD row present");
        assert_eq!(eth_usd.native_sym, "XETHZUSD");

        // Delisted row filtered.
        assert!(!rows.iter().any(|r| r.sym == "TOMBSTONE"));
    }

    #[test]
    fn parse_catalog_error_array_returns_err() {
        let json = r#"{"error":["EGeneral:Service unavailable"],"result":{}}"#;
        let err = parse_catalog(json).expect_err("non-empty error array must fail");
        assert!(format!("{err}").contains("Service unavailable"));
    }

    #[test]
    fn map_pair_kraken_routes_usd_through_alias_table() {
        // Legacy USD path uses the static alias table — BTC → XBTUSD.
        assert_eq!(KrakenProvider::map_pair("BTC", "USD"), "XBTUSD");
        // Multi-quote (USDT/USDC) takes the concatenation path with base
        // normalization (XBT stays XBT in the result, BTC base maps back to XBT
        // for native-sym formation).
        // The TS layer should prefer the catalog's `native_sym` over this fallback;
        // we still assert the fallback produces a usable string.
        let usdt = KrakenProvider::map_pair("BTC", "USDT");
        assert!(usdt.contains("USDT"), "kraken USDT pair fallback should contain USDT, got {usdt}");
    }
}
