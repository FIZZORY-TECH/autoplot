# ADR-0006: Terminal PTY Mode

Status: Accepted (2026-05-10)

Source: src-tauri/src/commands/terminal.rs:26 (MAX_SESSIONS=4 cap), src-tauri/src/commands/terminal.rs:91-118 (build_argv reuses isolation_flags, excludes --print/--input-format/--verbose), src-tauri/src/commands/terminal.rs:127-204 (terminal_spawn + drop(slave) at :198), src/terminal/XtermPanel.tsx, src/terminal/terminalClient.ts

## Context

The existing AI surface spawns `claude` as a one-shot subprocess with `--output-format=stream-json` and a synchronous tool-roundtrip dispatched through `ai_invoke` (see `src-tauri/src/commands/ai.rs`). That channel lives only for the duration of the stream-json session — the moment the process goes interactive the pipe dies and all in-flight tool calls are lost.

Users asked for a third AI surface: a live **Terminal mode** where the real `claude` TUI runs inside the app, with full readline/TUI control, `--dangerously-skip-permissions` interactions, slash commands, and the ability to switch models mid-session. Achieving that requires a true pseudo-terminal (PTY), not stream-json passthrough.

Adding a raw PTY surface without the same isolation guarantees as `ai_invoke` would violate ADR-0003. The design therefore reuses the exact same `isolation_flags()` helper and `ENV_REMOVE_KEYS` set introduced in ADR-0003 so every spawn site stays in sync.

## Decision

Use the `portable-pty` crate (0.9, with native ConPTY support on Windows, no `winpty.dll` required) to host PTY sessions in Rust. Expose four Tauri commands in `src-tauri/src/commands/terminal.rs`:

- `terminal_spawn` — creates a new PTY session and returns `{ session_id }`.
- `terminal_write` — writes base64-encoded bytes into the PTY master.
- `terminal_resize` — sends a SIGWINCH / ConPTY resize to the session.
- `terminal_kill` — signals the child process; idempotent after exit.

**Spawn arguments**: `[claude, ...isolation_flags(home)]` — identical to `ai_invoke` but without `--print`, `--input-format stream-json`, or `--verbose`. The PTY child must see the interactive TUI, not the machine-readable format.

**Environment**: `CLAUDE_CONFIG_DIR=<claude-home>` set; every key in `profile::ENV_REMOVE_KEYS` removed. `env_clear()` is explicitly not used (see ADR-0003 rationale).

**Session state**: `Arc<AsyncMutex<HashMap<String, Arc<TerminalSession>>>>` managed in `TerminalState`. Hard cap of **4 concurrent sessions**; `terminal_spawn` returns the error string `"max_sessions_reached"` when the cap is hit.

**Reader**: `spawn_blocking` thread reads 8 KiB chunks from the PTY master and emits `terminal:data` Tauri events with payload `{ session_id, bytes_b64 }`. On EOF or child exit the reader emits `terminal:exit` with `{ session_id, code }` and drops the session entry.

**Wire format**: base64 in both directions — Rust emits `bytes_b64`, the TS client calls `b64ToBytes` (chunked at 16 KiB to avoid `String.fromCharCode` call-stack limits) and writes raw `Uint8Array` to xterm.

**Frontend**: `src/terminal/terminalClient.ts` wraps the four `invoke` calls. `src/terminal/XtermPanel.tsx` lazy-loads `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-web-links` inside a `useEffect` so the ~250 KB bundle is never included in the first-paint chunk and is completely absent in browser-only mode. When neither `window.__TAURI__` nor `window.__TAURI_INTERNALS__` is defined (Tauri v2 only injects the latter), `XtermPanel` returns a static glass-card placeholder.

**Slave drop**: the PTY slave fd is dropped immediately after the child is spawned so the master reader sees EOF when the child exits rather than blocking.

## Consequences

- Terminal mode inherits the identical profile isolation guarantees as Research and Strategy modes — a unit test (`env_remove_keys_cover_documented_leaky_set`) continues to guard the key set.
- The xterm bundle (~250 KB) is lazy-loaded; zero bytes added to the first-paint bundle.
- ConPTY on Windows ships natively via `portable-pty` 0.9 — no `winpty.dll` is bundled or required.
- The 4-session cap is enforced in Rust; the TS client surfaces the error string to the user.
- Per-session token gating (to prevent cross-window injection) is left as a follow-up if that threat model materialises; the session id returned by `terminal_spawn` is a random UUID and is used to filter `terminal:data` / `terminal:exit` events in the TS listener.
- Adding a `Command::new("claude")` or equivalent without going through `profile::isolation_flags` + `ENV_REMOVE_KEYS` remains forbidden (ADR-0003).

**References**: `src-tauri/src/commands/terminal.rs`, `src/terminal/`, [ADR-0003](./0003-claude-profile-isolation.md) (profile isolation, which this extends).
