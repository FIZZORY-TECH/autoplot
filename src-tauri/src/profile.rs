//! src-tauri/src/profile.rs — Wave 0 profile isolation.
//!
//! Forces every Claude profile read/write to live under
//! `<dirs::data_dir>/autoplot/claude-home/`, mirroring `~/.claude` layout
//! but completely isolated from the user's main profile.
//!
//! Every helper that needs a base dir comes in two flavours:
//!
//! * `<name>()`            — uses the live OS data dir (production path).
//! * `<name>_at(base)`     — accepts a sentinel base dir for unit tests so
//!   `~/.claude` is never touched by cargo test.
//!
//! ## Layout under `claude-home/`
//!
//! ```text
//! claude-home/
//!   settings.json        # pre-seeded as `{}`; ours to read/merge
//!   .claude.json         # pre-seeded as `{"mcpServers":{}}` IFF missing;
//!                        # CLI then takes ownership (firstStartTime, OAuth,
//!                        # onboarding flags, …) — we never overwrite once it
//!                        # exists.
//!   agents/              # empty dir — pre-created
//!   skills/              # empty dir — pre-created
//!   commands/            # empty dir — pre-created
//!   plugins/             # empty dir — pre-created
//! ```
//!
//! ## What we do NOT do
//!
//! * We never `env_clear()` on subprocess spawn (breaks macOS Keychain / OAuth /
//!   locale / JS-bundle shebangs). Inherit env, then `env_remove` only the
//!   leaky `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` vars (see [`env_remove_keys`]).
//! * We never overwrite an existing `claude-home/.claude.json` — the CLI owns
//!   the file's WRITES (project history, OAuth cache, onboarding flags). We
//!   only seed the file's EXISTENCE on a clean install with `{"mcpServers":{}}`
//!   so `--strict-mcp-config --mcp-config <this file>` doesn't fail
//!   pre-stream with `mcpServers: Invalid input: expected record, received undefined`.
//! * We never read or write the user's `~/.claude*`.
//!   The single exception is `mcp_import_from_user_profile`, which is a
//!   user-triggered, read-only one-shot copy (see `commands/mcp.rs`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

/// Shared state holding the in-flight `claude auth login` child process so a
/// sibling Tauri command (`profile_login_cancel`) can kill it. We use
/// `tokio::sync::Mutex` (not `std::sync::Mutex`) because the login command
/// holds the lock across `await` points (during stream-pump and exit-wait).
pub type LoginState = Mutex<Option<Child>>;

/// Snapshot of the canonical profile paths — surfaced via the `profile_paths`
/// Tauri command so the React UI can render help text without hard-coding
/// `~/.claude` strings. Field naming is camelCase on the wire because it's
/// consumed exclusively by TS (no DB-row reuse).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePaths {
    pub claude_home: String,
    pub agents: String,
    pub skills: String,
    pub commands: String,
    pub plugins: String,
    pub settings: String,
    pub mcp: String,
}

#[tauri::command]
pub fn profile_init() -> Result<String, String> {
    let home = bootstrap_profile()?;
    Ok(home.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// In-app Claude account login (delegated to `claude auth …` subcommands)
// ---------------------------------------------------------------------------
//
// We never see an OAuth code or token directly: the CLI handles the entire
// browser hand-off and writes credentials into `<claude-home>/.claude.json`
// (which the CLI owns; see file invariants at the top of this module).
//
// Every spawn applies the same isolation contract as the chat path:
//   * `CLAUDE_CONFIG_DIR=<claude-home>` so the CLI reads/writes the isolated
//     profile, never the user's `~/.claude*`.
//   * `env_remove` for every key in `ENV_REMOVE_KEYS` so a stray
//     `ANTHROPIC_API_KEY` in the user's shell can't shadow the OAuth flow.
//
// We never `env_clear()` — that strips macOS bootstrap vars (`SSH_AUTH_SOCK`,
// `__CFBundleIdentifier`, locale, NODE_*) and breaks Keychain reads / OAuth.

/// Wire-facing auth status surfaced to the React UI. The CLI's `auth status
/// --json` output (`{loggedIn, authMethod, apiProvider}`) is translated into
/// this shape so the UI doesn't have to know which CLI version it's talking
/// to.
///
/// `mode` collapses three states the UI cares about:
///   * `"oauth"`  — CLI reports `loggedIn: true`.
///   * `"apiKey"` — CLI says no, but `<claude-home>/settings.json` has
///     `env.ANTHROPIC_API_KEY` set.
///   * `"none"`   — neither.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    /// One of `"oauth"`, `"apiKey"`, `"none"`.
    pub mode: String,
    pub account: Option<String>,
}

/// Subset of the CLI's `auth status --json` output we consume. Extra keys are
/// ignored; missing keys default. Field names mirror the CLI's camelCase.
#[derive(Debug, Default, Deserialize)]
struct CliAuthStatus {
    #[serde(default)]
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    #[serde(default)]
    #[serde(rename = "authMethod")]
    auth_method: Option<String>,
    #[serde(default)]
    #[serde(rename = "apiProvider")]
    api_provider: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    account: Option<String>,
}

fn cli_or_default(cli_path: Option<String>) -> String {
    cli_path.unwrap_or_else(|| "claude".to_string())
}

/// Configure a `tokio::process::Command` for the isolated profile: set
/// `CLAUDE_CONFIG_DIR` and strip the leaky env vars.
fn configure_isolated_command(cmd: &mut Command, home: &Path) {
    cmd.env("CLAUDE_CONFIG_DIR", home);
    for k in ENV_REMOVE_KEYS {
        cmd.env_remove(k);
    }
}

/// Tauri command — start `claude auth login --claudeai` under the isolated
/// profile, streaming stdout/stderr lines to the UI via the `auth:login:line`
/// event. Single-flight: returns `Err("login already in progress")` if a prior
/// invocation hasn't completed.
#[tauri::command]
pub async fn profile_login(
    window: tauri::Window,
    state: tauri::State<'_, LoginState>,
    cli_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    let win = window.clone();
    let emit_line = move |stream: &str, line: &str| {
        let _ = win.emit(
            "auth:login:line",
            serde_json::json!({ "stream": stream, "line": line }),
        );
    };
    profile_login_at(emit_line, state.inner(), cli_path, None).await
}

/// Test-friendly variant — accepts an explicit base dir and an emitter
/// closure so unit tests can substitute a tempdir + a recording sink without
/// touching `dirs::data_dir()` or constructing a real `tauri::Window`.
pub async fn profile_login_at<F>(
    emit_line: F,
    state: &LoginState,
    cli_path: Option<String>,
    base: Option<&Path>,
) -> Result<(), String>
where
    F: Fn(&str, &str) + Send + Sync + Clone + 'static,
{
    let home = match base {
        Some(b) => bootstrap_profile_at(b)?,
        None => bootstrap_profile()?,
    };
    let cli = cli_or_default(cli_path);

    // Single-flight check — claim the slot before spawning so two parallel
    // login clicks can't both proceed.
    {
        let guard = state.lock().await;
        if guard.is_some() {
            return Err("login already in progress".to_string());
        }
    }

    let mut cmd = Command::new(&cli);
    cmd.arg("auth").arg("login").arg("--claudeai");
    configure_isolated_command(&mut cmd, &home);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn `{} auth login`: {e}", cli))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = state.lock().await;
        *guard = Some(child);
    }

    // Pump stdout in this task; spawn a sibling task for stderr so the user
    // sees both interleaved as they arrive.
    let stderr_handle = if let Some(err) = stderr {
        let emitter = emit_line.clone();
        Some(tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emitter("stderr", &line);
            }
        }))
    } else {
        None
    };

    if let Some(out) = stdout {
        let mut reader = BufReader::new(out).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_line("stdout", &line);
        }
    }

    if let Some(h) = stderr_handle {
        let _ = h.await;
    }

    // Wait for exit. Take the child out of the slot so a late
    // `profile_login_cancel` is a no-op rather than a double-kill.
    let mut child = {
        let mut guard = state.lock().await;
        match guard.take() {
            Some(c) => c,
            // Slot was cleared by `profile_login_cancel` while streams drained.
            None => return Err("auth login cancelled".to_string()),
        }
    };

    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait for auth login: {e}"))?;
    if !status.success() {
        return Err(format!("auth login exited with status {status}"));
    }
    Ok(())
}

