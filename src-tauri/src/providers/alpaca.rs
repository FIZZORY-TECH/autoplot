//! src-tauri/src/providers/alpaca.rs — Alpaca Markets REST adapter (Step 3 — equities).
//!
//! Implements `MarketDataProvider` for the Alpaca Data API v2 bars endpoint.
//!
//! REST: `GET https://data.alpaca.markets/v2/stocks/{sym}/bars`
//!   Query params: `timeframe`, `limit`, `adjustment=raw`
//!
//! ## Auth
//!   Headers `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` populated from
//!   `get_provider_credentials("alpaca")` (env-var → credentials.json → None).
//!   If credentials are absent the adapter returns `ProviderError::Malformed`
//!   with a recognisable message so the TS layer falls through to mock.
//!
//! ## Symbol mapping
//!   Identity — Alpaca uses the canonical exchange ticker directly (e.g. "AAPL").
//!
//! ## Timeframe mapping (ADR-0008 Tf set)
//!   1h  → request `timeframe=1Hour`
//!   4h  → request `timeframe=1Hour`, aggregate 4 bars → 1 UTC-aligned 4h bar
//!   1d  → request `timeframe=1Day`
//!   1w  → request `timeframe=1Week`
//!
//! ## 4h UTC alignment rationale (ADR-0008 §5)
//!   Alpaca's native `4Hour` timeframe is session-aligned to US market open
//!   (09:30 ET), which would drift against the UTC-aligned 4h bars returned by
//!   crypto adapters. Rather than requesting `4Hour` and post-processing an
//!   irregular grid, this adapter requests `1Hour` bars and aggregates every
//!   4 consecutive UTC-aligned hours (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
//!   into a single OHLCV bar. This produces a clean UTC-bucket grid that matches
//!   crypto behavior on the shared chart axis.
//!
//! ## Pagination
//!   Alpaca supports cursor-based pagination via `next_page_token`. We follow
//!   the cursor until we have `count` bars or the token is null.
//!
//! ## Error handling
//!   404 → `ProviderError::SymbolNotFound`
//!   422 → `ProviderError::Malformed` (invalid symbol / param)
//!   429 → `ProviderError::RateLimited(60)`
//!
//! Rate-limit token acquisition is handled by the `market_fetch_history`
//! orchestrator — this adapter is pure: input → bars.
//!
//! WS subscriptions live in TS (`src/data/adapters/alpaca.ts`) per A2.

use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use crate::providers::catalog::{CatalogFetcher, SymbolRow};
use crate::providers::{Bar, MarketDataProvider, ProviderError};

// ---------------------------------------------------------------------------
// Alpaca wire types
// ---------------------------------------------------------------------------

