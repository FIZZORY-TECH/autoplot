# src/terminal — CLAUDE.md

PTY transport for Terminal mode. Architecture is frozen by [ADR-0006](../../docs/adr/0006-terminal-pty-mode.md); read it before editing.

## Module-local rules

- **Subscribe before spawn.** `openTerminal` in `terminalClient.ts` registers `listen('terminal:data')` + `listen('terminal:exit')` *before* invoking `terminal_spawn`. New flows must preserve this order or the first frame is lost. Mirrors `src/ai/claudeClient.ts`.
- **Filter by `session_id`.** Concurrent sessions share both event channels; every listener must drop events whose `session_id` does not match its handle.
- **Base64 only via `bytesToB64` / `b64ToBytes`.** These chunk at 16 KiB to dodge `String.fromCharCode` call-stack limits. Never call `btoa` / `atob` on terminal data directly.
- **Dispose is idempotent.** `TerminalHandle.dispose()` is safe after exit (no-op) and safe to call twice. The Rust `terminal_kill` is also idempotent.
- **Lazy-load xterm only inside `useEffect`.** `XtermPanel.tsx` must `await import('@xterm/xterm')` (and addons) inside the effect — top-level imports would break the browser-mode placeholder and bloat first paint.
- **Tauri runtime detection.** Use `isTauriRuntime()` (true when either `window.__TAURI__` or `window.__TAURI_INTERNALS__` is defined; Tauri v2 only injects the latter). Matches the convention in `src/panels/Composer.tsx` and `src/panels/AgentsFAB.tsx`.

## Cross-references

- Rust PTY commands: `src-tauri/src/commands/terminal.rs`
- ADRs: [0003](../../docs/adr/0003-claude-profile-isolation.md) (profile isolation reused) · [0006](../../docs/adr/0006-terminal-pty-mode.md) (this module's design) · [0007](../../docs/adr/0007-app-mcp-bridge.md) (MCP bridge available in this mode)
- IPC contract: [docs/reference/tauri-ipc.md](../../docs/reference/tauri-ipc.md) — search `terminal_*`
- Sidecar: `src-tauri/sidecars/autoplot-mcp/README.md`
