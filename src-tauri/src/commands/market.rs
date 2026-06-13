//! src-tauri/src/commands/market.rs — `market_fetch_history` orchestrator (P4.1).
//!
//! This is the single Tauri entry point the TS `RealMarketDataProvider` calls
//! for historical bars. It coordinates four pieces:
//!
//!   1. The warm cache in SQLite (`bars` table — added in P4.1 migration 0004).
//!   2. The per-provider rate-limiter (`providers::rate_limit::RateLimiters`).
//!   3. The provider registry — adapters register themselves here in P4.2/3/4.
//!   4. Upsert of fresh bars back into the warm cache.
//!
//! In P4.1 the registry is empty by design — there are no adapters yet. The
//! command therefore returns a clear `"adapter not registered: <id>"` error,
//! which the TS layer catches to fall back to `MockMarketDataProvider` so the
//! app keeps running until the adapter steps land.

use std::sync::Arc;

use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::commands::db::{bars_upsert, bars_v2_upsert, BarRow, DbState};
use crate::providers::{Bar, MarketDataProvider, ProviderError};
use crate::providers::alpaca::AlpacaProvider;
use crate::providers::binance::BinanceProvider;
use crate::providers::catalog::CatalogRegistry;
use crate::providers::coinbase::CoinbaseProvider;
use crate::providers::kraken::KrakenProvider;
use crate::providers::rate_limit::RateLimiters;