/// A single bar from the Alpaca v2 bars response.
#[derive(Debug, Deserialize)]
pub struct AlpacaBar {
    /// ISO 8601 timestamp, e.g. `"2023-10-01T13:00:00Z"`.
    pub t: String,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

/// Top-level Alpaca bars response envelope.
///
/// `bars` is `Option<Vec<…>>` because Alpaca's IEX free tier returns
/// `"bars": null` (not `[]`) when no data is in the requested window — for
/// example when the request omits `start` and lands in pre-/post-market.
/// Decoding as `Vec<AlpacaBar>` directly fails serde with a "expected sequence,
/// found null" error and surfaces as `ProviderError::Malformed`, which the TS
/// layer (mis)classifies as `fetch_failed`. Treating `null` as empty here keeps
/// the no-data case on the empty-bars happy path.
#[derive(Debug, Deserialize)]
pub struct AlpacaBarsResponse {
    #[serde(default)]
    pub bars: Option<Vec<AlpacaBar>>,
    /// Cursor for the next page; `null` when no more data.
    #[serde(default)]
    pub next_page_token: Option<String>,
}

impl AlpacaBarsResponse {
    /// Get bars as a slice, treating `None` as empty.
    pub fn bars_slice(&self) -> &[AlpacaBar] {
        self.bars.as_deref().unwrap_or(&[])
    }
}

// ---------------------------------------------------------------------------
// Parsing helpers — pure, testable without network
// ---------------------------------------------------------------------------

/// Format `unix_secs` as RFC 3339 UTC ("YYYY-MM-DDTHH:MM:SSZ").
/// Manual decomposition — avoids pulling chrono just for this.
pub(crate) fn format_rfc3339_utc(unix_secs: i64) -> String {
    let mut s = unix_secs;
    let sec = s.rem_euclid(60);
    s = s.div_euclid(60);
    let min = s.rem_euclid(60);
    s = s.div_euclid(60);
    let hour = s.rem_euclid(24);
    s = s.div_euclid(24);

    // Days since 1970-01-01
    let mut days = s;
    let mut year = 1970i64;
    let is_leap = |y: i64| (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let months = [
        31i64,
        28 + is_leap(year) as i64,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
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

/// Default `start` parameter — RFC3339 UTC for `now - 365 days`. Used by both
/// `build_url` and the probe endpoint as a safe lower bound that yields data
/// for any liquid US equity.
pub(crate) fn default_start_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_rfc3339_utc(now - 365 * 24 * 3600)
}

/// Parse an ISO 8601 UTC timestamp string into unix epoch milliseconds.
/// Returns `None` on parse failure.
fn parse_ts(t: &str) -> Option<i64> {
    // Timestamps from Alpaca are UTC ("Z" suffix or explicit offset "+00:00").
    // We parse manually to avoid a heavy datetime dependency:
    // expected format: "YYYY-MM-DDTHH:MM:SSZ" or "YYYY-MM-DDTHH:MM:SS+00:00"
    //
    // Strategy: strip timezone suffix, split date/time, compute epoch ms.
    let t = t.trim_end_matches('Z').trim_end_matches("+00:00");
    let (date_part, time_part) = t.split_once('T')?;
    let mut date_parts = date_part.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time_part.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.parse().ok()?;

    // Days since unix epoch (1970-01-01). Gregorian proleptic.
    // Using the algorithm from https://howardhinnant.github.io/date_algorithms.html
    let y = if month <= 2 { year - 1 } else { year };
    let m = month;
    let d = day;
    let era: i64 = if y >= 0 { y } else { y - 399 } / 400;
    let yoe: i64 = y - era * 400;
    let doy: i64 = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe: i64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days: i64 = era * 146097 + doe - 719468;

    let epoch_secs = days * 86400 + hour * 3600 + minute * 60 + second;
    Some(epoch_secs * 1_000)
}

/// Extract a human-readable auth error message from an Alpaca error response body.
/// Falls back to the raw body (up to 200 chars) or "no body" if empty.
fn extract_auth_msg(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("message").and_then(|x| x.as_str()) {
            return m.to_string();
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() { "no body".into() }
    else { trimmed.chars().take(200).collect() }
}

/// Parse a raw Alpaca bars JSON string into `Vec<Bar>`.
///
/// Exposed `pub` so unit tests can exercise it with fixture JSON without
/// touching the network.
pub fn parse_bars(json: &str) -> Result<AlpacaBarsResponse, ProviderError> {
    serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("alpaca bars parse error: {e}")))
}

/// Convert `AlpacaBar` → `Bar`, parsing the ISO 8601 timestamp.
fn alpaca_bar_to_bar(ab: &AlpacaBar) -> Result<Bar, ProviderError> {
    let ts = parse_ts(&ab.t)
        .ok_or_else(|| ProviderError::Malformed(format!("bad timestamp: {}", ab.t)))?;
    Ok(Bar { ts, o: ab.o, h: ab.h, l: ab.l, c: ab.c, v: ab.v })
}

/// Aggregate a slice of 1h `Bar`s into UTC-aligned 4h bars.
///
/// UTC 4h bucket boundaries (hours): 0, 4, 8, 12, 16, 20.
/// Any 1h bar is assigned to the bucket whose open time is
/// `floor(bar_hour / 4) * 4` hours on the same UTC day.
///
/// OHLCV aggregation:
///   - `ts`  = bucket open (earliest bar ts in the bucket)
///   - `o`   = open of the first bar in the bucket
///   - `h`   = max high across all bars
///   - `l`   = min low across all bars
///   - `c`   = close of the last bar in the bucket
///   - `v`   = sum of volumes
pub fn aggregate_to_4h(bars_1h: &[Bar]) -> Vec<Bar> {
    // Bucket key: truncate ts to the nearest 4h boundary (in ms).
    const FOUR_HOURS_MS: i64 = 4 * 60 * 60 * 1_000;

    // Use a BTreeMap so buckets come out in ascending order automatically.
    let mut buckets: std::collections::BTreeMap<i64, Vec<&Bar>> =
        std::collections::BTreeMap::new();

    for bar in bars_1h {
        let bucket_ts = (bar.ts / FOUR_HOURS_MS) * FOUR_HOURS_MS;
        buckets.entry(bucket_ts).or_default().push(bar);
    }

    buckets
        .into_values()
        .filter_map(|group| {
            if group.is_empty() {
                return None;
            }
            let ts = group[0].ts; // first bar in bucket is the bucket open
            let o = group[0].o;
            let c = group[group.len() - 1].c;
            let h = group.iter().map(|b| b.h).fold(f64::NEG_INFINITY, f64::max);
            let l = group.iter().map(|b| b.l).fold(f64::INFINITY, f64::min);
            let v = group.iter().map(|b| b.v).sum();
            Some(Bar { ts, o, h, l, c, v })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// AlpacaProvider
// ---------------------------------------------------------------------------

pub struct AlpacaProvider {
    client: Client,
    /// API key ID — from env or credentials.json at construction time.
    key_id: String,
    /// API secret key — from env or credentials.json at construction time.
    secret: String,
}

impl AlpacaProvider {
    /// Construct with explicit credentials (used by tests and by the `new_from_env`
    /// path when credentials are available).
    pub fn with_credentials(key_id: String, secret: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("failed to build reqwest client"),
            key_id,
            secret,
        }
    }

    /// ADR-0009 — multi-quote variant. Alpaca is USD-only equity, so `quote`
    /// is asserted (and otherwise ignored — non-USD quotes fall through to the
    /// same call rather than returning an error, leaving error surfacing to
    /// the symbol catalog layer that builds the request).
    pub async fn fetch_history_pair(
        &self,
        sym: &str,
        _quote: &str,
        tf: &str,
        count: usize,
    ) -> Result<Vec<Bar>, ProviderError> {
        // Native ticker == canonical sym for Alpaca; quote is identity USD.
        self.fetch_history(sym, tf, count).await
    }

    /// Alpaca free tier: 200 req/min ≈ 3.33/s, burst 10.
    /// Map `Tf` label to Alpaca `timeframe` query parameter.
    /// Returns `None` for unsupported intervals.
    ///
    /// Note: `4h` maps to `None` here because the 4h path requests `1Hour`
    /// and aggregates in-process (see `aggregate_to_4h`).
    pub fn map_timeframe(tf: &str) -> Option<&'static str> {
        match tf {
            // `1m` is NOT part of the frozen chart `Tf` set (ADR-0002) — it is a
            // dedicated freshness probe used by `market_fetch_latest_1m` to seed
            // the current chart bucket from a bar that is at most ~60s old,
            // rather than the last *completed* hour. The `build_url`
            // `start = now - 365d` + ascending-sort-then-trim path returns the
            // latest completed 1m bar for `count = 1`.
            "1m" => Some("1Min"),
            "1h" => Some("1Hour"),
            "4h" => None, // handled by 1Hour + aggregate
            "1d" => Some("1Day"),
            "1w" => Some("1Week"),
            _ => None,
        }
    }

    /// Build the bars URL for a given symbol, timeframe string, limit, and
    /// optional page cursor.
    ///
    /// `start` is REQUIRED for Alpaca's IEX free tier — without it the API
    /// returns `{"bars": null, "symbol": "..."}` even for liquid tickers. We
    /// default to `now - 365 days`, which covers every Tf we support up to
    /// `count` ≈ 365 daily bars (well above the chart's typical request size).
    fn build_url(
        sym: &str,
        timeframe: &str,
        limit: usize,
        page_token: Option<&str>,
    ) -> String {
        let start = default_start_iso();
        let mut url = format!(
            "https://data.alpaca.markets/v2/stocks/{}/bars?timeframe={}&limit={}&adjustment=raw&feed=iex&start={}",
            sym, timeframe, limit, start
        );
        if let Some(token) = page_token {
            url.push_str(&format!("&page_token={token}"));
        }
        url
    }

    /// Fetch raw 1h bars from the API, following pagination cursors until we
    /// have at least `count` bars or the token is exhausted.
    async fn fetch_1h_bars(&self, sym: &str, count: usize) -> Result<Vec<Bar>, ProviderError> {
        const PAGE_SIZE: usize = 1000;
        let mut all_bars: Vec<Bar> = Vec::with_capacity(count);
        let mut page_token: Option<String> = None;

        loop {
            let limit = (count - all_bars.len()).min(PAGE_SIZE);
            let url = Self::build_url(
                sym,
                "1Hour",
                limit,
                page_token.as_deref(),
            );

            let resp = self
                .client
                .get(&url)
                .header("APCA-API-KEY-ID", &self.key_id)
                .header("APCA-API-SECRET-KEY", &self.secret)
                .send()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            match resp.status().as_u16() {
                401 | 403 => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::AuthFailed(extract_auth_msg(&body)));
                }
                429 => return Err(ProviderError::RateLimited(60)),
                404 => return Err(ProviderError::SymbolNotFound(sym.to_string())),
                422 => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::Malformed(format!(
                        "invalid request (422): {body}"
                    )));
                }
                status if !(200..300).contains(&status) => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::Network(format!("HTTP {status}: {body}")));
                }
                _ => {}
            }

            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            let parsed = parse_bars(&body)?;
            let next_token = parsed.next_page_token.clone();
            let page_bars = parsed.bars_slice();

            for ab in page_bars {
                all_bars.push(alpaca_bar_to_bar(ab)?);
            }

            if all_bars.len() >= count || next_token.is_none() || page_bars.is_empty() {
                break;
            }

            page_token = next_token;
        }

        // Ensure ascending order and trim to `count`.
        all_bars.sort_by_key(|b| b.ts);
        all_bars.dedup_by_key(|b| b.ts);
        if all_bars.len() > count {
            let start = all_bars.len() - count;
            all_bars.drain(0..start);
        }

        Ok(all_bars)
    }
}

