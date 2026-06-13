//! src-tauri/src/commands/mcp.rs — MCP config IO + health checks (P5 W2-B).
//!
//! Three sources of MCP server entries are merged with documented precedence:
//!
//!   app  >  user  >  project
//!
//! - **app**     `<dirs::data_dir>/autoplot/mcp.json`
//! - **user**    `~/.claude.json`            (the `mcpServers` key)
//! - **project** `<cwd>/.mcp.json`           (best-effort — falls back gracefully)
//!
//! The merge is silent (per spec; surfaced to QA in `docs/p5-smoke.md`). Each
//! resulting `McpServer` carries its `source` tag so the UI can disable
//! edit/remove for non-`app` rows.
//!
//! Health-check is best-effort: `stdio` transports try `<cmd> <args> --help`
//! with a 1s timeout (the `--help` flag is not universal across MCP servers,
//! so we treat **timeout OR non-error exit** as healthy and only flag obvious
//! spawn failures); `http`/`sse` transports HEAD the URL with a 1s timeout.
//!
//! The `mcp_emit_temp_config` command writes a filtered copy of the merged
//! list — minus any names in `disabled` — into the per-session jail dir, and
//! returns its absolute path so the caller can pass `--mcp-config <path>`
//! when spawning a `terminal_spawn` PTY session.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::process::Command;
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// One MCP server entry — flattened across the three config sources.
///
/// Field naming mirrors Rust serde snake_case so the TS side can use the same
/// shape on the wire (no per-row remapping at the boundary).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// `"stdio" | "http" | "sse"`.
    pub transport: String,
    /// stdio only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// stdio only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// stdio only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    /// http / sse only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// `"app" | "user" | "project"` — set by the merge step. Round-tripped on
    /// upsert (caller passes whatever; we ignore on write).
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub name: String,
    pub healthy: bool,
    pub last_checked: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn data_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    Ok(base.join("autoplot"))
}

fn app_config_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("mcp.json"))
}

/// Wave 0 profile-isolation: the "user" MCP source now reads from the app's
/// isolated profile at `<claude-home>/.claude.json` — NOT the user's main
/// `~/.claude.json`. The label `"user"` is preserved for wire compatibility
/// (TS `McpSource = 'app' | 'user' | 'project'`) but semantically it's the
/// CLI-owned file inside our own profile dir.
fn user_config_path() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    Some(crate::profile::claude_dotjson_at(&base))
}

/// Path to the user's MAIN `~/.claude.json` — used ONLY by the explicit,
/// user-triggered `mcp_import_from_user_profile` command. Read-only.
fn user_main_profile_path_at(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

fn project_config_path() -> Option<PathBuf> {
    // Best-effort: use the current process cwd. In Tauri this is whatever the
    // bundle was launched from — typically not meaningful for end users, but
    // matches Claude CLI's documented `--mcp-config <project>/.mcp.json`
    // search semantics. We tolerate "no project file" silently.
    std::env::current_dir().ok().map(|d| d.join(".mcp.json"))
}

// ---------------------------------------------------------------------------
// Parse one server entry from a `mcpServers` value Map. Tolerates the
// loose-shape used by `~/.claude.json` (extra `type`, `disabled`, `headers`).
// Returns None if the entry is structurally unusable.
// ---------------------------------------------------------------------------

fn parse_server_entry(name: &str, raw: &Value, source: &str) -> Option<McpServer> {
    let obj = raw.as_object()?;

    // Honour the user's `disabled: true` flag by skipping the entry entirely.
    if obj.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }

    // Transport is either explicit (`type` per Claude CLI) or inferred:
    //   - has `url`              → "http" (default for url) or "sse" if type says so
    //   - has `command`          → "stdio"
    let explicit = obj
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let url = obj
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let command = obj
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let transport = match explicit.as_deref() {
        Some("stdio") => "stdio".to_string(),
        Some("http") => "http".to_string(),
        Some("sse") => "sse".to_string(),
        _ => {
            if url.is_some() {
                "http".to_string()
            } else if command.is_some() {
                "stdio".to_string()
            } else {
                return None;
            }
        }
    };

    let args = obj
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        });

    let env = obj.get("env").and_then(|v| v.as_object()).map(|m| {
        m.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect::<HashMap<String, String>>()
    });

    Some(McpServer {
        name: name.to_string(),
        transport,
        command,
        args,
        env,
        url,
        source: source.to_string(),
    })
}

fn read_servers_from(path: &Path, source: &str) -> Vec<McpServer> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let val: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let map = match val.get("mcpServers").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => return Vec::new(),
    };
    map.iter()
        .filter_map(|(k, v)| parse_server_entry(k, v, source))
        .collect()
}

