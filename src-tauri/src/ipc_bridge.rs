//! # IPC Bridge — app-side MCP tool surface over Unix-domain socket / Windows named pipe
//!
//! ## Purpose
//!
//! Exposes the full MCP tool surface to the Tauri sidecar (Steps 5/6) and to
//! the interactive Claude terminal session (Step 8). The sidecar dials this
//! socket, authenticates with a per-launch token, and issues JSON-RPC 2.0 calls
//! that are either:
//!
//! * **Rust-side** — fulfilled directly by reading SQLite / calling market adapters.
//! * **Frontend round-trip** — forwarded to the React UI via a `bridge:request`
//!   Tauri event; the UI resolves them and calls back via [`bridge_reply`].
//! * **Consent-gated** — mutation operations emit `mcp:consent_request` and
//!   await the user's accept/deny before proceeding.
//!
//! ## Wire protocol
//!
//! ```text
//! Frame:   [u32 big-endian length][UTF-8 JSON bytes]
//! Max frame size: 1 MiB (1_048_576 bytes).  Frames larger than this are rejected
//!                 with error -32005 and the connection is closed.
//!
//! Request:  {"jsonrpc":"2.0","id":<num|str>,"method":"<dotted.path>","params":{...}}
//! Response: {"jsonrpc":"2.0","id":<same>,"result":<json>}
//! Error:    {"jsonrpc":"2.0","id":<same>,"error":{"code":<int>,"message":"...","data":?}}
//!
//! Hello-handshake exception:
//!   The very first frame must be:
//!     {"jsonrpc":"2.0","method":"hello","params":{"token":"<hex>"}}
//!   The `id` field MAY be omitted. The server replies with the same id (or 0 if absent).
//!   If the token does not match the file at <claude_home>/mcp-bridge.token the server
//!   replies {"jsonrpc":"2.0","id":<id>,"error":{"code":-32001,"message":"unauthorized"}}
//!   and immediately closes the connection.
//! ```
//!
//! ## Error codes
//!
//! | Constant              | Code    | Meaning                                          |
//! |-----------------------|---------|--------------------------------------------------|
//! | `ERR_UNAUTHORIZED`    | -32001  | Token mismatch in hello handshake                |
//! | `ERR_NOT_IMPLEMENTED` | -32002  | Method not yet wired                             |
//! | `ERR_FE_UNAVAILABLE`  | -32003  | No active Tauri app handle for frontend events   |
//! | `ERR_FE_TIMEOUT`      | -32004  | Frontend did not reply within 10 seconds         |
//! | `ERR_INTERNAL`        | -32005  | Unexpected Rust-side error                       |
//! | `ERR_USER_DENIED`     | -32006  | User denied the consent prompt (or timed out)    |
//! | `ERR_FORBIDDEN`       | -32007  | Path-traversal guard rejected file_id            |

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

pub const ERR_UNAUTHORIZED: i32 = -32001;
pub const ERR_NOT_IMPLEMENTED: i32 = -32002;
pub const ERR_FE_UNAVAILABLE: i32 = -32003;
pub const ERR_FE_TIMEOUT: i32 = -32004;
pub const ERR_INTERNAL: i32 = -32005;
/// User denied the consent prompt (60-second timeout also maps here).
pub const ERR_USER_DENIED: i32 = -32006;
/// Path-traversal guard rejected a file_id in `read_attachment`.
pub const ERR_FORBIDDEN: i32 = -32007;

/// Maximum frame payload (bytes). Frames exceeding this are rejected.
const MAX_FRAME: u32 = 1_048_576; // 1 MiB

/// Frontend round-trip timeout.
const FE_TIMEOUT_SECS: u64 = 10;

/// Consent prompt timeout — 60 seconds per spec.
const CONSENT_TIMEOUT_SECS: u64 = 60;

/// Maximum attachment size returned by `read_attachment` (5 MiB).
const MAX_ATTACHMENT_BYTES: u64 = 5 * 1_048_576;

// ---------------------------------------------------------------------------
// Shared bridge state
// ---------------------------------------------------------------------------

/// Pending frontend round-trip: keyed by opaque request-id string.
/// The oneshot sender is fulfilled by [`bridge_reply`].
type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<FrontendReply>>>>;

/// Pending consent replies: keyed by consent-request uuid.
type PendingConsentMap = Arc<Mutex<HashMap<String, oneshot::Sender<ConsentDecision>>>>;

/// Result of a user consent interaction.
#[derive(Debug, Clone)]
pub enum ConsentDecision {
    Accept { remember_session: bool },
    Deny,
}

/// The reply sent back from [`bridge_reply`] (which the frontend calls).
#[derive(Debug)]
pub struct FrontendReply {
    pub result: Option<Value>,
    pub error: Option<BridgeErrorPayload>,
}

/// Payload of an error from the frontend (mirrors the JSON-RPC `error` object).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeErrorPayload {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Managed state mounted via `app.manage(BridgeState::default())`.
///
/// Holds:
/// * `pending` — in-flight frontend round-trips keyed by request id.
/// * `pending_consent` — in-flight consent prompts keyed by uuid.
/// * `session_allow` — set of tool names allowed for the current session.
/// * `socket_path` — set once the listener binds; readable by [`bridge_status`].
/// * `active_connections` — approximate count of open connections.
#[derive(Clone, Default)]
pub struct BridgeState {
    pub pending: PendingMap,
    pub pending_consent: PendingConsentMap,
    pub session_allow: Arc<Mutex<HashSet<String>>>,
    pub socket_path: Arc<Mutex<Option<String>>>,
    pub active_connections: Arc<std::sync::atomic::AtomicUsize>,
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/// Generate a fresh 32-byte random token, hex-encode it, write it to
/// `<claude_home>/mcp-bridge.token` with mode 0600 (Unix), and return the
/// hex string.
pub fn rotate_token(claude_home: &Path) -> std::io::Result<String> {
    let token = random_hex_token();
    write_token_file(claude_home, &token)?;
    Ok(token)
}

/// Read the current token from `<claude_home>/mcp-bridge.token`.
/// Returns `None` if the file does not exist or cannot be read.
fn read_token_file(claude_home: &Path) -> Option<String> {
    let path = token_path(claude_home);
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

fn token_path(claude_home: &Path) -> PathBuf {
    claude_home.join("mcp-bridge.token")
}

/// Write the token file with restrictive permissions.
fn write_token_file(claude_home: &Path, token: &str) -> std::io::Result<()> {
    let path = token_path(claude_home);
    std::fs::write(&path, token)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }

    Ok(())
}

/// Generate 32 random bytes and return as lowercase hex (64 chars).
fn random_hex_token() -> String {
    use std::fmt::Write as FmtWrite;
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG unavailable");
    let mut out = String::with_capacity(64);
    for b in &buf {
        write!(out, "{b:02x}").expect("write to String");
    }
    out
}

// ---------------------------------------------------------------------------
// Constant-time token comparison
// ---------------------------------------------------------------------------

/// Compare two byte slices in constant time (no early exit on mismatch).
/// Returns `true` iff `a == b`.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

fn ok_response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err_response(id: &Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn err_response_with_data(id: &Value, code: i32, message: &str, data: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message, "data": data }
    })
}

// ---------------------------------------------------------------------------
// Frame I/O
// ---------------------------------------------------------------------------

/// Write a single length-prefixed frame to the writer.
async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, payload: &[u8]) -> std::io::Result<()> {
    let len = payload.len() as u32;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await
}

/// Read a single length-prefixed frame from the reader.
/// Returns `None` on clean EOF (connection closed by peer).
/// Returns `Err` on I/O errors or oversized frame.
async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame too large: {len} bytes (max {MAX_FRAME})"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

// ---------------------------------------------------------------------------
// Consent flow
// ---------------------------------------------------------------------------