/// Tauri command — kill the in-flight `claude auth login` child, if any.
/// Idempotent: a no-op when the slot is empty.
#[tauri::command]
pub async fn profile_login_cancel(state: tauri::State<'_, LoginState>) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(mut child) = guard.take() {
        // Best-effort kill; `kill_on_drop(true)` covers us if this races.
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    Ok(())
}

/// Tauri command — `claude auth logout` then strip `ANTHROPIC_API_KEY` from
/// `<claude-home>/settings.json`'s `env` block. Mirrors the read-modify-write
/// merge of [`profile_set_api_key`] so sibling keys (`hooks`, `disabledSkills`,
/// other env vars) are preserved. We do NOT touch `.claude.json` — the CLI
/// owns that file.
#[tauri::command]
pub async fn profile_logout(cli_path: Option<String>) -> Result<(), String> {
    profile_logout_at(cli_path, None).await
}

pub async fn profile_logout_at(
    cli_path: Option<String>,
    base: Option<&Path>,
) -> Result<(), String> {
    let home = match base {
        Some(b) => bootstrap_profile_at(b)?,
        None => bootstrap_profile()?,
    };
    let cli = cli_or_default(cli_path);

    let mut cmd = Command::new(&cli);
    cmd.arg("auth").arg("logout");
    configure_isolated_command(&mut cmd, &home);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn `{} auth logout`: {e}", cli))?;
    if !out.status.success() {
        // Don't fail hard — even if the CLI couldn't reach the server, we
        // still want to clear the local API key so the UI shows "signed out".
        eprintln!(
            "[profile] auth logout exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }

    strip_api_key_from_settings(&home)?;
    Ok(())
}

/// Read-modify-write `<home>/settings.json` removing only
/// `env.ANTHROPIC_API_KEY`. Preserves every sibling key.
fn strip_api_key_from_settings(home: &Path) -> Result<(), String> {
    use serde_json::{json, Value};
    let path = home.join("settings.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut root: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("checked");
    if let Some(env_val) = obj.get_mut("env") {
        if let Some(env_obj) = env_val.as_object_mut() {
            env_obj.remove("ANTHROPIC_API_KEY");
        }
    }
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write settings.json: {e}"))?;
    Ok(())
}

/// Tauri command — query `claude auth status --json` under the isolated
/// profile and translate it into the [`AuthStatus`] surface. On any CLI
/// failure (non-zero exit, JSON parse error) falls back to inspecting
/// `<claude-home>/settings.json` for an API key — an outdated CLI without
/// `auth status` should still let the UI render.
#[tauri::command]
pub async fn profile_auth_status(cli_path: Option<String>) -> Result<AuthStatus, String> {
    profile_auth_status_at(cli_path, None).await
}

pub async fn profile_auth_status_at(
    cli_path: Option<String>,
    base: Option<&Path>,
) -> Result<AuthStatus, String> {
    let home = match base {
        Some(b) => bootstrap_profile_at(b)?,
        None => bootstrap_profile()?,
    };
    let cli = cli_or_default(cli_path);

    let mut cmd = Command::new(&cli);
    cmd.arg("auth").arg("status").arg("--json");
    configure_isolated_command(&mut cmd, &home);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let api_key_present = settings_has_api_key(&home);

    let out = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return Ok(fallback_status(api_key_present)),
    };

    if !out.status.success() {
        return Ok(fallback_status(api_key_present));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: CliAuthStatus = match serde_json::from_str(stdout.trim()) {
        Ok(p) => p,
        Err(_) => return Ok(fallback_status(api_key_present)),
    };

    if parsed.logged_in {
        let account = parsed
            .email
            .or(parsed.account)
            .or(parsed.auth_method)
            .or(parsed.api_provider);
        Ok(AuthStatus {
            signed_in: true,
            mode: "oauth".into(),
            account,
        })
    } else {
        Ok(fallback_status(api_key_present))
    }
}

fn fallback_status(api_key_present: bool) -> AuthStatus {
    if api_key_present {
        AuthStatus {
            signed_in: true,
            mode: "apiKey".into(),
            account: None,
        }
    } else {
        AuthStatus {
            signed_in: false,
            mode: "none".into(),
            account: None,
        }
    }
}

fn settings_has_api_key(home: &Path) -> bool {
    let path = home.join("settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    val.get("env")
        .and_then(|e| e.get("ANTHROPIC_API_KEY"))
        .and_then(|k| k.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Wave 0 — write a user-supplied API key into `<claude-home>/settings.json`'s
/// `env` block so the CLI sees it on next spawn (without leaking via process
/// env vars when `env_remove` is applied). Read-modify-write merge so existing
/// keys (`hooks`, `disabledSkills`) are preserved.
#[tauri::command]
pub fn profile_set_api_key(key: String) -> Result<(), String> {
    use serde_json::{json, Value};
    if key.trim().is_empty() {
        return Err("API key required".to_string());
    }
    let home = bootstrap_profile()?;
    let path = home.join("settings.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut root: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("checked");
    let env_entry = obj
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let env_obj = env_entry
        .as_object_mut()
        .ok_or_else(|| "settings.env is not an object".to_string())?;
    env_obj.insert("ANTHROPIC_API_KEY".into(), Value::String(key));
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write settings.json: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn profile_paths() -> Result<ProfilePaths, String> {
    let base =
        dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    let home = app_claude_home_at(&base);
    Ok(ProfilePaths {
        claude_home: home.to_string_lossy().to_string(),
        agents: agents_dir_at(&base).to_string_lossy().to_string(),
        skills: skills_dir_at(&base).to_string_lossy().to_string(),
        commands: commands_dir_at(&base).to_string_lossy().to_string(),
        plugins: plugins_dir_at(&base).to_string_lossy().to_string(),
        settings: settings_json_at(&base).to_string_lossy().to_string(),
        mcp: claude_dotjson_at(&base).to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// CLI connection test (W2-A General tab + FirstRun gate)
// ---------------------------------------------------------------------------

/// Tauri command — resolve the `claude` binary path, spawn `<cli> --version`,
/// and return the trimmed version string.
///
/// Used by `FirstRun.tsx` and `SettingsPanel.tsx` to confirm the CLI is
/// reachable before showing the main workspace.
///
/// * Resolves via `resolve_cli_path_inner` (override → which → ~/.local/bin → ~/.claude/local).
/// * Sets `CLAUDE_CONFIG_DIR` to the isolated profile dir so the smoke test
///   exercises the same env shape as a real spawn.
/// * 5-second timeout; non-zero exit → `"CliRuntime: <first stderr line>"`.
/// * Not found → `"CliNotFound"`.
#[tauri::command]
pub async fn claude_test_connection(
    cli_path_override: Option<String>,
) -> Result<String, String> {
    let cli_path = resolve_cli_path_inner(
        cli_path_override.as_deref(),
        dirs::home_dir(),
        /*use_which=*/ true,
    )
    .await?;

    let claude_home = app_claude_home().ok();
    let mut cmd = Command::new(&cli_path);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for k in ENV_REMOVE_KEYS {
        cmd.env_remove(k);
    }
    if let Some(ref h) = claude_home {
        cmd.env("CLAUDE_CONFIG_DIR", h);
    }

    let out = match timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(format!("CliRuntime: spawn claude --version: {e}"));
        }
        Err(_) => {
            return Err("CliRuntime: timeout".to_string());
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let first = stderr.lines().next().unwrap_or("").trim().to_string();
        return Err(format!("CliRuntime: {first}"));
    }

    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(version)
}

/// Top-level data root: `<dirs::data_dir>/autoplot/`.
pub fn data_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    Ok(base.join("autoplot"))
}

/// `<dirs::data_dir>/autoplot/claude-home/`.
pub fn app_claude_home() -> Result<PathBuf, String> {
    Ok(data_root()?.join("claude-home"))
}

/// Test-friendly variant — takes the base dir directly so unit tests can
/// substitute a tempdir and never poke `~/.claude`.
pub fn app_claude_home_at(base: &Path) -> PathBuf {
    base.join("autoplot").join("claude-home")
}

/// Path to the app-managed `settings.json` at `<claude-home>/settings.json`.
pub fn settings_json_at(base: &Path) -> PathBuf {
    app_claude_home_at(base).join("settings.json")
}

/// Path to the CLI-managed `<claude-home>/.claude.json`. We pre-seed this file
/// as `{"mcpServers":{}}` in `bootstrap_profile_at` IFF it does not exist, so
/// `--strict-mcp-config --mcp-config <this path>` works on a clean install.
/// After creation the CLI owns all WRITES (it appends `firstStartTime`,
/// `migrationVersion`, telemetry IDs, project history, OAuth cache, …); we
/// never overwrite once the file exists.
pub fn claude_dotjson_at(base: &Path) -> PathBuf {
    app_claude_home_at(base).join(".claude.json")
}

pub fn agents_dir_at(base: &Path) -> PathBuf {
    app_claude_home_at(base).join("agents")
}

pub fn skills_dir_at(base: &Path) -> PathBuf {
    app_claude_home_at(base).join("skills")
}

pub fn commands_dir_at(base: &Path) -> PathBuf {
    app_claude_home_at(base).join("commands")
}

pub fn plugins_dir_at(base: &Path) -> PathBuf {
    app_claude_home_at(base).join("plugins")
}

/// Env-var keys that MUST be `env_remove`d on every `claude` subprocess spawn.
/// We never `env_clear()` — that strips macOS bootstrap vars (`__CFBundleIdentifier`,
/// `XPC_SERVICE_NAME`, `SSH_AUTH_SOCK`, `LC_*`, `TMPDIR`, `DYLD_*`, `NODE_*`)
/// and breaks Keychain reads, OAuth, locale, and JS-bundle shebangs.
pub const ENV_REMOVE_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// The two constant profile-isolation flags (and their value for
/// `--setting-sources`) that appear in every `claude` subprocess spawn,
/// regardless of whether a `claude_home` path is available.
///
/// Exposed as a constant so callers can extend their argv without inlining the
/// literal string `"--strict-mcp-config"` outside this module.
pub(crate) const ISOLATION_CONSTANT_FLAGS: [&str; 3] =
    ["--strict-mcp-config", "--setting-sources", "user"];

/// Returns the four belt-and-suspenders isolation flags for every `claude` CLI
/// spawn, using the supplied `claude_home` as the default path source:
///
///   1. `--strict-mcp-config` (constant)
///   2. `--setting-sources user` (constant)
///   3. `--mcp-config <data_root>/mcp.json` (omitted if `data_root()` fails)
///   4. `--settings <claude_home>/settings.json`
///
/// This helper returns the **default** paths.  Call-site overrides for
/// `--mcp-config` / `--settings` must be applied by the caller after (or
/// instead of) consuming this helper's output; see
/// `commands/ai.rs::build_argv_with_home`.
#[allow(dead_code)] // used by future commands/terminal.rs (Step 8)
pub(crate) fn isolation_flags(claude_home: &Path) -> Vec<String> {
    let mut flags: Vec<String> = ISOLATION_CONSTANT_FLAGS.iter().map(|s| s.to_string()).collect();

    // --mcp-config: points at <data_root>/mcp.json (not .claude.json, which
    // is the CLI profile/state file that lacks a `mcpServers` key).
    if let Ok(dr) = data_root() {
        flags.push("--mcp-config".into());
        flags.push(dr.join("mcp.json").to_string_lossy().to_string());
    }

    // --settings: points at <claude_home>/settings.json.
    flags.push("--settings".into());
    flags.push(claude_home.join("settings.json").to_string_lossy().to_string());

    flags
}

// ---------------------------------------------------------------------------
// CLI path resolution (override → which → ~/.local/bin → ~/.claude/local)
// ---------------------------------------------------------------------------
//
// Shared helper used by `commands/ai.rs` and (in future) `commands/terminal.rs`.
// Returned errors are `String` to match the `Result<_, String>` convention
// used throughout this module; callers in `ai.rs` convert to `AiError`.

/// Resolve the `claude` CLI binary path.
///
/// Search order:
/// 1. `override_path` — if supplied and the path exists, use it directly.
/// 2. `which claude` — host PATH search (skipped in unit tests via `use_which`).
/// 3. `~/.local/bin/claude`
/// 4. `~/.claude/local/claude`
///
/// Returns `Err("CliNotFound")` when none of the candidates exist.
pub(crate) async fn resolve_cli_path_inner(
    override_path: Option<&str>,
    home: Option<PathBuf>,
    use_which: bool,
) -> Result<PathBuf, String> {
    if let Some(p) = override_path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }

    if use_which {
        if let Ok(out) = Command::new("which").arg("claude").output().await {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if pb.exists() {
                        return Ok(pb);
                    }
                }
            }
        }
    }

    if let Some(home) = home {
        let p1 = home.join(".local/bin/claude");
        if p1.exists() {
            return Ok(p1);
        }
        let p2 = home.join(".claude/local/claude");
        if p2.exists() {
            return Ok(p2);
        }
    }

    Err("CliNotFound".to_string())
}

/// Bootstrap the isolated profile at `<base>/autoplot/claude-home/`:
/// * create the dir + the four required subdirs (`agents/skills/commands/plugins/`)
/// * pre-seed `settings.json` as `{}` if missing
/// * pre-seed `.claude.json` as `{"mcpServers":{}}` if missing — the CLI then
///   takes ownership of all subsequent writes (firstStartTime, migrationVersion,
///   telemetry IDs, …); we never overwrite once it exists. Without this seed,
///   spawning the CLI with `--strict-mcp-config --mcp-config <this file>` on a
///   clean install fails pre-stream with
///   `mcpServers: Invalid input: expected record, received undefined`.
///
/// Idempotent — safe to call on every app boot. The existence guard on each
/// seeded file means subsequent boots leave any CLI-written keys intact.
pub fn bootstrap_profile_at(base: &Path) -> Result<PathBuf, String> {
    let home = app_claude_home_at(base);
    std::fs::create_dir_all(&home).map_err(|e| format!("create claude-home: {e}"))?;

    for sub in ["agents", "skills", "commands", "plugins"] {
        let p = home.join(sub);
        std::fs::create_dir_all(&p).map_err(|e| format!("create {sub}: {e}"))?;
    }

    let settings = home.join("settings.json");
    if !settings.exists() {
        std::fs::write(&settings, b"{}\n").map_err(|e| format!("seed settings.json: {e}"))?;
    }

    let dotjson = home.join(".claude.json");
    if !dotjson.exists() {
        std::fs::write(&dotjson, b"{\"mcpServers\":{}}\n")
            .map_err(|e| format!("seed .claude.json: {e}"))?;
    }

    // Seed <data_root>/mcp.json so that `--mcp-config <data_root>/mcp.json`
    // passed to the CLI on first use finds a valid `{"mcpServers":{}}` file
    // rather than a missing path.  mcp.rs's `ensure_app_config_at` is lazy
    // (only runs when MCP commands are invoked), so we must pre-seed here.
    let data_root = base.join("autoplot");
    std::fs::create_dir_all(&data_root)
        .map_err(|e| format!("create autoplot data dir: {e}"))?;
    let mcp_json = data_root.join("mcp.json");
    if !mcp_json.exists() {
        std::fs::write(&mcp_json, b"{\n  \"mcpServers\": {}\n}\n")
            .map_err(|e| format!("seed mcp.json: {e}"))?;
    }

    Ok(home)
}

/// Production bootstrap — uses the OS data dir.
pub fn bootstrap_profile() -> Result<PathBuf, String> {
    let base =
        dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    bootstrap_profile_at(&base)
}

/// Detect-and-warn for legacy app-config fragments at `<data_dir>/autoplot/`.
/// Wave 0 explicitly does NOT migrate, move, or delete — just logs a single
/// `[legacy-profile]` line per detected path. Returns the list of detected
/// paths (for tests).
pub fn detect_legacy_fragments_at(base: &Path) -> Vec<PathBuf> {
    let root = base.join("autoplot");
    let mut found: Vec<PathBuf> = Vec::new();
    for rel in ["mcp.json", "settings.json", "commands"] {
        let p = root.join(rel);
        if p.exists() {
            found.push(p);
        }
    }
    found
}

/// Production legacy detector — emits one `eprintln!` per detected path so
/// the warning lands in the Tauri stderr log without nagging the UI.
pub fn detect_legacy_fragments_and_warn() {
    let Some(base) = dirs::data_dir() else {
        return;
    };
    for p in detect_legacy_fragments_at(&base) {
        eprintln!(
            "[legacy-profile] found pre-Wave-0 fragment at {}; left in place (no migration)",
            p.display()
        );
    }
}

// ---------------------------------------------------------------------------
// Step 7 — MCP sidecar auto-registration + profile asset seeding
// ---------------------------------------------------------------------------

/// Build the Claude-CLI-shaped JSON object for the `autoplot` MCP server
/// entry.  Extracted as a standalone pure function so unit tests can verify the
/// exact JSON shape without constructing a Tauri `AppHandle`.
///
/// ```json
/// {
///   "command": "<sidecar_path>",
///   "args": [],
///   "env": { "TRADING_PORTAL_MCP_TOKEN": "<token>" }
/// }
/// ```
// Called from tests and from upsert_sidecar_in_mcp_json doc tests.
#[allow(dead_code)]
pub(crate) fn build_sidecar_entry(sidecar_path: &str, token: &str) -> serde_json::Value {
    serde_json::json!({
        "command": sidecar_path,
        "args": [],
        "env": { "TRADING_PORTAL_MCP_TOKEN": token }
    })
}

/// Resolve the sidecar binary path for the current platform.
///
/// In a packaged build Tauri resolves `binaries/autoplot-mcp` via the
/// `externalBin` bundle entry and appends a `-<target-triple>` suffix.  In a
/// dev build the binary lives at `<workspace>/src-tauri/binaries/autoplot-mcp-<triple>`.
///
/// We probe both locations and return the first that exists.  If neither
/// exists (e.g. the binary hasn't been compiled yet) we return the
/// `AppHandle`-resolved path anyway — `mcp.json` will be upserted and the
/// sidecar path will be correct once the binary is present.
fn resolve_sidecar_path(app: &tauri::AppHandle) -> String {
    use tauri::Manager;
    // Tauri 2 resource resolution for external binaries.
    // The binary is registered in tauri.conf.json as "binaries/autoplot-mcp"
    // and Tauri appends the target triple at build time.
    let triple = std::env::consts::ARCH.to_string() + "-" + std::env::consts::OS;
    // Map common Rust target triples used by Tauri.
    let tauri_triple = match std::env::consts::OS {
        "macos" => format!("{}-apple-darwin", std::env::consts::ARCH),
        "linux" => format!("{}-unknown-linux-gnu", std::env::consts::ARCH),
        "windows" => format!("{}-pc-windows-msvc", std::env::consts::ARCH),
        other => format!("{}-{other}", std::env::consts::ARCH),
    };
    let bin_name = format!("autoplot-mcp-{tauri_triple}");

    // Try Tauri resource path first (packaged builds).
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("binaries").join(&bin_name);
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        // Also try without the binaries/ subdirectory (alternate bundle layout).
        let candidate2 = resource_dir.join(&bin_name);
        if candidate2.exists() {
            return candidate2.to_string_lossy().to_string();
        }
    }

    // Dev build fallback: look next to the src-tauri dir.
    // `CARGO_MANIFEST_DIR` is set at compile time; in a running binary we use
    // the executable's location to find the workspace root.
    if let Ok(exe) = std::env::current_exe() {
        // In dev mode the binary is at `src-tauri/target/debug/autoplot`.
        // Walk up to `src-tauri/` and look in `binaries/`.
        if let Some(target_dir) = exe.ancestors().find(|p| p.ends_with("target")) {
            if let Some(src_tauri) = target_dir.parent() {
                let candidate = src_tauri.join("binaries").join(&bin_name);
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
                // On macOS the exe may be in .app bundle — fall through.
            }
        }
    }

    // Last resort: return the name with triple suffix; Tauri will find it via
    // PATH or the bundle at runtime.  The mcp.json entry is still correct.
    let _ = triple; // suppress unused warning
    bin_name
}

/// Upsert the `autoplot` entry in `<data_root>/mcp.json` so the Claude
/// CLI can launch the MCP sidecar with the correct token on next invocation.
///
/// Uses the inner `upsert_into` helper from `commands/mcp.rs` directly so
/// this function can remain synchronous (no `async` needed).
///
/// # Idempotency
///
/// Safe to call on every app launch.  Each call overwrites the previous entry,
/// keeping the token and path up-to-date.
pub(crate) fn upsert_sidecar_in_mcp_json(
    app: &tauri::AppHandle,
    token: &str,
) -> Result<(), String> {
    let sidecar_path = resolve_sidecar_path(app);

    // Build the McpServer value for upsert_into.
    use crate::commands::mcp::McpServer;
    use std::collections::HashMap;

    let mut env_map = HashMap::new();
    env_map.insert("TRADING_PORTAL_MCP_TOKEN".to_string(), token.to_string());

    let server = McpServer {
        name: "autoplot".to_string(),
        transport: "stdio".to_string(),
        command: Some(sidecar_path),
        args: Some(vec![]),
        env: Some(env_map),
        url: None,
        source: "app".to_string(),
    };

    // Resolve the app config path and upsert.
    let base = dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    let mcp_path = base.join("autoplot").join("mcp.json");
    crate::commands::mcp::upsert_into(&mcp_path, &server)
}

/// Upsert the `tradingview` entry in `<data_root>/mcp.json` so the in-app
/// Claude CLI can launch the tradingview-mcp server (installed directly from
/// the GitHub fork via `uvx`). Idempotent; safe on every app launch.
pub(crate) fn upsert_tradingview_in_mcp_json() -> Result<(), String> {
    use crate::commands::mcp::McpServer;
    let server = McpServer {
        name: "tradingview".to_string(),
        transport: "stdio".to_string(),
        command: Some("uvx".to_string()),
        args: Some(vec![
            "--from".into(),
            "git+https://github.com/FIZZORY-TECH/tradingview-mcp.git".into(),
            "tradingview-mcp".into(),
        ]),
        env: None,
        url: None,
        source: "app".to_string(),
    };
    let base = dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    let mcp_path = base.join("autoplot").join("mcp.json");
    crate::commands::mcp::upsert_into(&mcp_path, &server)
}

/// Re-seed trigger version — **decoupled from `CARGO_PKG_VERSION`**.
///
/// `seed_profile_assets` overwrites shipped assets only when this string
/// differs from the value stored in `<claude_home>/.assets-version`.  Bump
/// this constant (e.g. "2" → "3") to force a re-seed on the next app launch
/// without having to touch `Cargo.toml`.  The value is intentionally a plain
/// integer string so collisions with semver version strings are impossible.
const PROFILE_ASSETS_VERSION: &str = "2";

/// Seed profile assets (slash commands + skills) from the bundled
/// `resources/profile-assets/` directory into `<claude_home>/`.
///
/// ## Version tracking
///
/// A `<claude_home>/.assets-version` file records the app version at which
/// assets were last seeded.  On a **same-version re-run** (normal app launch),
/// files that already exist at the destination are left unchanged — the CLI /
/// user owns subsequent edits.  On a **version bump** ALL shipped files are
/// overwritten unconditionally.
///
/// ### Known limitation
///
/// The version-bump path uses a simple "overwrite all" strategy rather than
/// a per-file hash manifest.  This means user edits to shipped files are lost
/// on upgrade.  The trade-off was chosen for implementation simplicity; a
/// future step can layer a `.assets-manifest.json` hash check on top without
/// changing the public signature.
///
/// ## Directory layout expected in `asset_resource_root`
///
/// ```text
/// <asset_resource_root>/
///   commands/
///     *.md          → copied to <claude_home>/commands/<name>.md
///   skills/
///     <skill-name>/
///       SKILL.md    → copied to <claude_home>/skills/<skill-name>/SKILL.md
/// ```
pub(crate) fn seed_profile_assets(
    claude_home: &Path,
    app_version: &str,
    asset_resource_root: &Path,
) -> std::io::Result<()> {
    let version_file = claude_home.join(".assets-version");

    // Determine whether this is a first-run, same-version re-run, or version bump.
    let existing_version = std::fs::read_to_string(&version_file)
        .ok()
        .map(|s| s.trim().to_string());

    let version_bumped = match &existing_version {
        None => false,          // first run — no overwrite, just copy-if-missing
        Some(v) => v != app_version, // bump → overwrite all
    };
    let first_run = existing_version.is_none();

    // --- Commands ----------------------------------------------------------
    let src_commands = asset_resource_root.join("commands");
    let dst_commands = claude_home.join("commands");
    std::fs::create_dir_all(&dst_commands)?;

    if src_commands.is_dir() {
        for entry in std::fs::read_dir(&src_commands)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let file_name = path.file_name().expect("has file name");
                let dst = dst_commands.join(file_name);
                if first_run && dst.exists() {
                    // Same-version first install but file already there — skip.
                    continue;
                }
                if !version_bumped && dst.exists() {
                    // Same version, file exists — leave the user's copy intact.
                    continue;
                }
                std::fs::copy(&path, &dst)?;
            }
        }
    }

    // --- Skills ------------------------------------------------------------
    let src_skills = asset_resource_root.join("skills");
    let dst_skills = claude_home.join("skills");
    std::fs::create_dir_all(&dst_skills)?;

    if src_skills.is_dir() {
        for entry in std::fs::read_dir(&src_skills)? {
            let entry = entry?;
            let skill_dir = entry.path();
            if !skill_dir.is_dir() {
                continue;
            }
            let skill_name = skill_dir.file_name().expect("has name");
            let dst_skill_dir = dst_skills.join(skill_name);
            std::fs::create_dir_all(&dst_skill_dir)?;

            let skill_md = skill_dir.join("SKILL.md");
            if skill_md.exists() {
                let dst = dst_skill_dir.join("SKILL.md");
                if !version_bumped && dst.exists() {
                    // Same version — preserve existing.
                    continue;
                }
                std::fs::copy(&skill_md, &dst)?;
            }
        }
    }

    // Write / update the version marker.
    std::fs::write(&version_file, app_version)?;

    Ok(())
}

/// Run the Step-7 bootstrap extensions that require an `AppHandle`:
///
/// 1. Rotate the MCP bridge token and write it to `<claude_home>/mcp-bridge.token`.
/// 2. Upsert the `autoplot` entry in `<data_root>/mcp.json`.
/// 3. Seed profile assets from the bundled `resources/profile-assets/` directory.
///
/// Each step is **resilient**: failure of one logs a warning and does NOT abort
/// the others.  A missing sidecar binary in dev mode will not brick the launch.
///
/// Returns the generated token so the caller can pass it directly to the IPC
/// bridge (avoiding a second rotation).
pub(crate) fn bootstrap_profile_extensions(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let claude_home = match app_claude_home() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[profile] bootstrap_profile_extensions: cannot resolve claude_home: {e}");
            return None;
        }
    };

    // Step 1 — rotate token.
    let token = match crate::ipc_bridge::rotate_token(&claude_home) {
        Ok(t) => {
            eprintln!("[profile] MCP bridge token rotated");
            t
        }
        Err(e) => {
            eprintln!("[profile] WARNING: rotate_token failed: {e}");
            return None;
        }
    };

    // Step 2 — upsert sidecar in mcp.json.
    if let Err(e) = upsert_sidecar_in_mcp_json(app, &token) {
        eprintln!("[profile] WARNING: upsert_sidecar_in_mcp_json failed: {e}");
        // Continue — a failed upsert doesn't block the bridge from starting.
    }

    // Step 2b — upsert tradingview-mcp in mcp.json.
    if let Err(e) = upsert_tradingview_in_mcp_json() {
        eprintln!("[profile] WARNING: upsert_tradingview_in_mcp_json failed: {e}");
    }

    // Step 3 — seed profile assets.
    let asset_root = match app.path().resource_dir() {
        Ok(r) => r.join("resources").join("profile-assets"),
        Err(e) => {
            eprintln!("[profile] WARNING: cannot resolve resource_dir for asset seeding: {e}");
            // Try an alternate path relative to the exe for dev builds.
            match std::env::current_exe()
                .ok()
                .and_then(|exe| exe.ancestors()
                    .find(|p| p.ends_with("target"))
                    .and_then(|t| t.parent())
                    .map(|src_tauri| src_tauri.join("resources").join("profile-assets")))
            {
                Some(p) => p,
                None => {
                    eprintln!("[profile] WARNING: fallback asset root resolution failed too: {e}");
                    return Some(token);
                }
            }
        }
    };

    if let Err(e) = seed_profile_assets(&claude_home, PROFILE_ASSETS_VERSION, &asset_root) {
        eprintln!("[profile] WARNING: seed_profile_assets failed: {e}");
        // Non-fatal — assets can be re-seeded on next launch.
    } else {
        eprintln!(
            "[profile] profile assets seeded from {}",
            asset_root.display()
        );
    }

    Some(token)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    fn scratch(label: &str) -> PathBuf {
        let dir = env::temp_dir()
            .join(format!("tp-profile-{}-{}", label, Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn bootstrap_creates_layout_and_seeds_settings() {
        let base = scratch("bootstrap");
        let home = bootstrap_profile_at(&base).expect("bootstrap");
        assert!(home.ends_with("autoplot/claude-home"));
        for sub in ["agents", "skills", "commands", "plugins"] {
            assert!(home.join(sub).is_dir(), "missing {sub}");
        }
        let settings = std::fs::read_to_string(home.join("settings.json")).unwrap();
        assert_eq!(settings.trim(), "{}");
        // .claude.json IS pre-seeded so `--strict-mcp-config --mcp-config <path>`
        // doesn't fail pre-stream on a clean install. The CLI takes ownership
        // of subsequent writes; we just guarantee the file exists with a valid
        // (empty) `mcpServers` map.
        let dotjson = std::fs::read_to_string(home.join(".claude.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&dotjson).expect("valid JSON");
        assert_eq!(parsed["mcpServers"], serde_json::json!({}));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn bootstrap_idempotent() {
        let base = scratch("bootstrap-idem");
        let home = bootstrap_profile_at(&base).expect("first");
        std::fs::write(home.join("settings.json"), r#"{"x":1}"#).unwrap();
        let _ = bootstrap_profile_at(&base).expect("second");
        let after = std::fs::read_to_string(home.join("settings.json")).unwrap();
        assert!(
            after.contains(r#""x":1"#),
            "second bootstrap must not clobber existing settings"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn bootstrap_does_not_overwrite_existing_dotjson() {
        // Simulates the CLI having already taken ownership of `.claude.json`
        // and written its own keys (firstStartTime, OAuth cache, …). A second
        // bootstrap pass MUST leave those keys untouched.
        let base = scratch("bootstrap-dotjson-idem");
        let home = bootstrap_profile_at(&base).expect("first");
        let cli_written = r#"{"mcpServers":{"brave":{"command":"npx"}},"firstStartTime":"2026-05-10T00:00:00Z","migrationVersion":3}"#;
        std::fs::write(home.join(".claude.json"), cli_written).unwrap();
        let _ = bootstrap_profile_at(&base).expect("second");
        let after = std::fs::read_to_string(home.join(".claude.json")).unwrap();
        assert!(after.contains("firstStartTime"), "CLI-written keys must survive");
        assert!(after.contains("migrationVersion"), "CLI-written keys must survive");
        assert!(after.contains("brave"), "CLI-written mcpServers must survive");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn detect_legacy_returns_empty_for_clean_base() {
        let base = scratch("legacy-clean");
        assert!(detect_legacy_fragments_at(&base).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn detect_legacy_finds_known_fragments() {
        let base = scratch("legacy-found");
        let root = base.join("autoplot");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("mcp.json"), "{}").unwrap();
        std::fs::write(root.join("settings.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("commands")).unwrap();
        let found = detect_legacy_fragments_at(&base);
        assert_eq!(found.len(), 3);
        std::fs::remove_dir_all(&base).ok();
    }

    // ----------------------------------------------------------------
    // Auth-flow commands — driven via a tiny shell-script `claude` stub so
    // tests don't need a real CLI binary on the PATH.
    // ----------------------------------------------------------------

    /// Write an executable shell script and return its path. The script body
    /// runs verbatim; `$@` is the args the caller passed (e.g. `auth status
    /// --json`). Caller is responsible for the dispatch via a `case`.
    fn write_stub_cli(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("claude-stub.sh");
        std::fs::write(&path, body).expect("write stub");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
        path
    }

    /// Stub that succeeds for every `auth` subcommand and prints a canned
    /// JSON for `auth status --json`.
    fn stub_success_with_status(status_json: &str) -> String {
        format!(
            "#!/bin/sh\ncase \"$1\" in\n  auth)\n    case \"$2\" in\n      status) printf '%s' '{json}'; exit 0 ;;\n      logout) exit 0 ;;\n      login)  exit 0 ;;\n      *)      exit 0 ;;\n    esac ;;\n  *) exit 0 ;;\nesac\n",
            json = status_json.replace('\'', "'\\''")
        )
    }

    #[tokio::test]
    async fn profile_logout_strips_api_key_preserves_siblings() {
        let base = scratch("logout-strip");
        let home = bootstrap_profile_at(&base).expect("bootstrap");
        // Pre-write settings.json with the key + sibling keys we expect to
        // survive.
        let pre = r#"{"env":{"ANTHROPIC_API_KEY":"sk-foo","OTHER":"keep"},"hooks":{"x":1}}"#;
        std::fs::write(home.join("settings.json"), pre).unwrap();

        let stub = write_stub_cli(&base, &stub_success_with_status(r#"{"loggedIn":false}"#));
        profile_logout_at(Some(stub.to_string_lossy().to_string()), Some(&base))
            .await
            .expect("logout ok");

        let after_raw = std::fs::read_to_string(home.join("settings.json")).unwrap();
        let after: serde_json::Value = serde_json::from_str(&after_raw).unwrap();
        assert!(
            after["env"].get("ANTHROPIC_API_KEY").is_none(),
            "ANTHROPIC_API_KEY should be removed; got: {after_raw}"
        );
        assert_eq!(after["env"]["OTHER"], serde_json::json!("keep"));
        assert_eq!(after["hooks"]["x"], serde_json::json!(1));
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn profile_auth_status_oauth() {
        let base = scratch("auth-status-oauth");
        bootstrap_profile_at(&base).unwrap();
        let stub = write_stub_cli(
            &base,
            &stub_success_with_status(r#"{"loggedIn":true,"authMethod":"claudeai"}"#),
        );
        let st = profile_auth_status_at(Some(stub.to_string_lossy().to_string()), Some(&base))
            .await
            .expect("status ok");
        assert!(st.signed_in);
        assert_eq!(st.mode, "oauth");
        assert_eq!(st.account.as_deref(), Some("claudeai"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn profile_auth_status_apikey_fallback() {
        let base = scratch("auth-status-apikey");
        let home = bootstrap_profile_at(&base).unwrap();
        std::fs::write(
            home.join("settings.json"),
            r#"{"env":{"ANTHROPIC_API_KEY":"sk-x"}}"#,
        )
        .unwrap();
        let stub = write_stub_cli(&base, &stub_success_with_status(r#"{"loggedIn":false}"#));
        let st = profile_auth_status_at(Some(stub.to_string_lossy().to_string()), Some(&base))
            .await
            .expect("status ok");
        assert!(st.signed_in);
        assert_eq!(st.mode, "apiKey");
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn profile_auth_status_none() {
        let base = scratch("auth-status-none");
        bootstrap_profile_at(&base).unwrap();
        let stub = write_stub_cli(&base, &stub_success_with_status(r#"{"loggedIn":false}"#));
        let st = profile_auth_status_at(Some(stub.to_string_lossy().to_string()), Some(&base))
            .await
            .expect("status ok");
        assert!(!st.signed_in);
        assert_eq!(st.mode, "none");
        assert!(st.account.is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn profile_auth_status_cli_failure_fallback() {
        // Stub exits non-zero for `auth status`; falls back to the API-key
        // file check so an outdated CLI without the subcommand still lets
        // the UI render.
        let base = scratch("auth-status-fail");
        let home = bootstrap_profile_at(&base).unwrap();
        std::fs::write(
            home.join("settings.json"),
            r#"{"env":{"ANTHROPIC_API_KEY":"sk-y"}}"#,
        )
        .unwrap();
        let body = "#!/bin/sh\necho 'unknown subcommand: status' >&2\nexit 2\n";
        let stub = write_stub_cli(&base, body);
        let st = profile_auth_status_at(Some(stub.to_string_lossy().to_string()), Some(&base))
            .await
            .expect("graceful fallback");
        assert!(st.signed_in);
        assert_eq!(st.mode, "apiKey");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn paths_compose_under_claude_home() {
        let base = scratch("paths");
        assert!(settings_json_at(&base).ends_with("claude-home/settings.json"));
        assert!(claude_dotjson_at(&base).ends_with("claude-home/.claude.json"));
        assert!(agents_dir_at(&base).ends_with("claude-home/agents"));
        assert!(skills_dir_at(&base).ends_with("claude-home/skills"));
        assert!(commands_dir_at(&base).ends_with("claude-home/commands"));
        assert!(plugins_dir_at(&base).ends_with("claude-home/plugins"));
        std::fs::remove_dir_all(&base).ok();
    }

    // ----------------------------------------------------------------
    // Step 7 — build_sidecar_entry unit tests
    // ----------------------------------------------------------------

    #[test]
    fn build_sidecar_entry_exact_shape() {
        let entry = build_sidecar_entry("/usr/local/bin/autoplot-mcp", "deadbeef");
        assert_eq!(entry["command"], serde_json::json!("/usr/local/bin/autoplot-mcp"));
        assert_eq!(entry["args"], serde_json::json!([]));
        assert_eq!(
            entry["env"]["TRADING_PORTAL_MCP_TOKEN"],
            serde_json::json!("deadbeef")
        );
        // No extra top-level keys beyond command/args/env.
        let obj = entry.as_object().unwrap();
        assert_eq!(obj.len(), 3, "only command, args, env should be present");
    }

    // ----------------------------------------------------------------
    // Step 7 — seed_profile_assets tests
    // ----------------------------------------------------------------

    /// Build a minimal asset root with one command file and one skill.
    fn make_asset_root(base: &Path) -> PathBuf {
        let root = base.join("profile-assets");
        let cmd_dir = root.join("commands");
        let skill_dir = root.join("skills").join("my-skill");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(cmd_dir.join("test-cmd.md"), "# test command").unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# test skill").unwrap();
        root
    }

    #[test]
    fn seed_profile_assets_first_run_copies_files() {
        let base = scratch("seed-first-run");
        let home = base.join("claude-home");
        std::fs::create_dir_all(&home).unwrap();

        let asset_root = make_asset_root(&base);
        seed_profile_assets(&home, "0.1.0", &asset_root).expect("seed ok");

        assert!(
            home.join("commands/test-cmd.md").exists(),
            "command file should be copied"
        );
        assert!(
            home.join("skills/my-skill/SKILL.md").exists(),
            "skill SKILL.md should be copied"
        );
        let ver = std::fs::read_to_string(home.join(".assets-version")).unwrap();
        assert_eq!(ver.trim(), "0.1.0");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn seed_profile_assets_idempotent() {
        let base = scratch("seed-idempotent");
        let home = base.join("claude-home");
        std::fs::create_dir_all(&home).unwrap();

        let asset_root = make_asset_root(&base);
        seed_profile_assets(&home, "0.1.0", &asset_root).expect("first seed");
        // Second call — same version; should return early without changing anything.
        let ver_before = std::fs::read_to_string(home.join(".assets-version")).unwrap();
        seed_profile_assets(&home, "0.1.0", &asset_root).expect("second seed");
        let ver_after = std::fs::read_to_string(home.join(".assets-version")).unwrap();
        assert_eq!(ver_before.trim(), ver_after.trim(), "version unchanged on second call");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn seed_profile_assets_preserves_user_edits_same_version() {
        let base = scratch("seed-preserve");
        let home = base.join("claude-home");
        std::fs::create_dir_all(home.join("commands")).unwrap();

        let asset_root = make_asset_root(&base);
        // Pre-create the destination with user-edited content.
        std::fs::write(home.join("commands/test-cmd.md"), "user edited content").unwrap();
        // Write the version file so it's a same-version run.
        std::fs::write(home.join(".assets-version"), "0.1.0").unwrap();

        seed_profile_assets(&home, "0.1.0", &asset_root).expect("seed");

        // User's content must be preserved.
        let content = std::fs::read_to_string(home.join("commands/test-cmd.md")).unwrap();
        assert_eq!(content, "user edited content", "user edits must survive same-version seed");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn seed_profile_assets_version_bump_overwrites() {
        let base = scratch("seed-bump");
        let home = base.join("claude-home");
        std::fs::create_dir_all(home.join("commands")).unwrap();

        let asset_root = make_asset_root(&base);
        // Simulate a previous seed at version 0.0.9.
        std::fs::write(home.join("commands/test-cmd.md"), "old content").unwrap();
        std::fs::write(home.join(".assets-version"), "0.0.9").unwrap();

        // Seed with bumped version → should overwrite.
        seed_profile_assets(&home, "0.1.0", &asset_root).expect("seed bumped");

        let content = std::fs::read_to_string(home.join("commands/test-cmd.md")).unwrap();
        assert_eq!(
            content.trim(),
            "# test command",
            "version bump must overwrite shipped file"
        );
        let ver = std::fs::read_to_string(home.join(".assets-version")).unwrap();
        assert_eq!(ver.trim(), "0.1.0");

        std::fs::remove_dir_all(&base).ok();
    }
}