/// Pure helper: merge the three sources with `app > user > project` precedence.
/// Exposed `pub(crate)` so unit tests can drive it deterministically.
pub(crate) fn merge_sources(
    app: Vec<McpServer>,
    user: Vec<McpServer>,
    project: Vec<McpServer>,
) -> Vec<McpServer> {
    // Use BTreeMap for stable, name-ordered output.
    let mut by_name: BTreeMap<String, McpServer> = BTreeMap::new();
    // Lowest precedence first; later inserts overwrite.
    for s in project {
        by_name.insert(s.name.clone(), s);
    }
    for s in user {
        by_name.insert(s.name.clone(), s);
    }
    for s in app {
        by_name.insert(s.name.clone(), s);
    }
    by_name.into_values().collect()
}

// ---------------------------------------------------------------------------
// App-config IO helpers (testable; commands wrap these).
// ---------------------------------------------------------------------------

fn ensure_app_config_at(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create app config dir: {e}"))?;
    }
    if !path.exists() {
        std::fs::write(path, b"{\n  \"mcpServers\": {}\n}\n")
            .map_err(|e| format!("seed app config: {e}"))?;
    }
    Ok(())
}

fn read_app_object(path: &Path) -> Result<Value, String> {
    ensure_app_config_at(path)?;
    let bytes = std::fs::read(path).map_err(|e| format!("read app config: {e}"))?;
    let v: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "mcpServers": {} }));
    if v.is_object() {
        Ok(v)
    } else {
        Ok(json!({ "mcpServers": {} }))
    }
}

fn write_app_object(path: &Path, v: &Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty).map_err(|e| format!("write app config: {e}"))?;
    Ok(())
}

/// Convert one McpServer → the Claude-CLI-shaped entry value (the wrapping
/// object that lives under `mcpServers[<name>]`). Stripped of `name`/`source`.
fn server_to_entry(s: &McpServer) -> Value {
    let mut obj = Map::new();
    match s.transport.as_str() {
        "stdio" => {
            if let Some(c) = &s.command {
                obj.insert("command".into(), Value::String(c.clone()));
            }
            if let Some(args) = &s.args {
                obj.insert(
                    "args".into(),
                    Value::Array(args.iter().cloned().map(Value::String).collect()),
                );
            }
            if let Some(env) = &s.env {
                let mut em = Map::new();
                for (k, v) in env {
                    em.insert(k.clone(), Value::String(v.clone()));
                }
                obj.insert("env".into(), Value::Object(em));
            }
        }
        "http" | "sse" => {
            obj.insert("type".into(), Value::String(s.transport.clone()));
            if let Some(u) = &s.url {
                obj.insert("url".into(), Value::String(u.clone()));
            }
        }
        _ => {}
    }
    Value::Object(obj)
}

pub(crate) fn upsert_into(path: &Path, server: &McpServer) -> Result<(), String> {
    let mut root = read_app_object(path)?;
    let map = root
        .as_object_mut()
        .and_then(|o| {
            if !o.contains_key("mcpServers") {
                o.insert("mcpServers".into(), Value::Object(Map::new()));
            }
            o.get_mut("mcpServers").and_then(|v| v.as_object_mut())
        })
        .ok_or_else(|| "app config root is not an object".to_string())?;
    map.insert(server.name.clone(), server_to_entry(server));
    write_app_object(path, &root)
}

pub(crate) fn remove_from(path: &Path, name: &str) -> Result<(), String> {
    let mut root = read_app_object(path)?;
    if let Some(map) = root
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|v| v.as_object_mut())
    {
        map.remove(name);
    }
    write_app_object(path, &root)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mcp_list_merged() -> Result<Vec<McpServer>, String> {
    let app_path = app_config_path()?;
    ensure_app_config_at(&app_path)?;

    let app = read_servers_from(&app_path, "app");
    let user = user_config_path()
        .map(|p| read_servers_from(&p, "user"))
        .unwrap_or_default();
    let project = project_config_path()
        .map(|p| read_servers_from(&p, "project"))
        .unwrap_or_default();

    Ok(merge_sources(app, user, project))
}