/// Check whether `mcp.autoApprove` is set to "always" in the k/v app-state.
async fn auto_approve_setting(app: &tauri::AppHandle) -> String {
    // Read from the k/v store via db_app_state_get.
    let db = app.state::<crate::commands::db::DbState>();
    let result: Option<String> = {
        let conn = db.lock().expect("db lock poisoned");
        conn.query_row(
            "SELECT value FROM app_state WHERE key = 'mcp.autoApprove'",
            [],
            |r| r.get(0),
        )
        .ok()
    };
    // Default to "always": with the chat UI removed (2026-05-23), the CLI is the
    // user's direct surface, so consent is implicit. No TS listener exists for
    // `mcp:consent_request` — leaving the default at "prompt" would hang every
    // gated mutation 60s then return user_denied:timeout.
    result.unwrap_or_else(|| "always".to_string())
}

/// Gate a consent-required operation.
///
/// Returns `Ok(())` when the operation may proceed.
/// Returns `Err(ERR_USER_DENIED)` when denied (or timed out).
///
/// Decision logic:
/// 1. If `mcp.autoApprove == "always"` → allow immediately.
/// 2. If the tool name is in `state.session_allow` → allow immediately.
/// 3. Otherwise emit `mcp:consent_request` and wait up to 60 s.
async fn await_consent(
    state: &BridgeState,
    app: &tauri::AppHandle,
    tool: &str,
    summary: Value,
) -> Result<(), Value> {
    // Check autoApprove setting.
    let setting = auto_approve_setting(app).await;
    if setting == "always" {
        return Ok(());
    }

    // Check session-allow set.
    {
        let allowed = state.session_allow.lock().await;
        if allowed.contains(tool) {
            return Ok(());
        }
    }

    // Emit consent request.
    let consent_id = {
        let mut buf = [0u8; 16];
        getrandom::getrandom(&mut buf).expect("CSPRNG");
        uuid_from_bytes(buf).to_string()
    };

    let (tx, rx) = oneshot::channel::<ConsentDecision>();
    {
        let mut pending = state.pending_consent.lock().await;
        pending.insert(consent_id.clone(), tx);
    }

    let event_payload = json!({
        "id": consent_id,
        "tool": tool,
        "summary": summary,
    });

    if app.emit("mcp:consent_request", &event_payload).is_err() {
        let mut pending = state.pending_consent.lock().await;
        pending.remove(&consent_id);
        return Err(json!({ "code": ERR_FE_UNAVAILABLE, "message": "frontend_unavailable" }));
    }

    // Wait for reply or timeout.
    match tokio::time::timeout(
        std::time::Duration::from_secs(CONSENT_TIMEOUT_SECS),
        rx,
    )
    .await
    {
        Ok(Ok(ConsentDecision::Accept { remember_session })) => {
            if remember_session {
                let mut allowed = state.session_allow.lock().await;
                allowed.insert(tool.to_string());
            }
            Ok(())
        }
        Ok(Ok(ConsentDecision::Deny)) => {
            Err(json!({ "code": ERR_USER_DENIED, "message": "user_denied" }))
        }
        Ok(Err(_)) => {
            // Sender dropped unexpectedly.
            Err(json!({ "code": ERR_INTERNAL, "message": "consent channel dropped" }))
        }
        Err(_) => {
            // Timeout.
            let mut pending = state.pending_consent.lock().await;
            pending.remove(&consent_id);
            Err(json!({ "code": ERR_USER_DENIED, "message": "user_denied: timeout" }))
        }
    }
}

/// Simple UUID-like string from 16 random bytes.
fn uuid_from_bytes(b: [u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3],
        b[4], b[5],
        b[6], b[7],
        b[8], b[9],
        b[10], b[11], b[12], b[13], b[14], b[15],
    )
}

// ---------------------------------------------------------------------------
// Attachment jail helpers (for read_attachment)
// ---------------------------------------------------------------------------

/// Resolve the attachment jail directory — the same `<data_root>/tmp` dir
/// that `ai_attachment_write_temp` uses.
fn attachment_jail() -> Result<PathBuf, String> {
    let root = crate::profile::data_root()
        .map_err(|e| format!("data_root: {e}"))?
        .join("tmp");
    std::fs::create_dir_all(&root).map_err(|e| format!("create jail dir: {e}"))?;
    Ok(root)
}

/// Resolve `file_id` to an absolute path inside the jail, with path-traversal
/// hardening:
///
/// 1. Strip any leading `/` or path separators from `file_id`.
/// 2. Join with the canonical jail dir.
/// 3. `canonicalize()` the result.
/// 4. Assert the result starts with the canonicalized jail prefix.
///
/// Returns `Err(ERR_FORBIDDEN)` on any violation.
fn resolve_attachment_path(file_id: &str) -> Result<PathBuf, i32> {
    // Strip path-traversal sequences from file_id.
    // Accept only the filename part — no slashes, no `..`.
    let safe_name: String = file_id
        .chars()
        .filter(|&c| {
            c != '/' && c != '\\' && c != '\0'
        })
        .collect();

    if safe_name.is_empty() || safe_name.contains("..") {
        return Err(ERR_FORBIDDEN);
    }

    let jail = attachment_jail().map_err(|_| ERR_FORBIDDEN)?;
    let jail_canon = jail.canonicalize().map_err(|_| ERR_FORBIDDEN)?;

    let candidate = jail.join(&safe_name);
    let canon = candidate.canonicalize().map_err(|_| ERR_FORBIDDEN)?;

    if !canon.starts_with(&jail_canon) {
        return Err(ERR_FORBIDDEN);
    }

    Ok(canon)
}

// ---------------------------------------------------------------------------
// AppStateBus — dispatch table
// ---------------------------------------------------------------------------

/// Configuration injected into the bus (and into the listener) at startup.
#[derive(Clone, Default)]
pub struct BridgeConfig {
    /// Override socket path (used by integration tests). `None` → derive from data_dir.
    pub socket_path_override: Option<PathBuf>,
    /// Override claude_home path (used by integration tests).
    pub claude_home_override: Option<PathBuf>,
    /// Pre-computed token written by `bootstrap_profile_extensions` at app
    /// launch.  When `Some`, the bridge uses it directly (single rotation per
    /// launch).  When `None` (integration tests / fallback) the bridge calls
    /// `rotate_token` itself.
    pub precomputed_token: Option<String>,
}