/// Registry of installed adapters, keyed by `provider.id()`.
///
/// Adapters add themselves in P4.2 / P4.3 / P4.4 by calling `register()` from
/// `lib.rs`'s startup setup. P4.1 ships the registry empty.
pub struct ProviderRegistry {
    binance: Option<Arc<dyn MarketDataProvider>>,
    coinbase: Option<Arc<dyn MarketDataProvider>>,
    kraken: Option<Arc<dyn MarketDataProvider>>,
    /// Alpaca Markets equity adapter — `None` when credentials are absent
    /// (falls through to mock in the TS layer).
    alpaca: Option<Arc<dyn MarketDataProvider>>,
    // ADR-0009 — parallel typed handles so `market_fetch_history_v2` can call
    // each adapter's `fetch_history_pair` inherent method (not on the trait —
    // the trait stays frozen per ADR-0001). Registered alongside the dyn slot.
    binance_typed: Option<Arc<BinanceProvider>>,
    coinbase_typed: Option<Arc<CoinbaseProvider>>,
    kraken_typed: Option<Arc<KrakenProvider>>,
    alpaca_typed: Option<Arc<AlpacaProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            binance: None,
            coinbase: None,
            kraken: None,
            alpaca: None,
            binance_typed: None,
            coinbase_typed: None,
            kraken_typed: None,
            alpaca_typed: None,
        }
    }

    // ADR-0009 — typed accessors used by `market_fetch_history_v2` to invoke
    // the inherent `fetch_history_pair` methods on each adapter.
    pub fn binance_typed(&self) -> Option<Arc<BinanceProvider>> { self.binance_typed.clone() }
    pub fn coinbase_typed(&self) -> Option<Arc<CoinbaseProvider>> { self.coinbase_typed.clone() }
    pub fn kraken_typed(&self) -> Option<Arc<KrakenProvider>> { self.kraken_typed.clone() }
    pub fn alpaca_typed(&self) -> Option<Arc<AlpacaProvider>> { self.alpaca_typed.clone() }

    /// ADR-0009 — register both the dyn trait object and the typed Arc so the
    /// v1 (`market_fetch_history`) and v2 (`market_fetch_history_v2`) entry
    /// points see consistent adapter installations.
    pub fn register_binance(&mut self, p: Arc<BinanceProvider>) {
        self.binance = Some(p.clone());
        self.binance_typed = Some(p);
    }
    pub fn register_coinbase(&mut self, p: Arc<CoinbaseProvider>) {
        self.coinbase = Some(p.clone());
        self.coinbase_typed = Some(p);
    }
    pub fn register_kraken(&mut self, p: Arc<KrakenProvider>) {
        self.kraken = Some(p.clone());
        self.kraken_typed = Some(p);
    }
    pub fn register_alpaca(&mut self, p: Arc<AlpacaProvider>) {
        self.alpaca = Some(p.clone());
        self.alpaca_typed = Some(p);
    }

    /// Install an adapter for a known provider id. Unknown ids are ignored
    /// (the trait `id()` is `&'static str` so this is effectively closed
    /// for the v1 set).
    /// Used by P4.2 / P4.3 / P4.4 from `lib.rs` startup; quiet the dead-code
    /// lint here so P4.1 builds cleanly even with the registry empty.
    #[allow(dead_code)]
    pub fn register(&mut self, adapter: Arc<dyn MarketDataProvider>) {
        match adapter.id() {
            "binance" => self.binance = Some(adapter),
            "coinbase" => self.coinbase = Some(adapter),
            "kraken" => self.kraken = Some(adapter),
            "alpaca" => self.alpaca = Some(adapter),
            _ => { /* unknown provider id — silently ignore */ }
        }
    }

    /// Look up an adapter by provider id.
    pub fn get(&self, provider: &str) -> Option<Arc<dyn MarketDataProvider>> {
        match provider {
            "binance" => self.binance.clone(),
            "coinbase" => self.coinbase.clone(),
            "kraken" => self.kraken.clone(),
            "alpaca" => self.alpaca.clone(),
            _ => None,
        }
    }

    /// Remove any registered adapter for `name`. Used when credentials are
    /// missing after a reload attempt so a stale/broken adapter isn't left
    /// serving requests. After `clear`, `get(name)` returns `None`.
    pub fn clear(&mut self, name: &str) {
        match name {
            "binance"  => { self.binance  = None; self.binance_typed  = None; }
            "coinbase" => { self.coinbase = None; self.coinbase_typed = None; }
            "kraken"   => { self.kraken   = None; self.kraken_typed   = None; }
            "alpaca"   => { self.alpaca   = None; self.alpaca_typed   = None; }
            _ => {}
        }
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Bundled application state managed by Tauri.
///
/// `DbState` stays its existing `Arc<Mutex<Connection>>` so the rest of the
/// codebase (marks / watchlist / app_state commands) keeps using
/// `tauri::State<DbState>` unchanged. `AppState` aggregates the new pieces
/// and exposes them via `tauri::State<AppState>`.
pub struct AppState {
    pub db: DbState,
    pub limiters: RateLimiters,
    pub registry: AsyncMutex<ProviderRegistry>,
    /// ADR-0009 — parallel registry of `CatalogFetcher` impls (one per provider).
    /// Adapters register both here and in `registry` during `lib.rs` startup.
    pub catalog_registry: AsyncMutex<CatalogRegistry>,
}

impl AppState {
    pub fn new(db: DbState) -> Self {
        Self {
            db,
            limiters: RateLimiters::new(),
            registry: AsyncMutex::new(ProviderRegistry::new()),
            catalog_registry: AsyncMutex::new(CatalogRegistry::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// Timeframe → milliseconds (mirrors src/data/MarketDataProvider.ts Tf set)
// ---------------------------------------------------------------------------

/// Translate a 4-tier timeframe label to milliseconds, matching the TS Tf set.
/// Returns `None` for unknown labels so the orchestrator can return a typed
/// error rather than silently misbehaving.
fn tf_ms(tf: &str) -> Option<i64> {
    match tf {
        "1h" => Some(60 * 60 * 1000),
        "4h" => Some(4 * 60 * 60 * 1000),
        "1d" => Some(24 * 60 * 60 * 1000),
        "1w" => Some(7 * 24 * 60 * 60 * 1000),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// market_fetch_history — the entry point
// ---------------------------------------------------------------------------

/// Fetch up to `count` historical bars for `(provider, sym, tf)`.
///
/// Order of operations:
///   1. Validate `tf`.
///   2. Look up the adapter; if absent → return `"adapter not registered: …"`
///      so the TS layer can fall back to the mock.
///   3. Acquire a rate-limit token for the provider.
///   4. Call `adapter.fetch_history(...)`.
///   5. Upsert returned bars into the warm cache.
///   6. Return the bars to TS.
///
/// (Cache-first reads will be added in P4.5 once an adapter exists and we can
/// reason about freshness windows. P4.1 ships a write-through path so the
/// table starts populating as soon as the first real adapter lands.)
#[tauri::command]
pub async fn market_fetch_history(
    state: State<'_, AppState>,
    provider: String,
    sym: String,
    tf: String,
    count: usize,
) -> Result<Vec<BarRow>, String> {
    // 1. tf must be one of the 4-tier set.
    if tf_ms(&tf).is_none() {
        return Err(format!("unsupported timeframe: {tf}"));
    }

    // 2. Adapter lookup.
    let adapter = {
        let registry = state.registry.lock().await;
        registry.get(&provider)
    };
    let adapter = match adapter {
        Some(a) => a,
        None => return Err(format!("adapter not registered: {provider}")),
    };

    // 3. Rate-limit token.
    let bucket = state
        .limiters
        .for_provider(&provider)
        .ok_or_else(|| format!("no rate-limiter for provider: {provider}"))?;
    {
        let mut b = bucket.lock().await;
        b.acquire().await;
    }

    // 4. Fetch.
    let bars: Vec<Bar> = adapter
        .fetch_history(&sym, &tf, count)
        .await
        .map_err(|e: ProviderError| e.to_string())?;

    // 5. Upsert into warm cache (best-effort — a cache write failure should
    //    not poison the live response).
    let rows: Vec<BarRow> = bars.into_iter().map(BarRow::from).collect();
    if !rows.is_empty() {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Err(e) = bars_upsert(&conn, &provider, &sym, &tf, &rows) {
            eprintln!("[market] warm cache upsert failed: {e}");
        }
    }

    // 6. Return.
    Ok(rows)
}

// ---------------------------------------------------------------------------
// reload_provider — hot-reload a provider adapter after credentials change
// ---------------------------------------------------------------------------

/// Re-read credentials for `provider` and re-register the adapter.
///
/// This allows the frontend to save credentials via `set_provider_credentials`
/// and immediately pick them up without an app restart. Currently only
/// `"alpaca"` is supported; other providers return `Ok(())` as a no-op.
///
/// Hot-reload approach chosen over restart-required:
///   - Alpaca credentials are small and cheap to load from the credentials file.
///   - Re-registering an adapter is a simple lock-acquire + field update.
///   - The alternative (requiring restart) would leave the credentials banner
///     visible and the user without any confirmation that the save worked.
#[tauri::command]
pub async fn reload_provider(
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    use crate::commands::credentials::get_provider_credentials;

    match provider.as_str() {
        "alpaca" => {
            match get_provider_credentials("alpaca") {
                Some((key_id, secret)) => {
                    reload_alpaca_impl(&state, key_id, secret).await;
                    eprintln!("[alpaca] reload_provider: history adapter + catalog fetcher re-registered with new credentials");
                    Ok(())
                }
                None => {
                    // Credentials not found — clear any stale adapter so it
                    // doesn't continue serving requests with broken/old keys.
                    let mut registry = state.registry.lock().await;
                    registry.clear("alpaca");
                    Err("alpaca: credentials missing after save. The credential file write may have failed (check that the autoplot data dir is writable) or the binary may not have access. Try restarting the dev server.".to_string())
                }
            }
        }
        // Other providers don't currently support hot-reload.
        _ => Ok(()),
    }
}

/// Test-visible core of `reload_provider`'s alpaca arm. Re-registers the
/// freshly-credentialed Alpaca adapter into BOTH registries:
///   - `state.registry` (the `MarketDataProvider` history adapter, dyn + typed)
///   - `state.catalog_registry` (the `CatalogFetcher` used by
///     `symbol_catalog_fetch`)
///
/// The catalog registration is the bug fix: previously only the history
/// adapter was re-registered here, so the catalog registry kept serving the
/// credentials-less startup fetcher that always returns `AuthFailed` — the
/// live equity catalog could never populate after the user saved valid keys.
/// This mirrors the dual `r.register_alpaca(...)` + `cr.register(...)`
/// construction in `lib.rs` startup. Two `Arc`s of the same provider are
/// built (one per registry) so each holds an independent credentialed handle.
pub(crate) async fn reload_alpaca_impl(state: &AppState, key_id: String, secret: String) {
    let history = Arc::new(AlpacaProvider::with_credentials(key_id.clone(), secret.clone()));
    {
        let mut registry = state.registry.lock().await;
        registry.register_alpaca(history);
    }

    let catalog = Arc::new(AlpacaProvider::with_credentials(key_id, secret));
    {
        let mut catalog_registry = state.catalog_registry.lock().await;
        catalog_registry.register(catalog);
    }
}

// ---------------------------------------------------------------------------
// market_fetch_history_v2 — ADR-0009 multi-quote entry point
// ---------------------------------------------------------------------------

/// Fetch up to `count` historical bars for the canonical
/// `(provider, sym, quote, tf)` tuple, write through to `bars_v2`, and return.
///
/// Mirrors the v1 orchestrator but dispatches via the registry's typed handles
/// so each adapter's `fetch_history_pair(sym, quote, ...)` runs — preserving
/// the FROZEN `MarketDataProvider` trait per ADR-0001. v1 stays available for
/// any legacy caller that has not yet threaded `quote` through.
///
/// Rate-limit tokens are acquired exactly once (same bucket as v1), so a v1+v2
/// blend does not double-charge.
#[tauri::command]
pub async fn market_fetch_history_v2(
    state: State<'_, AppState>,
    provider: String,
    sym: String,
    quote: String,
    tf: String,
    count: usize,
    // Optional epoch-ms cursor: when present, return the page of bars STRICTLY
    // OLDER than this timestamp instead of the latest `count`. Declared as a
    // bare `Option<i64>` command arg — in Tauri 2 a missing field deserializes
    // to `None` automatically (the `CommandArg` impl for `Option` is the
    // equivalent of serde's `#[serde(default)]`), so existing callers that omit
    // `before` keep working. This matches the existing optional-arg convention
    // in `symbols.rs` (`providers: Option<Vec<String>>`) and `db.rs`.
    before: Option<i64>,
) -> Result<Vec<BarRow>, String> {
    market_fetch_history_v2_impl(&state, &provider, &sym, &quote, &tf, count, before).await
}

/// Shared rate-limit + typed-dispatch core for the v2 history commands.
///
/// Acquires the provider's rate-limit token, then routes to the matching typed
/// adapter's inherent `fetch_history_pair`. Used by both
/// `market_fetch_history_v2_impl` (4-tier `Tf`) and `market_fetch_latest_1m_impl`
/// (forced `"1m"`). Alpaca (equities) has no `before` cursor and ignores it.
async fn dispatch_typed_fetch(
    state: &AppState,
    provider: &str,
    sym: &str,
    quote: &str,
    tf: &str,
    count: usize,
    before: Option<i64>,
) -> Result<Vec<Bar>, String> {
    // Rate-limit token (shared bucket across v1/v2/latest_1m).
    let bucket = state
        .limiters
        .for_provider(provider)
        .ok_or_else(|| format!("no rate-limiter for provider: {provider}"))?;
    {
        let mut b = bucket.lock().await;
        b.acquire().await;
    }

    // Typed dispatch — each branch calls the inherent `fetch_history_pair`.
    let registry = state.registry.lock().await;
    let bars: Vec<Bar> = match provider {
        "binance" => {
            let p = registry
                .binance_typed()
                .ok_or_else(|| format!("adapter not registered: {provider}"))?;
            drop(registry);
            p.fetch_history_pair(sym, quote, tf, count, before)
                .await
                .map_err(|e: ProviderError| e.to_string())?
        }
        "coinbase" => {
            let p = registry
                .coinbase_typed()
                .ok_or_else(|| format!("adapter not registered: {provider}"))?;
            drop(registry);
            p.fetch_history_pair(sym, quote, tf, count, before)
                .await
                .map_err(|e: ProviderError| e.to_string())?
        }
        "kraken" => {
            let p = registry
                .kraken_typed()
                .ok_or_else(|| format!("adapter not registered: {provider}"))?;
            drop(registry);
            p.fetch_history_pair(sym, quote, tf, count, before)
                .await
                .map_err(|e: ProviderError| e.to_string())?
        }
        "alpaca" => {
            let p = registry
                .alpaca_typed()
                .ok_or_else(|| format!("adapter not registered: {provider}"))?;
            drop(registry);
            // Alpaca (equities) has no `before` cursor — silently ignored.
            let _ = before;
            p.fetch_history_pair(sym, quote, tf, count)
                .await
                .map_err(|e: ProviderError| e.to_string())?
        }
        other => return Err(format!("unknown provider: {other}")),
    };
    Ok(bars)
}

/// Test-visible implementation of `market_fetch_history_v2`. Takes a borrowed
/// `AppState` reference so unit tests can construct an `AppState` directly and
/// invoke the dispatch logic without going through the Tauri runtime (which
/// requires a fully-built `App` instance to fabricate `State<'_, T>`).
pub(crate) async fn market_fetch_history_v2_impl(
    state: &AppState,
    provider: &str,
    sym: &str,
    quote: &str,
    tf: &str,
    count: usize,
    before: Option<i64>,
) -> Result<Vec<BarRow>, String> {
    // 1. Validate tf.
    if tf_ms(tf).is_none() {
        return Err(format!("unsupported timeframe: {tf}"));
    }

    // 2. Rate-limit + typed dispatch (shared with market_fetch_latest_1m).
    let bars = dispatch_typed_fetch(state, provider, sym, quote, tf, count, before).await?;

    // 3. Warm-cache upsert to `bars_v2` (best-effort).
    let rows: Vec<BarRow> = bars.into_iter().map(BarRow::from).collect();
    if !rows.is_empty() {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Err(e) = bars_v2_upsert(&conn, provider, sym, quote, tf, &rows) {
            eprintln!("[market v2] warm cache upsert failed: {e}");
        }
    }

    Ok(rows)
}

// ---------------------------------------------------------------------------
// market_fetch_latest_1m — Fix A: 1h stale-price seed
// ---------------------------------------------------------------------------

/// Fetch the single latest **1-minute** `Bar` for `(provider, sym, quote)`.
///
/// ## Why this exists (Fix A — 1h stale-price bug)
///
/// The Alpaca chart seed previously fetched `count = 1` of the *chart's* own
/// timeframe. For a 1h chart that returns the last **completed** hourly bar,
/// which can be up to ~59 minutes stale. This command instead fetches the
/// latest completed **1-minute** bar (at most ~60s old). The TS adapter
/// (`seedCurrentBucket` in `src/data/adapters/alpaca.ts`) takes the returned
/// 1m close and re-stamps it onto the *current* chart bucket.
///
/// ## Why a dedicated command (not `market_fetch_history_v2`)
///
/// `"1m"` is intentionally NOT part of the frozen 4-tier chart `Tf` set
/// (ADR-0002), so the `tf_ms` gate in `market_fetch_history_v2_impl` rejects
/// it (`unsupported timeframe`). This command forces the `1m`/`1Min` timeframe
/// directly and **bypasses that gate**, while otherwise mirroring the v2
/// dispatch + rate-limit + provider-routing. It is the only freshness path that
/// hits Alpaca's `1Min` REST timeframe.
///
/// Alpaca is the requirement (equity seed). The crypto adapters' inherent
/// `fetch_history_pair` already accepts an arbitrary tf string, so they are
/// supported trivially here too — but the chart layer only calls this on the
/// Alpaca/equity path.
///
/// The latest 1m bar is NOT written to either warm cache: `bars`/`bars_v2` are
/// keyed by the 4-tier `Tf` set, and a `1m` row would pollute those tables.
#[tauri::command]
pub async fn market_fetch_latest_1m(
    state: State<'_, AppState>,
    provider: String,
    sym: String,
    quote: String,
) -> Result<Option<BarRow>, String> {
    market_fetch_latest_1m_impl(&state, &provider, &sym, &quote).await
}

/// Test-visible core of `market_fetch_latest_1m`. Takes a borrowed `AppState`
/// so unit tests can exercise the dispatch/guard logic without the Tauri
/// runtime (mirrors `market_fetch_history_v2_impl`).
pub(crate) async fn market_fetch_latest_1m_impl(
    state: &AppState,
    provider: &str,
    sym: &str,
    quote: &str,
) -> Result<Option<BarRow>, String> {
    // Deliberately NO `tf_ms` gate here — "1m" is not in the 4-tier set.
    // Force the "1m" timeframe (Alpaca maps it to "1Min"), count = 1, no cursor.
    let bars = dispatch_typed_fetch(state, provider, sym, quote, "1m", 1, None).await?;

    // Return the freshest (last, ascending) bar — or None if no data.
    Ok(bars.into_iter().next_back().map(BarRow::from))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;
    use rusqlite::Connection;
    use std::sync::Mutex as StdMutex;

    fn fresh_db() -> DbState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        run_migrations(&conn).expect("migrations");
        Arc::new(StdMutex::new(conn))
    }

    #[test]
    fn provider_registry_starts_empty() {
        let r = ProviderRegistry::new();
        assert!(r.get("binance").is_none());
        assert!(r.get("coinbase").is_none());
        assert!(r.get("kraken").is_none());
        assert!(r.get("alpaca").is_none());
    }

    #[tokio::test]
    async fn provider_registry_clear_removes_adapter() {
        use crate::providers::{Bar, MarketDataProvider, ProviderError};
        use async_trait::async_trait;

        /// Minimal stub adapter for testing registry clear.
        struct StubAdapter;
        #[async_trait]
        impl MarketDataProvider for StubAdapter {
            fn id(&self) -> &'static str { "alpaca" }
            async fn fetch_history(
                &self,
                _sym: &str,
                _tf: &str,
                _count: usize,
            ) -> Result<Vec<Bar>, ProviderError> {
                Ok(vec![])
            }
        }

        let mut r = ProviderRegistry::new();
        r.register(Arc::new(StubAdapter));
        assert!(r.get("alpaca").is_some(), "adapter should be present after register");

        r.clear("alpaca");
        assert!(r.get("alpaca").is_none(), "adapter should be absent after clear");
    }

    #[test]
    fn tf_ms_covers_4_tier_set() {
        assert_eq!(tf_ms("1h"), Some(3_600_000));
        assert_eq!(tf_ms("4h"), Some(14_400_000));
        assert_eq!(tf_ms("1d"), Some(86_400_000));
        assert_eq!(tf_ms("1w"), Some(7 * 86_400_000));
        assert_eq!(tf_ms("5m"), None, "5m is intentionally not in the v1 set");
        assert_eq!(tf_ms(""), None);
    }

    #[test]
    fn app_state_constructs_with_empty_registry() {
        let db = fresh_db();
        let state = AppState::new(db);
        // Use a tokio runtime to peek inside the async mutex.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let r = state.registry.lock().await;
            assert!(r.get("binance").is_none(), "no adapters in P4.1");
        });
    }

    // -------------------------------------------------------------------------
    // market_fetch_history_v2 tests (ADR-0009 / Step 11)
    //
    // We exercise the dispatch logic through `market_fetch_history_v2_impl`
    // rather than the `#[tauri::command]` wrapper (which requires a Tauri-built
    // `State<'_, T>` that can't be fabricated in a plain `cargo test`). The
    // impl takes `&AppState` directly so the same code path is covered.
    //
    // NOTE: The v2 dispatch uses TYPED registry handles
    // (`binance_typed()`, `coinbase_typed()`, etc.) returning concrete provider
    // structs rather than the `MarketDataProvider` trait. Injecting a stub
    // that returns canned bars would require refactoring the typed dispatch
    // to go through a trait object. The current tests instead assert:
    //   - tf is validated before dispatch (rejects 5m / empty)
    //   - rate-limiter guard catches unknown providers
    //   - "adapter not registered" is reported when typed_*() returns None
    //   - register_*() makes the typed handle visible to dispatch
    // Together these cover every branch except the happy-path fetch, which
    // is exercised through the live `cargo test smoke_live_*` integration
    // tests under each provider module.
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn market_fetch_history_v2_rejects_unsupported_tf() {
        let state = AppState::new(fresh_db());
        let err = market_fetch_history_v2_impl(&state, "binance", "BTC", "USDT", "5m", 10, None)
            .await
            .expect_err("5m is not in the 4-tier set");
        assert!(err.contains("unsupported timeframe"), "got: {err}");
    }

    #[tokio::test]
    async fn market_fetch_history_v2_returns_adapter_not_registered_for_known_provider() {
        // Fresh AppState has zero typed adapters installed — the v2 dispatch
        // for a known provider id should report "adapter not registered".
        let state = AppState::new(fresh_db());
        for provider in ["binance", "coinbase", "kraken", "alpaca"] {
            let err =
                market_fetch_history_v2_impl(&state, provider, "BTC", "USDT", "1h", 10, None)
                    .await
                    .expect_err(&format!("{provider}: no typed adapter installed"));
            assert!(
                err.contains("adapter not registered"),
                "{provider}: got {err}",
            );
        }
    }

    #[tokio::test]
    async fn market_fetch_history_v2_before_cursor_threads_through_for_known_providers() {
        // Supplying a `before` cursor must not change the early-guard behavior:
        // with no typed adapter installed, every known crypto provider still
        // reports "adapter not registered" (proving the cursor is accepted and
        // plumbed past tf-validation / rate-limit without altering dispatch).
        let state = AppState::new(fresh_db());
        let before = Some(1_700_000_000_000i64);
        for provider in ["binance", "coinbase", "kraken"] {
            let err =
                market_fetch_history_v2_impl(&state, provider, "BTC", "USDT", "1h", 10, before)
                    .await
                    .expect_err(&format!("{provider}: no typed adapter installed"));
            assert!(
                err.contains("adapter not registered"),
                "{provider} with before-cursor: got {err}",
            );
        }
    }

    #[tokio::test]
    async fn market_fetch_history_v2_rejects_unknown_provider() {
        // Unknown provider ids fail before dispatch reaches the typed branch —
        // the rate-limiter lookup is the first guard for any unknown id.
        let state = AppState::new(fresh_db());
        let err = market_fetch_history_v2_impl(&state, "bitstamp", "BTC", "USD", "1h", 10, None)
            .await
            .expect_err("bitstamp is not a known provider id");
        // Either "no rate-limiter for provider" (the actual first guard) or
        // "unknown provider" (the typed-dispatch fallthrough) is acceptable —
        // both reject the call before any work happens.
        assert!(
            err.contains("no rate-limiter") || err.contains("unknown provider"),
            "got: {err}",
        );
    }

    // -------------------------------------------------------------------------
    // reload_provider — alpaca arm registers BOTH registries (equity bug fix)
    //
    // The Tauri command wrapper reads credentials from the credentials file/env and can't
    // run in a plain `cargo test`, so we exercise `reload_alpaca_impl` (the
    // testable core that takes credentials directly). It must populate the
    // catalog_registry slot — previously omitted, which left the equity catalog
    // wedged on the credentials-less startup fetcher that always returns
    // AuthFailed.
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn reload_alpaca_registers_catalog_fetcher_with_credentials() {
        use crate::providers::ProviderError;

        let state = AppState::new(fresh_db());

        // Precondition: a fresh AppState has no alpaca catalog fetcher.
        {
            let cr = state.catalog_registry.lock().await;
            assert!(
                cr.get("alpaca").is_none(),
                "fresh catalog_registry has no alpaca fetcher"
            );
        }

        // Reload with valid-looking credentials.
        reload_alpaca_impl(&state, "AKTESTKEYID".to_string(), "test-secret".to_string()).await;

        // (1) History adapter is registered in the provider registry.
        {
            let reg = state.registry.lock().await;
            assert!(
                reg.get("alpaca").is_some(),
                "history adapter must be registered after reload"
            );
            assert!(
                reg.alpaca_typed().is_some(),
                "typed history handle must be registered after reload"
            );
        }

        // (2) THE FIX: a catalog fetcher is registered in the catalog registry,
        // and it is the *credentialed* variant — proven WITHOUT a real network
        // round-trip.
        //
        // Discriminator: `AlpacaProvider::fetch_catalog` runs a synchronous,
        // pre-network guard that returns `AuthFailed("...credentials not
        // configured...")` the instant `key_id`/`secret` are empty (alpaca.rs).
        // The credentialed variant passes that guard and proceeds to the
        // network. We wrap the call in a tight timeout so the credentialed
        // path (which would otherwise hit the live API) resolves locally:
        //   - Err(AuthFailed) containing "not configured" → empty fetcher → BUG
        //   - timeout / Network err / anything else        → guard passed → FIXED
        let fetcher = {
            let cr = state.catalog_registry.lock().await;
            cr.get("alpaca").expect("catalog fetcher must be registered after reload")
        };
        assert_eq!(fetcher.id(), "alpaca");

        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            fetcher.fetch_catalog(),
        )
        .await;

        if let Ok(Err(ProviderError::AuthFailed(msg))) = &outcome {
            assert!(
                !msg.contains("credentials not configured"),
                "registered fetcher is the credentials-less variant — the bug is NOT fixed (msg: {msg})"
            );
        }
        // A timeout (Err(_) from `timeout`) or any non-guard result confirms the
        // credentialed fetcher cleared the local no-creds guard. Control case:
        // an empty-creds fetcher returns AuthFailed("...not configured...")
        // synchronously, asserted by `fetch_catalog_no_creds_returns_auth_failed`
        // in providers/alpaca.rs.
    }

    // -------------------------------------------------------------------------
    // market_fetch_latest_1m (Fix A — 1h stale-price seed)
    //
    // Same testing constraints as the v2 dispatch (typed registry handles, real
    // HTTP adapters), so we assert the guard behavior:
    //   - NO tf gate: the impl never rejects on timeframe (it forces "1m").
    //   - "adapter not registered" when no typed adapter is installed.
    //   - unknown providers are rejected before dispatch.
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn market_fetch_latest_1m_returns_adapter_not_registered_for_known_provider() {
        // Fresh AppState has zero typed adapters — every known provider should
        // report "adapter not registered" (proving the tf gate did NOT reject
        // "1m" first — there is no tf gate on this path).
        let state = AppState::new(fresh_db());
        for provider in ["binance", "coinbase", "kraken", "alpaca"] {
            let err = market_fetch_latest_1m_impl(&state, provider, "BTC", "USDT")
                .await
                .expect_err(&format!("{provider}: no typed adapter installed"));
            assert!(
                err.contains("adapter not registered"),
                "{provider}: got {err}",
            );
        }
    }

    #[tokio::test]
    async fn market_fetch_latest_1m_rejects_unknown_provider() {
        let state = AppState::new(fresh_db());
        let err = market_fetch_latest_1m_impl(&state, "bitstamp", "BTC", "USD")
            .await
            .expect_err("bitstamp is not a known provider id");
        assert!(
            err.contains("no rate-limiter") || err.contains("unknown provider"),
            "got: {err}",
        );
    }

    #[tokio::test]
    async fn market_fetch_history_v2_typed_registration_is_visible_to_dispatch() {
        // Verify that `register_binance` plumbs the typed Arc into the
        // dispatch lookup. We don't drive a live network fetch here —
        // BinanceProvider speaks real HTTP. We just assert that after
        // registration, `binance_typed()` is `Some` (matching the v2 dispatch
        // branch's `ok_or_else("adapter not registered")` guard).
        use crate::providers::binance::BinanceProvider;
        let state = AppState::new(fresh_db());
        {
            let mut reg = state.registry.lock().await;
            assert!(
                reg.binance_typed().is_none(),
                "fresh registry has no typed binance"
            );
            reg.register_binance(Arc::new(BinanceProvider::new()));
            assert!(
                reg.binance_typed().is_some(),
                "after register_binance, typed handle is visible"
            );
        }
    }
}
