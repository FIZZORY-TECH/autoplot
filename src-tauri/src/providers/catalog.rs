//! src-tauri/src/providers/catalog.rs — Symbol catalog substrate (ADR-0009).
//!
//! Each provider adapter implements `CatalogFetcher` alongside its existing
//! `MarketDataProvider` impl. The catalog command surface (`symbol_catalog_*`
//! in `commands/symbols.rs`) walks a registry of `CatalogFetcher` impls and
//! materialises rows into the SQLite `symbols` table via the FTS5 trigger
//! pipeline declared in migration 0013.
//!
//! `CatalogFetcher` is intentionally NOT a method on `MarketDataProvider` —
//! the latter is frozen per ADR-0001. ADR-0009 §3 documents the split.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::ProviderError;

/// One catalog row — wire-compatible 1:1 with the `symbols` table and the
/// TS `SymbolRow` interface in `src/lib/db.ts`. snake_case field naming
/// matches the project-wide IPC convention.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolRow {
    pub provider: String,
    pub sym: String,
    pub quote: String,
    pub name: Option<String>,
    pub class: String,
    pub status: String,
    pub native_sym: String,
}

/// Catalog discovery trait. Each adapter knows how to fetch and parse its
/// own provider's pair/ticker listing endpoint into normalised `SymbolRow`s.
///
/// Implementations MUST:
/// - acquire from `RateLimiters::for_provider(self.id())` before the network call
/// - normalise provider-specific quirks (Kraken `X`/`Z` asset prefixes etc.)
/// - filter out non-tradeable rows (halted, delisted, !tradable) so the
///   catalog only surfaces instruments the user can actually research
/// - return `ProviderError::AuthFailed` when credentials are required and
///   missing (e.g. Alpaca) — the UI surfaces a credentials prompt for that
///   variant rather than a generic toast.
#[allow(dead_code)]
#[async_trait]
pub trait CatalogFetcher: Send + Sync {
    /// Stable provider identifier matching `MarketDataProvider::id()` and the
    /// `Provider` union in TS — `"binance"` / `"coinbase"` / `"kraken"` / `"alpaca"`.
    fn id(&self) -> &'static str;

    /// Fetch the provider's full catalog. Implementations should NOT cache
    /// internally — caching is the caller's concern (SQLite via migration 0013).
    async fn fetch_catalog(&self) -> Result<Vec<SymbolRow>, ProviderError>;
}

/// Per-provider registry of `CatalogFetcher` impls — kept parallel to
/// `ProviderRegistry` (which holds `MarketDataProvider` impls). Same closed
/// provider set as the TS `Provider` union.
#[derive(Default)]
pub struct CatalogRegistry {
    binance: Option<Arc<dyn CatalogFetcher>>,
    coinbase: Option<Arc<dyn CatalogFetcher>>,
    kraken: Option<Arc<dyn CatalogFetcher>>,
    alpaca: Option<Arc<dyn CatalogFetcher>>,
}

#[allow(dead_code)]
impl CatalogRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, fetcher: Arc<dyn CatalogFetcher>) {
        match fetcher.id() {
            "binance" => self.binance = Some(fetcher),
            "coinbase" => self.coinbase = Some(fetcher),
            "kraken" => self.kraken = Some(fetcher),
            "alpaca" => self.alpaca = Some(fetcher),
            _ => { /* unknown provider id — silently ignore */ }
        }
    }

    pub fn get(&self, provider: &str) -> Option<Arc<dyn CatalogFetcher>> {
        match provider {
            "binance" => self.binance.clone(),
            "coinbase" => self.coinbase.clone(),
            "kraken" => self.kraken.clone(),
            "alpaca" => self.alpaca.clone(),
            _ => None,
        }
    }

    pub fn clear(&mut self, name: &str) {
        match name {
            "binance" => self.binance = None,
            "coinbase" => self.coinbase = None,
            "kraken" => self.kraken = None,
            "alpaca" => self.alpaca = None,
            _ => {}
        }
    }
}
