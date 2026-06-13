# ADR-0007: App MCP Bridge (autoplot-mcp Sidecar)

Status: Accepted (2026-05-10)

Source: src-tauri/src/ipc_bridge.rs:60-70 (error code constants), src-tauri/src/ipc_bridge.rs:142-156 (rotate_token, mcp-bridge.token mode 0600), src-tauri/src/ipc_bridge.rs:285-361 (consent gate + ERR_USER_DENIED), src-tauri/src/ipc_bridge.rs:400-416 (path-jail + ERR_FORBIDDEN), src-tauri/src/profile.rs:814-984 (upsert_sidecar_in_mcp_json + bootstrap_profile_extensions threading), src-tauri/sidecars/autoplot-mcp/, src/panels/MCPConsentToast.tsx, src/ai/bridgeRoundtrip.ts

## Context

Terminal mode (ADR-0006) runs the interactive Claude TUI via a real PTY. A PTY session has no stream-json roundtrip channel — the six in-app tools previously reachable through `ai_invoke`'s tool-dispatch loop (`src/ai/dispatchTools.ts`) are unreachable once the CLI goes interactive.

Co-Research and Co-Strategy modes also have a gap: the stream-json channel dies at session end, so persistent app state (active symbol, visible range, overlay list) can only be queried once per invocation. Users want Claude to query and mutate live chart state from any mode.

The architectural answer is a **local MCP server** that the Claude CLI dials on every spawn — whether one-shot stream-json (`ai_invoke`) or interactive PTY. Because every `claude` spawn already passes `--mcp-config <mcp.json>` via `profile::isolation_flags`, a sidecar registered in that config is available in all three modes for free.

A pure in-process MCP server inside the Tauri process would require the MCP transport to be embedded in the Tauri binary, coupling the MCP lifecycle to the Rust async executor. Using an external sidecar binary instead keeps the MCP surface separately buildable and testable.

## Decision

### Sidecar

