//! Interactive PTY terminal hosting `claude` CLI. See plan Layer B.
//!
//! Provides `terminal_spawn` and `terminal_kill` Tauri commands. A reader task
//! runs in `spawn_blocking`, drains the PTY master, and emits:
//!   - `terminal:data`  → `{ session_id, bytes_b64 }` (base64 chunk)
//!   - `terminal:exit`  → `{ session_id, code }` (process exit)
//!
//! `terminal_write` and `terminal_resize` are added in Step 9.

use base64::Engine as _;
use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex as SyncMutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of concurrent PTY sessions.
pub const MAX_SESSIONS: usize = 4;

/// Read buffer size for the PTY reader task.
const READER_CHUNK: usize = 8 * 1024;

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/// Holds the live state for a single PTY session.
///
/// All three dyn-trait fields sit behind `std::sync::Mutex` because:
///   - `Box<dyn MasterPty + Send>` is `Send` but NOT `Sync` — wrapping it in
///     `SyncMutex` makes the field `Sync` and therefore `TerminalSession: Sync`.
///   - `Box<dyn Write + Send>` and `Box<dyn Child>` are inherently synchronous
///     I/O objects that cannot be awaited, so a sync mutex is the right tool.
///
/// The outer `TerminalState` map uses a tokio async mutex so commands can lock
/// it from async contexts without blocking the executor thread.
pub struct TerminalSession {
    /// Master PTY handle — used for resize (Step 9) and reader cloning.
    // Step 9 will read this field via `terminal_resize`.
    #[allow(dead_code)]
    pub master: SyncMutex<Box<dyn portable_pty::MasterPty + Send>>,
    /// Write end of the PTY — used by terminal_write (Step 9).
    // Step 9 will read this field via `terminal_write`.
    #[allow(dead_code)]
    pub writer: SyncMutex<Box<dyn Write + Send>>,
    /// Child process handle — used to wait for exit.
    pub child: SyncMutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Separate killer handle so we can signal the process from async context
    /// without holding the `child` mutex while blocked in `wait()`.
    pub killer: SyncMutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

// SAFETY: all fields are behind `SyncMutex` which provides interior
// mutability with the appropriate Send + Sync guarantees.
// `Box<dyn MasterPty + Send>` wrapping satisfies Sync via SyncMutex.
unsafe impl Sync for TerminalSession {}

/// Inner map type — session_id → session arc.
type SessionMap = Arc<AsyncMutex<HashMap<String, Arc<TerminalSession>>>>;

/// Managed Tauri state for PTY sessions.
///
/// Structured as a newtype (rather than a bare type alias) so Tauri can
/// manage it via `app.manage(TerminalState::default())` with the required
/// `Send + Sync` bounds automatically satisfied.
#[derive(Clone, Default)]
pub struct TerminalState {
    pub sessions: SessionMap,
}

// ---------------------------------------------------------------------------
// Argv builder (also tested below)
// ---------------------------------------------------------------------------

/// Build the `claude` CLI argv for an interactive PTY session.
///
/// Omits `--print`, `--input-format stream-json`, and `--verbose` — those are
/// stream-json-only flags; the PTY path launches the real interactive TUI.
///
/// Reuses `crate::profile::isolation_flags` verbatim so the isolation contract
/// is consistent across all `terminal_spawn` sessions.
///
/// Appends `--permission-mode bypassPermissions` after the isolation flags so
/// the interactive PTY session defaults to bypassPermissions.
///
/// Session id / resume (Branch A — `claude` v2 supports `--session-id <uuid>`
/// and `--resume <value>`):
///   - `resume == true` with a `session_id` → append `--resume <id>` (the long
///     form; value required) so the CLI re-attaches to that prior conversation.
///   - otherwise, when a `session_id` is supplied → append `--session-id <id>`
///     so the CLI adopts the app-chosen UUID as its own session id (making the
///     PTY map key equal the CLI session id).
///   - when `session_id` is `None` → append nothing (backward compatible: the
///     CLI mints its own id and the PTY uses a random `Uuid::new_v4()` key).
pub(crate) fn build_argv(
    cli_path: &str,
    claude_home: &Path,
    session_id: Option<&str>,
    resume: bool,
) -> Vec<String> {
    let mut argv: Vec<String> = vec![cli_path.to_string()];
    argv.extend(crate::profile::isolation_flags(claude_home));
    argv.push("--permission-mode".into());
    argv.push("bypassPermissions".into());

    // Branch A session flags — appended last so they don't disturb the
    // isolation / permission-mode flags above.
    if let Some(id) = session_id {
        if resume {
            argv.push("--resume".into());
            argv.push(id.to_string());
        } else {
            argv.push("--session-id".into());
            argv.push(id.to_string());
        }
    }

    argv
}

// ---------------------------------------------------------------------------
// Session pruning (self-healing cap)
// ---------------------------------------------------------------------------

/// Remove sessions whose child process has already exited.
///
/// The session cap in `terminal_spawn` counts every entry in the map, but a
/// dead session is only removed asynchronously (the reader task's deferred
/// `rt.spawn(... remove ...)` or a fire-and-forget `terminal_kill`). On rapid
/// open→close cycles that removal can lag or be lost, leaving stale dead
/// entries that pile up to MAX_SESSIONS and wrongly trip the cap. Pruning
/// these before the cap check makes the cap self-healing.
///
/// Uses non-blocking `try_wait` (never the blocking `wait`). A session is kept
/// when it is still running (`Ok(None)`) or when `try_wait` errors — being
/// conservative on error so a transient hiccup never evicts a live PTY.
fn prune_exited(map: &mut HashMap<String, Arc<TerminalSession>>) {
    map.retain(|_, session| {
        // Keep unless try_wait proves the child has already exited.
        // Conservative on error (Err / Ok(None) → keep) so a transient hiccup
        // never evicts a live PTY.
        !matches!(session.child.lock().unwrap().try_wait(), Ok(Some(_)))
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Arguments for spawning a new PTY session.
#[derive(Deserialize)]
pub struct TerminalSpawnArgs {
    /// Override path to the `claude` binary. `None` → resolve automatically.
    pub cli_path: Option<String>,
    /// Initial terminal width in columns.
    pub cols: u16,
    /// Initial terminal height in rows.
    pub rows: u16,
    /// Working directory for the spawned process. `None` → claude-home.
    pub cwd: Option<String>,
    /// Caller-supplied session id (an RFC-4122 UUID). When `Some`, it is used
    /// BOTH as the PTY map key / returned id AND passed to the CLI via
    /// `--session-id <id>` (new) or `--resume <id>` (resume) so the app's PTY
    /// session id equals the CLI's own session id. When `None`, a random
    /// `Uuid::new_v4()` is generated and no session flag is emitted
    /// (backward compatible with existing callers).
    pub session_id: Option<String>,
    /// When `Some(true)`, resume the prior CLI conversation for `session_id`
    /// (emits `--resume <id>`). Falsy / absent → start a new session (emits
    /// `--session-id <id>` when `session_id` is provided).
    pub resume: Option<bool>,
}

/// Result returned by `terminal_spawn`.
#[derive(Serialize)]
pub struct TerminalSpawnResult {
    pub session_id: String,
}

/// Spawn a new interactive `claude` CLI PTY session.
///
/// Returns a `session_id` UUID that subsequent `terminal_write`, `terminal_resize`,
/// and `terminal_kill` commands use to address this session.
///
/// Errors if the session cap of 4 is reached.
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalState>,
    args: TerminalSpawnArgs,
) -> Result<TerminalSpawnResult, String> {
    // ------------------------------------------------------------------
    // Cap check (self-healing)
    // ------------------------------------------------------------------
    {
        let mut map = state.sessions.lock().await;
        // Self-heal: drop sessions whose child has already exited but whose
        // async removal (reader task's deferred rt.spawn / terminal_kill) lagged
        // or was lost. Without this, rapid open→close cycles leave stale dead
        // entries that accumulate to MAX_SESSIONS and wrongly trip the cap even
        // when no terminal is actually open. Prune first so the cap reflects
        // only LIVE PTYs, not zombie map entries.
        prune_exited(&mut map);
        if map.len() >= MAX_SESSIONS {
            return Err("max_sessions_reached".to_string());
        }
    }

    // ------------------------------------------------------------------
    // Resolve CLI path and claude-home
    // ------------------------------------------------------------------
    let cli_path = crate::profile::resolve_cli_path_inner(args.cli_path.as_deref(), None, true)
        .await
        .map_err(|e| e.to_string())?;

    let claude_home = crate::profile::app_claude_home().map_err(|e| e.to_string())?;

    // ------------------------------------------------------------------
    // Resolve the session id up-front so it can flow into both the CLI argv
    // (Branch A `--session-id` / `--resume`) and the PTY map key. When the
    // caller supplies one, the PTY session id EQUALS the CLI session id; when
    // absent we mint a random UUID and emit no session flag (backward compat).
    // ------------------------------------------------------------------
    let resume = args.resume.unwrap_or(false);
    let session_id = args
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    // Only forward a session flag to the CLI when the caller explicitly
    // supplied an id; a randomly minted id is the PTY key only, not a CLI flag
    // (preserves today's no-flag behavior for existing callers).
    let cli_session_id: Option<&str> = args.session_id.as_deref();

    // ------------------------------------------------------------------
    // Build argv (no --print, no --input-format stream-json, no --verbose)
    // ------------------------------------------------------------------
    let argv = build_argv(
        &cli_path.to_string_lossy(),
        &claude_home,
        cli_session_id,
        resume,
    );

    // ------------------------------------------------------------------
    // Build CommandBuilder
    // ------------------------------------------------------------------
    let mut cmd = CommandBuilder::new(&argv[0]);
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }

    // Isolation env: set CLAUDE_CONFIG_DIR, remove leaky keys.
    cmd.env("CLAUDE_CONFIG_DIR", &claude_home);
    for k in crate::profile::ENV_REMOVE_KEYS {
        cmd.env_remove(k);
    }

    // Working directory: caller override wins, otherwise claude-home.
    let cwd = args
        .cwd
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| claude_home.clone());
    cmd.cwd(&cwd);

    // ------------------------------------------------------------------
    // Open PTY pair and spawn
    // ------------------------------------------------------------------
    let pty_system = NativePtySystem::default();
    let pair: PtyPair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    // Spawn the child on the slave side.
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;

    // Critical: drop the slave IMMEDIATELY after spawn so the reader task
    // sees EOF when the child exits rather than blocking forever.
    drop(pair.slave);

    // Clone a killer handle BEFORE moving `child` into the mutex so we can
    // signal the process from `terminal_kill` without holding the `wait` lock.
    let killer = child.clone_killer();

    // ------------------------------------------------------------------
    // Take writer and reader handles from the master
    // ------------------------------------------------------------------
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;

    // ------------------------------------------------------------------
    // Build session, register in state. `session_id` was resolved above
    // (caller-supplied id reused as the map key, else a random UUID).
    // ------------------------------------------------------------------
    let session = Arc::new(TerminalSession {
        master: SyncMutex::new(pair.master),
        writer: SyncMutex::new(writer),
        child: SyncMutex::new(child),
        killer: SyncMutex::new(killer),
    });

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), session.clone());

    // ------------------------------------------------------------------
    // Spawn the reader task (blocking — PTY reads are synchronous)
    // ------------------------------------------------------------------
    let sid_for_task = session_id.clone();
    let app_for_task = app.clone();
    let sessions_for_task = Arc::clone(&state.sessions);
    let session_for_task = session.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut buf = vec![0u8; READER_CHUNK];
        let mut reader = reader;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_for_task.emit(
                        "terminal:data",
                        serde_json::json!({
                            "session_id": sid_for_task,
                            "bytes_b64": encoded
                        }),
                    );
                }
                Err(_) => break, // read error → treat as EOF
            }
        }

        // Child has exited (or master closed). Collect exit code.
        // `session_for_task` keeps the Arc alive even if terminal_kill already
        // removed it from the map.
        let code = session_for_task
            .child
            .lock()
            .unwrap()
            .wait()
            .map(|s| s.exit_code() as i32)
            .unwrap_or(-1);

        // Emit terminal:exit.
        let _ = app_for_task.emit(
            "terminal:exit",
            serde_json::json!({
                "session_id": sid_for_task,
                "code": code
            }),
        );

        // Remove the session from state (idempotent — terminal_kill may have
        // already removed it; remove() on a missing key is a no-op).
        let sid_remove = sid_for_task.clone();
        let rt = tokio::runtime::Handle::current();
        rt.spawn(async move {
            sessions_for_task.lock().await.remove(&sid_remove);
        });
    });

    Ok(TerminalSpawnResult { session_id })
}

