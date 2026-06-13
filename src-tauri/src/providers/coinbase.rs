//! src-tauri/src/providers/coinbase.rs — Coinbase REST adapter (P4.3).
//!
//! Implements `MarketDataProvider` for the Coinbase Exchange public candles endpoint.
//! No authentication required for historical OHLCV data.
//!
//! REST: `GET https://api.exchange.coinbase.com/products/{product_id}/candles`
//!   Query params: `granularity={seconds}&start={iso8601}&end={iso8601}`
//!
//! ## Symbol mapping
//!   Canonical token → Coinbase product ID: "BTC" → "BTC-USD", "ETH" → "ETH-USD", etc.
//!   (uppercase symbol + "-USD")
//!
//! ## Granularity (interval) support
//!   Coinbase Exchange candles API supports only these granularities (in seconds):
//!     60, 300, 900, 3600, 21600, 86400
//!
//!   Of the app's 4-tier set (1h / 4h / 1d / 1w):
//!   - `1h`  → 3600   ✓ supported
//!   - `4h`  → 14400  ✗ NOT a valid Coinbase granularity — returns `Malformed` error
//!   - `1d`  → 86400  ✓ supported
//!   - `1w`  → 604800 ✗ NOT a valid Coinbase granularity (max is 1d) — returns `Malformed` error
//!
//!   Users who pick Coinbase + 4h or 1w will see an error toast (wired in P4.5).
//!   This is a known, intentional limitation documented here. Do NOT add aggregation
//!   (that expands scope into P8 polish territory).
//!
//! ## Response shape
//!   Each candle is an array: `[time, low, high, open, close, volume]`
//!   where `time` is unix epoch in **seconds**. We convert to milliseconds for `Bar.ts`.
//!
//! ## Pagination
//!   Coinbase caps each response at 300 candles. If `count > 300`, we chain calls
//!   working backwards using `start`/`end` ISO 8601 timestamps until we have enough
//!   bars (or history runs out).
//!
//! ## Rate limiting
//!   Token acquisition is handled by the `market_fetch_history` orchestrator (P4.1).
//!   This adapter is pure: input → bars.
//!
//! WS subscriptions live in TS (`src/data/adapters/coinbase.ts`) per A2.

use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;

use crate::providers::catalog::{CatalogFetcher, SymbolRow};
use crate::providers::{Bar, MarketDataProvider, ProviderError};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE: usize = 300; // Coinbase hard cap per candles request

// ---------------------------------------------------------------------------
// before-cursor seed helper
// ---------------------------------------------------------------------------

/// Seed the initial backward end-cursor (epoch-ms) for the paged candles walk.
///
/// Coinbase pages by walking an explicit `end` timestamp backwards. When the
/// caller asks for an OLDER page via `before` (epoch-ms), the walk starts at
/// `before` so it returns bars strictly older than the cutoff (the Coinbase
/// `end` query param is exclusive). When `before` is `None` the seed is "now",
/// preserving the original "last N bars" behavior exactly.
///
/// Binance uses an equivalent inline `Option`/omission pattern (omitting
/// `endTime` means "now"); only Coinbase needs an explicit ms value, so the
/// helper lives here.
fn seed_end_cursor_ms(before: Option<i64>) -> i64 {
    before.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    })
}

// ---------------------------------------------------------------------------
// parse_candles — pure helper, testable without network
// ---------------------------------------------------------------------------

/// Parse a raw Coinbase candles JSON string into a `Vec<Bar>`.
///
/// Coinbase returns candles as a JSON array of arrays:
///   `[[time_sec, low, high, open, close, volume], ...]`
///
/// Note: Coinbase returns candles in **descending** time order (newest first).
/// This helper reverses to ascending (oldest first) before returning, matching
/// the convention used by the rest of the data layer.
///
/// This helper is `pub` so unit tests can drive it with fixture JSON without
/// touching the network. The `fetch_history` method delegates to it.
pub fn parse_candles(json: &str) -> Result<Vec<Bar>, ProviderError> {
    // Deserialize into raw f64 tuples — all fields are numeric (time is also
    // numeric, not a string, unlike Binance).
    let rows: Vec<(i64, f64, f64, f64, f64, f64)> = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("candles parse error: {e}")))?;

    let mut bars: Vec<Bar> = rows
        .into_iter()
        .map(|(time_sec, low, high, open, close, volume)| Bar {
            ts: time_sec * 1_000, // seconds → milliseconds
            o: open,
            h: high,
            l: low,
            c: close,
            v: volume,
        })
        .collect();

    // Coinbase returns newest-first; reverse to ascending (oldest first).
    bars.reverse();

    Ok(bars)
}

