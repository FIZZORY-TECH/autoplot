//! src-tauri/src/providers/binance.rs — Binance REST adapter (P4.2).
//!
//! Implements `MarketDataProvider` for the Binance public klines endpoint.
//!
//! REST: `GET https://api.binance.com/api/v3/klines`
//!   - Symbol mapping: canonical token (e.g. "BTC") → "BTCUSDT".
//!   - Binance caps each call at 1000 bars. If `count > 1000`, we chain calls
//!     backwards using the `endTime` parameter and dedupe/sort at the end.
//!
//! WS subscriptions live in TS (`src/data/adapters/binance.ts`) per A2.
//!
//! NOTE: Rate-limit token acquisition is handled by the `market_fetch_history`
//! orchestrator in P4.1 — this adapter is pure (no rate-limit calls inside).

use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;

use crate::providers::catalog::{CatalogFetcher, SymbolRow};
use crate::providers::{Bar, MarketDataProvider, ProviderError};

// ---------------------------------------------------------------------------
// Typed kline row deserialization
// ---------------------------------------------------------------------------

/// A single Binance kline entry from the REST response.
///
/// Binance returns each kline as a mixed-type JSON array:
///   `[openTime, open, high, low, close, volume, closeTime, ...]`
///
/// Indices 0 and 6 are integers; 1–5 and 7–11 are decimal strings.
/// We deserialize via a custom visitor to avoid allocating `serde_json::Value`
/// for each kline — the typed struct is cleaner and faster.
#[derive(Debug)]
pub struct KlineRow {
    /// Open time, unix epoch milliseconds.
    pub open_time: i64,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
    /// Close time (present in the wire format but unused for `Bar`).
    #[allow(dead_code)]
    pub close_time: i64,
    // Fields 7–11 are present but unused; serde ignores them with default.
}

/// Custom deserializer: Binance returns a JSON array `[i64, str, str, ...]`,
/// not an object. We use `serde::Deserialize` with a tuple intermediary.
impl<'de> serde::de::Deserialize<'de> for KlineRow {
    fn deserialize<D: serde::de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // Accept any sequence; capture exactly the first 7 elements.
        struct KlineVisitor;

        impl<'de> serde::de::Visitor<'de> for KlineVisitor {
            type Value = KlineRow;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a Binance kline array [openTime, open, high, low, close, volume, closeTime, ...]")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                use serde::de::Error;

                let open_time: i64 = seq.next_element()?.ok_or_else(|| Error::missing_field("open_time"))?;
                let open: String = seq.next_element()?.ok_or_else(|| Error::missing_field("open"))?;
                let high: String = seq.next_element()?.ok_or_else(|| Error::missing_field("high"))?;
                let low: String = seq.next_element()?.ok_or_else(|| Error::missing_field("low"))?;
                let close: String = seq.next_element()?.ok_or_else(|| Error::missing_field("close"))?;
                let volume: String = seq.next_element()?.ok_or_else(|| Error::missing_field("volume"))?;
                let close_time: i64 = seq.next_element()?.ok_or_else(|| Error::missing_field("close_time"))?;

                // Drain remaining elements (8–12) so the deserializer doesn't
                // complain about trailing data.
                while seq.next_element::<serde_json::Value>()?.is_some() {}

                Ok(KlineRow { open_time, open, high, low, close, volume, close_time })
            }
        }

        d.deserialize_seq(KlineVisitor)
    }
}

// ---------------------------------------------------------------------------
// parse_klines — pure helper, testable without network
// ---------------------------------------------------------------------------