/// Dispatch a JSON-RPC method to the appropriate handler.
///
/// `app` is `Option` because integration tests run without a real Tauri app
/// handle.  Methods that require frontend round-trips return `ERR_FE_UNAVAILABLE`
/// when `app` is `None`.
async fn dispatch(
    method: &str,
    params: Value,
    id: &Value,
    app: &Option<tauri::AppHandle>,
    state: &BridgeState,
) -> Value {
    match method {
        // ------------------------------------------------------------------
        // Rust-side: market data
        // ------------------------------------------------------------------
        "fetch_ohlc" => handle_fetch_ohlc(params, id, app).await,

        // ------------------------------------------------------------------
        // Frontend round-trips (React UI fulfils these)
        // ------------------------------------------------------------------
        "compute_indicator" => {
            fe_roundtrip("compute_indicator", params, id, app, state).await
        }
        "get_current_symbol" => {
            fe_roundtrip("get_current_symbol", params, id, app, state).await
        }
        "get_visible_range" => {
            fe_roundtrip("get_visible_range", params, id, app, state).await
        }
        "list_overlays" => {
            fe_roundtrip("list_overlays", params, id, app, state).await
        }

        // ------------------------------------------------------------------
        // list_assets — frontend round-trip (single source of truth in assets.ts)
        // Returns: { provider, sym, class, name? }[] per ADR-0008 frozen shape.
        // ------------------------------------------------------------------
        "list_assets" => {
            fe_roundtrip("list_assets", params, id, app, state).await
        }

        // ------------------------------------------------------------------
        // Mutation tools — consent required, then frontend round-trip
        // ------------------------------------------------------------------
        "apply_dataset" => {
            handle_with_consent(
                "apply_dataset",
                params.clone(),
                id,
                app,
                state,
                summarise_dataset(&params),
                true,
            ).await
        }
        "remove_dataset" => {
            let dataset_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "remove_dataset",
                params,
                id,
                app,
                state,
                json!({ "action": "remove dataset", "id": dataset_id }),
                true,
            ).await
        }
        "apply_timeline_events" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "apply_timeline_events",
                params,
                id,
                app,
                state,
                json!({ "action": "apply timeline events", "name": name }),
                true,
            ).await
        }
        "remove_timeline_layer" => {
            let layer_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "remove_timeline_layer",
                params,
                id,
                app,
                state,
                json!({ "action": "remove timeline layer", "id": layer_id }),
                true,
            ).await
        }
        "apply_strategy" => {
            let strategy_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "apply_strategy",
                params,
                id,
                app,
                state,
                json!({ "action": "apply strategy overlay", "id": strategy_id }),
                true,
            ).await
        }
        "remove_strategy_overlay" => {
            let strategy_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "remove_strategy_overlay",
                params,
                id,
                app,
                state,
                json!({ "action": "remove strategy overlay", "id": strategy_id }),
                true,
            ).await
        }
        "apply_research_overlay" => {
            // Shape validation happens frontend-side (Zod) at dispatch, which
            // returns per-field {path,message} diagnostics. Rust passes the
            // JSON payload through unchanged after the consent gate — mirroring
            // `apply_dataset`.
            handle_with_consent(
                "apply_research_overlay",
                params.clone(),
                id,
                app,
                state,
                summarise_research_overlay(&params),
                true,
            ).await
        }
        "remove_research_overlay" => {
            let overlay_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "remove_research_overlay",
                params,
                id,
                app,
                state,
                json!({ "action": "remove research overlay", "id": overlay_id }),
                true,
            ).await
        }

        // ------------------------------------------------------------------
        // Research-overlay library — persistence round-trips to the frontend.
        // Unlike `save_dataset` (which hits the Rust ai_workspace DAO directly),
        // these tools round-trip to the FE so the canonical Zod validation +
        // `useResearchOverlayLibraryStore` persistence (via `dbResearchOverlays*`)
        // remains the single source of truth.
        // ------------------------------------------------------------------
        "save_research_overlay" => {
            // Shape validation happens frontend-side (Zod) at dispatch, mirroring
            // `apply_research_overlay`. Rust passes the JSON through unchanged
            // after the consent gate.
            handle_with_consent(
                "save_research_overlay",
                params.clone(),
                id,
                app,
                state,
                summarise_save_research_overlay(&params),
                true,
            ).await
        }
        "delete_research_overlay" => {
            let overlay_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "delete_research_overlay",
                params,
                id,
                app,
                state,
                json!({ "action": "delete research overlay", "id": overlay_id }),
                true,
            ).await
        }
        "list_research_overlays" => {
            fe_roundtrip("list_research_overlays", params, id, app, state).await
        }
        "load_research_overlay" => {
            fe_roundtrip("load_research_overlay", params, id, app, state).await
        }
        "open_strategy_artifact" => {
            let strategy_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            handle_with_consent(
                "open_strategy_artifact",
                params,
                id,
                app,
                state,
                json!({ "action": "open strategy panel", "id": strategy_id }),
                true,
            ).await
        }

        // ------------------------------------------------------------------
        // Delete tools — consent required, DAO call
        // ------------------------------------------------------------------
        "delete_dataset" => {
            let dataset_id = match params.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_response(id, ERR_INTERNAL, "missing param: id"),
            };
            let summary = json!({ "action": "delete dataset", "id": dataset_id });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "delete_dataset", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_delete_dataset(id, app, &dataset_id)
        }
        "update_strategy" => {
            let strategy_id = match params.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_response(id, ERR_INTERNAL, "missing param: id"),
            };
            let body_json = match params.get("body_json").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_response(id, ERR_INTERNAL, "missing param: body_json"),
            };
            let summary = json!({ "action": "update strategy", "id": strategy_id });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "update_strategy", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_update_strategy(id, app, &strategy_id, &body_json)
        }
        "delete_strategy" => {
            let strategy_id = match params.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_response(id, ERR_INTERNAL, "missing param: id"),
            };
            let summary = json!({ "action": "delete strategy", "id": strategy_id });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "delete_strategy", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_delete_strategy(id, app, &strategy_id)
        }
        "paper_open_position" => {
            let symbol = params.get("symbol").and_then(|v| v.as_str()).unwrap_or("?");
            let side = params.get("side").and_then(|v| v.as_str()).unwrap_or("?");
            let summary = json!({ "action": "open paper position", "symbol": symbol, "side": side });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "paper_open_position", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_paper_open(id, app, params)
        }
        "paper_close_position" => {
            let pos_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let summary = json!({ "action": "close paper position", "id": pos_id });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "paper_close_position", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_paper_close(id, app, params)
        }

        // ------------------------------------------------------------------
        // Read-only attachment tools (no consent)
        // ------------------------------------------------------------------
        "read_attachment" => handle_read_attachment(params, id),
        "list_attachments" => handle_list_attachments(params, id),

        // ------------------------------------------------------------------
        // Persistence — no consent (pure read/write, no UI mutation)
        // ------------------------------------------------------------------
        "save_dataset" => handle_dao_save_dataset(id, app, params),
        "list_datasets" => handle_dao_list_datasets(id, app),
        "load_dataset" => {
            let ds_id = match params.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_response(id, ERR_INTERNAL, "missing param: id"),
            };
            handle_dao_load_dataset(id, app, &ds_id)
        }

        "save_strategy" => handle_dao_save_strategy(id, app, params),
        "list_strategies" => handle_dao_list_strategies(id, app),
        "load_strategy" => {
            let strategy_id = match params.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_response(id, ERR_INTERNAL, "missing param: id"),
            };
            handle_dao_load_strategy(id, app, &strategy_id)
        }

        "save_research_note" => handle_dao_save_research_note(id, app, params),
        "list_research_notes" => handle_dao_list_research_notes(id, app),

        // ------------------------------------------------------------------
        // Compute — no consent (pure compute, round-trip to TS)
        // ------------------------------------------------------------------
        "validate_strategy" => {
            fe_roundtrip("validate_strategy", params, id, app, state).await
        }
        "backtest_strategy" => {
            fe_roundtrip("backtest_strategy", params, id, app, state).await
        }

        // ------------------------------------------------------------------
        // Paper PnL — read-only aggregate
        // ------------------------------------------------------------------
        "get_paper_pnl" => handle_dao_get_paper_pnl(id, app),

        // ------------------------------------------------------------------
        // Portfolio — read-only (no consent)
        // ------------------------------------------------------------------
        "portfolio_list_holdings" => handle_dao_portfolio_list(id, app),
        "portfolio_get_summary" => handle_dao_portfolio_summary(id, app).await,
        "portfolio_get_allocation" => handle_dao_portfolio_allocation(id, app).await,

        // ------------------------------------------------------------------
        // Portfolio — mutations (consent-gated, DAO call)
        // ------------------------------------------------------------------
        "portfolio_set_holding" => {
            let sym = params.get("sym").and_then(|v| v.as_str()).unwrap_or("?");
            let provider = params.get("provider").and_then(|v| v.as_str()).unwrap_or("?");
            let summary = json!({ "action": "set portfolio holding", "sym": sym, "provider": provider });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "portfolio_set_holding", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_portfolio_set(id, app, params)
        }
        "portfolio_add_lot" => {
            let sym = params.get("sym").and_then(|v| v.as_str()).unwrap_or("?");
            let provider = params.get("provider").and_then(|v| v.as_str()).unwrap_or("?");
            let add_qty = params.get("add_qty").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if add_qty <= 0.0 {
                return err_response(id, ERR_INTERNAL, "add_qty must be > 0");
            }
            let summary = json!({ "action": "add lot to portfolio", "sym": sym, "provider": provider, "add_qty": add_qty });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "portfolio_add_lot", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_portfolio_add_lot(id, app, params)
        }
        "portfolio_reduce_holding" => {
            let sym = params.get("sym").and_then(|v| v.as_str()).unwrap_or("?");
            let provider = params.get("provider").and_then(|v| v.as_str()).unwrap_or("?");
            let quote = params.get("quote").and_then(|v| v.as_str()).unwrap_or("?");
            let sell_qty = params.get("sell_qty").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if sell_qty <= 0.0 {
                return err_response(id, ERR_INTERNAL, "sell_qty must be > 0");
            }
            let summary = json!({ "action": "reduce portfolio holding", "sym": sym, "provider": provider, "quote": quote, "sell_qty": sell_qty });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "portfolio_reduce_holding", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_portfolio_reduce(id, app, params)
        }
        "portfolio_remove_holding" => {
            let sym = params.get("sym").and_then(|v| v.as_str()).unwrap_or("?");
            let provider = params.get("provider").and_then(|v| v.as_str()).unwrap_or("?");
            let quote = params.get("quote").and_then(|v| v.as_str()).unwrap_or("?");
            let summary = json!({ "action": "remove portfolio holding", "sym": sym, "provider": provider, "quote": quote });
            if let Some(app_handle) = app {
                if let Err(e) = await_consent(state, app_handle, "portfolio_remove_holding", summary).await {
                    return consent_error_to_response(id, &e);
                }
            }
            handle_dao_portfolio_remove(id, app, params)
        }

        // ------------------------------------------------------------------
        // Everything else → -32002 not_implemented
        // ------------------------------------------------------------------
        _ => err_response(id, ERR_NOT_IMPLEMENTED, "not_implemented"),
    }
}