// ---------------------------------------------------------------------------
// CoinbaseProvider
// ---------------------------------------------------------------------------

pub struct CoinbaseProvider {
    client: Client,
}

impl CoinbaseProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("autoplot/1.0")
                .build()
                .expect("failed to build reqwest client"),
        }
    }

    /// Map canonical symbol to Coinbase product ID: "BTC" → "BTC-USD".
    ///
    /// Legacy single-quote shape — Step 7 widens callers to `map_pair`.
    pub fn map_symbol(sym: &str) -> String {
        format!("{}-USD", sym.to_uppercase())
    }

    /// Map canonical (sym, quote) to Coinbase product ID: ("BTC", "USDC") → "BTC-USDC".
    ///
    /// ADR-0009 — multi-quote replacement for `map_symbol`.
    pub fn map_pair(sym: &str, quote: &str) -> String {
        format!("{}-{}", sym.to_uppercase(), quote.to_uppercase())
    }

    /// Map 4-tier timeframe label to Coinbase granularity in seconds.
    ///
    /// Returns `Ok(seconds)` for supported intervals, or `Err(ProviderError::Malformed)`
    /// for intervals not supported by the Coinbase candles API.
    ///
    /// Supported: `1h` (3600), `1d` (86400).
    /// Unsupported: `4h` (14400 is not a valid Coinbase granularity),
    ///              `1w` (Coinbase tops out at 1d / 86400).
    pub fn map_interval(tf: &str) -> Result<u64, ProviderError> {
        match tf {
            "1h" => Ok(3_600),
            "4h" => Err(ProviderError::Malformed(
                "4h not supported by Coinbase candles API (valid granularities: 60, 300, 900, 3600, 21600, 86400). \
                 Use Binance or Kraken for 4h bars."
                    .to_string(),
            )),
            "1d" => Ok(86_400),
            "1w" => Err(ProviderError::Malformed(
                "1w not supported by Coinbase candles API (maximum granularity is 86400 / 1d). \
                 Use Binance or Kraken for weekly bars."
                    .to_string(),
            )),
            _ => Err(ProviderError::Malformed(format!("unsupported tf: {tf}"))),
        }
    }

    /// Format a unix millisecond timestamp as an ISO 8601 UTC string suitable
    /// for Coinbase's `start`/`end` query parameters.
    fn ms_to_iso(ts_ms: i64) -> String {
        // Coinbase accepts RFC 3339 / ISO 8601 with 'Z' suffix.
        // We build it manually to avoid pulling in chrono for this simple case.
        let secs = ts_ms / 1_000;
        let micros = ((ts_ms % 1_000) * 1_000) as u32;
        // Use time crate (available via reqwest's transitive deps) or just format
        // manually. We do manual — it's a fixed-format conversion.
        format_iso_utc(secs, micros)
    }
}

/// Format a unix second + sub-second microseconds as ISO 8601 UTC string.
/// Output example: `"2023-10-01T00:00:00.000Z"`.
fn format_iso_utc(unix_secs: i64, _micros: u32) -> String {
    // Manual Gregorian calendar decomposition — no external dep needed.
    // Handles dates from 1970 onwards (more than sufficient for market data).
    let mut s = unix_secs;
    let sec = s % 60;
    s /= 60;
    let min = s % 60;
    s /= 60;
    let hour = s % 24;
    s /= 24;

    // Days since 1970-01-01
    let mut days = s;
    let mut year = 1970i64;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let months = [31i64, 28 + is_leap(year) as i64, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1i64;
    for &m in &months {
        if days < m {
            break;
        }
        days -= m;
        month += 1;
    }
    let day = days + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, min, sec
    )
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

impl Default for CoinbaseProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MarketDataProvider for CoinbaseProvider {
    fn id(&self) -> &'static str {
        "coinbase"
    }

    /// Fetch up to `count` historical OHLCV bars from Coinbase candles.
    ///
    /// Coinbase caps each response at 300 candles. If `count > 300`, this method
    /// chains calls backwards using `start`/`end` ISO 8601 timestamps, then
    /// deduplicates by `ts` and sorts ascending before returning.
    ///
    /// Returns `Err(ProviderError::Malformed)` for intervals not supported by
    /// Coinbase (4h and 1w). See module-level doc for full interval support table.
    ///
    /// Rate-limit tokens are acquired by the `market_fetch_history` orchestrator
    /// (P4.1) — NOT inside this method.
    async fn fetch_history(
        &self,
        sym: &str,
        tf: &str,
        count: usize,
    ) -> Result<Vec<Bar>, ProviderError> {
        let product_id = Self::map_symbol(sym);
        // v1 trait path: always "latest N bars" (no cursor).
        self.fetch_history_native(&product_id, tf, count, None).await
    }
}