A new Rust binary `autoplot-mcp` (crate at `src-tauri/sidecars/autoplot-mcp/`) implements the MCP server using `rmcp` 1.6.0 (Anthropic's official Rust MCP SDK, features: `server`, `transport-io`, `schemars`, `macros`). The Claude CLI launches it via the `mcp.json` `command` field and communicates over stdio using the standard MCP protocol.

### IPC bridge

The sidecar cannot directly access Tauri state. A new module `src-tauri/src/ipc_bridge.rs` hosts a tokio `UnixListener` (Linux/macOS) or `NamedPipeServer` (Windows) at `<data_dir>/autoplot/ipc.sock`. The sidecar dials this socket; the app's bridge dispatches inbound JSON-RPC 2.0 frames to Rust handlers (`DbState`, `AiState`) or forwards them to frontend round-trips via Tauri events.

**Wire format**: 4-byte big-endian length prefix + UTF-8 JSON body, one frame per message. JSON-RPC 2.0 with `id`, `method`, `params` / `result` / `error` fields.

### Token handshake

On each app launch `profile::bootstrap_profile_extensions` rotates a 64-char lowercase hex token, writes it to `<claude_home>/mcp-bridge.token` (mode 0600), and injects it into the `mcp.json` `env` block as `TRADING_PORTAL_MCP_TOKEN`. The token is threaded through `BridgeConfig::precomputed_token` so there is exactly one source of truth and no two code sites generate independent tokens.

The sidecar presents the token in its first frame: `{"jsonrpc":"2.0","id":0,"method":"hello","params":{"token":"<hex>"}}`. On mismatch the bridge returns `-32001 unauthorized` and closes the connection; the CLI surfaces this to the user.

### Tool surface (38 tools, five buckets)

| Bucket | Representative tools |
|---|---|
| Read-only | `fetch_ohlc`, `compute_indicator`, `list_assets`, `get_current_symbol`, `get_visible_range`, `list_overlays`, `read_attachment`, `list_attachments` |
| Mutation (consent-gated) | `apply_dataset`, `remove_dataset`, `apply_timeline_events`, `remove_timeline_layer`, `apply_strategy`, `remove_strategy_overlay`, `open_strategy_artifact` |
| Persistence | `save_dataset`, `list_datasets`, `load_dataset`, `delete_dataset`, `save_strategy`, `list_strategies`, `load_strategy`, `update_strategy`, `delete_strategy`, `save_research_note`, `list_research_notes`, `paper_open_position`, `paper_close_position`, `get_paper_pnl` |
| Portfolio (read + consent-gated mutation) | `portfolio_list_holdings`, `portfolio_get_summary`, `portfolio_get_allocation`, `portfolio_set_holding`, `portfolio_add_lot`, `portfolio_reduce_holding`, `portfolio_remove_holding` |
| Compute (frontend round-trip) | `compute_indicator`, `validate_strategy`, `backtest_strategy` |

Compute tools (`compute_indicator`, `validate_strategy`, `backtest_strategy`) round-trip to the canonical TS handlers in `src/ai/tools/` and `src/engine/backtest.ts` via frontend Tauri events — the math is not reimplemented in Rust, maintaining a single source of truth (consistent with ADR-0001 / ADR-0002 invariants).

### Consent model

Mutation tools surface a `MCPConsentToast` (`src/panels/MCPConsentToast.tsx`) driven by Tauri events. The bridge awaits the user's decision before returning a result. Responses follow the `mcp.autoApprove` setting: `prompt` (default) | `session-allow` | `always`. Denials return `-32006 user_denied`; path-jail violations on `read_attachment` return `-32007 forbidden`.

### Auto-registration

`profile::bootstrap_profile_extensions` upserts the sidecar entry into `<data_root>/mcp.json` on every app launch using the existing `mcp_app_config_upsert` merge logic (precedence: app > user > project). The token is rewritten each launch; existing user-added MCP servers are preserved.

### Error codes

| Code | Constant | Meaning |
|---|---|---|
| -32000 | `app_not_running` | Sidecar could not connect to the bridge |
| -32001 | `ERR_UNAUTHORIZED` | Token mismatch in hello handshake |
| -32002 | `ERR_NOT_IMPLEMENTED` | Bridge method not yet wired |
| -32003 | `ERR_FE_UNAVAILABLE` | No active Tauri window for frontend events |
| -32004 | `ERR_FE_TIMEOUT` | Frontend did not reply within 10 s |
| -32005 | `ERR_INTERNAL` | Unexpected Rust-side error |
| -32006 | `ERR_USER_DENIED` | Mutation consent denied |
| -32007 | `ERR_FORBIDDEN` | Path-jail violation (`read_attachment`) |

## Consequences

- All three AI modes (Research, Strategy, Terminal) gain the full `mcp__autoplot__*` toolset without any per-mode wiring changes — the sidecar is in `mcp.json` which is loaded on every spawn.
- Compute math (`compute_indicator`, `validate_strategy`, `backtest_strategy`) remains a single TS implementation; the Rust bridge is just a proxy.
- The token rotation means a stale sidecar from a prior launch cannot authenticate to a new bridge instance.
- Mutation safety is preserved: `apply_*` and `paper_*` always go through `MCPConsentToast` unless the user opts into `mcp.autoApprove=always`.
- The sidecar binary (~4–6 MB per platform) is registered in `tauri.conf.json` `bundle.externalBin` and shipped with the app.
- If the app is not running the sidecar returns `app_not_running` on every `tools/call`; `tools/list` still succeeds so Claude can report the tool surface clearly.
- Strategy revisions written via `update_strategy` follow ADR-0005 (append-only) — a new `strategy_revisions` row is inserted and `current_revision` bumped; prior revisions are never mutated.

**References**: `src-tauri/src/ipc_bridge.rs`, `src-tauri/sidecars/autoplot-mcp/`, `src/ai/bridgeRoundtrip.ts`, `src/panels/MCPConsentToast.tsx`, [ADR-0003](./0003-claude-profile-isolation.md) (profile isolation), [ADR-0005](./0005-append-only-migrations.md) (append-only strategy revisions), [ADR-0006](./0006-terminal-pty-mode.md) (Terminal mode, which this bridges).