// ---------------------------------------------------------------------------
// Helper: consent gate + frontend round-trip (for mutation tools)
// ---------------------------------------------------------------------------

async fn handle_with_consent(
    method: &str,
    params: Value,
    id: &Value,
    app: &Option<tauri::AppHandle>,
    state: &BridgeState,
    summary: Value,
    _is_mutation: bool,
) -> Value {
    if let Some(app_handle) = app {
        if let Err(e) = await_consent(state, app_handle, method, summary).await {
            return consent_error_to_response(id, &e);
        }
    }
    fe_roundtrip(method, params, id, app, state).await
}

fn consent_error_to_response(id: &Value, err: &Value) -> Value {
    let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(ERR_USER_DENIED as i64) as i32;
    let message = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("user_denied")
        .to_string();
    err_response(id, code, &message)
}

fn summarise_dataset(params: &Value) -> Value {
    let label = params.get("label").and_then(|v| v.as_str())
        .or_else(|| params.get("id").and_then(|v| v.as_str()))
        .unwrap_or("dataset");
    json!({ "action": "apply dataset overlay", "label": label })
}

fn summarise_research_overlay(params: &Value) -> Value {
    research_overlay_summary(params, "apply research overlay")
}

fn summarise_save_research_overlay(params: &Value) -> Value {
    research_overlay_summary(params, "save research overlay")
}

fn research_overlay_summary(params: &Value, action: &str) -> Value {
    let label = params.get("label").and_then(|v| v.as_str())
        .or_else(|| params.get("id").and_then(|v| v.as_str()))
        .unwrap_or("research overlay");
    let element_count = params
        .get("elements")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    json!({ "action": action, "label": label, "elements": element_count })
}

// ---------------------------------------------------------------------------
// fetch_ohlc — calls AppState.registry directly (no frontend round-trip)
// ---------------------------------------------------------------------------

async fn handle_fetch_ohlc(params: Value, id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    let Some(app) = app else {
        return err_response(id, ERR_FE_UNAVAILABLE, "no app handle");
    };

    let provider = match params.get("provider").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: provider"),
    };
    let sym = match params.get("sym").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: sym"),
    };
    let tf = match params.get("tf").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: tf"),
    };
    let count = params
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or(300) as usize;

    use crate::commands::market::AppState;
    let app_state = app.state::<AppState>();

    let adapter = {
        let registry = app_state.registry.lock().await;
        registry.get(&provider)
    };
    let Some(adapter) = adapter else {
        return err_response(
            id,
            ERR_INTERNAL,
            &format!("adapter not registered: {provider}"),
        );
    };

    let Some(bucket) = app_state.limiters.for_provider(&provider) else {
        return err_response(
            id,
            ERR_INTERNAL,
            &format!("no rate-limiter for provider: {provider}"),
        );
    };
    {
        let mut b = bucket.lock().await;
        b.acquire().await;
    }

    match adapter.fetch_history(&sym, &tf, count).await {
        Ok(bars) => {
            use crate::commands::db::BarRow;
            let rows: Vec<BarRow> = bars.into_iter().map(BarRow::from).collect();
            match serde_json::to_value(&rows) {
                Ok(v) => ok_response(id, v),
                Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize error: {e}")),
            }
        }
        Err(e) => err_response(id, ERR_INTERNAL, &format!("fetch_history: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Frontend round-trip helper
// ---------------------------------------------------------------------------

async fn fe_roundtrip(
    method: &str,
    params: Value,
    id: &Value,
    app: &Option<tauri::AppHandle>,
    state: &BridgeState,
) -> Value {
    let Some(app) = app else {
        return err_response(id, ERR_FE_UNAVAILABLE, "frontend_unavailable");
    };

    let req_id = id.to_string();

    let (tx, rx) = oneshot::channel::<FrontendReply>();
    {
        let mut pending = state.pending.lock().await;
        pending.insert(req_id.clone(), tx);
    }

    let envelope = json!({
        "id": req_id,
        "method": method,
        "params": params,
    });
    if app.emit("bridge:request", &envelope).is_err() {
        let mut pending = state.pending.lock().await;
        pending.remove(&req_id);
        return err_response(id, ERR_FE_UNAVAILABLE, "frontend_unavailable");
    }

    match tokio::time::timeout(std::time::Duration::from_secs(FE_TIMEOUT_SECS), rx).await {
        Ok(Ok(reply)) => {
            if let Some(err) = reply.error {
                err_response_with_data(
                    id,
                    err.code,
                    &err.message,
                    err.data.unwrap_or(Value::Null),
                )
            } else {
                ok_response(id, reply.result.unwrap_or(Value::Null))
            }
        }
        Ok(Err(_)) => err_response(id, ERR_INTERNAL, "internal: reply sender dropped"),
        Err(_) => {
            let mut pending = state.pending.lock().await;
            pending.remove(&req_id);
            err_response(id, ERR_FE_TIMEOUT, "frontend_timeout")
        }
    }
}

// ---------------------------------------------------------------------------
// Attachment handlers
// ---------------------------------------------------------------------------

fn handle_read_attachment(params: Value, id: &Value) -> Value {
    let file_id = match params.get("file_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: file_id"),
    };

    let path = match resolve_attachment_path(&file_id) {
        Ok(p) => p,
        Err(code) => {
            let msg = if code == ERR_FORBIDDEN {
                "forbidden: path traversal detected"
            } else {
                "attachment not found"
            };
            return err_response(id, code, msg);
        }
    };

    // Size guard: reject > 5 MiB.
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return err_response(id, ERR_INTERNAL, &format!("stat: {e}")),
    };
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return err_response(id, ERR_INTERNAL, "attachment too large (max 5 MiB)");
    }

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return err_response(id, ERR_INTERNAL, &format!("read: {e}")),
    };

    // Detect mime type from extension.
    let mime = mime_from_path(&path);

    // Determine name from path.
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Base64-encode.
    let b64 = BASE64_STANDARD.encode(&bytes);

    ok_response(
        id,
        json!({ "name": name, "mime": mime, "base64": b64 }),
    )
}

fn handle_list_attachments(_params: Value, id: &Value) -> Value {
    let jail = match attachment_jail() {
        Ok(p) => p,
        Err(e) => return err_response(id, ERR_INTERNAL, &format!("jail: {e}")),
    };

    let mut files = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&jail) {
        for entry in rd.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let size = meta.len();
                    files.push(json!({ "name": name, "size": size }));
                }
            }
        }
    }

    ok_response(id, json!(files))
}

fn mime_from_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "json" => "application/json",
        "csv" => "text/csv",
        "txt" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// DAO handlers — dataset
// ---------------------------------------------------------------------------

fn with_db<F, T>(app: &Option<tauri::AppHandle>, f: F) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
{
    let app = app.as_ref().ok_or_else(|| "no app handle".to_string())?;
    let db = app.state::<crate::commands::db::DbState>();
    let conn = db.lock().expect("db lock poisoned");
    f(&conn).map_err(|e| format!("db error: {e}"))
}