#[async_trait]
impl MarketDataProvider for AlpacaProvider {
    fn id(&self) -> &'static str {
        "alpaca"
    }

    /// Fetch up to `count` historical OHLCV bars for an equity symbol.
    ///
    /// - `1h` / `1d` / `1w`: direct Alpaca request, aligned to UTC already.
    /// - `4h`: fetch `count * 4` 1h bars then aggregate to UTC 4h buckets
    ///   (ADR-0008 §5 — Alpaca's native 4h is session-aligned, not UTC).
    async fn fetch_history(
        &self,
        sym: &str,
        tf: &str,
        count: usize,
    ) -> Result<Vec<Bar>, ProviderError> {
        if tf == "4h" {
            // Request ~4× as many 1h bars to ensure we have enough after
            // aggregation (equity session gaps mean not all hours have bars).
            let raw_count = count * 4 + 16; // 16-bar headroom for session gaps
            let bars_1h = self.fetch_1h_bars(sym, raw_count).await?;
            let mut bars_4h = aggregate_to_4h(&bars_1h);

            // Trim to requested count (newest last).
            if bars_4h.len() > count {
                let start = bars_4h.len() - count;
                bars_4h.drain(0..start);
            }

            return Ok(bars_4h);
        }

        let timeframe = Self::map_timeframe(tf)
            .ok_or_else(|| ProviderError::Malformed(format!("unsupported tf: {tf}")))?;

        const PAGE_SIZE: usize = 1000;
        let mut all_bars: Vec<Bar> = Vec::with_capacity(count);
        let mut page_token: Option<String> = None;

        loop {
            let limit = (count - all_bars.len()).min(PAGE_SIZE);
            let url = Self::build_url(sym, timeframe, limit, page_token.as_deref());

            let resp = self
                .client
                .get(&url)
                .header("APCA-API-KEY-ID", &self.key_id)
                .header("APCA-API-SECRET-KEY", &self.secret)
                .send()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            match resp.status().as_u16() {
                401 | 403 => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::AuthFailed(extract_auth_msg(&body)));
                }
                429 => return Err(ProviderError::RateLimited(60)),
                404 => return Err(ProviderError::SymbolNotFound(sym.to_string())),
                422 => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::Malformed(format!(
                        "invalid request (422): {body}"
                    )));
                }
                status if !(200..300).contains(&status) => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::Network(format!("HTTP {status}: {body}")));
                }
                _ => {}
            }

            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            let parsed = parse_bars(&body)?;
            let next_token = parsed.next_page_token.clone();
            let page_bars = parsed.bars_slice();

            for ab in page_bars {
                all_bars.push(alpaca_bar_to_bar(ab)?);
            }

            if all_bars.len() >= count || next_token.is_none() || page_bars.is_empty() {
                break;
            }

            page_token = next_token;
        }

        all_bars.sort_by_key(|b| b.ts);
        all_bars.dedup_by_key(|b| b.ts);
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