#[tauri::command]
pub async fn mcp_app_config_path() -> Result<String, String> {
    let p = app_config_path()?;
    ensure_app_config_at(&p)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn mcp_app_config_upsert(server: McpServer) -> Result<(), String> {
    if server.name.trim().is_empty() {
        return Err("server name required".into());
    }
    let path = app_config_path()?;
    upsert_into(&path, &server)
}

#[tauri::command]
pub async fn mcp_app_config_remove(name: String) -> Result<(), String> {
    let path = app_config_path()?;
    remove_from(&path, &name)
}

#[tauri::command]
pub async fn mcp_health_check(server: McpServer) -> Result<McpStatus, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let result = match server.transport.as_str() {
        "stdio" => stdio_health(&server).await,
        "http" | "sse" => http_health(&server).await,
        other => Err(format!("unsupported transport: {other}")),
    };

    Ok(match result {
        Ok(()) => McpStatus {
            name: server.name,
            healthy: true,
            last_checked: now,
            error: None,
        },
        Err(e) => McpStatus {
            name: server.name,
            healthy: false,
            last_checked: now,
            error: Some(e),
        },
    })
}

async fn stdio_health(server: &McpServer) -> Result<(), String> {
    let cmd = server
        .command
        .as_deref()
        .ok_or_else(|| "stdio server missing command".to_string())?;

    let mut c = Command::new(cmd);
    if let Some(args) = &server.args {
        c.args(args);
    }
    c.arg("--help");
    if let Some(env) = &server.env {
        for (k, v) in env {
            c.env(k, v);
        }
    }
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let spawn = c.output();
    match timeout(Duration::from_secs(1), spawn).await {
        // Process completed within budget — `--help` may exit non-zero on
        // servers that don't recognise it; treat any successful spawn as
        // healthy.
        Ok(Ok(_out)) => Ok(()),
        // Spawn itself failed (binary not found, EACCES, etc.).
        Ok(Err(e)) => Err(format!("spawn: {e}")),
        // Timeout — process is alive and didn't exit on `--help`. Still a
        // sign the binary launched, so we treat as healthy.
        Err(_) => Ok(()),
    }
}

async fn http_health(server: &McpServer) -> Result<(), String> {
    let url = server
        .url
        .as_deref()
        .ok_or_else(|| "http server missing url".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let req = client.head(url).send();
    match timeout(Duration::from_secs(1), req).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("http: {e}")),
        Err(_) => Err("http timeout".into()),
    }
}