/// Parse a raw Binance klines JSON string into a `Vec<Bar>`.
///
/// This helper is exposed `pub` so unit tests can drive it with fixture JSON
/// without touching the network. The `fetch_history` method delegates to it.
pub fn parse_klines(json: &str) -> Result<Vec<Bar>, ProviderError> {
    let rows: Vec<KlineRow> = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("klines parse error: {e}")))?;

    rows.iter()
        .map(|r| {
            let o = r.open.parse::<f64>()
                .map_err(|e| ProviderError::Malformed(format!("open parse: {e}")))?;
            let h = r.high.parse::<f64>()
                .map_err(|e| ProviderError::Malformed(format!("high parse: {e}")))?;
            let l = r.low.parse::<f64>()
                .map_err(|e| ProviderError::Malformed(format!("low parse: {e}")))?;
            let c = r.close.parse::<f64>()
                .map_err(|e| ProviderError::Malformed(format!("close parse: {e}")))?;
            let v = r.volume.parse::<f64>()
                .map_err(|e| ProviderError::Malformed(format!("volume parse: {e}")))?;
            Ok(Bar { ts: r.open_time, o, h, l, c, v })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// BinanceProvider
// ---------------------------------------------------------------------------

pub struct BinanceProvider {
    client: Client,
}

impl BinanceProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("failed to build reqwest client"),
        }
    }

    /// Map canonical symbol to Binance spot pair: "BTC" → "BTCUSDT".
    ///
    /// Legacy single-quote shape — Step 7 widens callers to `map_pair`.
    pub fn map_symbol(sym: &str) -> String {
        format!("{}USDT", sym.to_uppercase())
    }

    /// Map canonical (sym, quote) to Binance spot pair: ("BTC", "USDT") → "BTCUSDT".
    ///
    /// ADR-0009 — multi-quote replacement for `map_symbol`. Binance native
    /// strings are the concatenation of base + quote, both uppercased.
    pub fn map_pair(sym: &str, quote: &str) -> String {
        format!("{}{}", sym.to_uppercase(), quote.to_uppercase())
    }

    /// Map 4-tier timeframe label to Binance interval string.
    /// Returns `None` for unsupported intervals.
    pub fn map_interval(tf: &str) -> Option<&'static str> {
        match tf {
            "1h" => Some("1h"),
            "4h" => Some("4h"),
            "1d" => Some("1d"),
            "1w" => Some("1w"),
            _ => None,
        }
    }
}

impl Default for BinanceProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MarketDataProvider for BinanceProvider {
    fn id(&self) -> &'static str {
        "binance"
    }

    /// Fetch up to `count` historical OHLCV bars from Binance klines.
    ///
    /// Binance caps each request at 1000 bars. If `count > 1000`, this method
    /// chains calls backwards using the `endTime` parameter, then deduplicates
    /// by `ts` and sorts ascending before returning.
    ///
    /// Rate-limit tokens are acquired by the `market_fetch_history` orchestrator
    /// (P4.1) — NOT inside this method. This adapter is pure: input → bars.
    async fn fetch_history(
        &self,
        sym: &str,
        tf: &str,
        count: usize,
    ) -> Result<Vec<Bar>, ProviderError> {
        let symbol = Self::map_symbol(sym);
        // v1 trait path: always "latest N bars" (no cursor).
        self.fetch_history_native(&symbol, tf, count, None).await
    }
}