impl CoinbaseProvider {
    /// ADR-0009 — multi-quote variant of `fetch_history` keyed by `(sym, quote)`.
    pub async fn fetch_history_pair(
        &self,
        sym: &str,
        quote: &str,
        tf: &str,
        count: usize,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, ProviderError> {
        let product_id = Self::map_pair(sym, quote);
        self.fetch_history_native(&product_id, tf, count, before).await
    }

    /// Walk Coinbase candles backwards. `before` (epoch-ms), when `Some`, seeds
    /// the initial `end` cursor so the walk returns bars strictly older than the
    /// cutoff (Coinbase's `end` param is exclusive); when `None` the seed is
    /// "now", preserving the original "last N bars" behavior.
    async fn fetch_history_native(
        &self,
        product_id: &str,
        tf: &str,
        count: usize,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, ProviderError> {
        let granularity = Self::map_interval(tf)?;

        let pages = count.div_ceil(PAGE_SIZE); // ceiling division

        let mut all_bars: Vec<Bar> = Vec::with_capacity(count);

        // `end_ms` tracks the exclusive end of the window we haven't fetched yet.
        // First call: end = `before` cutoff (or "now" when no cursor is asked);
        // subsequent calls: end = start of the earliest bar we have.
        let mut end_ms = seed_end_cursor_ms(before);

        for page in 0..pages {
            let page_size = if page == pages - 1 && !count.is_multiple_of(PAGE_SIZE) {
                count % PAGE_SIZE
            } else {
                PAGE_SIZE
            };

            // `start` = end - (page_size * granularity) seconds, in ms.
            let start_ms = end_ms - (page_size as i64) * (granularity as i64) * 1_000;

            let url = format!(
                "https://api.exchange.coinbase.com/products/{}/candles?granularity={}&start={}&end={}",
                product_id,
                granularity,
                Self::ms_to_iso(start_ms),
                Self::ms_to_iso(end_ms),
            );

            let resp = self
                .client
                .get(&url)
                .send()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            let status = resp.status();

            if status.as_u16() == 429 {
                return Err(ProviderError::RateLimited(10));
            }

            if !status.is_success() {
                let code = status.as_u16();
                let body = resp.text().await.unwrap_or_default();
                if code == 400 || code == 404 {
                    // Coinbase returns 400/404 for invalid product IDs.
                    return Err(ProviderError::SymbolNotFound(product_id.to_string()));
                }
                return Err(ProviderError::Network(format!("HTTP {code}: {body}")));
            }

            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            let page_bars = parse_candles(&body)?;

            if page_bars.is_empty() {
                break; // no more history
            }

            // Move the window: next page ends just before the earliest bar we got.
            end_ms = page_bars
                .first()
                .map(|b| b.ts) // already in ms
                .unwrap_or(start_ms);

            all_bars.extend(page_bars);
        }

        // Deduplicate by ts (pagination window edges may overlap by one candle).
        all_bars.sort_by_key(|b| b.ts);
        all_bars.dedup_by_key(|b| b.ts);

        // When paging an OLDER window, guarantee every bar is strictly older
        // than the cutoff. Coinbase's `end` param is exclusive, but a boundary
        // candle whose open time equals `before` could still slip in; trim it.
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

// ---------------------------------------------------------------------------
// Catalog parsing — ADR-0009
// ---------------------------------------------------------------------------

/// Subset of `GET /products` response entries we need. Coinbase returns many
/// extra fields (size precisions, quotes, post-only flags); ignored via serde
/// default-allow.
#[derive(Debug, serde::Deserialize)]
struct CoinbaseProduct {
    id: String,
    base_currency: String,
    quote_currency: String,
    display_name: Option<String>,
    status: String,
    #[serde(default)]
    trading_disabled: bool,
}

/// Parse a raw Coinbase `/products` JSON string into the canonical
/// `SymbolRow` shape. Only `status == "online" && !trading_disabled` rows
/// survive — delisted, internal-test, and disabled instruments are filtered.
pub fn parse_catalog(json: &str) -> Result<Vec<SymbolRow>, ProviderError> {
    let products: Vec<CoinbaseProduct> = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("/products parse error: {e}")))?;

    Ok(products
        .into_iter()
        .filter(|p| p.status == "online" && !p.trading_disabled)
        .map(|p| SymbolRow {
            provider: "coinbase".to_string(),
            sym: p.base_currency,
            quote: p.quote_currency,
            name: p.display_name,
            class: "crypto".to_string(),
            status: "active".to_string(),
            native_sym: p.id,
        })
        .collect())
}

#[async_trait]
impl CatalogFetcher for CoinbaseProvider {
    fn id(&self) -> &'static str {
        "coinbase"
    }

    async fn fetch_catalog(&self) -> Result<Vec<SymbolRow>, ProviderError> {
        let url = "https://api.exchange.coinbase.com/products";
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
        assert_eq!(CoinbaseProvider::map_symbol("BTC"), "BTC-USD");
    }

    #[test]
    fn map_symbol_eth() {
        assert_eq!(CoinbaseProvider::map_symbol("ETH"), "ETH-USD");
    }

    #[test]
    fn map_symbol_lowercase_normalised() {
        assert_eq!(CoinbaseProvider::map_symbol("btc"), "BTC-USD");
        assert_eq!(CoinbaseProvider::map_symbol("sol"), "SOL-USD");
    }

    // -----------------------------------------------------------------------
    // map_interval
    // -----------------------------------------------------------------------

    #[test]
    fn map_interval_1h_supported() {
        assert_eq!(CoinbaseProvider::map_interval("1h").unwrap(), 3_600);
    }

    #[test]
    fn map_interval_1d_supported() {
        assert_eq!(CoinbaseProvider::map_interval("1d").unwrap(), 86_400);
    }

    #[test]
    fn map_interval_4h_unsupported() {
        // 4h is not a valid Coinbase granularity — must return Malformed.
        let err = CoinbaseProvider::map_interval("4h").unwrap_err();
        assert!(
            matches!(err, ProviderError::Malformed(ref m) if m.contains("4h not supported")),
            "expected Malformed error for 4h, got: {err}"
        );
    }

    #[test]
    fn map_interval_1w_unsupported() {
        // 1w exceeds maximum Coinbase granularity (86400 / 1d).
        let err = CoinbaseProvider::map_interval("1w").unwrap_err();
        assert!(
            matches!(err, ProviderError::Malformed(ref m) if m.contains("1w not supported")),
            "expected Malformed error for 1w, got: {err}"
        );
    }

    #[test]
    fn map_interval_unknown_returns_err() {
        assert!(CoinbaseProvider::map_interval("5m").is_err());
        assert!(CoinbaseProvider::map_interval("").is_err());
        assert!(CoinbaseProvider::map_interval("15m").is_err());
    }

    // -----------------------------------------------------------------------
    // format_iso_utc helper
    // -----------------------------------------------------------------------

    #[test]
    fn format_iso_epoch_zero() {
        assert_eq!(format_iso_utc(0, 0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn format_iso_known_timestamp() {
        // 2023-10-01T00:00:00Z = 1696118400
        assert_eq!(format_iso_utc(1_696_118_400, 0), "2023-10-01T00:00:00Z");
    }

    // -----------------------------------------------------------------------
    // parse_candles — fixture-based (no network)
    // -----------------------------------------------------------------------

    /// Load the committed fixture and assert parsed bars have the correct shape
    /// and field mapping.
    ///
    /// Fixture: `tests/fixtures/coinbase_candles_btc_usd_1h.json` — 10 candles
    /// in Coinbase's `[time_sec, low, high, open, close, volume]` format,
    /// descending order (newest first, as Coinbase returns them).
    #[test]
    fn parse_candles_fixture() {
        let fixture = include_str!(
            "../../tests/fixtures/coinbase_candles_btc_usd_1h.json"
        );

        let bars = parse_candles(fixture).expect("fixture should parse cleanly");

        assert_eq!(bars.len(), 10, "fixture has 10 candles");

        // After parse_candles reverses to ascending, the first bar should be the
        // one with the smallest timestamp in the fixture.
        // Fixture row 0 (descending-first) = ts 1696150800, which becomes last after reverse.
        // Fixture row 9 (descending-last)  = ts 1696118400, which becomes first after reverse.
        let first = &bars[0];
        assert_eq!(first.ts, 1_696_118_400 * 1_000, "first bar ts (in ms)");
        assert!((first.o - 27000.50).abs() < 1e-6, "first bar open");
        assert!((first.h - 27150.00).abs() < 1e-6, "first bar high");
        assert!((first.l - 26950.25).abs() < 1e-6, "first bar low");
        assert!((first.c - 27100.75).abs() < 1e-6, "first bar close");
        assert!((first.v - 500.123).abs() < 1e-6, "first bar volume");

        // Last bar in ascending order = fixture row 0 (ts 1696150800).
        let last = &bars[9];
        assert_eq!(last.ts, 1_696_150_800 * 1_000, "last bar ts (in ms)");
        assert!((last.o - 27510.50).abs() < 1e-6, "last bar open");
        assert!((last.c - 27580.00).abs() < 1e-6, "last bar close");
    }

    #[test]
    fn parse_candles_empty_array() {
        let bars = parse_candles("[]").expect("empty array is valid");
        assert!(bars.is_empty());
    }

    #[test]
    fn parse_candles_malformed_returns_err() {
        let result = parse_candles("{\"error\": \"invalid product\"}");
        assert!(result.is_err(), "malformed JSON should yield an error");
    }

    #[test]
    fn parse_candles_time_converted_to_ms() {
        // Single candle: time = 1696118400 seconds → ts must be 1696118400000 ms.
        let json = r#"[[1696118400, 26950.25, 27150.00, 27000.50, 27100.75, 500.123]]"#;
        let bars = parse_candles(json).expect("single candle should parse");
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].ts, 1_696_118_400_000i64, "time must be converted to milliseconds");
    }

    #[test]
    fn parse_candles_field_order_low_high_open_close_volume() {
        // Verify the [time, low, high, open, close, volume] field order is applied correctly.
        // low=100, high=200, open=150, close=180, volume=99
        let json = r#"[[1696118400, 100.0, 200.0, 150.0, 180.0, 99.0]]"#;
        let bars = parse_candles(json).expect("should parse");
        let b = &bars[0];
        assert!((b.l - 100.0).abs() < 1e-9, "l should be low (100)");
        assert!((b.h - 200.0).abs() < 1e-9, "h should be high (200)");
        assert!((b.o - 150.0).abs() < 1e-9, "o should be open (150)");
        assert!((b.c - 180.0).abs() < 1e-9, "c should be close (180)");
        assert!((b.v - 99.0).abs() < 1e-9, "v should be volume (99)");
    }

    // -----------------------------------------------------------------------
    // Live REST smoke test (ignored by default — run manually with:
    //   cargo test --manifest-path src-tauri/Cargo.toml smoke_live_coinbase -- --ignored)
    // -----------------------------------------------------------------------

    /// One-shot integration test against the real Coinbase API.
    ///
    /// Fetches 5 × 1h BTC-USD candles and verifies the response parses without
    /// error and returns sensible values (price > 0, ts > 0).
    ///
    /// Run manually: `cargo test smoke_live_coinbase -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn smoke_live_coinbase() {
        let provider = CoinbaseProvider::new();
        let bars = provider
            .fetch_history("BTC", "1h", 5)
            .await
            .expect("live Coinbase fetch should succeed");

        assert!(!bars.is_empty(), "should return at least one bar");
        for b in &bars {
            assert!(b.ts > 0, "ts must be positive");
            assert!(b.o > 0.0, "open price must be positive");
            assert!(b.h >= b.o || b.h >= b.c, "high must be >= open or close");
            assert!(b.l <= b.o || b.l <= b.c, "low must be <= open or close");
            assert!(b.v >= 0.0, "volume must be non-negative");
        }
        println!("Live Coinbase smoke: {} bars, last close = {}", bars.len(), bars.last().unwrap().c);
    }

    // -----------------------------------------------------------------------
    // Catalog parser — ADR-0009
    // -----------------------------------------------------------------------

    #[test]
    fn parse_catalog_fixture_filters_offline_and_disabled() {
        let fixture = include_str!("../../tests/fixtures/coinbase_catalog.json");
        let rows = parse_catalog(fixture).expect("fixture should parse");

        // Fixture has 7 rows: 5 online+!disabled + 1 trading_disabled + 1 delisted.
        // Only the 5 valid rows should survive.
        assert_eq!(rows.len(), 5);
        assert!(rows.iter().all(|r| r.provider == "coinbase"));
        assert!(rows.iter().all(|r| r.class == "crypto"));
        assert!(rows.iter().all(|r| r.status == "active"));

        // Multi-quote check.
        assert!(rows.iter().any(|r| r.sym == "BTC" && r.quote == "USD" && r.native_sym == "BTC-USD"));
        assert!(rows.iter().any(|r| r.sym == "BTC" && r.quote == "USDC" && r.native_sym == "BTC-USDC"));
        // Non-USD quote present (ETH/EUR).
        assert!(rows.iter().any(|r| r.sym == "ETH" && r.quote == "EUR"));

        // Filter assertions.
        assert!(!rows.iter().any(|r| r.sym == "BAD"));
        assert!(!rows.iter().any(|r| r.sym == "DELISTED"));

        // display_name flows into the `name` field.
        let btc_usd = rows.iter().find(|r| r.sym == "BTC" && r.quote == "USD").unwrap();
        assert_eq!(btc_usd.name.as_deref(), Some("BTC/USD"));
    }

    #[test]
    fn map_pair_coinbase() {
        assert_eq!(CoinbaseProvider::map_pair("BTC", "USD"), "BTC-USD");
        assert_eq!(CoinbaseProvider::map_pair("BTC", "USDC"), "BTC-USDC");
        assert_eq!(CoinbaseProvider::map_pair("eth", "eur"), "ETH-EUR");
    }

    // -----------------------------------------------------------------------
    // seed_end_cursor_ms — the backward end-cursor seed (pure, no network).
    //
    // `Some(before)` seeds the walk at the cutoff so the page is OLDER than it;
    // `None` seeds "now", preserving the original "last N bars" behavior.
    // -----------------------------------------------------------------------

    #[test]
    fn seed_end_cursor_uses_before_when_present() {
        assert_eq!(seed_end_cursor_ms(Some(1_696_150_800_000)), 1_696_150_800_000);
        assert_eq!(seed_end_cursor_ms(Some(0)), 0);
    }

    #[test]
    fn seed_end_cursor_none_is_now_ish() {
        // With no cursor the seed is "now" — bounded sanity check (after 2020,
        // not in the future by more than a small skew). This proves `None`
        // reproduces the original latest-window seed.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let seeded = seed_end_cursor_ms(None);
        assert!(seeded >= 1_577_836_800_000, "seed should be after 2020-01-01");
        assert!(
            (seeded - now_ms).abs() < 5_000,
            "no-cursor seed must track wall-clock now (got {seeded}, now {now_ms})"
        );
    }

    /// Live `before`-cursor smoke test (ignored — needs network).
    ///   cargo test smoke_live_coinbase_before -- --ignored
    ///
    /// Asserts every older-page bar is strictly older than the cutoff.
    #[tokio::test]
    #[ignore]
    async fn smoke_live_coinbase_before() {
        let provider = CoinbaseProvider::new();

        let latest = provider
            .fetch_history_pair("BTC", "USD", "1h", 20, None)
            .await
            .expect("live Coinbase latest fetch should succeed");
        assert!(!latest.is_empty(), "latest fetch returns bars");

        let cutoff = latest.first().expect("non-empty").ts;
        let older = provider
            .fetch_history_pair("BTC", "USD", "1h", 20, Some(cutoff))
            .await
            .expect("live Coinbase older-page fetch should succeed");

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