/// Subset of `GET /v2/assets` response entries we need. Alpaca returns
/// `id`, `exchange`, etc. — ignored. Only USD-quoted US equities are
/// catalog-eligible.
#[derive(Debug, Deserialize)]
struct AlpacaAsset {
    symbol: String,
    name: Option<String>,
    class: String,
    status: String,
    tradable: bool,
}

/// Parse a raw Alpaca `/v2/assets` JSON string into the canonical
/// `SymbolRow` shape. Only `status == "active" && tradable && class == "us_equity"`
/// rows are surfaced. `quote` is always `"USD"` for the equity feed.
pub fn parse_catalog(json: &str) -> Result<Vec<SymbolRow>, ProviderError> {
    let assets: Vec<AlpacaAsset> = serde_json::from_str(json)
        .map_err(|e| ProviderError::Malformed(format!("/v2/assets parse error: {e}")))?;

    Ok(assets
        .into_iter()
        .filter(|a| a.status == "active" && a.tradable && a.class == "us_equity")
        .map(|a| SymbolRow {
            provider: "alpaca".to_string(),
            sym: a.symbol.clone(),
            quote: "USD".to_string(),
            name: a.name,
            class: "equity".to_string(),
            status: "active".to_string(),
            native_sym: a.symbol,
        })
        .collect())
}