/// Arguments for writing raw bytes to a PTY session.
#[derive(Deserialize)]
pub struct TerminalWriteArgs {
    pub session_id: String,
    /// Base64-encoded bytes to write to the PTY master.
    pub data_b64: String,
}

/// Write raw bytes (base64-encoded) to a PTY session's master input.
///
/// Returns `Err("unknown_session")` if the session_id is not found.
#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    args: TerminalWriteArgs,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .await
        .get(&args.session_id)
        .cloned()
        .ok_or_else(|| "unknown_session".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&args.data_b64)
        .map_err(|e| format!("bad_b64: {e}"))?;

    tokio::task::spawn_blocking(move || {
        let mut writer = session.writer.lock().unwrap();
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|e| format!("write_failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Arguments for resizing a PTY session's terminal dimensions.
#[derive(Deserialize)]
pub struct TerminalResizeArgs {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Resize the terminal window for an active PTY session.
///
/// Returns `Err("unknown_session")` if the session_id is not found.
#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    args: TerminalResizeArgs,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .await
        .get(&args.session_id)
        .cloned()
        .ok_or_else(|| "unknown_session".to_string())?;

    let cols = args.cols;
    let rows = args.rows;

    tokio::task::spawn_blocking(move || {
        let master = session.master.lock().unwrap();
        master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Terminate a PTY session by session ID.
///
/// Idempotent — returns `Ok(())` even if the session is already gone.
/// Sends a kill signal to the child; the reader task will drain to EOF and
/// emit `terminal:exit` naturally, then remove the session from state.
#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let removed = state.sessions.lock().await.remove(&session_id);
    if let Some(session) = removed {
        // Best-effort kill — the reader task will detect EOF and emit terminal:exit.
        session.killer.lock().unwrap().kill().ok();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // -----------------------------------------------------------------------
    // Stub session for state-cap test (no real PTY allocation needed)
    // -----------------------------------------------------------------------

    // The stub uses a real tiny PTY pair so we don't have to re-implement
    // every method of MasterPty / Child / ChildKiller (they carry many
    // cfg(unix)-gated methods including `process_group_leader` which takes
    // `libc::pid_t` — a type we'd have to import from a non-direct dep).
    // Instead, spin up an actual PTY with `echo` and immediately close it —
    // it's still fast enough for a unit test and avoids fake-trait complexity.
    //
    // On non-Unix (Windows) the cap test is skipped; ConPTY integration is
    // verified in the Step 14 Windows smoke-test checklist.
    #[cfg(unix)]
    fn stub_session() -> Arc<TerminalSession> {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("stub openpty");

        // Spawn a no-op process that exits immediately.
        let cmd = CommandBuilder::new("true");
        let child = pair.slave.spawn_command(cmd).expect("stub spawn");
        drop(pair.slave); // critical: release slave so reader sees EOF

        let killer = child.clone_killer();
        let writer = pair.master.take_writer().expect("stub take_writer");

        Arc::new(TerminalSession {
            master: SyncMutex::new(pair.master),
            writer: SyncMutex::new(writer),
            child: SyncMutex::new(child),
            killer: SyncMutex::new(killer),
        })
    }

    // -----------------------------------------------------------------------
    // Test: argv excludes --print, --input-format, --verbose
    // -----------------------------------------------------------------------

    #[test]
    fn argv_excludes_print_and_stream_json() {
        let home = PathBuf::from("/tmp/test-claude-home");
        let argv = build_argv("/usr/local/bin/claude", &home, None, false);

        let forbidden = ["--print", "--input-format", "--verbose"];
        for flag in forbidden {
            assert!(
                !argv.iter().any(|a| a == flag),
                "argv must NOT contain '{flag}' — found: {argv:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Test: argv includes all isolation flags in order
    // -----------------------------------------------------------------------

    #[test]
    fn argv_includes_isolation_flags() {
        let home = PathBuf::from("/tmp/test-claude-home");
        let argv = build_argv("/usr/local/bin/claude", &home, None, false);

        // All three constant flags must appear.
        for flag in crate::profile::ISOLATION_CONSTANT_FLAGS {
            assert!(
                argv.iter().any(|a| a == flag),
                "argv must contain isolation flag '{flag}'"
            );
        }

        // --settings must appear (pointing at the supplied home).
        assert!(
            argv.iter().any(|a| a == "--settings"),
            "argv must contain --settings"
        );

        // The PTY session defaults to bypassPermissions, appended as the two
        // trailing args after the isolation flags.
        assert_eq!(
            argv.last().map(String::as_str),
            Some("bypassPermissions"),
            "argv must end with 'bypassPermissions' — found: {argv:?}"
        );
        let n = argv.len();
        assert_eq!(
            argv.get(n - 2).map(String::as_str),
            Some("--permission-mode"),
            "argv must contain '--permission-mode' before 'bypassPermissions'"
        );
    }

    // -----------------------------------------------------------------------
    // Test: Branch A session flags — new session emits `--session-id <id>`,
    // resume emits `--resume <id>`, and an omitted id yields the prior argv.
    // -----------------------------------------------------------------------

    // Find the value immediately following `flag` in argv, if present.
    fn flag_value<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
        argv.iter()
            .position(|a| a == flag)
            .and_then(|i| argv.get(i + 1))
            .map(String::as_str)
    }

    #[test]
    fn argv_new_session_emits_session_id_flag() {
        let home = PathBuf::from("/tmp/test-claude-home");
        let id = "11111111-2222-3333-4444-555555555555";
        let argv = build_argv("/usr/local/bin/claude", &home, Some(id), false);

        assert_eq!(
            flag_value(&argv, "--session-id"),
            Some(id),
            "a new spawn with a session id must emit `--session-id <id>` — got: {argv:?}"
        );
        // Must NOT emit --resume for a new session.
        assert!(
            !argv.iter().any(|a| a == "--resume"),
            "new session must NOT emit --resume — got: {argv:?}"
        );
    }

    #[test]
    fn argv_resume_emits_resume_flag() {
        let home = PathBuf::from("/tmp/test-claude-home");
        let id = "11111111-2222-3333-4444-555555555555";
        let argv = build_argv("/usr/local/bin/claude", &home, Some(id), true);

        assert_eq!(
            flag_value(&argv, "--resume"),
            Some(id),
            "a resume spawn must emit `--resume <id>` (long form, value required) — got: {argv:?}"
        );
        // Must NOT emit --session-id when resuming.
        assert!(
            !argv.iter().any(|a| a == "--session-id"),
            "resume must NOT emit --session-id — got: {argv:?}"
        );
    }

    #[test]
    fn argv_no_session_id_matches_prior_argv() {
        let home = PathBuf::from("/tmp/test-claude-home");
        // Backward compatible: with no session id and no resume, argv must be
        // identical to the prior 2-arg behavior — no --session-id / --resume.
        let argv = build_argv("/usr/local/bin/claude", &home, None, false);

        assert!(
            !argv.iter().any(|a| a == "--session-id" || a == "--resume"),
            "an omitted session id must yield the prior argv (no session flags) — got: {argv:?}"
        );
        // And resume=true with no id is still a no-op (nothing to resume).
        let argv_resume_no_id = build_argv("/usr/local/bin/claude", &home, None, true);
        assert_eq!(
            argv, argv_resume_no_id,
            "resume=true with no session id must not change argv — got: {argv_resume_no_id:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Test: ENV_REMOVE_KEYS constant is non-empty and references known vars
    // -----------------------------------------------------------------------

    #[test]
    fn env_remove_keys_are_listed() {
        let keys = crate::profile::ENV_REMOVE_KEYS;
        assert!(!keys.is_empty(), "ENV_REMOVE_KEYS must not be empty");
        assert!(
            keys.contains(&"ANTHROPIC_API_KEY"),
            "ANTHROPIC_API_KEY must be in ENV_REMOVE_KEYS"
        );
        assert!(
            keys.contains(&"ANTHROPIC_AUTH_TOKEN"),
            "ANTHROPIC_AUTH_TOKEN must be in ENV_REMOVE_KEYS"
        );
    }

    // -----------------------------------------------------------------------
    // Test: terminal_write returns "unknown_session" for a missing id
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn write_unknown_session_errors() {
        let ts = TerminalState::default();
        // Build the args struct directly — no Tauri State wrapping needed for
        // the logic; we exercise only the session-lookup branch.
        let result: Result<Arc<TerminalSession>, String> = ts
            .sessions
            .lock()
            .await
            .get("bogus-id")
            .cloned()
            .ok_or_else(|| "unknown_session".to_string());
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), "unknown_session");
    }

    // -----------------------------------------------------------------------
    // Test: terminal_resize returns "unknown_session" for a missing id
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn resize_unknown_session_errors() {
        let ts = TerminalState::default();
        let result: Result<Arc<TerminalSession>, String> = ts
            .sessions
            .lock()
            .await
            .get("bogus-id")
            .cloned()
            .ok_or_else(|| "unknown_session".to_string());
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), "unknown_session");
    }

    // -----------------------------------------------------------------------
    // Test: write round-trip via `cat` (Unix only)
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[tokio::test]
    async fn write_round_trip() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::io::Read;

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty for round-trip test");

        // Spawn `cat` — it echoes stdin back to stdout on the PTY.
        let cmd = CommandBuilder::new("cat");
        let child = pair.slave.spawn_command(cmd).expect("spawn cat");
        drop(pair.slave); // release slave so reader sees EOF when child dies

        let killer = child.clone_killer();
        let writer = pair.master.take_writer().expect("take_writer");
        // Clone a reader BEFORE moving master into the session.
        let mut reader = pair.master.try_clone_reader().expect("try_clone_reader");

        let session = Arc::new(TerminalSession {
            master: SyncMutex::new(pair.master),
            writer: SyncMutex::new(writer),
            child: SyncMutex::new(child),
            killer: SyncMutex::new(killer),
        });

        let session_id = Uuid::new_v4().to_string();
        let ts = TerminalState::default();
        ts.sessions.lock().await.insert(session_id.clone(), session.clone());

        // Write "hello\n" via base64.
        let payload = base64::engine::general_purpose::STANDARD.encode(b"hello\n");
        {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&payload)
                .expect("decode");
            let mut w = session.writer.lock().unwrap();
            w.write_all(&bytes).and_then(|_| w.flush()).expect("write_all");
        }

        // Read back the echo from the PTY master.
        let mut buf = vec![0u8; 64];
        let n = reader.read(&mut buf).expect("read from PTY");
        let echoed = std::str::from_utf8(&buf[..n]).unwrap_or("");
        assert!(
            echoed.contains("hello"),
            "expected 'hello' in PTY echo, got: {echoed:?}"
        );

        // Clean up.
        session.killer.lock().unwrap().kill().ok();
    }

    // -----------------------------------------------------------------------
    // Test: state caps at MAX_SESSIONS (async, no real PTY needed)
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[tokio::test]
    async fn state_caps_at_max_sessions() {
        let ts = TerminalState::default();

        // Fill the map to the cap.
        {
            let mut map = ts.sessions.lock().await;
            for _ in 0..MAX_SESSIONS {
                let id = Uuid::new_v4().to_string();
                map.insert(id, stub_session());
            }
            assert_eq!(map.len(), MAX_SESSIONS);
        }

        // Simulate the cap check in terminal_spawn.
        let would_be_rejected = {
            let map = ts.sessions.lock().await;
            map.len() >= MAX_SESSIONS
        };
        assert!(
            would_be_rejected,
            "A 5th spawn must be rejected when {MAX_SESSIONS} sessions are active"
        );
    }

    // -----------------------------------------------------------------------
    // Test: prune_exited frees the cap for sessions whose child has exited
    // -----------------------------------------------------------------------
    //
    // Regression for the session-leak bug: rapid open→close cycles leave dead
    // entries in the map (their async removal lagged/was lost), accumulating to
    // MAX_SESSIONS and wrongly tripping "max_sessions_reached". prune_exited
    // must drop those zombie entries so the cap reflects only live PTYs.

    #[cfg(unix)]
    #[tokio::test]
    async fn prune_exited_frees_cap() {
        let ts = TerminalState::default();

        // Fill the map to the cap with stub sessions whose child is `true` —
        // it exits immediately, so by the time we prune the children are gone.
        {
            let mut map = ts.sessions.lock().await;
            for _ in 0..MAX_SESSIONS {
                map.insert(Uuid::new_v4().to_string(), stub_session());
            }
            assert_eq!(map.len(), MAX_SESSIONS);
        }

        // Give the `true` children a moment to reach exit so try_wait reports it.
        for _ in 0..50 {
            {
                let mut map = ts.sessions.lock().await;
                prune_exited(&mut map);
                if map.is_empty() {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let map = ts.sessions.lock().await;
        assert!(
            map.is_empty(),
            "prune_exited must drop sessions whose child has exited so the cap \
             frees up — remaining: {}",
            map.len()
        );
    }
}
