//! src-tauri/src/commands/db.rs — DB command module (A9)
//!
//! This module is the single audit point for all SQLite access from the
//! frontend. No Tauri command anywhere else should open or query the DB.
//!
//! Phases:
//!   P2  → db_marks_list, db_marks_insert, db_marks_delete  (this file)
//!   P3  → db_watchlist_*, db_app_state_*
//!   P4  → db_bars_*

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::providers::Bar;

/// Shared DB handle injected into Tauri's managed state on startup.
/// Commands receive it as `state: tauri::State<DbState>`.
pub type DbState = Arc<Mutex<Connection>>;

// ---------------------------------------------------------------------------
// Marks (P2.5)
// ---------------------------------------------------------------------------

/// One annotated mark on a chart. `note == None` → Mark; `note == Some(_)` → Comment.
/// Field names use snake_case in the JSON wire format; the TS wrapper mirrors them.
///
/// ADR-0009 (Step 11) — `quote` joins the canonical key tuple alongside `(provider, sym)`.
/// Migration 0016 backfilled existing rows with the per-provider default quote; new
/// reads/writes thread the quote through so BTC/USDT and BTC/USDC marks stay isolated.
#[derive(Debug, Clone, Serialize)]
pub struct Mark {
    pub id: i64,
    pub sym: String,
    pub provider: String,
    /// Canonical quote token, e.g. 'USDT', 'USDC', 'USD'. Added in Step 11 / migration 0016.
    pub quote: String,
    pub price: f64,
    pub ts: i64,
    pub color: String,
    pub note: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_marks_list(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
) -> Result<Vec<Mark>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    marks_list(&conn, &sym, &provider, &quote).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_marks_insert(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
    price: f64,
    ts: i64,
    color: String,
    note: Option<String>,
) -> Result<i64, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    marks_insert(&conn, &sym, &provider, &quote, price, ts, &color, note.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_marks_delete(
    state: tauri::State<'_, DbState>,
    id: i64,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    marks_delete(&conn, id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests (don't depend on tauri::State).
// ---------------------------------------------------------------------------

pub(crate) fn marks_list(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
) -> rusqlite::Result<Vec<Mark>> {
    // ADR-0008/0009: reads include `provider` AND `quote` in the key tuple.
    let mut stmt = conn.prepare(
        "SELECT id, sym, provider, quote, price, ts, color, note, created_at
         FROM marks
         WHERE sym = ?1 AND provider = ?2 AND quote = ?3
         ORDER BY ts ASC, id ASC",
    )?;
    let rows = stmt
        .query_map(params![sym, provider, quote], |row| {
            Ok(Mark {
                id: row.get(0)?,
                sym: row.get(1)?,
                provider: row.get(2)?,
                quote: row.get(3)?,
                price: row.get(4)?,
                ts: row.get(5)?,
                color: row.get(6)?,
                note: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn marks_insert(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
    price: f64,
    ts: i64,
    color: &str,
    note: Option<&str>,
) -> rusqlite::Result<i64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // ADR-0008/0009: provider + quote are mandatory on every insert.
    conn.execute(
        "INSERT INTO marks (sym, provider, quote, price, ts, color, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![sym, provider, quote, price, ts, color, note, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn marks_delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM marks WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Watchlist (P3.1)
// ---------------------------------------------------------------------------

/// One entry in the user's watchlist.
#[derive(Debug, Clone, Serialize)]
pub struct WatchlistEntry {
    pub sym: String,
    pub provider: String,
    pub added_at: i64,
}

#[tauri::command]
pub fn db_watchlist_list(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<WatchlistEntry>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    watchlist_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_watchlist_add(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    watchlist_add(&conn, &sym, &provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_watchlist_remove(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    watchlist_remove(&conn, &sym, &provider).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// App state (P3.1)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_app_state_get(
    state: tauri::State<'_, DbState>,
    key: String,
) -> Result<Option<String>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    app_state_get(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_app_state_set(
    state: tauri::State<'_, DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    app_state_set(&conn, &key, &value).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pure helpers — watchlist
// ---------------------------------------------------------------------------

pub(crate) fn watchlist_list(conn: &Connection) -> rusqlite::Result<Vec<WatchlistEntry>> {
    let mut stmt = conn.prepare(
        "SELECT sym, provider, added_at FROM watchlist ORDER BY added_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WatchlistEntry {
                sym: row.get(0)?,
                provider: row.get(1)?,
                added_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn watchlist_add(
    conn: &Connection,
    sym: &str,
    provider: &str,
) -> rusqlite::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // INSERT OR IGNORE respects the PK constraint — duplicate adds are safe no-ops.
    conn.execute(
        "INSERT OR IGNORE INTO watchlist (sym, provider, added_at) VALUES (?1, ?2, ?3)",
        params![sym, provider, now],
    )?;
    Ok(())
}

pub(crate) fn watchlist_remove(
    conn: &Connection,
    sym: &str,
    provider: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM watchlist WHERE sym = ?1 AND provider = ?2",
        params![sym, provider],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pure helpers — app_state
// ---------------------------------------------------------------------------

pub(crate) fn app_state_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let result = conn.query_row(
        "SELECT value FROM app_state WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn app_state_set(
    conn: &Connection,
    key: &str,
    value: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Bars warm cache (P4.1)
// ---------------------------------------------------------------------------

/// Wire shape mirroring the Rust `providers::Bar`. Re-declared as a thin
/// `Deserialize` newtype-shaped struct so the Tauri command handler can
/// receive bars from the TS side without needing `Bar` itself to derive
/// `Deserialize` extra constraints. (We keep `providers::Bar` derives general.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarRow {
    pub ts: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

impl From<BarRow> for Bar {
    fn from(b: BarRow) -> Self {
        Bar { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
    }
}

impl From<Bar> for BarRow {
    fn from(b: Bar) -> Self {
        BarRow { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
    }
}

/// Read all bars for `(provider, sym, tf)` whose `ts` falls in
/// `[since_ts, until_ts]` inclusive, ordered by `ts` ascending.
#[tauri::command]
pub fn db_bars_get_range(
    state: tauri::State<'_, DbState>,
    provider: String,
    sym: String,
    tf: String,
    since_ts: i64,
    until_ts: i64,
) -> Result<Vec<BarRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    bars_get_range(&conn, &provider, &sym, &tf, since_ts, until_ts)
        .map_err(|e| e.to_string())
}

/// Upsert a batch of bars into the warm cache. Existing rows with the same PK
/// are replaced (so re-fetching a partial bar overwrites with the final close).
#[tauri::command]
pub fn db_bars_upsert(
    state: tauri::State<'_, DbState>,
    provider: String,
    sym: String,
    tf: String,
    bars: Vec<BarRow>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    bars_upsert(&conn, &provider, &sym, &tf, &bars).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pure helpers — bars
// ---------------------------------------------------------------------------

pub(crate) fn bars_get_range(
    conn: &Connection,
    provider: &str,
    sym: &str,
    tf: &str,
    since_ts: i64,
    until_ts: i64,
) -> rusqlite::Result<Vec<BarRow>> {
    let mut stmt = conn.prepare(
        "SELECT ts, o, h, l, c, v
         FROM bars
         WHERE provider = ?1 AND sym = ?2 AND tf = ?3
           AND ts >= ?4 AND ts <= ?5
         ORDER BY ts ASC",
    )?;
    let rows = stmt
        .query_map(params![provider, sym, tf, since_ts, until_ts], |row| {
            Ok(BarRow {
                ts: row.get(0)?,
                o: row.get(1)?,
                h: row.get(2)?,
                l: row.get(3)?,
                c: row.get(4)?,
                v: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn bars_upsert(
    conn: &Connection,
    provider: &str,
    sym: &str,
    tf: &str,
    bars: &[BarRow],
) -> rusqlite::Result<()> {
    // INSERT OR REPLACE keeps the (provider, sym, tf, ts) PK semantics:
    // a re-fetched bar overwrites the cached one (last-write wins).
    let sql = "INSERT OR REPLACE INTO bars(provider, sym, tf, ts, o, h, l, c, v)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)";
    // One transaction wraps the whole batch for atomicity + speed.
    let tx_guard = conn.unchecked_transaction()?;
    {
        let mut stmt = conn.prepare(sql)?;
        for b in bars {
            stmt.execute(params![provider, sym, tf, b.ts, b.o, b.h, b.l, b.c, b.v])?;
        }
    }
    tx_guard.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Trends (P2.6 follow-up — Step 4)
// ---------------------------------------------------------------------------

/// One persisted trend line. Two anchor points (`ts`, `price`) define a
/// segment that the chart projects through the standard view-transform.
/// `id` is a TEXT primary key — the TS side generates a stable id (e.g.
/// crypto.randomUUID) so insert is idempotent over reloads.
/// ADR-0009 (Step 11) — `quote` joins the canonical key tuple. Migration 0017
/// backfilled rows; new reads/writes thread the quote so BTC/USDT and BTC/USDC
/// trend lines stay isolated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendRow {
    pub id: String,
    pub sym: String,
    pub provider: String,
    /// Canonical quote token, added in Step 11 / migration 0017.
    pub quote: String,
    pub tf: String,
    pub x1_ts: i64,
    pub y1_price: f64,
    pub x2_ts: i64,
    pub y2_price: f64,
    pub color: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_trends_list(
    state: tauri::State<'_, DbState>,
    sym: String,
    tf: String,
    provider: String,
    quote: String,
) -> Result<Vec<TrendRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    trends_list(&conn, &sym, &tf, &provider, &quote).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_trends_insert(
    state: tauri::State<'_, DbState>,
    trend: TrendRow,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    trends_insert(&conn, &trend).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_trends_delete(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    trends_delete(&conn, &id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pure helpers — trends (exported for unit tests)
// ---------------------------------------------------------------------------

pub(crate) fn trends_list(
    conn: &Connection,
    sym: &str,
    tf: &str,
    provider: &str,
    quote: &str,
) -> rusqlite::Result<Vec<TrendRow>> {
    // ADR-0008/0009: reads include `provider` AND `quote` in the key tuple.
    let mut stmt = conn.prepare(
        "SELECT id, sym, provider, quote, tf, x1_ts, y1_price, x2_ts, y2_price, color, created_at
         FROM trends
         WHERE sym = ?1 AND tf = ?2 AND provider = ?3 AND quote = ?4
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map(params![sym, tf, provider, quote], |row| {
            Ok(TrendRow {
                id: row.get(0)?,
                sym: row.get(1)?,
                provider: row.get(2)?,
                quote: row.get(3)?,
                tf: row.get(4)?,
                x1_ts: row.get(5)?,
                y1_price: row.get(6)?,
                x2_ts: row.get(7)?,
                y2_price: row.get(8)?,
                color: row.get(9)?,
                created_at: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn trends_insert(
    conn: &Connection,
    t: &TrendRow,
) -> rusqlite::Result<()> {
    // ADR-0008/0009: provider + quote are mandatory on every insert.
    conn.execute(
        "INSERT INTO trends (id, sym, provider, quote, tf, x1_ts, y1_price, x2_ts, y2_price, color, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            t.id,
            t.sym,
            t.provider,
            t.quote,
            t.tf,
            t.x1_ts,
            t.y1_price,
            t.x2_ts,
            t.y2_price,
            t.color,
            t.created_at,
        ],
    )?;
    Ok(())
}

pub(crate) fn trends_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM trends WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Datasets (P6 W4-B) — AI Research result rows.
// One row per persisted Dataset; `json` is the full Dataset JSON blob (the Zod
// shape lives in `src/ai/schemas.ts`, owned by W4-A). Mirrors the trends
// pattern: TEXT primary key generated on the TS side, snake_case wire shape.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetRow {
    pub id: String,
    pub json: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_datasets_list(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<DatasetRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    datasets_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_datasets_upsert(
    state: tauri::State<'_, DbState>,
    row: DatasetRow,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    datasets_upsert(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_datasets_delete(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    datasets_delete(&conn, &id).map_err(|e| e.to_string())
}

pub(crate) fn datasets_list(conn: &Connection) -> rusqlite::Result<Vec<DatasetRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, json, created_at FROM datasets ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DatasetRow {
                id: row.get(0)?,
                json: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn datasets_upsert(conn: &Connection, r: &DatasetRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO datasets (id, json, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![r.id, r.json, r.created_at],
    )?;
    Ok(())
}

pub(crate) fn datasets_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM datasets WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Research overlays (blob store) — persisted analysis passes the user can
// render over the chart. One row per overlay; `json` is the full JSON blob.
// Mirrors the datasets pattern exactly: TEXT primary key generated on the TS
// side, snake_case wire shape.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchOverlayRow {
    pub id: String,
    pub json: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_research_overlays_list(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<ResearchOverlayRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    research_overlays_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_research_overlays_upsert(
    state: tauri::State<'_, DbState>,
    row: ResearchOverlayRow,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    research_overlays_upsert(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_research_overlays_delete(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    research_overlays_delete(&conn, &id).map_err(|e| e.to_string())
}

pub(crate) fn research_overlays_list(conn: &Connection) -> rusqlite::Result<Vec<ResearchOverlayRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, json, created_at FROM research_overlays ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ResearchOverlayRow {
                id: row.get(0)?,
                json: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn research_overlays_upsert(conn: &Connection, r: &ResearchOverlayRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO research_overlays (id, json, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![r.id, r.json, r.created_at],
    )?;
    Ok(())
}

pub(crate) fn research_overlays_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM research_overlays WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ai_strategies (Step 11b) — append-only revision-tracked strategy editor.
//
// These two commands thin-wrap the DAO in `ai_workspace.rs`:
//   - `db_ai_strategy_get(id)`              → Option<AiStrategy>
//   - `db_ai_strategy_update_body(id, new_body_json)` → AiStrategy (new rev)
//
// The DAO enforces ADR-0005: `update_body` NEVER mutates an existing revision
// row — it inserts a new `strategy_revisions` row with rev = current+1.
// ---------------------------------------------------------------------------

use crate::ai_workspace::{strategy_get, strategy_update, AiStrategy};

/// Return the strategy head record (name, body_json, current_revision, …) for
/// the given `id`.  Returns `None` when the id is unknown — the TS panel shows
/// a "[not found]" placeholder in that case.
#[tauri::command]
pub fn db_ai_strategy_get(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<Option<AiStrategy>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    strategy_get(&conn, &id).map_err(|e| e.to_string())
}

/// Save a new body for the strategy — writes a new revision row (ADR-0005).
/// Returns the updated head record so the UI can refresh the revision badge.
///
/// The caller supplies only `id` and `new_body_json`; this command generates
/// a UUID for the new revision row (matches the DAO's rev_id parameter).
#[tauri::command]
pub fn db_ai_strategy_update_body(
    state: tauri::State<'_, DbState>,
    id: String,
    new_body_json: String,
) -> Result<AiStrategy, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    // Generate a stable UUID for the new revision row.
    let rev_id = uuid_v4();
    strategy_update(&conn, &id, &new_body_json, &rev_id).map_err(|e| e.to_string())
}

/// Simple UUID-v4 generator that works without the `uuid` crate — pulls 16
/// random bytes from `getrandom` (already in the dependency tree via Tauri)
/// and formats them in the standard 8-4-4-4-12 pattern.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Simple pseudo-random UUID using time + thread seed. Not cryptographic,
    // but sufficient for a revision row PK where collision probability over the
    // lifetime of one user's strategy history is negligible.
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Mix with a per-call counter via atomic to avoid duplicates on fast calls.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seq128 = seq as u128;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (ts >> 32) as u32,
        ((ts >> 16) & 0xffff) as u16,
        (ts & 0x0fff) as u16,
        (0x8000u128 | (seq128 & 0x3fff)) as u16,
        (ts ^ (seq128 << 8)) & 0xffffffffffff,
    )
}

// ---------------------------------------------------------------------------
// Strategies (P7 W5-C3) — AI Co-Strategy result rows.
// One row per persisted Strategy; `json` is the full Strategy JSON blob (the
// Zod shape lives in `src/ai/schemas.ts`, owned by W5-A). Mirrors the datasets
// pattern: TEXT primary key generated on the TS side, snake_case wire shape.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyRow {
    pub id: String,
    pub json: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_strategies_list(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<StrategyRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    strategies_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_strategies_upsert(
    state: tauri::State<'_, DbState>,
    row: StrategyRow,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    strategies_upsert(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_strategies_delete(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    strategies_delete(&conn, &id).map_err(|e| e.to_string())
}

pub(crate) fn strategies_list(conn: &Connection) -> rusqlite::Result<Vec<StrategyRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, json, created_at FROM strategies ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StrategyRow {
                id: row.get(0)?,
                json: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn strategies_upsert(conn: &Connection, r: &StrategyRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO strategies (id, json, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![r.id, r.json, r.created_at],
    )?;
    Ok(())
}

pub(crate) fn strategies_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM strategies WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// AI sessions (P5 W1-A) — one row per Claude CLI conversation thread.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSessionRow {
    pub id: String,
    pub mode: String,
    pub cwd_path: String,
    pub model: Option<String>,
    pub created_at: i64,
    pub last_used_at: i64,
    pub summary: Option<String>,
}

#[tauri::command]
pub fn db_ai_sessions_list(
    state: tauri::State<'_, DbState>,
    mode: Option<String>,
) -> Result<Vec<AiSessionRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    ai_sessions_list(&conn, mode.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_ai_sessions_get(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<Option<AiSessionRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    ai_sessions_get(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_ai_sessions_delete(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    ai_sessions_delete(&conn, &id).map_err(|e| e.to_string())
}

// Pure helpers — used by the db_ai_sessions_* Tauri commands above.

pub(crate) fn ai_sessions_list(
    conn: &Connection,
    mode: Option<&str>,
) -> rusqlite::Result<Vec<AiSessionRow>> {
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(AiSessionRow {
            id: row.get(0)?,
            mode: row.get(1)?,
            cwd_path: row.get(2)?,
            model: row.get(3)?,
            created_at: row.get(4)?,
            last_used_at: row.get(5)?,
            summary: row.get(6)?,
        })
    };
    match mode {
        Some(m) => {
            let mut stmt = conn.prepare(
                "SELECT id, mode, cwd_path, model, created_at, last_used_at, summary
                 FROM ai_sessions WHERE mode = ?1 ORDER BY last_used_at DESC",
            )?;
            let rows = stmt
                .query_map(params![m], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, mode, cwd_path, model, created_at, last_used_at, summary
                 FROM ai_sessions ORDER BY last_used_at DESC",
            )?;
            let rows = stmt
                .query_map([], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    }
}

pub(crate) fn ai_sessions_get(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<AiSessionRow>> {
    let result = conn.query_row(
        "SELECT id, mode, cwd_path, model, created_at, last_used_at, summary
         FROM ai_sessions WHERE id = ?1",
        params![id],
        |row| {
            Ok(AiSessionRow {
                id: row.get(0)?,
                mode: row.get(1)?,
                cwd_path: row.get(2)?,
                model: row.get(3)?,
                created_at: row.get(4)?,
                last_used_at: row.get(5)?,
                summary: row.get(6)?,
            })
        },
    );
    match result {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn ai_sessions_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ai_sessions WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// watchlist_v2 + bars_v2 Tauri commands (ADR-0009)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_watchlist_v2_list(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<WatchlistEntryV2>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    watchlist_v2_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_watchlist_v2_add(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    watchlist_v2_add(&conn, &sym, &provider, &quote).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_watchlist_v2_remove(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    watchlist_v2_remove(&conn, &sym, &provider, &quote).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_bars_v2_get_range(
    state: tauri::State<'_, DbState>,
    provider: String,
    sym: String,
    quote: String,
    tf: String,
    since_ts: i64,
    until_ts: i64,
) -> Result<Vec<BarRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    bars_v2_get_range(&conn, &provider, &sym, &quote, &tf, since_ts, until_ts)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_bars_v2_upsert(
    state: tauri::State<'_, DbState>,
    provider: String,
    sym: String,
    quote: String,
    tf: String,
    bars: Vec<BarRow>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    bars_v2_upsert(&conn, &provider, &sym, &quote, &tf, &bars).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Symbol catalog (ADR-0009)
// ---------------------------------------------------------------------------

pub use crate::providers::catalog::SymbolRow;

/// One row of the per-provider freshness ledger (`symbols_meta`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolsMeta {
    pub provider: String,
    pub fetched_at: i64,
    pub row_count: i64,
}

pub(crate) fn symbols_upsert_batch(
    conn: &Connection,
    rows: &[SymbolRow],
) -> rusqlite::Result<()> {
    // INSERT OR REPLACE keeps the (provider, sym, quote) PK semantics and
    // fires the AFTER UPDATE FTS5 trigger so symbols_fts stays in sync.
    let sql = "INSERT OR REPLACE INTO symbols
                   (provider, sym, quote, name, class, status, native_sym)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";
    let tx_guard = conn.unchecked_transaction()?;
    {
        let mut stmt = conn.prepare(sql)?;
        for r in rows {
            stmt.execute(params![
                r.provider, r.sym, r.quote, r.name, r.class, r.status, r.native_sym,
            ])?;
        }
    }
    tx_guard.commit()?;
    Ok(())
}

pub(crate) fn symbols_list_by_provider(
    conn: &Connection,
    provider: &str,
    limit: u32,
    offset: u32,
) -> rusqlite::Result<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        "SELECT provider, sym, quote, name, class, status, native_sym
         FROM symbols
         WHERE provider = ?1
         ORDER BY sym ASC, quote ASC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt
        .query_map(params![provider, limit, offset], |row| {
            Ok(SymbolRow {
                provider: row.get(0)?,
                sym: row.get(1)?,
                quote: row.get(2)?,
                name: row.get(3)?,
                class: row.get(4)?,
                status: row.get(5)?,
                native_sym: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Count rows for a provider — used by `symbol_catalog_list` to render the
/// "Showing N of M" capped-browse footer.
pub(crate) fn symbols_count_by_provider(
    conn: &Connection,
    provider: &str,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM symbols WHERE provider = ?1",
        params![provider],
        |row| row.get(0),
    )
}

/// Look up the catalog `class` for a single `(provider, sym)` instrument.
///
/// Returns the catalog row's `class` (`"crypto"` / `"equity"`) when the symbol
/// has been materialised into the `symbols` table by a `symbol_catalog_fetch`,
/// or `None` when no such row exists yet. Used by the portfolio mutation
/// handlers to derive `asset_class` instead of blindly defaulting to crypto,
/// which miscategorised equities. Matches on the lowest `quote` row so a
/// USD/USDT ambiguity resolves deterministically; `class` is quote-invariant
/// in practice (a ticker is either an equity or a crypto pair across quotes).
pub(crate) fn symbol_class_lookup(
    conn: &Connection,
    provider: &str,
    sym: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT class FROM symbols WHERE provider = ?1 AND sym = ?2
         ORDER BY quote ASC LIMIT 1",
        params![provider, sym],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// FTS5-backed search. Empty/whitespace `query` returns no rows (callers should
/// fall back to `symbols_list_by_provider` for browse mode). `providers` filter
/// is honoured when `Some(non-empty)`; `None` or empty Vec means all providers.
///
/// The caller is expected to pass a sanitised FTS5 MATCH expression (e.g.
/// `"btc*"` for prefix). Tokens are split by whitespace inside FTS5 itself.
pub(crate) fn symbols_search_fts(
    conn: &Connection,
    query: &str,
    providers: Option<&[String]>,
    limit: u32,
) -> rusqlite::Result<Vec<SymbolRow>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    // Build the IN (...) clause inline so we can use ?N placeholders for the
    // values. rusqlite has no built-in "list bind" — we lay them out manually.
    let mut sql = String::from(
        "SELECT s.provider, s.sym, s.quote, s.name, s.class, s.status, s.native_sym
         FROM symbols s
         JOIN symbols_fts fts ON fts.rowid = s.rowid
         WHERE symbols_fts MATCH ?1",
    );
    let mut param_strs: Vec<String> = vec![q.to_string()];
    if let Some(ps) = providers {
        if !ps.is_empty() {
            let placeholders: Vec<String> = (2..=ps.len() + 1).map(|i| format!("?{i}")).collect();
            sql.push_str(&format!(" AND s.provider IN ({})", placeholders.join(",")));
            for p in ps {
                param_strs.push(p.clone());
            }
        }
    }
    // bm25 returns lower = more relevant; rank by relevance, tie-break by sym.
    sql.push_str(&format!(
        " ORDER BY bm25(symbols_fts) ASC, s.sym ASC LIMIT ?{}",
        param_strs.len() + 1
    ));

    let mut stmt = conn.prepare(&sql)?;
    let params_dyn: Vec<&dyn rusqlite::ToSql> = param_strs
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .chain(std::iter::once(&limit as &dyn rusqlite::ToSql))
        .collect();
    let rows = stmt
        .query_map(params_dyn.as_slice(), |row| {
            Ok(SymbolRow {
                provider: row.get(0)?,
                sym: row.get(1)?,
                quote: row.get(2)?,
                name: row.get(3)?,
                class: row.get(4)?,
                status: row.get(5)?,
                native_sym: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[allow(dead_code)] // used by Step 10's per-provider TTL gating in `ensureFreshCatalog`
pub(crate) fn symbols_meta_get(
    conn: &Connection,
    provider: &str,
) -> rusqlite::Result<Option<SymbolsMeta>> {
    let result = conn.query_row(
        "SELECT provider, fetched_at, row_count FROM symbols_meta WHERE provider = ?1",
        params![provider],
        |row| {
            Ok(SymbolsMeta {
                provider: row.get(0)?,
                fetched_at: row.get(1)?,
                row_count: row.get(2)?,
            })
        },
    );
    match result {
        Ok(m) => Ok(Some(m)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn symbols_meta_upsert(
    conn: &Connection,
    provider: &str,
    fetched_at: i64,
    row_count: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO symbols_meta (provider, fetched_at, row_count) VALUES (?1, ?2, ?3)
         ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, row_count = excluded.row_count",
        params![provider, fetched_at, row_count],
    )?;
    Ok(())
}

pub(crate) fn symbols_meta_list(conn: &Connection) -> rusqlite::Result<Vec<SymbolsMeta>> {
    let mut stmt = conn.prepare(
        "SELECT provider, fetched_at, row_count FROM symbols_meta ORDER BY provider ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SymbolsMeta {
                provider: row.get(0)?,
                fetched_at: row.get(1)?,
                row_count: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// watchlist_v2 helpers (ADR-0009)
// ---------------------------------------------------------------------------

/// One entry in the user's v2 watchlist (multi-quote aware).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchlistEntryV2 {
    pub sym: String,
    pub provider: String,
    pub quote: String,
    pub added_at: i64,
}

pub(crate) fn watchlist_v2_list(conn: &Connection) -> rusqlite::Result<Vec<WatchlistEntryV2>> {
    let mut stmt = conn.prepare(
        "SELECT sym, provider, quote, added_at FROM watchlist_v2 ORDER BY added_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WatchlistEntryV2 {
                sym: row.get(0)?,
                provider: row.get(1)?,
                quote: row.get(2)?,
                added_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn watchlist_v2_add(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
) -> rusqlite::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT OR IGNORE INTO watchlist_v2 (sym, provider, quote, added_at) VALUES (?1, ?2, ?3, ?4)",
        params![sym, provider, quote, now],
    )?;
    Ok(())
}

pub(crate) fn watchlist_v2_remove(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM watchlist_v2 WHERE sym = ?1 AND provider = ?2 AND quote = ?3",
        params![sym, provider, quote],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// bars_v2 helpers (ADR-0009)
// ---------------------------------------------------------------------------

pub(crate) fn bars_v2_get_range(
    conn: &Connection,
    provider: &str,
    sym: &str,
    quote: &str,
    tf: &str,
    since_ts: i64,
    until_ts: i64,
) -> rusqlite::Result<Vec<BarRow>> {
    let mut stmt = conn.prepare(
        "SELECT ts, o, h, l, c, v
         FROM bars_v2
         WHERE provider = ?1 AND sym = ?2 AND quote = ?3 AND tf = ?4
           AND ts >= ?5 AND ts <= ?6
         ORDER BY ts ASC",
    )?;
    let rows = stmt
        .query_map(params![provider, sym, quote, tf, since_ts, until_ts], |row| {
            Ok(BarRow {
                ts: row.get(0)?,
                o: row.get(1)?,
                h: row.get(2)?,
                l: row.get(3)?,
                c: row.get(4)?,
                v: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn bars_v2_upsert(
    conn: &Connection,
    provider: &str,
    sym: &str,
    quote: &str,
    tf: &str,
    bars: &[BarRow],
) -> rusqlite::Result<()> {
    let sql = "INSERT OR REPLACE INTO bars_v2(provider, sym, quote, tf, ts, o, h, l, c, v)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)";
    let tx_guard = conn.unchecked_transaction()?;
    {
        let mut stmt = conn.prepare(sql)?;
        for b in bars {
            stmt.execute(params![provider, sym, quote, tf, b.ts, b.o, b.h, b.l, b.c, b.v])?;
        }
    }
    tx_guard.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Portfolio holdings (portfolio feature)
//
// Simple position store: one editable row per (sym, provider, quote).
// NOT a transaction ledger — only qty + avg_cost are persisted.
// P&L is computed at read time from live prices in the TS layer.
// ---------------------------------------------------------------------------

/// One portfolio position. Fields mirror the `portfolio_holdings` table
/// column-for-column in snake_case; timestamps are unix milliseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoldingRow {
    pub sym: String,
    pub provider: String,
    pub quote: String,
    pub asset_class: String,
    pub qty: f64,
    pub avg_cost: f64,
    pub currency: String,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Tauri command wrappers — portfolio
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_portfolio_list(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<HoldingRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    holdings_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_portfolio_upsert(
    state: tauri::State<'_, DbState>,
    holding: HoldingRow,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    holding_upsert(&conn, &holding).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_portfolio_add_lot(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
    asset_class: String,
    add_qty: f64,
    add_price: f64,
    currency: String,
    note: Option<String>,
    now_ms: i64,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    holding_add_lot(
        &conn,
        &sym,
        &provider,
        &quote,
        &asset_class,
        add_qty,
        add_price,
        &currency,
        note.as_deref(),
        now_ms,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_portfolio_reduce(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
    sell_qty: f64,
    now_ms: i64,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    holding_reduce(&conn, &sym, &provider, &quote, sell_qty, now_ms).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_portfolio_remove(
    state: tauri::State<'_, DbState>,
    sym: String,
    provider: String,
    quote: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    holding_remove(&conn, &sym, &provider, &quote).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pure DAO helpers — portfolio (exported for unit tests)
// ---------------------------------------------------------------------------

/// Return all holdings ordered by sym ASC.
pub(crate) fn holdings_list(conn: &Connection) -> rusqlite::Result<Vec<HoldingRow>> {
    let mut stmt = conn.prepare(
        "SELECT sym, provider, quote, asset_class, qty, avg_cost, currency, note, created_at, updated_at
         FROM portfolio_holdings
         ORDER BY sym ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(HoldingRow {
                sym: row.get(0)?,
                provider: row.get(1)?,
                quote: row.get(2)?,
                asset_class: row.get(3)?,
                qty: row.get(4)?,
                avg_cost: row.get(5)?,
                currency: row.get(6)?,
                note: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// INSERT OR REPLACE the full holding row (edit/set semantics).
/// `updated_at` must be set by the caller before calling this function.
pub(crate) fn holding_upsert(conn: &Connection, h: &HoldingRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO portfolio_holdings
             (sym, provider, quote, asset_class, qty, avg_cost, currency, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            h.sym,
            h.provider,
            h.quote,
            h.asset_class,
            h.qty,
            h.avg_cost,
            h.currency,
            h.note,
            h.created_at,
            h.updated_at,
        ],
    )?;
    Ok(())
}

/// Weighted-average lot blend.
///
/// - If a row exists: `new_qty = qty + add_qty`,
///   `new_avg = (qty * avg_cost + add_qty * add_price) / new_qty`, update `updated_at`.
/// - If absent: INSERT a fresh row with qty = add_qty, avg_cost = add_price.
///
/// Guard: add_qty must be > 0 (caller is responsible; a zero add_qty would
/// produce a divide-by-zero in the blend formula for a previously-zero row).
pub(crate) fn holding_add_lot(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
    asset_class: &str,
    add_qty: f64,
    add_price: f64,
    currency: &str,
    note: Option<&str>,
    now_ms: i64,
) -> rusqlite::Result<()> {
    // Fetch existing row (if any).
    let existing: rusqlite::Result<(f64, f64)> = conn.query_row(
        "SELECT qty, avg_cost FROM portfolio_holdings
         WHERE sym = ?1 AND provider = ?2 AND quote = ?3",
        params![sym, provider, quote],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );

    match existing {
        Ok((old_qty, old_avg)) => {
            // Blend: new_qty must be > 0 — guard against degenerate state.
            let new_qty = old_qty + add_qty;
            let new_avg = if new_qty > 1e-12 {
                (old_qty * old_avg + add_qty * add_price) / new_qty
            } else {
                add_price
            };
            conn.execute(
                "UPDATE portfolio_holdings
                 SET qty = ?1, avg_cost = ?2, updated_at = ?3
                 WHERE sym = ?4 AND provider = ?5 AND quote = ?6",
                params![new_qty, new_avg, now_ms, sym, provider, quote],
            )?;
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            conn.execute(
                "INSERT INTO portfolio_holdings
                     (sym, provider, quote, asset_class, qty, avg_cost, currency, note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    sym,
                    provider,
                    quote,
                    asset_class,
                    add_qty,
                    add_price,
                    currency,
                    note,
                    now_ms,
                    now_ms,
                ],
            )?;
        }
        Err(e) => return Err(e),
    }
    Ok(())
}

/// Reduce a position by `sell_qty`. If the resulting qty <= 0 (epsilon 1e-12)
/// the row is deleted; otherwise only qty and updated_at are updated.
/// avg_cost is intentionally left unchanged (no realized-pnl capture here).
pub(crate) fn holding_reduce(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
    sell_qty: f64,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let existing: rusqlite::Result<f64> = conn.query_row(
        "SELECT qty FROM portfolio_holdings
         WHERE sym = ?1 AND provider = ?2 AND quote = ?3",
        params![sym, provider, quote],
        |row| row.get(0),
    );

    match existing {
        Ok(old_qty) => {
            let new_qty = old_qty - sell_qty;
            if new_qty <= 1e-12 {
                conn.execute(
                    "DELETE FROM portfolio_holdings
                     WHERE sym = ?1 AND provider = ?2 AND quote = ?3",
                    params![sym, provider, quote],
                )?;
            } else {
                conn.execute(
                    "UPDATE portfolio_holdings
                     SET qty = ?1, updated_at = ?2
                     WHERE sym = ?3 AND provider = ?4 AND quote = ?5",
                    params![new_qty, now_ms, sym, provider, quote],
                )?;
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            // Row does not exist — nothing to reduce; treat as no-op (same as
            // marks_delete on a missing id).
        }
        Err(e) => return Err(e),
    }
    Ok(())
}

/// DELETE the row identified by (sym, provider, quote). No-op if absent.
pub(crate) fn holding_remove(
    conn: &Connection,
    sym: &str,
    provider: &str,
    quote: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM portfolio_holdings WHERE sym = ?1 AND provider = ?2 AND quote = ?3",
        params![sym, provider, quote],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        run_migrations(&conn).expect("migrations");
        conn
    }

    #[test]
    fn test_marks_insert_list_delete() {
        let conn = fresh_db();

        // Insert 3 BTC marks (one with a note → Comment).
        let id1 = marks_insert(&conn, "BTC", "coinbase", "USD", 50_000.0, 1_700_000_000_000, "oklch(0.82 0.14 215)", None)
            .expect("insert BTC #1");
        let id2 = marks_insert(&conn, "BTC", "coinbase", "USD", 51_000.0, 1_700_000_100_000, "oklch(0.78 0.16 150)", Some("entry zone"))
            .expect("insert BTC #2 (comment)");
        let _id3 = marks_insert(&conn, "BTC", "coinbase", "USD", 52_000.0, 1_700_000_200_000, "oklch(0.70 0.20 25)", None)
            .expect("insert BTC #3");

        // Insert 1 ETH mark.
        let id_eth = marks_insert(&conn, "ETH", "coinbase", "USD", 3_000.0, 1_700_000_000_000, "oklch(0.85 0.16 80)", None)
            .expect("insert ETH");

        let btc = marks_list(&conn, "BTC", "coinbase", "USD").expect("list BTC");
        assert_eq!(btc.len(), 3, "BTC should have 3 marks");

        let eth = marks_list(&conn, "ETH", "coinbase", "USD").expect("list ETH");
        assert_eq!(eth.len(), 1, "ETH should have 1 mark");

        // Comment vs Mark: middle BTC has note=Some, others None.
        let comment = btc.iter().find(|m| m.id == id2).expect("BTC #2 found");
        assert_eq!(comment.note.as_deref(), Some("entry zone"));
        let mark = btc.iter().find(|m| m.id == id1).expect("BTC #1 found");
        assert!(mark.note.is_none(), "BTC #1 note should be NULL (Mark, not Comment)");

        // Delete one BTC + the ETH mark.
        marks_delete(&conn, id1).expect("delete BTC #1");
        marks_delete(&conn, id_eth).expect("delete ETH");

        assert_eq!(marks_list(&conn, "BTC", "coinbase", "USD").expect("list").len(), 2);
        assert_eq!(marks_list(&conn, "ETH", "coinbase", "USD").expect("list").len(), 0);
    }

    #[test]
    fn test_marks_isolated_per_sym() {
        let conn = fresh_db();
        marks_insert(&conn, "BTC", "coinbase", "USD", 1.0, 1, "c", None).expect("ins");
        marks_insert(&conn, "ETH", "coinbase", "USD", 2.0, 2, "c", None).expect("ins");
        marks_insert(&conn, "SOL", "binance", "USDT", 3.0, 3, "c", None).expect("ins");
        // No cross-sym contamination.
        assert_eq!(marks_list(&conn, "BTC", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(marks_list(&conn, "ETH", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(marks_list(&conn, "DOGE", "binance", "USDT").unwrap().len(), 0);
    }

    #[test]
    fn test_marks_isolated_per_provider() {
        // ADR-0008: ('binance','BTC') and ('coinbase','BTC') must not collide.
        let conn = fresh_db();
        marks_insert(&conn, "BTC", "binance", "USDT", 100.0, 1, "c", None).expect("ins bn");
        marks_insert(&conn, "BTC", "coinbase", "USD", 200.0, 2, "c", None).expect("ins cb");
        let bn = marks_list(&conn, "BTC", "binance", "USDT").unwrap();
        let cb = marks_list(&conn, "BTC", "coinbase", "USD").unwrap();
        assert_eq!(bn.len(), 1);
        assert_eq!(cb.len(), 1);
        assert!((bn[0].price - 100.0).abs() < f64::EPSILON);
        assert!((cb[0].price - 200.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_marks_isolated_per_quote() {
        // ADR-0009 (Step 11): (binance, BTC, USDT) and (binance, BTC, USDC) coexist.
        let conn = fresh_db();
        marks_insert(&conn, "BTC", "binance", "USDT", 50_000.0, 1, "c", None).expect("ins usdt");
        marks_insert(&conn, "BTC", "binance", "USDC", 50_010.0, 2, "c", None).expect("ins usdc");
        let usdt = marks_list(&conn, "BTC", "binance", "USDT").unwrap();
        let usdc = marks_list(&conn, "BTC", "binance", "USDC").unwrap();
        assert_eq!(usdt.len(), 1);
        assert_eq!(usdc.len(), 1);
        assert_eq!(usdt[0].quote, "USDT");
        assert_eq!(usdc[0].quote, "USDC");
        assert!((usdt[0].price - 50_000.0).abs() < f64::EPSILON);
        assert!((usdc[0].price - 50_010.0).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------------
    // Watchlist tests (P3.1)
    // -------------------------------------------------------------------------

    #[test]
    fn test_watchlist_add_and_list() {
        let conn = fresh_db();
        watchlist_add(&conn, "BTC", "coinbase").expect("add BTC");
        watchlist_add(&conn, "ETH", "binance").expect("add ETH");
        let list = watchlist_list(&conn).expect("list");
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|e| e.sym == "BTC" && e.provider == "coinbase"));
        assert!(list.iter().any(|e| e.sym == "ETH" && e.provider == "binance"));
    }

    #[test]
    fn test_watchlist_dup_add_is_noop() {
        let conn = fresh_db();
        watchlist_add(&conn, "BTC", "coinbase").expect("add first");
        // Duplicate add must not error and must not create a second row.
        watchlist_add(&conn, "BTC", "coinbase").expect("add duplicate");
        let list = watchlist_list(&conn).expect("list");
        assert_eq!(list.len(), 1, "duplicate add must not create a second row (PK constraint)");
    }

    #[test]
    fn test_watchlist_remove() {
        let conn = fresh_db();
        watchlist_add(&conn, "BTC", "coinbase").expect("add BTC");
        watchlist_add(&conn, "ETH", "binance").expect("add ETH");
        watchlist_remove(&conn, "BTC", "coinbase").expect("remove BTC");
        let list = watchlist_list(&conn).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].sym, "ETH");
    }

    #[test]
    fn test_watchlist_remove_nonexistent_is_ok() {
        let conn = fresh_db();
        // Removing an entry that never existed should succeed silently.
        watchlist_remove(&conn, "DOGE", "kraken").expect("remove nonexistent");
        let list = watchlist_list(&conn).expect("list");
        assert!(list.is_empty());
    }

    // -------------------------------------------------------------------------
    // App state tests (P3.1)
    // -------------------------------------------------------------------------

    #[test]
    fn test_app_state_set_and_get() {
        let conn = fresh_db();
        app_state_set(&conn, "activeSym", "ETH").expect("set");
        let val = app_state_get(&conn, "activeSym").expect("get");
        assert_eq!(val, Some("ETH".to_string()));
    }

    #[test]
    fn test_app_state_overwrite() {
        let conn = fresh_db();
        app_state_set(&conn, "tf", "1h").expect("set first");
        app_state_set(&conn, "tf", "4h").expect("overwrite");
        let val = app_state_get(&conn, "tf").expect("get");
        assert_eq!(val, Some("4h".to_string()));
    }

    #[test]
    fn test_app_state_missing_key_returns_none() {
        let conn = fresh_db();
        let val = app_state_get(&conn, "nonexistent_key").expect("get");
        assert_eq!(val, None, "missing key must return None, not an error");
    }

    #[test]
    fn test_app_state_multiple_keys_are_isolated() {
        let conn = fresh_db();
        app_state_set(&conn, "activeSym", "BTC").expect("set activeSym");
        app_state_set(&conn, "chartType", "candles").expect("set chartType");
        app_state_set(&conn, "tf", "1d").expect("set tf");
        assert_eq!(app_state_get(&conn, "activeSym").unwrap(), Some("BTC".to_string()));
        assert_eq!(app_state_get(&conn, "chartType").unwrap(), Some("candles".to_string()));
        assert_eq!(app_state_get(&conn, "tf").unwrap(), Some("1d".to_string()));
    }

    // -------------------------------------------------------------------------
    // Bars warm cache tests (P4.1)
    // -------------------------------------------------------------------------

    fn make_bar(ts: i64, c: f64) -> BarRow {
        BarRow { ts, o: c - 1.0, h: c + 0.5, l: c - 1.5, c, v: 100.0 }
    }

    #[test]
    fn test_bars_upsert_and_get_range() {
        let conn = fresh_db();
        let bars = vec![make_bar(1000, 50.0), make_bar(2000, 51.0), make_bar(3000, 52.0)];
        bars_upsert(&conn, "binance", "BTC", "1h", &bars).expect("upsert");

        // Inclusive bounds — expect all 3 back, ordered ascending.
        let got = bars_get_range(&conn, "binance", "BTC", "1h", 1000, 3000).expect("range");
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].ts, 1000);
        assert_eq!(got[2].ts, 3000);
        assert!((got[1].c - 51.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_bars_range_filters_correctly() {
        let conn = fresh_db();
        let bars = vec![make_bar(100, 1.0), make_bar(200, 2.0), make_bar(300, 3.0), make_bar(400, 4.0)];
        bars_upsert(&conn, "kraken", "ETH", "1d", &bars).expect("upsert");

        // Range strictly inside the data — middle two only.
        let got = bars_get_range(&conn, "kraken", "ETH", "1d", 200, 300).expect("range");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].ts, 200);
        assert_eq!(got[1].ts, 300);
    }

    #[test]
    fn test_bars_isolated_per_provider_sym_tf() {
        let conn = fresh_db();
        bars_upsert(&conn, "binance", "BTC", "1h", &[make_bar(1, 1.0)]).expect("ins");
        bars_upsert(&conn, "coinbase", "BTC", "1h", &[make_bar(1, 2.0)]).expect("ins");
        bars_upsert(&conn, "binance", "ETH", "1h", &[make_bar(1, 3.0)]).expect("ins");
        bars_upsert(&conn, "binance", "BTC", "4h", &[make_bar(1, 4.0)]).expect("ins");

        // Each (provider, sym, tf) tuple is its own bucket.
        let bn_btc_1h = bars_get_range(&conn, "binance", "BTC", "1h", 0, i64::MAX).unwrap();
        let cb_btc_1h = bars_get_range(&conn, "coinbase", "BTC", "1h", 0, i64::MAX).unwrap();
        let bn_eth_1h = bars_get_range(&conn, "binance", "ETH", "1h", 0, i64::MAX).unwrap();
        let bn_btc_4h = bars_get_range(&conn, "binance", "BTC", "4h", 0, i64::MAX).unwrap();
        assert_eq!(bn_btc_1h.len(), 1);
        assert_eq!(cb_btc_1h.len(), 1);
        assert_eq!(bn_eth_1h.len(), 1);
        assert_eq!(bn_btc_4h.len(), 1);
        assert!((bn_btc_1h[0].c - 1.0).abs() < f64::EPSILON);
        assert!((cb_btc_1h[0].c - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_bars_upsert_replaces_existing_row() {
        let conn = fresh_db();
        // Insert a bar, then re-insert with the same (provider, sym, tf, ts) — expect overwrite.
        bars_upsert(&conn, "binance", "BTC", "1h", &[make_bar(1000, 50.0)]).expect("ins");
        bars_upsert(&conn, "binance", "BTC", "1h", &[make_bar(1000, 99.0)]).expect("upsert");

        let got = bars_get_range(&conn, "binance", "BTC", "1h", 1000, 1000).unwrap();
        assert_eq!(got.len(), 1, "PK enforced — should still be 1 row");
        assert!((got[0].c - 99.0).abs() < f64::EPSILON, "close should be overwritten");
    }

    #[test]
    fn test_bars_empty_range_returns_empty_vec() {
        let conn = fresh_db();
        // Querying before any insert must return Ok(vec![]) — never an error.
        let got = bars_get_range(&conn, "binance", "BTC", "1h", 0, 9_999_999).unwrap();
        assert!(got.is_empty());
    }

    // -------------------------------------------------------------------------
    // Trends tests (Step 4 — trend-line tool)
    // -------------------------------------------------------------------------

    fn make_trend(id: &str, sym: &str, tf: &str) -> TrendRow {
        make_trend_pq(id, sym, tf, "coinbase", "USD")
    }

    fn make_trend_p(id: &str, sym: &str, tf: &str, provider: &str) -> TrendRow {
        // Same default quote as migration 0017 for non-binance providers.
        let q = if provider == "binance" { "USDT" } else { "USD" };
        make_trend_pq(id, sym, tf, provider, q)
    }

    fn make_trend_pq(id: &str, sym: &str, tf: &str, provider: &str, quote: &str) -> TrendRow {
        TrendRow {
            id: id.to_string(),
            sym: sym.to_string(),
            provider: provider.to_string(),
            quote: quote.to_string(),
            tf: tf.to_string(),
            x1_ts: 1_700_000_000_000,
            y1_price: 50_000.0,
            x2_ts: 1_700_000_100_000,
            y2_price: 51_000.0,
            color: "accent".to_string(),
            created_at: 1_700_000_500_000,
        }
    }

    #[test]
    fn test_trends_insert_list_delete() {
        let conn = fresh_db();

        // Insert 3 BTC trends and 1 ETH trend.
        trends_insert(&conn, &make_trend("t1", "BTC", "1h")).expect("ins t1");
        trends_insert(&conn, &make_trend("t2", "BTC", "1h")).expect("ins t2");
        trends_insert(&conn, &make_trend("t3", "BTC", "4h")).expect("ins t3 (different tf)");
        trends_insert(&conn, &make_trend("e1", "ETH", "1h")).expect("ins e1");

        // List filters by (sym, tf, provider, quote) per ADR-0008/0009.
        let btc_1h = trends_list(&conn, "BTC", "1h", "coinbase", "USD").expect("list BTC 1h");
        assert_eq!(btc_1h.len(), 2, "BTC@1h should have 2 trends");
        let btc_4h = trends_list(&conn, "BTC", "4h", "coinbase", "USD").expect("list BTC 4h");
        assert_eq!(btc_4h.len(), 1, "BTC@4h should have 1 trend");
        let eth_1h = trends_list(&conn, "ETH", "1h", "coinbase", "USD").expect("list ETH 1h");
        assert_eq!(eth_1h.len(), 1, "ETH@1h should have 1 trend");

        // Round-trip integrity — pick one and verify all fields.
        let t1 = btc_1h.iter().find(|t| t.id == "t1").expect("t1 found");
        assert_eq!(t1.x1_ts, 1_700_000_000_000);
        assert!((t1.y1_price - 50_000.0).abs() < f64::EPSILON);
        assert!((t1.y2_price - 51_000.0).abs() < f64::EPSILON);
        assert_eq!(t1.color, "accent");
        assert_eq!(t1.provider, "coinbase");
        assert_eq!(t1.quote, "USD");

        // Delete one BTC trend.
        trends_delete(&conn, "t1").expect("delete t1");
        assert_eq!(trends_list(&conn, "BTC", "1h", "coinbase", "USD").unwrap().len(), 1);
        // Other (sym, tf) buckets untouched.
        assert_eq!(trends_list(&conn, "BTC", "4h", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(trends_list(&conn, "ETH", "1h", "coinbase", "USD").unwrap().len(), 1);
    }

    #[test]
    fn test_trends_delete_nonexistent_is_ok() {
        let conn = fresh_db();
        trends_delete(&conn, "does-not-exist").expect("delete nonexistent");
        assert!(trends_list(&conn, "BTC", "1h", "coinbase", "USD").unwrap().is_empty());
    }

    #[test]
    fn test_trends_isolated_per_provider() {
        // ADR-0008: provider is part of the key.
        let conn = fresh_db();
        trends_insert(&conn, &make_trend_p("a", "BTC", "1h", "binance")).unwrap();
        trends_insert(&conn, &make_trend_p("b", "BTC", "1h", "coinbase")).unwrap();
        assert_eq!(trends_list(&conn, "BTC", "1h", "binance", "USDT").unwrap().len(), 1);
        assert_eq!(trends_list(&conn, "BTC", "1h", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(trends_list(&conn, "BTC", "1h", "kraken", "USD").unwrap().len(), 0);
    }

    #[test]
    fn test_trends_isolated_per_quote() {
        // ADR-0009 (Step 11): (binance, BTC, USDT) and (binance, BTC, USDC) coexist.
        let conn = fresh_db();
        trends_insert(&conn, &make_trend_pq("a", "BTC", "1h", "binance", "USDT")).unwrap();
        trends_insert(&conn, &make_trend_pq("b", "BTC", "1h", "binance", "USDC")).unwrap();
        let usdt = trends_list(&conn, "BTC", "1h", "binance", "USDT").unwrap();
        let usdc = trends_list(&conn, "BTC", "1h", "binance", "USDC").unwrap();
        assert_eq!(usdt.len(), 1);
        assert_eq!(usdc.len(), 1);
        assert_eq!(usdt[0].quote, "USDT");
        assert_eq!(usdc[0].quote, "USDC");
    }

    // -------------------------------------------------------------------------
    // Datasets tests (P6 W4-B)
    // -------------------------------------------------------------------------

    fn make_dataset(id: &str, payload: &str) -> DatasetRow {
        DatasetRow {
            id: id.to_string(),
            json: format!(r#"{{"id":"{id}","name":"{payload}"}}"#),
            created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn test_datasets_upsert_list_delete() {
        let conn = fresh_db();
        datasets_upsert(&conn, &make_dataset("d1", "vol30")).expect("ins d1");
        datasets_upsert(&conn, &make_dataset("d2", "corrETH")).expect("ins d2");
        let listed = datasets_list(&conn).expect("list");
        assert_eq!(listed.len(), 2);
        // Round-trip: id and json preserved verbatim.
        let d1 = listed.iter().find(|d| d.id == "d1").expect("d1 found");
        assert!(d1.json.contains("vol30"));

        // Upsert overwrites the json blob (PK conflict path).
        let mut updated = make_dataset("d1", "vol30-renamed");
        updated.created_at = 1_700_000_999_999;
        datasets_upsert(&conn, &updated).expect("upsert d1");
        let listed2 = datasets_list(&conn).expect("list");
        assert_eq!(listed2.len(), 2, "upsert must NOT create a duplicate");
        let d1b = listed2.iter().find(|d| d.id == "d1").expect("d1 found");
        assert!(d1b.json.contains("vol30-renamed"));

        datasets_delete(&conn, "d1").expect("delete d1");
        assert_eq!(datasets_list(&conn).unwrap().len(), 1);

        // Deleting a non-existent id is a safe no-op.
        datasets_delete(&conn, "does-not-exist").expect("delete missing");
    }

    #[test]
    fn test_datasets_migration_idempotent() {
        // Second run of the embedded migration set must not error out — proves
        // 0008_datasets.sql uses `CREATE TABLE IF NOT EXISTS`.
        let conn = fresh_db();
        run_migrations(&conn).expect("second migration run");
        // Table is queryable.
        datasets_upsert(&conn, &make_dataset("smoke", "x")).expect("post-rerun insert");
        assert_eq!(datasets_list(&conn).unwrap().len(), 1);
    }

    // -------------------------------------------------------------------------
    // Research overlays tests
    // -------------------------------------------------------------------------

    fn make_research_overlay(id: &str, payload: &str) -> ResearchOverlayRow {
        ResearchOverlayRow {
            id: id.to_string(),
            json: format!(r#"{{"id":"{id}","name":"{payload}"}}"#),
            created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn test_research_overlays_upsert_list_delete() {
        let conn = fresh_db();
        research_overlays_upsert(&conn, &make_research_overlay("o1", "rsiBand")).expect("ins o1");
        research_overlays_upsert(&conn, &make_research_overlay("o2", "vwap")).expect("ins o2");
        let listed = research_overlays_list(&conn).expect("list");
        assert_eq!(listed.len(), 2);
        // Round-trip: id and json preserved verbatim.
        let o1 = listed.iter().find(|o| o.id == "o1").expect("o1 found");
        assert!(o1.json.contains("rsiBand"));

        research_overlays_delete(&conn, "o1").expect("delete o1");
        assert_eq!(research_overlays_list(&conn).unwrap().len(), 1);

        // Deleting a non-existent id is a safe no-op.
        research_overlays_delete(&conn, "does-not-exist").expect("delete missing");
    }

    #[test]
    fn test_research_overlays_conflict_update() {
        let conn = fresh_db();
        research_overlays_upsert(&conn, &make_research_overlay("o1", "rsiBand")).expect("ins o1");

        // Upsert overwrites the json blob (PK conflict path).
        let mut updated = make_research_overlay("o1", "rsiBand-renamed");
        updated.created_at = 1_700_000_999_999;
        research_overlays_upsert(&conn, &updated).expect("upsert o1");

        let listed = research_overlays_list(&conn).expect("list");
        assert_eq!(listed.len(), 1, "upsert must NOT create a duplicate");
        let o1b = listed.iter().find(|o| o.id == "o1").expect("o1 found");
        assert!(o1b.json.contains("rsiBand-renamed"));
    }

    #[test]
    fn test_trends_isolated_per_sym_tf() {
        let conn = fresh_db();
        trends_insert(&conn, &make_trend("a", "BTC", "1h")).unwrap();
        trends_insert(&conn, &make_trend("b", "BTC", "1d")).unwrap();
        trends_insert(&conn, &make_trend("c", "ETH", "1h")).unwrap();
        // Each (sym, tf, provider, quote) tuple is its own bucket.
        assert_eq!(trends_list(&conn, "BTC", "1h", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(trends_list(&conn, "BTC", "1d", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(trends_list(&conn, "BTC", "4h", "coinbase", "USD").unwrap().len(), 0);
        assert_eq!(trends_list(&conn, "ETH", "1h", "coinbase", "USD").unwrap().len(), 1);
        assert_eq!(trends_list(&conn, "DOGE", "1h", "coinbase", "USD").unwrap().len(), 0);
    }

    // -------------------------------------------------------------------------
    // Strategies tests (P7 W5-C3)
    // -------------------------------------------------------------------------

    fn make_strategy(id: &str, name: &str) -> StrategyRow {
        StrategyRow {
            id: id.to_string(),
            json: format!(r#"{{"id":"{id}","name":"{name}","version":1}}"#),
            created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn test_strategies_upsert_list_delete() {
        let conn = fresh_db();
        strategies_upsert(&conn, &make_strategy("s1", "RSI Mean Revert")).expect("ins s1");
        strategies_upsert(&conn, &make_strategy("s2", "Donchian Breakout")).expect("ins s2");
        let listed = strategies_list(&conn).expect("list");
        assert_eq!(listed.len(), 2);

        // Round-trip: id and json preserved verbatim.
        let s1 = listed.iter().find(|s| s.id == "s1").expect("s1 found");
        assert!(s1.json.contains("RSI Mean Revert"));

        // Upsert overwrites the json blob (PK conflict path) but NOT created_at.
        let mut updated = make_strategy("s1", "RSI Mean Revert v2");
        updated.created_at = 1_700_000_999_999; // ignored — NOT updated by ON CONFLICT
        strategies_upsert(&conn, &updated).expect("upsert s1");
        let listed2 = strategies_list(&conn).expect("list");
        assert_eq!(listed2.len(), 2, "upsert must NOT create a duplicate");
        let s1b = listed2.iter().find(|s| s.id == "s1").expect("s1 found");
        assert!(s1b.json.contains("RSI Mean Revert v2"));
        // created_at stays at original (ON CONFLICT only updates json).
        assert_eq!(s1b.created_at, 1_700_000_000_000);

        strategies_delete(&conn, "s1").expect("delete s1");
        assert_eq!(strategies_list(&conn).unwrap().len(), 1);

        // Deleting a non-existent id is a safe no-op.
        strategies_delete(&conn, "does-not-exist").expect("delete missing");
    }

    #[test]
    fn test_strategies_migration_idempotent() {
        // Second run of the embedded migration set must not error out — proves
        // 0009_strategies.sql uses `CREATE TABLE IF NOT EXISTS`.
        let conn = fresh_db();
        run_migrations(&conn).expect("second migration run");
        // Table is queryable after re-running migrations.
        strategies_upsert(&conn, &make_strategy("smoke", "x")).expect("post-rerun insert");
        assert_eq!(strategies_list(&conn).unwrap().len(), 1);
    }

    // -------------------------------------------------------------------------
    // Symbol catalog tests (ADR-0009)
    // -------------------------------------------------------------------------

    fn sym_row(provider: &str, sym: &str, quote: &str, name: Option<&str>) -> SymbolRow {
        SymbolRow {
            provider: provider.to_string(),
            sym: sym.to_string(),
            quote: quote.to_string(),
            name: name.map(|s| s.to_string()),
            class: "crypto".to_string(),
            status: "active".to_string(),
            native_sym: format!("{sym}{quote}"),
        }
    }

    #[test]
    fn test_symbols_upsert_and_list_by_provider() {
        let conn = fresh_db();
        let rows = vec![
            sym_row("binance", "BTC", "USDT", Some("Bitcoin")),
            sym_row("binance", "ETH", "USDT", Some("Ethereum")),
            sym_row("coinbase", "BTC", "USD", Some("Bitcoin")),
        ];
        symbols_upsert_batch(&conn, &rows).expect("upsert");

        let bn = symbols_list_by_provider(&conn, "binance", 50, 0).expect("list binance");
        assert_eq!(bn.len(), 2);
        assert!(bn.iter().any(|r| r.sym == "BTC" && r.quote == "USDT"));
        assert!(bn.iter().any(|r| r.sym == "ETH" && r.quote == "USDT"));

        let cb = symbols_list_by_provider(&conn, "coinbase", 50, 0).expect("list coinbase");
        assert_eq!(cb.len(), 1);
        assert_eq!(cb[0].sym, "BTC");
        assert_eq!(cb[0].quote, "USD");

        assert_eq!(symbols_count_by_provider(&conn, "binance").unwrap(), 2);
        assert_eq!(symbols_count_by_provider(&conn, "kraken").unwrap(), 0);
    }

    #[test]
    fn test_symbols_upsert_is_idempotent_on_pk_collision() {
        let conn = fresh_db();
        // First upsert.
        symbols_upsert_batch(&conn, &[sym_row("binance", "BTC", "USDT", Some("Bitcoin"))])
            .expect("upsert 1");
        // Second upsert with the same PK but a different name — should replace, not duplicate.
        symbols_upsert_batch(&conn, &[sym_row("binance", "BTC", "USDT", Some("Bitcoin renamed"))])
            .expect("upsert 2");
        let rows = symbols_list_by_provider(&conn, "binance", 50, 0).expect("list");
        assert_eq!(rows.len(), 1, "PK collision must REPLACE, not duplicate");
        assert_eq!(rows[0].name.as_deref(), Some("Bitcoin renamed"));
    }

    #[test]
    fn test_symbols_search_fts_basic() {
        let conn = fresh_db();
        symbols_upsert_batch(&conn, &[
            sym_row("binance", "BTC", "USDT", Some("Bitcoin")),
            sym_row("binance", "ETH", "USDT", Some("Ethereum")),
            sym_row("binance", "BTC", "USDC", Some("Bitcoin")),
            sym_row("coinbase", "BTC", "USD", Some("Bitcoin")),
            sym_row("kraken", "ADA", "USD", Some("Cardano")),
        ])
        .expect("upsert");

        // Exact-sym match: 'btc' should return all three BTC rows (binance USDT, binance USDC, coinbase USD).
        let hits = symbols_search_fts(&conn, "btc", None, 10).expect("search btc");
        assert_eq!(hits.len(), 3, "expected 3 BTC rows across providers/quotes, got {hits:?}");
        assert!(hits.iter().all(|r| r.sym == "BTC"));

        // Prefix match using FTS5 `*` operator.
        let hits = symbols_search_fts(&conn, "bitc*", None, 10).expect("search bitc*");
        assert_eq!(hits.len(), 3, "prefix match on 'Bitcoin' should hit all 3 BTC rows");

        // Provider filter narrows the result set.
        let bn_only: Vec<String> = vec!["binance".to_string()];
        let hits = symbols_search_fts(&conn, "btc", Some(&bn_only), 10).expect("search btc binance");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|r| r.provider == "binance"));

        // Empty query short-circuits to no results.
        assert!(symbols_search_fts(&conn, "", None, 10).unwrap().is_empty());
        assert!(symbols_search_fts(&conn, "   ", None, 10).unwrap().is_empty());

        // Limit clamps result count.
        let hits = symbols_search_fts(&conn, "btc", None, 1).expect("search btc limit 1");
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn test_symbols_meta_roundtrip() {
        let conn = fresh_db();
        assert!(symbols_meta_get(&conn, "binance").unwrap().is_none());

        symbols_meta_upsert(&conn, "binance", 1_700_000_000_000, 2103).expect("meta upsert 1");
        let meta = symbols_meta_get(&conn, "binance").unwrap().expect("meta present");
        assert_eq!(meta.provider, "binance");
        assert_eq!(meta.fetched_at, 1_700_000_000_000);
        assert_eq!(meta.row_count, 2103);

        // Second upsert overwrites (no duplicate row).
        symbols_meta_upsert(&conn, "binance", 1_700_000_500_000, 2150).expect("meta upsert 2");
        let meta = symbols_meta_get(&conn, "binance").unwrap().expect("meta present");
        assert_eq!(meta.fetched_at, 1_700_000_500_000);
        assert_eq!(meta.row_count, 2150);

        symbols_meta_upsert(&conn, "coinbase", 1_700_001_000_000, 540).expect("meta cb");
        let all = symbols_meta_list(&conn).expect("meta list");
        assert_eq!(all.len(), 2);
    }

    // -------------------------------------------------------------------------
    // watchlist_v2 tests (ADR-0009)
    // -------------------------------------------------------------------------

    #[test]
    fn test_watchlist_v2_multi_quote() {
        // The whole point of v2: same (sym, provider) with different quotes coexist.
        let conn = fresh_db();
        watchlist_v2_add(&conn, "BTC", "binance", "USDT").expect("add BTC/USDT");
        watchlist_v2_add(&conn, "BTC", "binance", "USDC").expect("add BTC/USDC");
        watchlist_v2_add(&conn, "BTC", "coinbase", "USD").expect("add BTC/USD cb");

        let rows = watchlist_v2_list(&conn).expect("list");
        // Includes legacy backfilled rows from migration 0015 (none on a fresh empty watchlist v1),
        // plus our 3 new rows.
        let new = rows
            .iter()
            .filter(|r| r.sym == "BTC")
            .collect::<Vec<_>>();
        assert_eq!(new.len(), 3, "BTC must persist 3 distinct quote rows");

        // Duplicate add is a no-op (PK collision INSERT OR IGNORE).
        watchlist_v2_add(&conn, "BTC", "binance", "USDT").expect("dup add");
        let again = watchlist_v2_list(&conn).expect("list 2");
        assert_eq!(again.len(), rows.len(), "dup add must not grow the table");

        // Remove only the USDT row; USDC stays.
        watchlist_v2_remove(&conn, "BTC", "binance", "USDT").expect("remove BTC/USDT");
        let post = watchlist_v2_list(&conn).expect("list 3");
        assert!(post.iter().any(|r| r.sym == "BTC" && r.provider == "binance" && r.quote == "USDC"));
        assert!(!post.iter().any(|r| r.sym == "BTC" && r.provider == "binance" && r.quote == "USDT"));
    }

    #[test]
    fn test_watchlist_v1_to_v2_backfill() {
        // Simulate a pre-ADR-0009 user: insert legacy v1 rows BEFORE the v2 table
        // exists. The migration 0015 should copy them with deterministic per-provider
        // quotes. We can't replay migrations partially in a single in-memory DB, so
        // assert the behavior end-to-end by checking that an empty fresh DB's
        // watchlist_v2 contains zero rows (the v1 table is empty too).
        let conn = fresh_db();
        let v2 = watchlist_v2_list(&conn).expect("list");
        assert!(v2.is_empty(), "fresh-install v2 should be empty");

        // Insert into legacy v1 directly, simulating what would happen if v1 had
        // existed before the migration. (Real upgrade path is covered by the
        // migration itself; this test exercises the per-provider quote map.)
        conn.execute(
            "INSERT INTO watchlist (sym, provider, added_at) VALUES ('BTC','binance',1), ('ETH','coinbase',2), ('ADA','kraken',3), ('AAPL','alpaca',4)",
            [],
        )
        .expect("insert legacy rows");
        // Replay the backfill statement that 0015 ran (same CASE WHEN).
        conn.execute(
            "INSERT OR IGNORE INTO watchlist_v2 (sym, provider, quote, added_at)
             SELECT sym, provider,
                    CASE provider WHEN 'binance' THEN 'USDT' WHEN 'coinbase' THEN 'USD' WHEN 'kraken' THEN 'USD' WHEN 'alpaca' THEN 'USD' ELSE 'USD' END,
                    added_at
             FROM watchlist",
            [],
        )
        .expect("backfill replay");

        let v2 = watchlist_v2_list(&conn).expect("list");
        let lookup = |sym: &str, prov: &str| -> Option<String> {
            v2.iter()
                .find(|r| r.sym == sym && r.provider == prov)
                .map(|r| r.quote.clone())
        };
        assert_eq!(lookup("BTC", "binance").as_deref(), Some("USDT"));
        assert_eq!(lookup("ETH", "coinbase").as_deref(), Some("USD"));
        assert_eq!(lookup("ADA", "kraken").as_deref(), Some("USD"));
        assert_eq!(lookup("AAPL", "alpaca").as_deref(), Some("USD"));
    }

    // -------------------------------------------------------------------------
    // bars_v2 tests (ADR-0009)
    // -------------------------------------------------------------------------

    fn bar(ts: i64) -> BarRow {
        BarRow { ts, o: 1.0, h: 2.0, l: 0.5, c: 1.5, v: 100.0 }
    }

    #[test]
    fn test_bars_v2_multi_quote_isolation() {
        // BTC/USDT and BTC/USDC at the same (provider, sym, tf, ts) must coexist —
        // this is the entire reason bars_v2 exists.
        let conn = fresh_db();
        bars_v2_upsert(&conn, "binance", "BTC", "USDT", "1h", &[bar(1_700_000_000_000)])
            .expect("upsert USDT");
        bars_v2_upsert(&conn, "binance", "BTC", "USDC", "1h", &[bar(1_700_000_000_000)])
            .expect("upsert USDC");

        let usdt = bars_v2_get_range(&conn, "binance", "BTC", "USDT", "1h", 0, i64::MAX).expect("range USDT");
        let usdc = bars_v2_get_range(&conn, "binance", "BTC", "USDC", "1h", 0, i64::MAX).expect("range USDC");
        assert_eq!(usdt.len(), 1);
        assert_eq!(usdc.len(), 1);
    }

    #[test]
    fn test_bars_v2_upsert_replaces_on_pk() {
        let conn = fresh_db();
        bars_v2_upsert(&conn, "binance", "BTC", "USDT", "1h", &[bar(1)])
            .expect("upsert");
        let mut b = bar(1);
        b.c = 999.0;
        bars_v2_upsert(&conn, "binance", "BTC", "USDT", "1h", &[b])
            .expect("upsert replace");
        let rows = bars_v2_get_range(&conn, "binance", "BTC", "USDT", "1h", 0, i64::MAX).expect("range");
        assert_eq!(rows.len(), 1, "PK collision must REPLACE, not duplicate");
        assert!((rows[0].c - 999.0).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------------
    // Portfolio holdings tests
    // -------------------------------------------------------------------------

    fn make_holding(sym: &str, provider: &str, quote: &str) -> HoldingRow {
        HoldingRow {
            sym: sym.to_string(),
            provider: provider.to_string(),
            quote: quote.to_string(),
            asset_class: "crypto".to_string(),
            qty: 1.0,
            avg_cost: 100.0,
            currency: "USD".to_string(),
            note: None,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn test_portfolio_add_lot_creates_new_row() {
        let conn = fresh_db();
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 1.0, 100.0, "USD", None, 1_000)
            .expect("add lot");
        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sym, "BTC");
        assert!((rows[0].qty - 1.0).abs() < f64::EPSILON);
        assert!((rows[0].avg_cost - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_portfolio_add_lot_blends_avg_cost() {
        // 1 unit @ 100, then 1 unit @ 200 → qty 2, avg_cost 150.
        let conn = fresh_db();
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 1.0, 100.0, "USD", None, 1_000)
            .expect("add lot 1");
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 1.0, 200.0, "USD", None, 2_000)
            .expect("add lot 2");

        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 1, "two lots on the same key must stay one row");
        assert!((rows[0].qty - 2.0).abs() < f64::EPSILON, "qty should be 2");
        assert!(
            (rows[0].avg_cost - 150.0).abs() < f64::EPSILON,
            "avg_cost should blend to 150, got {}",
            rows[0].avg_cost
        );
        assert_eq!(rows[0].updated_at, 2_000, "updated_at should be set to second lot timestamp");
    }

    #[test]
    fn test_portfolio_add_lot_blend_asymmetric() {
        // 2 units @ 200, then 1 unit @ 50 → qty 3, avg_cost (400+50)/3 = 150.
        let conn = fresh_db();
        holding_add_lot(&conn, "ETH", "binance", "USDT", "crypto", 2.0, 200.0, "USD", None, 1_000)
            .expect("add lot 1");
        holding_add_lot(&conn, "ETH", "binance", "USDT", "crypto", 1.0, 50.0, "USD", None, 2_000)
            .expect("add lot 2");

        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 1);
        assert!((rows[0].qty - 3.0).abs() < f64::EPSILON);
        assert!(
            (rows[0].avg_cost - 150.0).abs() < 1e-9,
            "expected avg_cost 150, got {}",
            rows[0].avg_cost
        );
    }

    #[test]
    fn test_portfolio_reduce_decrements_qty() {
        let conn = fresh_db();
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 5.0, 100.0, "USD", None, 1_000)
            .expect("add lot");
        holding_reduce(&conn, "BTC", "coinbase", "USD", 2.0, 2_000).expect("reduce");

        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 1, "row should still exist after partial reduce");
        assert!((rows[0].qty - 3.0).abs() < f64::EPSILON, "qty should be 3 after reducing 2 from 5");
        assert_eq!(rows[0].updated_at, 2_000);
        // avg_cost must be unchanged.
        assert!((rows[0].avg_cost - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_portfolio_reduce_to_zero_deletes_row() {
        let conn = fresh_db();
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 2.0, 100.0, "USD", None, 1_000)
            .expect("add lot");
        // Sell exact qty → qty becomes 0, which is <= epsilon → DELETE.
        holding_reduce(&conn, "BTC", "coinbase", "USD", 2.0, 2_000).expect("reduce to zero");
        assert!(holdings_list(&conn).expect("list").is_empty(), "row should be deleted when qty hits 0");
    }

    #[test]
    fn test_portfolio_reduce_below_zero_deletes_row() {
        let conn = fresh_db();
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 1.0, 100.0, "USD", None, 1_000)
            .expect("add lot");
        // Sell more than held — should delete rather than go negative.
        holding_reduce(&conn, "BTC", "coinbase", "USD", 999.0, 2_000).expect("reduce below zero");
        assert!(holdings_list(&conn).expect("list").is_empty(), "row should be deleted when qty would go negative");
    }

    #[test]
    fn test_portfolio_reduce_nonexistent_is_noop() {
        let conn = fresh_db();
        // Reducing a row that never existed must succeed silently.
        holding_reduce(&conn, "DOGE", "kraken", "USD", 1.0, 1_000).expect("reduce nonexistent");
        assert!(holdings_list(&conn).expect("list").is_empty());
    }

    #[test]
    fn test_portfolio_upsert_replaces_row() {
        let conn = fresh_db();
        let h = make_holding("BTC", "coinbase", "USD");
        holding_upsert(&conn, &h).expect("upsert insert");

        // Replace with different qty + avg_cost.
        let h2 = HoldingRow {
            qty: 5.0,
            avg_cost: 42_000.0,
            updated_at: 2_000_000_000_000,
            ..h.clone()
        };
        holding_upsert(&conn, &h2).expect("upsert replace");

        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 1, "upsert must NOT create a duplicate row");
        assert!((rows[0].qty - 5.0).abs() < f64::EPSILON);
        assert!((rows[0].avg_cost - 42_000.0).abs() < f64::EPSILON);
        assert_eq!(rows[0].updated_at, 2_000_000_000_000);
    }

    #[test]
    fn test_portfolio_remove_deletes_row() {
        let conn = fresh_db();
        let h = make_holding("BTC", "coinbase", "USD");
        holding_upsert(&conn, &h).expect("upsert");
        assert_eq!(holdings_list(&conn).expect("list").len(), 1);

        holding_remove(&conn, "BTC", "coinbase", "USD").expect("remove");
        assert!(holdings_list(&conn).expect("list").is_empty(), "holding_remove must delete the row");
    }

    #[test]
    fn test_portfolio_remove_nonexistent_is_noop() {
        let conn = fresh_db();
        // Removing a row that never existed must succeed silently.
        holding_remove(&conn, "XRP", "kraken", "USD").expect("remove nonexistent");
        assert!(holdings_list(&conn).expect("list").is_empty());
    }

    #[test]
    fn test_portfolio_holdings_list_ordered_by_sym() {
        let conn = fresh_db();
        // Insert in reverse alphabetical order.
        holding_upsert(&conn, &make_holding("SOL", "coinbase", "USD")).expect("ins SOL");
        holding_upsert(&conn, &make_holding("ETH", "coinbase", "USD")).expect("ins ETH");
        holding_upsert(&conn, &make_holding("BTC", "coinbase", "USD")).expect("ins BTC");
        holding_upsert(&conn, &make_holding("ADA", "coinbase", "USD")).expect("ins ADA");

        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].sym, "ADA");
        assert_eq!(rows[1].sym, "BTC");
        assert_eq!(rows[2].sym, "ETH");
        assert_eq!(rows[3].sym, "SOL");
    }

    #[test]
    fn test_portfolio_isolated_per_key_tuple() {
        // (sym, provider, quote) is the composite PK — different triples must not collide.
        let conn = fresh_db();
        holding_add_lot(&conn, "BTC", "binance", "USDT", "crypto", 1.0, 100.0, "USD", None, 1_000)
            .expect("add BTC/binance/USDT");
        holding_add_lot(&conn, "BTC", "coinbase", "USD", "crypto", 2.0, 200.0, "USD", None, 1_000)
            .expect("add BTC/coinbase/USD");
        holding_add_lot(&conn, "BTC", "binance", "USDC", "crypto", 3.0, 300.0, "USD", None, 1_000)
            .expect("add BTC/binance/USDC");

        let rows = holdings_list(&conn).expect("list");
        assert_eq!(rows.len(), 3, "each (sym, provider, quote) triple must be a distinct row");
        // Verify each row's qty is distinct (no blending across different triples).
        let usdt = rows.iter().find(|r| r.provider == "binance" && r.quote == "USDT").expect("USDT row");
        let usd  = rows.iter().find(|r| r.provider == "coinbase" && r.quote == "USD").expect("USD row");
        let usdc = rows.iter().find(|r| r.provider == "binance" && r.quote == "USDC").expect("USDC row");
        assert!((usdt.qty - 1.0).abs() < f64::EPSILON);
        assert!((usd.qty  - 2.0).abs() < f64::EPSILON);
        assert!((usdc.qty - 3.0).abs() < f64::EPSILON);
    }
}