/// Resolve the `asset_class` for a portfolio mutation without defaulting
/// equities into the crypto bucket.
///
/// Resolution order (first hit wins):
///   1. Caller-supplied `asset_class` param — the MCP tool / UI knows best.
///   2. The catalog row's `class` for this `(provider, sym)` in the `symbols`
///      table, when it has been materialised by a `symbol_catalog_fetch`
///      (e.g. an Alpaca equity → `"equity"`).
///   3. `"crypto"` as a genuine last resort, matching the column default and
///      the historical behaviour for un-cataloged crypto pairs.
fn resolve_asset_class(
    app: &Option<tauri::AppHandle>,
    provider: &str,
    sym: &str,
    params: &Value,
) -> String {
    if let Some(supplied) = params.get("asset_class").and_then(|v| v.as_str()) {
        return supplied.to_string();
    }
    if let Ok(Some(class)) =
        with_db(app, |conn| crate::commands::db::symbol_class_lookup(conn, provider, sym))
    {
        return class;
    }
    "crypto".to_string()
}

/// Emit `portfolio:changed` so the UI can live-refresh after a successful
/// portfolio mutation. Mirrors the `app.emit(...)` pattern used for
/// `mcp:consent_request` / `bridge:request`. No-op when the app handle is
/// absent (e.g. headless tests); an emit failure is ignored — the mutation
/// already succeeded and a missing refresh is non-fatal.
fn emit_portfolio_changed(app: &Option<tauri::AppHandle>) {
    if let Some(app) = app {
        let _ = app.emit("portfolio:changed", json!({}));
    }
}

