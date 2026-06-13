//! src-tauri/src/providers/mod.rs — Real-data provider substrate (P4.1).
//!
//! This module declares the Rust-side `MarketDataProvider` trait that the
//! Binance / Coinbase / Kraken adapters will implement in P4.2 / P4.3 / P4.4.
//! It also re-exports the rate-limiter substrate.
//!
//! P4.2 / P4.3 / P4.4 add `pub mod binance;` / `pub mod coinbase;` /
//! `pub mod kraken;` lines below and implement `MarketDataProvider` for their
//! adapter type. They do NOT mutate this trait — the shape is locked.
//!
//! Architectural decisions:
//!
//! - A2: REST adapters live here in Rust (centralised rate-limit + retry).
//!   WebSocket subscriptions live in TS (zero-copy into the chart layer).
//! - A3: The TS `MarketDataProvider` interface is FROZEN. This Rust trait is
//!   the REST-half mirror — only `fetch_history` crosses the IPC boundary.

pub mod rate_limit;

// ADR-0009 — catalog discovery substrate. Kept off `MarketDataProvider`
// so the frozen 3-method interface remains untouched.
pub mod catalog;

// Adapter modules — added by P4.2 / P4.3 / P4.4; Alpaca added in Step 3 (equities):
pub mod binance;
pub mod coinbase;
pub mod kraken;
pub mod alpaca;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// One OHLCV bar — wire-compatible with the TS `Bar` interface.
///
/// Field naming is intentionally short (`o`/`h`/`l`/`c`/`v`) to match the TS
/// shape exactly so the JSON crossing the Tauri IPC boundary doesn't need a
/// per-row remap. `ts` is unix epoch in **milliseconds (UTC)**.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    pub ts: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

/// Typed adapter errors. Variants are kept narrow so the `market_fetch_history`
/// orchestrator can react differently per case (e.g. respect `RateLimited`'s
/// `retry_after_secs` rather than blind-retrying).
///
/// All variants are constructed by adapters in P4.2 / P4.3 / P4.4 — quiet the
/// dead-code lint here so P4.1 builds cleanly with no adapters yet installed.
#[allow(dead_code)]
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("rate limited; retry after {0}s")]
    RateLimited(u64),
    #[error("symbol not found: {0}")]
    SymbolNotFound(String),
    #[error("malformed response: {0}")]
    Malformed(String),
    #[error("authentication failed: {0}")]
    AuthFailed(String),
}

/// The Rust mirror of the TS `MarketDataProvider` interface (REST half only).
///
/// Adapters implement this trait. The orchestrator (`market_fetch_history`)
/// looks adapters up by `id()` in a `ProviderRegistry` and dispatches. WS
/// subscriptions are NOT part of this trait — they live in TS per A2.
///
/// `id()` and `fetch_history` are exercised by adapters in P4.2 / P4.3 / P4.4
/// — quiet the dead-code lint here so P4.1 builds cleanly.
#[allow(dead_code)]
#[async_trait]
pub trait MarketDataProvider: Send + Sync {
    /// Stable provider identifier — `"binance"` / `"coinbase"` / `"kraken"`.
    fn id(&self) -> &'static str;

    /// Fetch up to `count` historical OHLCV bars for `sym` at timeframe `tf`,
    /// newest bar last. Adapters may paginate internally to fulfil large
    /// requests. `sym` is the canonical token (e.g. `"BTC"`); the adapter is
    /// responsible for mapping to its provider-specific symbol.
    async fn fetch_history(
        &self,
        sym: &str,
        tf: &str,
        count: usize,
    ) -> Result<Vec<Bar>, ProviderError>;
}