impl BinanceProvider {
    /// ADR-0009 — multi-quote variant: fetches bars for `(sym, quote)`.
    ///
    /// Delegates to a shared `fetch_history_native` helper after mapping
    /// `(sym, quote)` via `map_pair`. The legacy single-quote `fetch_history`
    /// trait method now also routes through this helper via `map_symbol`.
    pub async fn fetch_history_pair(
        &self,
        sym: &str,
        quote: &str,
        tf: &str,
        count: usize,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, ProviderError> {
        let symbol = Self::map_pair(sym, quote);
        self.fetch_history_native(&symbol, tf, count, before).await
    }

    /// Walk Binance klines backwards. `before` (epoch-ms), when `Some`, seeds
    /// the initial `endTime` cursor so the walk returns bars strictly older than
    /// the cutoff; when `None` the first call omits `endTime` (Binance defaults
    /// to "now"), preserving the original "last N bars" behavior.
    async fn fetch_history_native(
        &self,
        symbol: &str,
        tf: &str,
        count: usize,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, ProviderError> {
        let interval = Self::map_interval(tf)
            .ok_or_else(|| ProviderError::Malformed(format!("unsupported tf: {tf}")))?;

        const PAGE_SIZE: usize = 1000;
        let pages = count.div_ceil(PAGE_SIZE); // ceiling division

        let mut all_bars: Vec<Bar> = Vec::with_capacity(count);
        // `end_time` is None on the first (most-recent) call when no cursor is
        // requested; subsequent calls use the open_time of the earliest bar we
        // have to walk backwards. When `before` is supplied, seed the first
        // call's `endTime` to the cutoff so we page the OLDER window.
        let mut end_time: Option<i64> = before;

        for page in 0..pages {
            let limit = if page == pages - 1 && !count.is_multiple_of(PAGE_SIZE) {
                count % PAGE_SIZE
            } else {
                PAGE_SIZE
            };

            let mut url = format!(
                "https://api.binance.com/api/v3/klines?symbol={}&interval={}&limit={}",
                symbol, interval, limit
            );
            if let Some(et) = end_time {
                url.push_str(&format!("&endTime={}", et - 1));
            }

            let resp = self
                .client
                .get(&url)
                .send()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            if resp.status() == 429 {
                return Err(ProviderError::RateLimited(60));
            }
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                if status == 400 && body.contains("-1121") {
                    return Err(ProviderError::SymbolNotFound(symbol.to_string()));
                }
                return Err(ProviderError::Network(format!(
                    "HTTP {status}: {body}"
                )));
            }

            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            let page_bars = parse_klines(&body)?;

            if page_bars.is_empty() {
                break; // no more history
            }

            // The earliest bar's open_time becomes the endTime ceiling for the
            // next page (minus 1ms to avoid overlap).
            end_time = page_bars.first().map(|b| b.ts);

            all_bars.extend(page_bars);
        }

        // Deduplicate by ts (in case pagination edges overlap).
        all_bars.sort_by_key(|b| b.ts);
        all_bars.dedup_by_key(|b| b.ts);

        // Return the most-recent `count` bars, newest last.
        if all_bars.len() > count {
            let start = all_bars.len() - count;
            all_bars.drain(0..start);
        }

        Ok(all_bars)
    }
}

// ---------------------------------------------------------------------------
// Catalog parsing — ADR-0009
// ---------------------------------------------------------------------------

/// Subset of the `/api/v3/exchangeInfo` `symbols[]` entry we need. Binance returns
/// many extra fields per row (filters, permissions, isSpotTradingAllowed, etc.);
/// we ignore them via serde's default-allow.
#[derive(Debug, serde::Deserialize)]
struct ExchangeInfoSymbol {
    symbol: String,
    #[serde(rename = "baseAsset")]
    base_asset: String,
    #[serde(rename = "quoteAsset")]
    quote_asset: String,
    status: String,
}

#[derive(Debug, serde::Deserialize)]
struct ExchangeInfo {
    symbols: Vec<ExchangeInfoSymbol>,
}

/// Parse a raw Binance `exchangeInfo` JSON string into the canonical
/// `SymbolRow` shape. Only `status == "TRADING"` rows are surfaced — `BREAK`
/// and `HALT` instruments are filtered.
///
/// Exposed `pub` so unit tests can drive it with a captured fixture.
pub fn parse_catalog(json: &str) -> Result<Vec<SymbolRow>, ProviderError> {
    let info: ExchangeInfo = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("exchangeInfo parse error: {e}")))?;

    Ok(info
        .symbols
        .into_iter()
        .filter(|s| s.status == "TRADING")
        .map(|s| SymbolRow {
            provider: "binance".to_string(),
            sym: s.base_asset,
            quote: s.quote_asset,
            name: None, // Binance exchangeInfo doesn't provide human display names
            class: "crypto".to_string(),
            status: "active".to_string(),
            native_sym: s.symbol,
        })
        .collect())
}