fn handle_dao_save_dataset(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let ds_id = match params.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: id"),
    };

    let ds = crate::ai_workspace::AiDataset {
        id: ds_id.clone(),
        name: params.get("label").or_else(|| params.get("name"))
            .and_then(|v| v.as_str()).unwrap_or("unnamed").to_string(),
        symbol: params.get("sym").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        timeframe: params.get("tf").and_then(|v| v.as_str()).unwrap_or("1h").to_string(),
        kind: params.get("kind").and_then(|v| v.as_str()).unwrap_or("series").to_string(),
        values_json: params.get("values")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".to_string()),
        source: "ai".to_string(),
        created_at: now_ms(),
    };

    match with_db(app, |conn| crate::ai_workspace::ai_dataset_insert(conn, &ds)) {
        Ok(_) => ok_response(id, json!({ "id": ds_id })),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_list_datasets(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    match with_db(app, crate::ai_workspace::ai_dataset_list) {
        Ok(list) => match serde_json::to_value(&list) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_load_dataset(id: &Value, app: &Option<tauri::AppHandle>, ds_id: &str) -> Value {
    let ds_id = ds_id.to_string();
    match with_db(app, |conn| crate::ai_workspace::ai_dataset_get(conn, &ds_id)) {
        Ok(Some(ds)) => match serde_json::to_value(&ds) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Ok(None) => err_response(id, ERR_INTERNAL, "dataset not found"),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_delete_dataset(id: &Value, app: &Option<tauri::AppHandle>, ds_id: &str) -> Value {
    let ds_id = ds_id.to_string();
    match with_db(app, |conn| crate::ai_workspace::ai_dataset_delete(conn, &ds_id)) {
        Ok(_) => ok_response(id, json!({ "deleted": ds_id })),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

// ---------------------------------------------------------------------------
// DAO handlers — strategy
// ---------------------------------------------------------------------------

fn handle_dao_save_strategy(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let strategy_id = match params.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: id"),
    };
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed").to_string();
    let body_json = params.to_string();

    let ts = now_ms();
    let strategy = crate::ai_workspace::AiStrategy {
        id: strategy_id.clone(),
        name,
        body_json,
        current_revision: 1,
        created_at: ts,
        updated_at: ts,
    };
    let rev_id = random_uuid();

    match with_db(app, |conn| {
        crate::ai_workspace::strategy_insert(conn, &strategy, &rev_id)
    }) {
        Ok(_) => ok_response(id, json!({ "id": strategy_id })),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_list_strategies(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    match with_db(app, crate::ai_workspace::strategy_list) {
        Ok(list) => match serde_json::to_value(&list) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_load_strategy(id: &Value, app: &Option<tauri::AppHandle>, strategy_id: &str) -> Value {
    let sid = strategy_id.to_string();
    match with_db(app, |conn| crate::ai_workspace::strategy_get(conn, &sid)) {
        Ok(Some(s)) => match serde_json::to_value(&s) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Ok(None) => err_response(id, ERR_INTERNAL, "strategy not found"),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_update_strategy(
    id: &Value,
    app: &Option<tauri::AppHandle>,
    strategy_id: &str,
    body_json: &str,
) -> Value {
    let sid = strategy_id.to_string();
    let body = body_json.to_string();
    let rev_id = random_uuid();

    match with_db(app, |conn| {
        crate::ai_workspace::strategy_update(conn, &sid, &body, &rev_id)
    }) {
        Ok(updated) => match serde_json::to_value(&updated) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_delete_strategy(id: &Value, app: &Option<tauri::AppHandle>, strategy_id: &str) -> Value {
    let sid = strategy_id.to_string();
    match with_db(app, |conn| crate::ai_workspace::strategy_delete(conn, &sid)) {
        Ok(_) => ok_response(id, json!({ "deleted": sid })),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

// ---------------------------------------------------------------------------
// DAO handlers — research notes
// ---------------------------------------------------------------------------

fn handle_dao_save_research_note(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let note_id = random_uuid();
    let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
    let body = params.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tags_json = params.get("tags")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "[]".to_string());
    let symbol = params.get("symbol").and_then(|v| v.as_str()).map(|s| s.to_string());
    let timeframe = params.get("timeframe").and_then(|v| v.as_str()).map(|s| s.to_string());

    let note = crate::ai_workspace::ResearchNote {
        id: note_id.clone(),
        title,
        body,
        tags_json,
        symbol,
        timeframe,
        created_at: now_ms(),
    };

    match with_db(app, |conn| crate::ai_workspace::research_note_insert(conn, &note)) {
        Ok(_) => ok_response(id, json!({ "id": note_id })),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_list_research_notes(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    match with_db(app, crate::ai_workspace::research_note_list) {
        Ok(list) => match serde_json::to_value(&list) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

// ---------------------------------------------------------------------------
// DAO handlers — paper trading
// ---------------------------------------------------------------------------

fn handle_dao_paper_open(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let position_id = random_uuid();
    let fill_id = random_uuid();

    let symbol = params.get("symbol").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let side = params.get("side").and_then(|v| v.as_str()).unwrap_or("long").to_string();
    let qty = params.get("qty").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ref_price = params.get("ref_price").and_then(|v| v.as_f64()).unwrap_or(0.0);

    if symbol.is_empty() {
        return err_response(id, ERR_INTERNAL, "missing param: symbol");
    }

    let position = crate::ai_workspace::PaperPosition {
        id: position_id.clone(),
        symbol,
        side,
        qty,
        ref_price,
        opened_at: now_ms(),
        closed_at: None,
        close_price: None,
    };

    match with_db(app, |conn| {
        crate::ai_workspace::paper_position_open(conn, &position, &fill_id)
    }) {
        Ok(_) => ok_response(id, json!({ "id": position_id })),
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_paper_close(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let position_id = match params.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: id"),
    };
    // close_price may be provided; if not, use 0.0 as a stub.
    let close_price = params.get("close_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let fill_id = random_uuid();

    match with_db(app, |conn| {
        crate::ai_workspace::paper_position_close(conn, &position_id, close_price, &fill_id)
    }) {
        Ok(pos) => match serde_json::to_value(&pos) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_get_paper_pnl(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    match with_db(app, crate::ai_workspace::paper_position_list) {
        Ok(positions) => {
            let mut realized_pnl = 0.0f64;
            let unrealized_pnl = 0.0f64; // mark=null path since we don't have live prices here
            let mut open_count = 0usize;
            let mut closed_count = 0usize;

            for p in &positions {
                if let (Some(cp), _) = (p.close_price, p.closed_at) {
                    // Closed position: realized PnL.
                    let pnl = if p.side == "long" {
                        (cp - p.ref_price) * p.qty
                    } else {
                        (p.ref_price - cp) * p.qty
                    };
                    realized_pnl += pnl;
                    closed_count += 1;
                } else {
                    open_count += 1;
                }
            }

            ok_response(id, json!({
                "realized_pnl": realized_pnl,
                "unrealized_pnl": unrealized_pnl,
                "unrealized_mark": null,
                "open_positions": open_count,
                "closed_positions": closed_count,
            }))
        }
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

// ---------------------------------------------------------------------------
// DAO handlers — portfolio
// ---------------------------------------------------------------------------

fn handle_dao_portfolio_list(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    match with_db(app, crate::commands::db::holdings_list) {
        Ok(list) => match serde_json::to_value(&list) {
            Ok(v) => ok_response(id, v),
            Err(e) => err_response(id, ERR_INTERNAL, &format!("serialize: {e}")),
        },
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

/// Per-holding valuation: fetches the latest close price via the market registry
/// and computes value, cost, unrealized P&L.
///
/// Returns `None` for the price fields if the price fetch fails — the holding
/// is then excluded from portfolio totals.
struct HoldingValuation {
    sym: String,
    provider: String,
    quote: String,
    asset_class: String,
    qty: f64,
    avg_cost: f64,
    /// `None` when the price fetch failed.
    price: Option<f64>,
    value: Option<f64>,
    cost: f64,
    unrealized_pnl: Option<f64>,
    unrealized_pnl_pct: Option<f64>,
}

/// Fetch the most-recent close price for a holding.
/// Falls back to 1.0 for stablecoin / USD-denominated quotes (USDT, USDC, USD, BUSD, DAI, TUSD).
async fn fetch_holding_price(
    sym: &str,
    provider: &str,
    app: &tauri::AppHandle,
) -> Option<f64> {
    // Stablecoin / fiat identity shortcut — no network call needed.
    let stable_syms = ["USDT", "USDC", "USD", "BUSD", "DAI", "TUSD", "USDP", "GUSD"];
    if stable_syms.iter().any(|&s| sym.eq_ignore_ascii_case(s)) {
        return Some(1.0);
    }

    use crate::commands::market::AppState;
    let app_state = app.state::<AppState>();

    let adapter = {
        let registry = app_state.registry.lock().await;
        registry.get(provider)
    }?;

    let Some(bucket) = app_state.limiters.for_provider(provider) else {
        return None;
    };
    {
        let mut b = bucket.lock().await;
        b.acquire().await;
    }

    // Fetch a small window of recent 1h bars and take the last close.
    match adapter.fetch_history(sym, "1h", 3).await {
        Ok(bars) if !bars.is_empty() => Some(bars.last().unwrap().c),
        _ => None,
    }
}

/// Compute per-holding valuations. Shared by both `portfolio_get_summary`
/// and `portfolio_get_allocation` to avoid duplicating the price-fetch logic.
async fn compute_holding_valuations(
    app: &tauri::AppHandle,
    holdings: &[crate::commands::db::HoldingRow],
) -> Vec<HoldingValuation> {
    let mut result = Vec::with_capacity(holdings.len());
    for h in holdings {
        let price = fetch_holding_price(&h.sym, &h.provider, app).await;
        let cost = h.avg_cost * h.qty;
        let (value, unrealized_pnl, unrealized_pnl_pct) = match price {
            Some(p) => {
                let v = p * h.qty;
                let u = v - cost;
                let u_pct = if h.avg_cost > 1e-12 {
                    (p - h.avg_cost) / h.avg_cost
                } else {
                    0.0
                };
                (Some(v), Some(u), Some(u_pct))
            }
            None => (None, None, None),
        };
        result.push(HoldingValuation {
            sym: h.sym.clone(),
            provider: h.provider.clone(),
            quote: h.quote.clone(),
            asset_class: h.asset_class.clone(),
            qty: h.qty,
            avg_cost: h.avg_cost,
            price,
            value,
            cost,
            unrealized_pnl,
            unrealized_pnl_pct,
        });
    }
    result
}

async fn handle_dao_portfolio_summary(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    let Some(app_handle) = app else {
        return err_response(id, ERR_FE_UNAVAILABLE, "no app handle");
    };

    let holdings = match with_db(app, crate::commands::db::holdings_list) {
        Ok(h) => h,
        Err(e) => return err_response(id, ERR_INTERNAL, &e),
    };

    let valuations = compute_holding_valuations(app_handle, &holdings).await;

    let mut total_value = 0.0f64;
    let mut total_cost = 0.0f64;
    let mut priced_count = 0usize;

    for v in &valuations {
        total_cost += v.cost;
        if let Some(val) = v.value {
            total_value += val;
            priced_count += 1;
        }
    }

    let total_unrealized = total_value - total_cost;
    let total_unrealized_pct = if total_cost > 1e-12 {
        total_unrealized / total_cost
    } else {
        0.0
    };

    // Build the per-holding rows with weight_pct.
    let holding_rows: Vec<Value> = valuations.iter().map(|v| {
        let weight_pct = if total_value > 1e-12 {
            v.value.map(|val| val / total_value)
        } else {
            None
        };
        json!({
            "sym": v.sym,
            "provider": v.provider,
            "quote": v.quote,
            "asset_class": v.asset_class,
            "qty": v.qty,
            "avg_cost": v.avg_cost,
            "price": v.price,
            "value": v.value,
            "cost": v.cost,
            "unrealized_pnl": v.unrealized_pnl,
            "unrealized_pnl_pct": v.unrealized_pnl_pct,
            "weight_pct": weight_pct,
        })
    }).collect();

    ok_response(id, json!({
        "total_value": total_value,
        "total_cost": total_cost,
        "unrealized_pnl": total_unrealized,
        "unrealized_pnl_pct": total_unrealized_pct,
        "holding_count": valuations.len(),
        "priced_count": priced_count,
        "holdings": holding_rows,
    }))
}

async fn handle_dao_portfolio_allocation(id: &Value, app: &Option<tauri::AppHandle>) -> Value {
    let Some(app_handle) = app else {
        return err_response(id, ERR_FE_UNAVAILABLE, "no app handle");
    };

    let holdings = match with_db(app, crate::commands::db::holdings_list) {
        Ok(h) => h,
        Err(e) => return err_response(id, ERR_INTERNAL, &e),
    };

    let valuations = compute_holding_valuations(app_handle, &holdings).await;

    // Aggregate total value from priced holdings only.
    let total_value: f64 = valuations.iter()
        .filter_map(|v| v.value)
        .sum();

    // Allocation by asset_class.
    let mut class_map: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for v in &valuations {
        if let Some(val) = v.value {
            *class_map.entry(v.asset_class.clone()).or_insert(0.0) += val;
        }
    }
    let mut by_class: Vec<Value> = class_map.into_iter().map(|(cls, val)| {
        let weight_pct = if total_value > 1e-12 { val / total_value } else { 0.0 };
        json!({ "asset_class": cls, "value": val, "weight_pct": weight_pct })
    }).collect();
    by_class.sort_by(|a, b| {
        b["value"].as_f64().unwrap_or(0.0)
            .partial_cmp(&a["value"].as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Allocation by holding.
    let by_holding: Vec<Value> = valuations.iter().map(|v| {
        let weight_pct = if total_value > 1e-12 {
            v.value.map(|val| val / total_value)
        } else {
            None
        };
        json!({ "sym": v.sym, "provider": v.provider, "quote": v.quote, "weight_pct": weight_pct })
    }).collect();

    // Best / worst performer by unrealized_pnl_pct (priced holdings only).
    let priced: Vec<&HoldingValuation> = valuations.iter()
        .filter(|v| v.unrealized_pnl_pct.is_some())
        .collect();

    let best = priced.iter().max_by(|a, b| {
        a.unrealized_pnl_pct.unwrap_or(f64::NEG_INFINITY)
            .partial_cmp(&b.unrealized_pnl_pct.unwrap_or(f64::NEG_INFINITY))
            .unwrap_or(std::cmp::Ordering::Equal)
    }).map(|v| json!({ "sym": v.sym, "provider": v.provider, "unrealized_pnl_pct": v.unrealized_pnl_pct }));

    let worst = priced.iter().min_by(|a, b| {
        a.unrealized_pnl_pct.unwrap_or(f64::INFINITY)
            .partial_cmp(&b.unrealized_pnl_pct.unwrap_or(f64::INFINITY))
            .unwrap_or(std::cmp::Ordering::Equal)
    }).map(|v| json!({ "sym": v.sym, "provider": v.provider, "unrealized_pnl_pct": v.unrealized_pnl_pct }));

    ok_response(id, json!({
        "total_value": total_value,
        "by_class": by_class,
        "by_holding": by_holding,
        "best_performer": best,
        "worst_performer": worst,
    }))
}

fn handle_dao_portfolio_set(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let sym = match params.get("sym").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: sym"),
    };
    let provider = match params.get("provider").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: provider"),
    };
    let quote = match params.get("quote").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: quote"),
    };
    let qty = match params.get("qty").and_then(|v| v.as_f64()) {
        Some(v) => v,
        None => return err_response(id, ERR_INTERNAL, "missing param: qty"),
    };
    let avg_cost = match params.get("avg_cost").and_then(|v| v.as_f64()) {
        Some(v) => v,
        None => return err_response(id, ERR_INTERNAL, "missing param: avg_cost"),
    };
    let asset_class = resolve_asset_class(app, &provider, &sym, &params);
    let currency = params.get("currency").and_then(|v| v.as_str()).unwrap_or("USD").to_string();
    let note = params.get("note").and_then(|v| v.as_str()).map(|s| s.to_string());

    let ts = now_ms();
    let holding = crate::commands::db::HoldingRow {
        sym: sym.clone(),
        provider,
        quote,
        asset_class,
        qty,
        avg_cost,
        currency,
        note,
        created_at: ts,
        updated_at: ts,
    };

    match with_db(app, |conn| crate::commands::db::holding_upsert(conn, &holding)) {
        Ok(_) => {
            emit_portfolio_changed(app);
            ok_response(id, json!({ "sym": sym }))
        }
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_portfolio_add_lot(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let sym = match params.get("sym").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: sym"),
    };
    let provider = match params.get("provider").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: provider"),
    };
    let quote = match params.get("quote").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: quote"),
    };
    let add_qty = match params.get("add_qty").and_then(|v| v.as_f64()) {
        Some(v) if v > 0.0 => v,
        Some(_) => return err_response(id, ERR_INTERNAL, "add_qty must be > 0"),
        None => return err_response(id, ERR_INTERNAL, "missing param: add_qty"),
    };
    let add_price = match params.get("add_price").and_then(|v| v.as_f64()) {
        Some(v) => v,
        None => return err_response(id, ERR_INTERNAL, "missing param: add_price"),
    };
    let asset_class = resolve_asset_class(app, &provider, &sym, &params);
    let currency = params.get("currency").and_then(|v| v.as_str()).unwrap_or("USD").to_string();
    let note = params.get("note").and_then(|v| v.as_str()).map(|s| s.to_string());

    let ts = now_ms();

    match with_db(app, |conn| {
        crate::commands::db::holding_add_lot(
            conn,
            &sym,
            &provider,
            &quote,
            &asset_class,
            add_qty,
            add_price,
            &currency,
            note.as_deref(),
            ts,
        )
    }) {
        Ok(_) => {
            emit_portfolio_changed(app);
            ok_response(id, json!({ "sym": sym, "add_qty": add_qty }))
        }
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_portfolio_reduce(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let sym = match params.get("sym").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: sym"),
    };
    let provider = match params.get("provider").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: provider"),
    };
    let quote = match params.get("quote").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: quote"),
    };
    let sell_qty = match params.get("sell_qty").and_then(|v| v.as_f64()) {
        Some(v) if v > 0.0 => v,
        Some(_) => return err_response(id, ERR_INTERNAL, "sell_qty must be > 0"),
        None => return err_response(id, ERR_INTERNAL, "missing param: sell_qty"),
    };

    let ts = now_ms();

    match with_db(app, |conn| {
        crate::commands::db::holding_reduce(conn, &sym, &provider, &quote, sell_qty, ts)
    }) {
        Ok(_) => {
            emit_portfolio_changed(app);
            ok_response(id, json!({ "sym": sym, "provider": provider, "quote": quote, "sell_qty": sell_qty }))
        }
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

fn handle_dao_portfolio_remove(id: &Value, app: &Option<tauri::AppHandle>, params: Value) -> Value {
    let sym = match params.get("sym").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: sym"),
    };
    let provider = match params.get("provider").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: provider"),
    };
    let quote = match params.get("quote").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return err_response(id, ERR_INTERNAL, "missing param: quote"),
    };

    match with_db(app, |conn| {
        crate::commands::db::holding_remove(conn, &sym, &provider, &quote)
    }) {
        Ok(_) => {
            emit_portfolio_changed(app);
            ok_response(id, json!({ "sym": sym, "provider": provider, "quote": quote }))
        }
        Err(e) => err_response(id, ERR_INTERNAL, &e),
    }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_uuid() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("CSPRNG");
    uuid_from_bytes(buf)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Called by the React UI to fulfil a pending [`fe_roundtrip`] request.
///
/// `id` must match the `id` string from the `bridge:request` event envelope.
/// Exactly one of `result` / `error` should be non-null.
#[tauri::command]
pub async fn bridge_reply(
    state: tauri::State<'_, BridgeState>,
    id: String,
    result: Option<Value>,
    error: Option<BridgeErrorPayload>,
) -> Result<(), String> {
    let mut pending = state.pending.lock().await;
    if let Some(tx) = pending.remove(&id) {
        let _ = tx.send(FrontendReply { result, error });
    }
    Ok(())
}

/// Called by the React `MCPConsentToast` to reply to a consent prompt.
///
/// `decision` must be `"accept"` or `"deny"`.
/// `remember_session` — when `true` and `decision == "accept"`, adds the tool
/// to the per-session allow-set so future calls skip the prompt.
#[tauri::command]
pub async fn mcp_consent_reply(
    state: tauri::State<'_, BridgeState>,
    id: String,
    decision: String,
    remember_session: bool,
) -> Result<(), String> {
    let mut pending = state.pending_consent.lock().await;
    if let Some(tx) = pending.remove(&id) {
        let d = if decision == "accept" {
            ConsentDecision::Accept { remember_session }
        } else {
            ConsentDecision::Deny
        };
        let _ = tx.send(d);
    }
    Ok(())
}

/// Debug command — returns the bridge's current listening status.
#[tauri::command]
pub async fn bridge_status(
    state: tauri::State<'_, BridgeState>,
) -> Result<BridgeStatusPayload, String> {
    let socket_path = state.socket_path.lock().await;
    Ok(BridgeStatusPayload {
        listening: socket_path.is_some(),
        socket_path: socket_path.clone().unwrap_or_default(),
        active_connections: state
            .active_connections
            .load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// Shape returned by [`bridge_status`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusPayload {
    pub listening: bool,
    pub socket_path: String,
    pub active_connections: usize,
}

// ---------------------------------------------------------------------------
// Listener startup
// ---------------------------------------------------------------------------

/// Start the IPC bridge listener.
pub async fn start(
    app: tauri::AppHandle,
    state: BridgeState,
) -> anyhow::Result<()> {
    start_with_config(Some(app), state, BridgeConfig::default()).await
}

/// Internal entry-point accepting an optional app handle and a [`BridgeConfig`].
/// Used by integration tests (which pass `app = None` and supply path overrides).
pub async fn start_with_config(
    app: Option<tauri::AppHandle>,
    state: BridgeState,
    cfg: BridgeConfig,
) -> anyhow::Result<()> {
    // Resolve claude_home.
    let claude_home: PathBuf = if let Some(ref p) = cfg.claude_home_override {
        p.clone()
    } else {
        crate::profile::app_claude_home()
            .map_err(|e| anyhow::anyhow!("cannot resolve claude_home: {e}"))?
    };

    if let Err(e) = std::fs::create_dir_all(&claude_home) {
        eprintln!("[ipc_bridge] cannot create claude_home {}: {e}", claude_home.display());
    }
    // Use the pre-computed token when bootstrap has already rotated it (single
    // rotation per launch).  Fall back to rotating here for tests / edge cases.
    let token = if let Some(t) = cfg.precomputed_token.clone() {
        t
    } else {
        rotate_token(&claude_home)
            .map_err(|e| anyhow::anyhow!("rotate_token: {e}"))?
    };

    let sock_path: PathBuf = if let Some(ref p) = cfg.socket_path_override {
        p.clone()
    } else {
        crate::profile::data_root()
            .map_err(|e| anyhow::anyhow!("data_root: {e}"))?
            .join("ipc.sock")
    };

    {
        let mut guard = state.socket_path.lock().await;
        *guard = Some(sock_path.to_string_lossy().to_string());
    }

    cfg_if_unix_else_windows! {
        unix => {
            use tokio::net::UnixListener;
            let _ = std::fs::remove_file(&sock_path);
            let listener = UnixListener::bind(&sock_path)
                .map_err(|e| anyhow::anyhow!("bind UDS {}: {e}", sock_path.display()))?;

            eprintln!("[ipc_bridge] listening on {}", sock_path.display());

            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let (reader, writer) = tokio::io::split(stream);
                        spawn_connection_task(
                            Box::pin(reader),
                            Box::pin(writer),
                            token.clone(),
                            claude_home.clone(),
                            app.clone(),
                            state.clone(),
                        );
                    }
                    Err(e) => {
                        eprintln!("[ipc_bridge] accept error: {e}");
                    }
                }
            }
        }
        windows => {
            use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};
            let pipe_name = format!(
                r"\\.\pipe\autoplot-mcp-{}",
                sock_path.file_name().unwrap_or_default().to_string_lossy()
            );
            {
                let mut guard = state.socket_path.lock().await;
                *guard = Some(pipe_name.clone());
            }
            eprintln!("[ipc_bridge] listening on named pipe {pipe_name}");
            loop {
                let server = ServerOptions::new()
                    .pipe_mode(PipeMode::Byte)
                    .first_pipe_instance(false)
                    .create(&pipe_name)
                    .map_err(|e| anyhow::anyhow!("create named pipe: {e}"))?;
                server.connect().await
                    .map_err(|e| anyhow::anyhow!("named pipe connect: {e}"))?;
                let (reader, writer) = tokio::io::split(server);
                spawn_connection_task(
                    Box::pin(reader),
                    Box::pin(writer),
                    token.clone(),
                    claude_home.clone(),
                    app.clone(),
                    state.clone(),
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Platform cfg_if macro (avoids pulling in cfg-if crate)
// ---------------------------------------------------------------------------

macro_rules! cfg_if_unix_else_windows {
    ( unix => { $($unix_tt:tt)* } windows => { $($win_tt:tt)* } ) => {
        #[cfg(unix)]
        { $($unix_tt)* }
        #[cfg(windows)]
        { $($win_tt)* }
    };
}

use cfg_if_unix_else_windows;

// ---------------------------------------------------------------------------
// Per-connection task
// ---------------------------------------------------------------------------

fn spawn_connection_task(
    reader: std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
    expected_token: String,
    claude_home: PathBuf,
    app: Option<tauri::AppHandle>,
    state: BridgeState,
) {
    state
        .active_connections
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let active = state.active_connections.clone();
    tokio::spawn(async move {
        if let Err(e) = run_connection(
            reader,
            writer,
            &expected_token,
            &claude_home,
            &app,
            &state,
        )
        .await
        {
            eprintln!("[ipc_bridge] connection error: {e}");
        }
        active.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    });
}

async fn run_connection(
    mut reader: std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
    expected_token: &str,
    claude_home: &Path,
    app: &Option<tauri::AppHandle>,
    state: &BridgeState,
) -> anyhow::Result<()> {
    // -----------------------------------------------------------------------
    // Hello handshake
    // -----------------------------------------------------------------------
    let raw = match read_frame(&mut reader).await? {
        Some(b) => b,
        None => return Ok(()),
    };

    let hello: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let hello_id = hello
        .get("id")
        .cloned()
        .unwrap_or(json!(0));

    let method = hello
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if method != "hello" {
        let resp = err_response(&hello_id, ERR_UNAUTHORIZED, "expected hello");
        write_frame(&mut writer, resp.to_string().as_bytes()).await?;
        return Ok(());
    }

    let provided = hello
        .get("params")
        .and_then(|p| p.get("token"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    let live_token = read_token_file(claude_home)
        .unwrap_or_else(|| expected_token.to_string());

    if !ct_eq(provided.as_bytes(), live_token.as_bytes()) {
        let resp = err_response(&hello_id, ERR_UNAUTHORIZED, "unauthorized");
        write_frame(&mut writer, resp.to_string().as_bytes()).await?;
        return Ok(());
    }

    let resp = ok_response(&hello_id, json!({ "status": "ok" }));
    write_frame(&mut writer, resp.to_string().as_bytes()).await?;

    // -----------------------------------------------------------------------
    // Main request loop
    // -----------------------------------------------------------------------
    loop {
        let raw = match read_frame(&mut reader).await {
            Ok(Some(b)) => b,
            Ok(None) => break,
            Err(e) => {
                eprintln!("[ipc_bridge] read_frame: {e}");
                break;
            }
        };

        let req: Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(e) => {
                let resp = err_response(
                    &json!(null),
                    ERR_INTERNAL,
                    &format!("json parse error: {e}"),
                );
                if write_frame(&mut writer, resp.to_string().as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
        };

        let req_id = req.get("id").cloned().unwrap_or(json!(null));
        let method = req
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let params = req
            .get("params")
            .cloned()
            .unwrap_or(json!({}));

        let response = dispatch(method, params, &req_id, app, state).await;

        if write_frame(&mut writer, response.to_string().as_bytes())
            .await
            .is_err()
        {
            break;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (unit)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_basics() {
        assert!(ct_eq(b"hello", b"hello"));
        assert!(!ct_eq(b"hello", b"world"));
        assert!(!ct_eq(b"ab", b"abc"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn token_generation_is_64_hex_chars() {
        let t = random_hex_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn rotate_token_writes_file_0600() {
        let dir = tempfile::tempdir().expect("tempdir");
        let tok = rotate_token(dir.path()).expect("rotate_token");
        assert_eq!(tok.len(), 64);
        let on_disk = std::fs::read_to_string(dir.path().join("mcp-bridge.token")).unwrap();
        assert_eq!(on_disk.trim(), tok);

        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::metadata(dir.path().join("mcp-bridge.token")).unwrap();
            assert_eq!(meta.mode() & 0o777, 0o600, "token file must be 0600");
        }
    }

    #[test]
    fn ok_response_shape() {
        let r = ok_response(&json!(42), json!("hello"));
        assert_eq!(r["id"], json!(42));
        assert_eq!(r["result"], json!("hello"));
        assert!(r.get("error").is_none());
    }

    #[test]
    fn err_response_shape() {
        let r = err_response(&json!("abc"), -32001, "unauthorized");
        assert_eq!(r["id"], json!("abc"));
        assert_eq!(r["error"]["code"], json!(-32001));
        assert_eq!(r["error"]["message"], json!("unauthorized"));
    }

    #[test]
    fn resolve_attachment_path_rejects_traversal() {
        // The jail dir may or may not exist in the test env. Either way a
        // path-traversal file_id must be rejected.
        let result = resolve_attachment_path("../../../etc/passwd");
        // Should get ERR_FORBIDDEN because the `..` check triggers.
        assert!(result.is_err());
        if let Err(code) = result {
            assert_eq!(code, ERR_FORBIDDEN);
        }
    }

    #[test]
    fn resolve_attachment_path_rejects_slash() {
        let result = resolve_attachment_path("/etc/passwd");
        // After stripping leading slash, becomes "etc/passwd" — no `..` but
        // still won't be inside the jail. May fail at canonicalize() or jail check.
        assert!(result.is_err());
    }

    #[test]
    fn err_code_user_denied_is_minus_32006() {
        assert_eq!(ERR_USER_DENIED, -32006);
    }

    #[test]
    fn err_code_forbidden_is_minus_32007() {
        assert_eq!(ERR_FORBIDDEN, -32007);
    }

    #[test]
    fn uuid_from_bytes_length() {
        let b = [0u8; 16];
        let s = uuid_from_bytes(b);
        // UUID format: 8-4-4-4-12 = 36 chars
        assert_eq!(s.len(), 36);
    }
}