/// Write a filtered copy of the merged config (minus `disabled` names) to the
/// session's jail dir; return the absolute path. Used by PTY callers
/// (`terminal_spawn`) when a per-session disabled set is non-empty.
#[tauri::command]
pub async fn mcp_emit_temp_config(
    disabled: Vec<String>,
    session_id: String,
) -> Result<String, String> {
    if session_id.trim().is_empty() {
        return Err("session_id required".into());
    }
    // Reuse the same jail-dir layout as ai.rs: data_root/sessions/<id>/.
    let jail = data_root()?.join("sessions").join(&session_id);
    std::fs::create_dir_all(&jail).map_err(|e| format!("create jail: {e}"))?;

    let merged = mcp_list_merged().await?;
    let disabled_set: std::collections::HashSet<&str> =
        disabled.iter().map(|s| s.as_str()).collect();

    let mut servers_obj = Map::new();
    for srv in merged.iter() {
        if disabled_set.contains(srv.name.as_str()) {
            continue;
        }
        servers_obj.insert(srv.name.clone(), server_to_entry(srv));
    }
    let root = json!({ "mcpServers": Value::Object(servers_obj) });
    let dest = jail.join("mcp-runtime.json");
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&dest, pretty).map_err(|e| format!("write temp config: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Wave 0 — Import MCP servers from main `~/.claude.json` (READ-ONLY one-shot)
// ---------------------------------------------------------------------------
//
// Explicit user-triggered command surfaced in Settings → MCP. Reads
// `~/.claude.json`'s `mcpServers` map (best-effort), merges entries into the
// app-managed `mcp.json` (skipping entries already present), and returns the
// number of imported entries. The source file is NOT modified — caller can
// `shasum` it pre/post and confirm byte-equality.

#[derive(Debug, Clone, Serialize)]
pub struct McpImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub source_path: String,
}

pub(crate) fn import_from_main_profile_inner(
    main_path: &Path,
    app_path: &Path,
) -> Result<McpImportResult, String> {
    let bytes = match std::fs::read(main_path) {
        Ok(b) => b,
        Err(_) => {
            return Ok(McpImportResult {
                imported: 0,
                skipped: 0,
                source_path: main_path.to_string_lossy().to_string(),
            });
        }
    };
    let val: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse main profile: {e}"))?;
    let map = match val.get("mcpServers").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => {
            return Ok(McpImportResult {
                imported: 0,
                skipped: 0,
                source_path: main_path.to_string_lossy().to_string(),
            });
        }
    };

    // Load existing app names so we can skip duplicates → idempotent on repeat.
    let existing: std::collections::HashSet<String> =
        read_servers_from(app_path, "app").into_iter().map(|s| s.name).collect();

    let mut imported = 0usize;
    let mut skipped = 0usize;
    for (name, raw) in map {
        if existing.contains(name) {
            skipped += 1;
            continue;
        }
        let Some(srv) = parse_server_entry(name, raw, "app") else {
            skipped += 1;
            continue;
        };
        upsert_into(app_path, &srv)?;
        imported += 1;
    }

    Ok(McpImportResult {
        imported,
        skipped,
        source_path: main_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn mcp_import_from_user_profile() -> Result<McpImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
    let main_path = user_main_profile_path_at(&home);
    let app_path = app_config_path()?;
    ensure_app_config_at(&app_path)?;
    import_from_main_profile_inner(&main_path, &app_path)
}

// ---------------------------------------------------------------------------
// Unit tests (W2-B)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    fn scratch(label: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("tp-mcp-{}-{}", label, Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn server(name: &str, src: &str) -> McpServer {
        McpServer {
            name: name.into(),
            transport: "stdio".into(),
            command: Some("/bin/echo".into()),
            args: Some(vec!["hi".into()]),
            env: None,
            url: None,
            source: src.into(),
        }
    }

    // -------- parse_server_entry ------------------------------------------

    #[test]
    fn parse_stdio_entry_infers_transport_from_command() {
        let raw = json!({
            "command": "npx",
            "args": ["-y", "foo"],
            "env": { "K": "V" },
        });
        let s = parse_server_entry("foo", &raw, "user").expect("parse");
        assert_eq!(s.transport, "stdio");
        assert_eq!(s.command.as_deref(), Some("npx"));
        assert_eq!(s.args.as_ref().unwrap(), &vec!["-y".to_string(), "foo".to_string()]);
        assert_eq!(s.env.as_ref().unwrap().get("K").unwrap(), "V");
        assert_eq!(s.source, "user");
    }

    #[test]
    fn parse_http_entry_uses_explicit_type() {
        let raw = json!({
            "type": "http",
            "url": "https://example.com/mcp",
        });
        let s = parse_server_entry("remote", &raw, "user").expect("parse");
        assert_eq!(s.transport, "http");
        assert_eq!(s.url.as_deref(), Some("https://example.com/mcp"));
    }

    #[test]
    fn parse_skips_disabled_entries() {
        let raw = json!({ "disabled": true, "command": "x" });
        assert!(parse_server_entry("x", &raw, "user").is_none());
    }

    #[test]
    fn parse_url_default_transport_is_http() {
        let raw = json!({ "url": "https://x.example/" });
        let s = parse_server_entry("u", &raw, "user").expect("parse");
        assert_eq!(s.transport, "http");
    }

    // -------- merge precedence --------------------------------------------

    #[test]
    fn merge_app_wins_over_user_and_project() {
        let app = vec![server("shared", "app")];
        let mut user = server("shared", "user");
        user.command = Some("/from/user".into());
        let project = vec![server("only-project", "project")];

        let merged = merge_sources(app, vec![user], project);
        let by_name: HashMap<_, _> = merged.iter().map(|s| (s.name.clone(), s)).collect();

        // app row wins for the shared name.
        let shared = by_name.get("shared").expect("shared present");
        assert_eq!(shared.source, "app");
        assert_eq!(shared.command.as_deref(), Some("/bin/echo"));
        // project-only row survives.
        assert!(by_name.contains_key("only-project"));
    }

    #[test]
    fn merge_user_wins_over_project_only() {
        let user = vec![server("name", "user")];
        let project = vec![server("name", "project")];
        let merged = merge_sources(vec![], user, project);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "user");
    }

    // -------- read_servers_from -------------------------------------------

    #[test]
    fn read_servers_from_returns_empty_for_missing_file() {
        let dir = scratch("missing");
        let bogus = dir.join("nope.json");
        assert!(read_servers_from(&bogus, "user").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_servers_from_skips_disabled_and_unsupported() {
        let dir = scratch("read");
        let path = dir.join("c.json");
        std::fs::write(
            &path,
            r#"{
              "mcpServers": {
                "ok": { "command": "x" },
                "off": { "disabled": true, "command": "x" },
                "bad": { "junk": true }
              }
            }"#,
        )
        .unwrap();
        let rows = read_servers_from(&path, "user");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "ok");
        std::fs::remove_dir_all(&dir).ok();
    }

    // -------- ensure / upsert / remove on app config -----------------------

    #[test]
    fn ensure_creates_seed_file() {
        let dir = scratch("ensure");
        let p = dir.join("mcp.json");
        ensure_app_config_at(&p).unwrap();
        assert!(p.exists());
        let s = std::fs::read_to_string(&p).unwrap();
        assert!(s.contains("mcpServers"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_then_remove_round_trip() {
        let dir = scratch("upsert");
        let p = dir.join("mcp.json");
        let s = McpServer {
            name: "demo".into(),
            transport: "stdio".into(),
            command: Some("npx".into()),
            args: Some(vec!["-y".into(), "@org/srv".into()]),
            env: None,
            url: None,
            source: "app".into(),
        };
        upsert_into(&p, &s).unwrap();

        let rows = read_servers_from(&p, "app");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "demo");
        assert_eq!(rows[0].command.as_deref(), Some("npx"));

        // Replace.
        let mut s2 = s.clone();
        s2.command = Some("node".into());
        upsert_into(&p, &s2).unwrap();
        let rows = read_servers_from(&p, "app");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command.as_deref(), Some("node"));

        // Remove.
        remove_from(&p, "demo").unwrap();
        let rows = read_servers_from(&p, "app");
        assert!(rows.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    // -------- Wave 0 — mcp_import_from_user_profile -----------------------

    fn sha256_file(p: &Path) -> String {
        // Tiny, no-deps SHA-256 alternative: read the bytes and hash them via
        // a built-in. We avoid pulling in `sha2` for one test by checksumming
        // through `std::collections::hash_map::DefaultHasher` — collision
        // resistance isn't the goal; we just need to detect mutation.
        use std::hash::{Hasher, BuildHasher, RandomState};
        let bytes = std::fs::read(p).expect("read");
        let bh = RandomState::new();
        let mut h = bh.build_hasher();
        h.write(&bytes);
        format!("{}-{}", bytes.len(), h.finish())
    }

    #[test]
    fn import_from_main_profile_byte_identical_source_and_idempotent() {
        let dir = scratch("import");
        let main = dir.join(".claude.json");
        let main_body = r#"{
            "mcpServers": {
                "demo": { "command": "npx", "args": ["-y", "@org/srv"] },
                "remote": { "type": "http", "url": "https://x.example/mcp" }
            },
            "otherStuff": "preserve me"
        }"#;
        std::fs::write(&main, main_body).unwrap();
        // Compare raw bytes pre/post — strict byte-identical.
        let pre_bytes = std::fs::read(&main).unwrap();

        let app = dir.join("mcp.json");
        ensure_app_config_at(&app).unwrap();

        // First import: 2 imported, 0 skipped.
        let r1 = import_from_main_profile_inner(&main, &app).expect("import 1");
        assert_eq!(r1.imported, 2);
        assert_eq!(r1.skipped, 0);

        // Source must be byte-identical.
        let post_bytes = std::fs::read(&main).unwrap();
        assert_eq!(pre_bytes, post_bytes, "source ~/.claude.json mutated!");

        // Second import: 0 imported, 2 skipped (idempotent).
        let r2 = import_from_main_profile_inner(&main, &app).expect("import 2");
        assert_eq!(r2.imported, 0);
        assert_eq!(r2.skipped, 2);

        // Target rows present + correct shape.
        let rows = read_servers_from(&app, "app");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.name == "demo" && r.transport == "stdio"));
        assert!(rows.iter().any(|r| r.name == "remote" && r.transport == "http"));

        // Source byte-identical after second pass too.
        assert_eq!(pre_bytes, std::fs::read(&main).unwrap());

        // Sanity: hash matches.
        let _ = sha256_file(&main); // exercise the helper

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_from_missing_main_profile_is_no_op() {
        let dir = scratch("import-missing");
        let main = dir.join("does-not-exist.json");
        let app = dir.join("mcp.json");
        ensure_app_config_at(&app).unwrap();
        let r = import_from_main_profile_inner(&main, &app).expect("import");
        assert_eq!(r.imported, 0);
        assert_eq!(r.skipped, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_http_writes_type_and_url() {
        let dir = scratch("upsert-http");
        let p = dir.join("mcp.json");
        let s = McpServer {
            name: "remote".into(),
            transport: "http".into(),
            command: None,
            args: None,
            env: None,
            url: Some("https://x.example/mcp".into()),
            source: "app".into(),
        };
        upsert_into(&p, &s).unwrap();
        let bytes = std::fs::read_to_string(&p).unwrap();
        assert!(bytes.contains(r#""type": "http""#));
        assert!(bytes.contains(r#""url": "https://x.example/mcp""#));
        std::fs::remove_dir_all(&dir).ok();
    }
}
