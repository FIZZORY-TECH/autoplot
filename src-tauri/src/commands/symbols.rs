//! src-tauri/src/commands/symbols.rs — Symbol catalog commands (ADR-0009).
//!
//! Four Tauri commands expose the dynamic catalog to the TS frontend:
//!
//!   `symbol_catalog_fetch(provider)` — pull the provider's full pair listing
//!       from its public REST endpoint, normalise into `SymbolRow`s, upsert to
//!       the `symbols` table (FTS5 stays in sync via the triggers in migration
//!       0013), and bump the `symbols_meta` freshness ledger.
//!   `symbol_catalog_list(provider, limit, offset)` — paged browse from cache.
//!       Returns `{ rows, total }` so the modal can render "Showing N of M".
//!   `symbol_catalog_search(query, providers, limit)` — FTS5 cross-provider
//!       search from cache. Empty query returns no rows.
//!   `symbol_catalog_meta()` — returns the freshness ledger across all
//!       providers (drives the "Refresh" button + TTL gating).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::db::{
    symbols_count_by_provider, symbols_list_by_provider, symbols_meta_list, symbols_meta_upsert,
    symbols_search_fts, symbols_upsert_batch, SymbolRow, SymbolsMeta,
};
use crate::commands::market::AppState;

/// Returned by `symbol_catalog_fetch`. `row_count` is the post-upsert provider
/// total, `fetched_at` is the unix-ms timestamp now persisted in `symbols_meta`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogFetchResult {
    pub provider: String,
    pub row_count: i64,
    pub fetched_at: i64,
}

/// Returned by `symbol_catalog_list`. `total` is the unfiltered provider row
/// count — used by the modal to render the "Showing N of M" footer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogListResult {
    pub rows: Vec<SymbolRow>,
    pub total: i64,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn symbol_catalog_fetch(
    state: State<'_, AppState>,
    provider: String,
) -> Result<CatalogFetchResult, String> {
    // 1. Resolve the CatalogFetcher impl for this provider.
    let fetcher = {
        let r = state.catalog_registry.lock().await;
        r.get(&provider)
            .ok_or_else(|| format!("catalog fetcher not registered: {provider}"))?
    };

    // 2. Respect the per-provider rate limit (shared with the bar-fetcher).
    let bucket = state
        .limiters
        .for_provider(&provider)
        .ok_or_else(|| format!("no rate-limiter for provider: {provider}"))?;
    {
        let mut b = bucket.lock().await;
        b.acquire().await;
    }

    // 3. Hit the network.
    let rows = fetcher
        .fetch_catalog()
        .await
        .map_err(|e| e.to_string())?;

    // 4. Upsert into SQLite and bump the freshness ledger.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    symbols_upsert_batch(&conn, &rows).map_err(|e| e.to_string())?;
    let row_count = symbols_count_by_provider(&conn, &provider).map_err(|e| e.to_string())?;
    symbols_meta_upsert(&conn, &provider, now, row_count).map_err(|e| e.to_string())?;

    Ok(CatalogFetchResult {
        provider,
        row_count,
        fetched_at: now,
    })
}

#[tauri::command]
pub fn symbol_catalog_list(
    state: State<'_, AppState>,
    provider: String,
    limit: u32,
    offset: u32,
) -> Result<CatalogListResult, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let rows = symbols_list_by_provider(&conn, &provider, limit, offset)
        .map_err(|e| e.to_string())?;
    let total = symbols_count_by_provider(&conn, &provider).map_err(|e| e.to_string())?;
    Ok(CatalogListResult { rows, total })
}

#[tauri::command]
pub fn symbol_catalog_search(
    state: State<'_, AppState>,
    query: String,
    providers: Option<Vec<String>>,
    limit: u32,
) -> Result<Vec<SymbolRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    symbols_search_fts(&conn, &query, providers.as_deref(), limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn symbol_catalog_meta(
    state: State<'_, AppState>,
) -> Result<Vec<SymbolsMeta>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    symbols_meta_list(&conn).map_err(|e| e.to_string())
}
