# autoplot-mcp

Stdio MCP sidecar for the autoplot Tauri application.

Implements the [Model Context Protocol](https://spec.modelcontextprotocol.io/) over stdin/stdout using [`rmcp`](https://crates.io/crates/rmcp) v1.6.0. The Claude CLI launches this binary via `mcp.json`; the sidecar then dials the app-side IPC bridge to expose app tools to Claude.

## Architecture

```
Claude CLI ──(MCP/stdio)──► autoplot-mcp ──(JSON-RPC/UDS)──► ipc_bridge (Tauri)
                                                                        │
                                                                        ├── Rust handlers (fetch_ohlc, list_assets)
                                                                        └── Frontend round-trips (compute_indicator, chart state)
```

## Env vars

| Var | Required | Default |
|---|---|---|
| `TRADING_PORTAL_MCP_TOKEN` | **yes** | — |
| `TRADING_PORTAL_MCP_SOCKET` | no | `<data_dir>/autoplot/ipc.sock` |

The token is a 64-char lowercase hex string rotated by the Tauri app on each launch.  It is written to `<claude_home>/mcp-bridge.token` and auto-injected into `mcp.json` by Step 7.

## Wire protocol (bridge side)

Frames: 4-byte big-endian length + UTF-8 JSON body.

```text
Request:  {"jsonrpc":"2.0","id":"<uuid>","method":"<name>","params":{...}}
Response: {"jsonrpc":"2.0","id":"<uuid>","result":<json>}
       or {"jsonrpc":"2.0","id":"<uuid>","error":{"code":<int>,"message":"..."}}
```

Hello handshake (first frame only):
```text
→ {"jsonrpc":"2.0","id":0,"method":"hello","params":{"token":"<hex>"}}
← {"jsonrpc":"2.0","id":0,"result":{"status":"ok"}}
← {"jsonrpc":"2.0","id":0,"error":{"code":-32001,"message":"unauthorized"}}  ← exits
```

## Error codes

| Code | Constant | Meaning |
|---|---|---|
| -32001 | `ERR_UNAUTHORIZED` | Token mismatch in hello handshake |
| -32002 | `ERR_NOT_IMPLEMENTED` | Bridge method not yet wired |
| -32003 | `ERR_FE_UNAVAILABLE` | No active Tauri app window for frontend events |
| -32004 | `ERR_FE_TIMEOUT` | Frontend did not reply within 10 s |
| -32005 | `ERR_INTERNAL` | Unexpected Rust-side error |
| -32000 | app_not_running | Sidecar could not connect to the bridge |

## MCP tools (Step 5 — read-only)

| Tool | Params | Bridge method |
|---|---|---|
| `fetch_ohlc` | `symbol: string, timeframe: enum["1h","4h","1d","1w"], limit?: int` | `fetch_ohlc` (Rust, calls market adapter) |
| `compute_indicator` | `name: IndicatorEnum, bars: array, params?: object` | `compute_indicator` (frontend round-trip) |
| `list_assets` | `{}` | `list_assets` (stub → empty array; Step 6 wires) |
| `get_current_symbol` | `{}` | `get_current_symbol` (frontend round-trip) |
| `get_visible_range` | `{}` | `get_visible_range` (frontend round-trip) |
| `list_overlays` | `{}` | `list_overlays` (frontend round-trip) |
| `read_attachment` | `file_id: string` | `read_attachment` (returns `-32002` until Step 6) |

Indicator enum (15 entries, pinned from `src/ai/schemas.ts`):
`close`, `open`, `high`, `low`, `volume`, `sma`, `ema`, `rsi`, `atr`,
`bollinger_upper`, `bollinger_middle`, `bollinger_lower`,
`donchian_high`, `donchian_low`, `realized_vol`

## MCP tools (full surface — 35 tools)

### Mutation tools (consent-gated via MCPConsentToast)

| Tool | Params | Notes |
|---|---|---|
| `apply_dataset` | `dataset: object` | Renders dataset on chart; user must confirm |
| `remove_dataset` | `id: string` | Reverses `apply_dataset` |
| `apply_timeline_events` | `layer_id: string, events: array` | Pins/vlines/ranges on the time axis |
| `remove_timeline_layer` | `layer_id: string` | Clears a timeline layer |
| `apply_strategy` | `id: string` | Renders entry/exit markers + signal overlay |
| `remove_strategy_overlay` | `id: string` | Clears strategy overlay |
| `open_strategy_artifact` | `id: string` | Opens the Strategy Artifact Panel |

### Persistence tools

| Tool | Category |
|---|---|
| `save_dataset`, `list_datasets`, `load_dataset`, `delete_dataset` | Dataset CRUD |
| `save_research_overlay`, `list_research_overlays`, `load_research_overlay`, `delete_research_overlay` | Research-overlay library CRUD (`save`/`delete` consent-gated; library is durable, distinct from session-only `remove_research_overlay`) |
| `save_strategy`, `list_strategies`, `load_strategy`, `update_strategy`, `delete_strategy` | Strategy CRUD (append-only revisions per ADR-0005) |
| `save_research_note`, `list_research_notes` | Research notes |
| `paper_open_position`, `paper_close_position`, `get_paper_pnl` | Paper ledger |
| `list_attachments` | Enumerate user-uploaded attachments |

### Compute tools (frontend round-trip)

| Tool | Backend |
|---|---|
| `compute_indicator` | Forwarded to `src/ai/tools/computeIndicator.ts` |
| `validate_strategy` | Forwarded to `src/ai/tools/validateStrategy.ts` |
| `backtest_strategy` | Forwarded to `src/engine/backtest.ts` |

For the full tool parameter schemas see the plan at `~/.claude/plans/act-as-senior-ai-stateful-sutton.md` (Layer A tool surface table).

## Connection management

- 5-second timeout on initial dial.
- If dial fails, `tools/list` still serves normally; `tools/call` returns `app_not_running` error content.
- On mid-session IO failure: backoff reconnect (100ms → 500ms → 2s), then give up until next call.
- `unauthorized` response on hello → exit non-zero (CLI surfaces this to the user).

## Building

```sh
# from src-tauri/
cargo build -p autoplot-mcp

# whole workspace
cargo build --workspace
```

## Testing

```sh
cargo test -p autoplot-mcp
# smoke test (no app needed):
cargo test -p autoplot-mcp -- tools_list_without_bridge
# bridge test (fake in-process bridge):
cargo test -p autoplot-mcp -- tools_call_get_current_symbol_via_fake_bridge
```

## Manual e2e checkpoint

With the autoplot app running and `mcp.json` pointing to this binary:

```sh
CLAUDE_CONFIG_DIR=<data_dir>/autoplot/claude-home \
  claude mcp list
# → shows: autoplot (autoplot-mcp)

claude --print "Use mcp__autoplot__get_current_symbol"
# → returns the active symbol from the chart
```

*(This is a documentation checkpoint — no auto test runs the real CLI.)*

## rmcp version

Pinned to `rmcp = "1.6.0"` with features `server`, `transport-io`, `schemars`, `macros`.
The crate is [Anthropic's official Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk).

## Cross-references

- IPC bridge (app side): `src-tauri/src/ipc_bridge.rs`
- Bridge design decision: [docs/adr/0007-app-mcp-bridge.md](../../../../docs/adr/0007-app-mcp-bridge.md)
- Terminal PTY mode (which uses this sidecar): [docs/adr/0006-terminal-pty-mode.md](../../../../docs/adr/0006-terminal-pty-mode.md)
- Profile isolation (token rotation, `mcp.json` bootstrap): `src-tauri/src/profile.rs`, [ADR-0003](../../../../docs/adr/0003-claude-profile-isolation.md)
- Consent UI: `src/panels/MCPConsentToast.tsx`
- `src/ai/CLAUDE.md` — Terminal mode + MCP bridge section