#[async_trait]
impl CatalogFetcher for AlpacaProvider {
    fn id(&self) -> &'static str {
        "alpaca"
    }

    async fn fetch_catalog(&self) -> Result<Vec<SymbolRow>, ProviderError> {
        if self.key_id.is_empty() || self.secret.is_empty() {
            return Err(ProviderError::AuthFailed(
                "alpaca credentials not configured".to_string(),
            ));
        }

        // `/v2/assets` is a TRADING/account endpoint, so its host must match the
        // credential TYPE: `paper-api.alpaca.markets` for paper keys vs
        // `api.alpaca.markets` for live. (Bars + the credential probe use
        // `data.alpaca.markets`, the market-data host, which accepts BOTH key
        // types — that's why they worked while this catalog fetch did not.)
        // This app is paper-trading-oriented, so try the paper host first and
        // fall back to live on an auth rejection: the catalog then populates
        // regardless of which key type the user configured.
        const HOSTS: [&str; 2] = [
            "https://paper-api.alpaca.markets",
            "https://api.alpaca.markets",
        ];

        let mut auth_err: Option<ProviderError> = None;
        for host in HOSTS {
            let url = format!("{host}/v2/assets?status=active&asset_class=us_equity");
            let resp = self
                .client
                .get(&url)
                .header("APCA-API-KEY-ID", &self.key_id)
                .header("APCA-API-SECRET-KEY", &self.secret)
                .send()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;

            let status = resp.status().as_u16();
            match status {
                401 | 403 => {
                    // Auth/forbidden on this host — likely the wrong key type for
                    // it (paper vs live). Remember the error and try the other host.
                    let body = resp.text().await.unwrap_or_default();
                    auth_err = Some(ProviderError::AuthFailed(extract_auth_msg(&body)));
                    continue;
                }
                429 => return Err(ProviderError::RateLimited(60)),
                s if !(200..300).contains(&s) => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::Network(format!("HTTP {s}: {body}")));
                }
                _ => {}
            }

            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;
            return Ok(parse_catalog(&body)?);
        }

        // Both paper and live hosts rejected the credentials.
        Err(auth_err.unwrap_or_else(|| {
            ProviderError::AuthFailed(
                "alpaca /v2/assets rejected on both paper and live hosts".to_string(),
            )
        }))
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_ts
    // -----------------------------------------------------------------------

    #[test]
    fn parse_ts_utc_z() {
        // 2023-10-01 13:00:00 UTC
        // days since epoch = 19631, so secs = 19631 * 86400 + 13*3600
        let ts = parse_ts("2023-10-01T13:00:00Z").expect("parse should succeed");
        // Cross-check: 2023-10-01 00:00:00 UTC = 1696118400 s
        assert_eq!(ts, (1_696_118_400 + 13 * 3600) * 1_000);
    }

    #[test]
    fn parse_ts_utc_offset() {
        let ts_z = parse_ts("2023-10-01T14:00:00Z").unwrap();
        let ts_off = parse_ts("2023-10-01T14:00:00+00:00").unwrap();
        assert_eq!(ts_z, ts_off, "+00:00 and Z should resolve to same ms");
    }

    #[test]
    fn parse_ts_bad_returns_none() {
        assert!(parse_ts("not-a-date").is_none());
        assert!(parse_ts("").is_none());
    }

    // -----------------------------------------------------------------------
    // parse_bars fixture
    // -----------------------------------------------------------------------

    #[test]
    fn parse_bars_fixture() {
        let fixture = include_str!("../../tests/fixtures/alpaca_bars_aapl_1h.json");
        let resp = parse_bars(fixture).expect("fixture should parse cleanly");

        assert_eq!(resp.bars_slice().len(), 8, "fixture has 8 1h bars");
        assert!(resp.next_page_token.is_none(), "no next page in fixture");

        let first = &resp.bars_slice()[0];
        assert_eq!(first.t, "2023-10-01T13:00:00Z");
        assert!((first.o - 171.21).abs() < 1e-6, "open price");
        assert!((first.h - 171.38).abs() < 1e-6, "high price");
        assert!((first.l - 170.82).abs() < 1e-6, "low price");
        assert!((first.c - 171.09).abs() < 1e-6, "close price");
        assert!((first.v - 3_245_678.0).abs() < 1.0, "volume");
    }

    #[test]
    fn parse_bars_empty_array_is_valid() {
        let json = r#"{"bars":[],"symbol":"AAPL","next_page_token":null}"#;
        let resp = parse_bars(json).expect("empty bars is valid");
        assert!(resp.bars_slice().is_empty());
    }

    /// Alpaca's IEX free tier returns `"bars": null` (not `[]`) when the request
    /// window contains no trades — e.g. weekend, pre-market, or when `start` is
    /// omitted entirely. We must treat `null` as empty, NOT as a decode error.
    #[test]
    fn parse_bars_null_bars_is_empty_not_error() {
        let json = r#"{"bars":null,"next_page_token":null,"symbol":"TSLA"}"#;
        let resp = parse_bars(json).expect("null bars must decode cleanly");
        assert!(resp.bars.is_none(), "expected None when JSON is null");
        assert!(resp.bars_slice().is_empty(), "slice view of null is empty");
    }

    #[test]
    fn parse_bars_malformed_returns_err() {
        let result = parse_bars("not json");
        assert!(result.is_err(), "malformed JSON should yield an error");
    }

    // -----------------------------------------------------------------------
    // alpaca_bar_to_bar
    // -----------------------------------------------------------------------

    #[test]
    fn alpaca_bar_to_bar_converts_ts_and_ohlcv() {
        let fixture = include_str!("../../tests/fixtures/alpaca_bars_aapl_1h.json");
        let resp = parse_bars(fixture).unwrap();
        let bar = alpaca_bar_to_bar(&resp.bars_slice()[0]).expect("conversion should succeed");

        // 2023-10-01T13:00:00Z = 1696118400 (midnight) + 13*3600 = 1696165200 s
        assert_eq!(bar.ts, 1_696_165_200_000, "ts should be epoch ms");
        assert!((bar.o - 171.21).abs() < 1e-6);
        assert!((bar.h - 171.38).abs() < 1e-6);
        assert!((bar.l - 170.82).abs() < 1e-6);
        assert!((bar.c - 171.09).abs() < 1e-6);
    }

    // -----------------------------------------------------------------------
    // aggregate_to_4h — UTC alignment
    // -----------------------------------------------------------------------

    /// Build a minimal set of 1h bars at UTC hours that straddle two 4h buckets.
    ///
    /// Fixture: 8 1h bars from 12:00–19:00 UTC on 2023-10-01.
    ///   Bucket 12:00 UTC → bars at 12, 13, 14, 15  (4 bars)
    ///   Bucket 16:00 UTC → bars at 16, 17, 18, 19  (4 bars)
    fn make_test_bars(base_ts_ms: i64) -> Vec<Bar> {
        (0..8_i64)
            .map(|i| Bar {
                ts: base_ts_ms + i * 3_600_000,
                o: 100.0 + i as f64,
                h: 101.0 + i as f64,
                l: 99.0 + i as f64,
                c: 100.5 + i as f64,
                v: 1_000.0 + i as f64 * 100.0,
            })
            .collect()
    }

    #[test]
    fn aggregate_to_4h_produces_utc_aligned_buckets() {
        // 2023-10-01 12:00:00 UTC in ms
        let base_ts: i64 = (1_696_118_400 + 12 * 3600) * 1_000;
        let bars_1h = make_test_bars(base_ts);

        let bars_4h = aggregate_to_4h(&bars_1h);

        assert_eq!(bars_4h.len(), 2, "8 consecutive 1h bars → 2 UTC 4h buckets");

        // First bucket: 12:00 UTC
        let bucket_12 = &bars_4h[0];
        assert_eq!(
            bucket_12.ts, base_ts,
            "first bucket opens at 12:00 UTC"
        );
        // open = first bar's open (i=0 → 100.0)
        assert!((bucket_12.o - 100.0).abs() < 1e-9, "open of first bar");
        // close = last bar's close in bucket (i=3 → 103.5)
        assert!((bucket_12.c - 103.5).abs() < 1e-9, "close of 4th bar");
        // high = max of [101, 102, 103, 104] = 104
        assert!((bucket_12.h - 104.0).abs() < 1e-9, "max high");
        // low = min of [99, 100, 101, 102] = 99
        assert!((bucket_12.l - 99.0).abs() < 1e-9, "min low");
        // volume = 1000 + 1100 + 1200 + 1300 = 4600
        assert!((bucket_12.v - 4_600.0).abs() < 1e-9, "summed volume");

        // Second bucket: 16:00 UTC
        let bucket_16 = &bars_4h[1];
        let expected_ts_16 = base_ts + 4 * 3_600_000;
        assert_eq!(
            bucket_16.ts, expected_ts_16,
            "second bucket opens at 16:00 UTC"
        );
        // open = bar at i=4 → 104.0
        assert!((bucket_16.o - 104.0).abs() < 1e-9, "open of 5th bar");
        // close = bar at i=7 → 107.5
        assert!((bucket_16.c - 107.5).abs() < 1e-9, "close of 8th bar");
    }

    #[test]
    fn aggregate_to_4h_empty_input_is_empty() {
        let result = aggregate_to_4h(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn aggregate_to_4h_partial_bucket_is_included() {
        // A single 1h bar at 00:00 UTC — falls into the [00:00, 04:00) bucket.
        let bar = Bar { ts: 0, o: 10.0, h: 11.0, l: 9.0, c: 10.5, v: 100.0 };
        let result = aggregate_to_4h(&[bar]);
        assert_eq!(result.len(), 1, "single bar still produces a bucket");
        assert_eq!(result[0].ts, 0, "bucket ts = 00:00 UTC epoch");
    }

    // -----------------------------------------------------------------------
    // 404 error path (simulated via parse path — network path tested via
    // integration tests once credentials are available)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_bars_404_like_body_decodes_to_empty() {
        // Post-fix (2026-05-24): both `bars` and `next_page_token` are
        // `#[serde(default)]` so an Alpaca error JSON body (which lacks both
        // fields) decodes as a no-data response rather than a hard parse
        // error. This is intentional: the HTTP-status check on 404/422
        // upstream already converts those into structured errors before we
        // ever reach `parse_bars`. The decoder needs to be permissive enough
        // to handle Alpaca's `null` shape for IEX free-tier no-data replies.
        let body = r#"{"code":40410000,"message":"asset not found for ZZZZZ"}"#;
        let resp = parse_bars(body).expect("permissive decode should succeed");
        assert!(resp.bars_slice().is_empty(), "no bars in an error body");
        assert!(resp.next_page_token.is_none(), "no cursor in an error body");
    }

    // -----------------------------------------------------------------------
    // map_timeframe
    // -----------------------------------------------------------------------

    #[test]
    fn map_timeframe_supported() {
        assert_eq!(AlpacaProvider::map_timeframe("1h"), Some("1Hour"));
        assert_eq!(AlpacaProvider::map_timeframe("1d"), Some("1Day"));
        assert_eq!(AlpacaProvider::map_timeframe("1w"), Some("1Week"));
    }

    #[test]
    fn map_timeframe_1m_freshness_probe() {
        // `1m` is the dedicated freshness-probe timeframe used by
        // `market_fetch_latest_1m` — NOT part of the frozen chart `Tf` set.
        assert_eq!(AlpacaProvider::map_timeframe("1m"), Some("1Min"));
    }

    #[test]
    fn map_timeframe_4h_is_none_handled_separately() {
        // 4h is aggregated from 1h bars; map_timeframe returns None for it.
        assert_eq!(AlpacaProvider::map_timeframe("4h"), None);
    }

    #[test]
    fn map_timeframe_unsupported_returns_none() {
        assert_eq!(AlpacaProvider::map_timeframe("5m"), None);
        assert_eq!(AlpacaProvider::map_timeframe(""), None);
        assert_eq!(AlpacaProvider::map_timeframe("30m"), None);
    }

    // -----------------------------------------------------------------------
    // extract_auth_msg
    // -----------------------------------------------------------------------

    #[test]
    fn extract_auth_msg_json_message_field() {
        assert_eq!(
            extract_auth_msg(r#"{"message":"forbidden"}"#),
            "forbidden"
        );
    }

    #[test]
    fn extract_auth_msg_html_body_starts_with_tag() {
        let result = extract_auth_msg("<html>401</html>");
        assert!(
            result.starts_with("<html>"),
            "expected result to start with '<html>', got: {result}"
        );
    }

    #[test]
    fn extract_auth_msg_empty_body_returns_no_body() {
        assert_eq!(extract_auth_msg(""), "no body");
    }

    // -----------------------------------------------------------------------
    // Catalog parser — ADR-0009
    // -----------------------------------------------------------------------

    #[test]
    fn parse_catalog_filters_inactive_and_non_equity() {
        let fixture = include_str!("../../tests/fixtures/alpaca_catalog.json");
        let rows = parse_catalog(fixture).expect("fixture should parse");

        // Fixture has 7 rows: 4 valid + 1 inactive + 1 not-tradable + 1 crypto.
        // Only the 4 valid US equities should survive.
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|r| r.provider == "alpaca"));
        assert!(rows.iter().all(|r| r.class == "equity"));
        assert!(rows.iter().all(|r| r.quote == "USD"));
        assert!(rows.iter().all(|r| r.sym == r.native_sym));

        // Spot-check rows.
        let aapl = rows.iter().find(|r| r.sym == "AAPL").expect("AAPL row");
        assert_eq!(aapl.name.as_deref(), Some("Apple Inc. Common Stock"));

        // Filter assertions.
        assert!(!rows.iter().any(|r| r.sym == "OLD"));       // inactive
        assert!(!rows.iter().any(|r| r.sym == "HALTED"));    // tradable=false
        assert!(!rows.iter().any(|r| r.sym == "BTCUSD"));    // class=crypto
    }

    #[test]
    fn parse_catalog_malformed_returns_err() {
        assert!(parse_catalog("{not json}").is_err());
    }

    #[tokio::test]
    async fn fetch_catalog_no_creds_returns_auth_failed() {
        let p = AlpacaProvider::with_credentials(String::new(), String::new());
        let err = p.fetch_catalog().await.expect_err("empty creds must fail");
        assert!(matches!(err, ProviderError::AuthFailed(_)));
        assert!(format!("{err}").contains("credentials not configured"));
    }
}