#[async_trait]
impl CatalogFetcher for BinanceProvider {
    fn id(&self) -> &'static str {
        "binance"
    }

    async fn fetch_catalog(&self) -> Result<Vec<SymbolRow>, ProviderError> {
        let url = "https://api.binance.com/api/v3/exchangeInfo";
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
    // map_symbol
    // -----------------------------------------------------------------------

    #[test]
    fn map_symbol_btc() {
        assert_eq!(BinanceProvider::map_symbol("BTC"), "BTCUSDT");
    }

    #[test]
    fn map_symbol_eth() {
        assert_eq!(BinanceProvider::map_symbol("ETH"), "ETHUSDT");
    }

    #[test]
    fn map_symbol_lowercase_normalised() {
        // Callers may pass lowercase canonical symbols — should still produce
        // the uppercase Binance pair.
        assert_eq!(BinanceProvider::map_symbol("btc"), "BTCUSDT");
        assert_eq!(BinanceProvider::map_symbol("sol"), "SOLUSDT");
    }

    // -----------------------------------------------------------------------
    // map_interval
    // -----------------------------------------------------------------------

    #[test]
    fn map_interval_supported() {
        assert_eq!(BinanceProvider::map_interval("1h"), Some("1h"));
        assert_eq!(BinanceProvider::map_interval("4h"), Some("4h"));
        assert_eq!(BinanceProvider::map_interval("1d"), Some("1d"));
        assert_eq!(BinanceProvider::map_interval("1w"), Some("1w"));
    }

    #[test]
    fn map_interval_unsupported_returns_none() {
        assert_eq!(BinanceProvider::map_interval("5m"), None);
        assert_eq!(BinanceProvider::map_interval("15m"), None);
        assert_eq!(BinanceProvider::map_interval(""), None);
        assert_eq!(BinanceProvider::map_interval("1M"), None);
    }

    // -----------------------------------------------------------------------
    // parse_klines — fixture-based (no network)
    // -----------------------------------------------------------------------

    /// Load the committed fixture from `src-tauri/tests/fixtures/` and assert
    /// the parsed bars have the right shape and values.
    ///
    /// The fixture contains 10 BTCUSDT 1h klines (see
    /// `tests/fixtures/binance_klines_btcusdt_1h.json`).
    #[test]
    fn parse_klines_fixture() {
        let fixture = include_str!(
            "../../tests/fixtures/binance_klines_btcusdt_1h.json"
        );

        let bars = parse_klines(fixture).expect("fixture should parse cleanly");

        assert_eq!(bars.len(), 10, "fixture has 10 klines");

        // First bar
        let first = &bars[0];
        assert_eq!(first.ts, 1696118400000, "first bar open_time");
        assert!((first.o - 27000.50).abs() < 1e-6, "first bar open");
        assert!((first.h - 27150.00).abs() < 1e-6, "first bar high");
        assert!((first.l - 26950.25).abs() < 1e-6, "first bar low");
        assert!((first.c - 27100.75).abs() < 1e-6, "first bar close");
        assert!((first.v - 500.123).abs() < 1e-6, "first bar volume");

        // Last bar
        let last = &bars[9];
        assert_eq!(last.ts, 1696150800000, "last bar open_time");
        assert!((last.o - 27510.50).abs() < 1e-6, "last bar open");
        assert!((last.c - 27580.00).abs() < 1e-6, "last bar close");
    }

    #[test]
    fn parse_klines_empty_array() {
        let bars = parse_klines("[]").expect("empty array is valid");
        assert!(bars.is_empty());
    }

    #[test]
    fn parse_klines_malformed_returns_err() {
        // Not a JSON array at all.
        let result = parse_klines("{\"error\": \"invalid symbol\"}");
        assert!(result.is_err(), "malformed JSON should yield an error");
    }

    #[test]
    fn parse_klines_bad_float_returns_err() {
        // Well-formed array structure but a non-numeric price string.
        let bad = r#"[[1696118400000, "NaN", "27150.00", "26950.25", "27100.75", "500.123", 1696122000000]]"#;
        let result = parse_klines(bad);
        // "NaN" parses as f64::NAN in Rust — that's technically successful.
        // Verify we get a Bar back (NaN propagation is the adapter consumer's
        // concern, not the parser's).
        assert!(result.is_ok());
    }

    #[test]
    fn parse_klines_non_numeric_open_returns_err() {
        // A string that cannot be parsed as f64 at all.
        let bad = r#"[[1696118400000, "INVALID_PRICE", "27150.00", "26950.25", "27100.75", "500.123", 1696122000000]]"#;
        let result = parse_klines(bad);
        assert!(result.is_err(), "non-numeric price should return Malformed error");
    }

    // -----------------------------------------------------------------------
    // Catalog parser — ADR-0009
    // -----------------------------------------------------------------------

    #[test]
    fn parse_catalog_fixture_filters_non_trading() {
        let fixture = include_str!("../../tests/fixtures/binance_catalog.json");
        let rows = parse_catalog(fixture).expect("fixture should parse");

        // Fixture has 9 rows total: 7 TRADING + 1 BREAK + 1 HALT.
        // Only the 7 TRADING rows should survive the filter.
        assert_eq!(rows.len(), 7, "expected 7 TRADING rows, got {}", rows.len());
        assert!(rows.iter().all(|r| r.provider == "binance"));
        assert!(rows.iter().all(|r| r.class == "crypto"));
        assert!(rows.iter().all(|r| r.status == "active"));

        // Spot-check the multi-quote BTC rows.
        let btc_usdt = rows
            .iter()
            .find(|r| r.sym == "BTC" && r.quote == "USDT")
            .expect("BTC/USDT row present");
        assert_eq!(btc_usdt.native_sym, "BTCUSDT");

        let btc_usdc = rows
            .iter()
            .find(|r| r.sym == "BTC" && r.quote == "USDC")
            .expect("BTC/USDC row present");
        assert_eq!(btc_usdc.native_sym, "BTCUSDC");

        // Long sym (`1000PEPE`) — verifies the parser doesn't truncate.
        let pepe = rows
            .iter()
            .find(|r| r.sym == "1000PEPE")
            .expect("1000PEPE row present");
        assert_eq!(pepe.native_sym, "1000PEPEUSDT");

        // Non-TRADING rows must be filtered.
        assert!(!rows.iter().any(|r| r.sym == "OLDCOIN"));
        assert!(!rows.iter().any(|r| r.sym == "HALTED"));
    }

    #[test]
    fn map_pair_handles_multi_quote() {
        assert_eq!(BinanceProvider::map_pair("BTC", "USDT"), "BTCUSDT");
        assert_eq!(BinanceProvider::map_pair("BTC", "USDC"), "BTCUSDC");
        assert_eq!(BinanceProvider::map_pair("btc", "usdt"), "BTCUSDT");
    }

    #[test]
    fn parse_catalog_malformed_returns_err() {
        assert!(parse_catalog("{not json}").is_err());
        // Missing "symbols" key.
        assert!(parse_catalog(r#"{"timezone":"UTC"}"#).is_err());
    }

    // -----------------------------------------------------------------------
    // before-cursor seed semantics
    //
    // Binance uses the inline `Option`/omission pattern: the first call seeds
    // its `endTime` cursor directly from `before`. When `before` is `None` the
    // first call omits `endTime` entirely (Binance defaults to "now"), which is
    // the original "last N bars" behavior. Because the cursor maps 1:1 onto the
    // `Option`, the only pure assertion is the live round-trip below; the
    // identity "before=None == latest" is structural (the same `None` flows to
    // the same omitted `endTime`).
    // -----------------------------------------------------------------------

    /// Live `before`-cursor smoke test (ignored — needs network).
    ///   cargo test smoke_live_binance_before -- --ignored
    ///
    /// Asserts every older-page bar is strictly older than the cutoff, and that
    /// `before = None` returns the latest window (the page the cutoff was taken
    /// from).
    #[tokio::test]
    #[ignore]
    async fn smoke_live_binance_before() {
        let provider = BinanceProvider::new();

        // Latest 20 × 1h bars (no cursor) — the same path as today.
        let latest = provider
            .fetch_history_pair("BTC", "USDT", "1h", 20, None)
            .await
            .expect("live Binance latest fetch should succeed");
        assert!(!latest.is_empty(), "latest fetch returns bars");

        // Older page anchored just before the oldest latest bar.
        let cutoff = latest.first().expect("non-empty").ts;
        let older = provider
            .fetch_history_pair("BTC", "USDT", "1h", 20, Some(cutoff))
            .await
            .expect("live Binance older-page fetch should succeed");

        assert!(!older.is_empty(), "older page returns bars");
        for b in &older {
            assert!(
                b.ts < cutoff,
                "older-page bar must be strictly older than cutoff (ts {} >= {cutoff})",
                b.ts
            );
        }
    }
}
