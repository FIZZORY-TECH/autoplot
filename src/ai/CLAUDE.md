# src/ai — CLAUDE.md

MCP bridge + tool handlers for MCP-driven artifact mutation.

## Architecture

The **chat UI was removed 2026-05-23.** This directory now contains only the MCP bridge runtime and the tool handlers it invokes:

- **`bridgeRoundtrip.ts`** — mounts from `AppShell.tsx:573`. Listens for `bridge:request` events from `ipc_bridge.rs` (Rust), dispatches to tool handlers, replies with `bridge_reply` Tauri command.
- **`schemas.ts`** — Zod schemas for Dataset / Strategy / Indicator / Op / ResearchOverlay. Source of truth for DSL shapes; must stay in sync with Rust serde types. `ResearchOverlay` (Step 4) is the generic multi-element overlay (`apply_research_overlay`); unlike `Dataset` it is `safeParse`-validated at dispatch in `bridgeRoundtrip.ts`, returning field-level `{path,message}` issues on failure.
- **`types.ts`** — minimal types: `Mode` (kept for historical reasons but unused in runtime), `PermissionMode` (flat, no per-mode map).
- **`tools/{computeIndicator,validateStrategy,backtestStrategy,_barFetcher}.ts`** — invoked by the MCP bridge via `bridgeRoundtrip`.
- **Research Library MCP tools** — `save_research_overlay`, `list_research_overlays`, `load_research_overlay`, `delete_research_overlay`; handled inline in `bridgeRoundtrip.ts` (no separate tool file), persisted via `useResearchOverlayLibraryStore` → `db_research_overlays_*` Tauri commands → `research_overlays` SQLite table (migration 0019).
- **`seedDatasets.ts`, `seedStrategies.ts`** — first-run defaults (idempotent).
- **`cliPaths.ts`** — `SUPPORTED_CLI` constant (moved from deleted `claudeClient.ts`).

Deleted (chat UI removal, 2026-05-23):
- `claudeClient.ts`, `dispatchTools.ts`, `streamPacer.ts`, `imageResize.ts`, `parseUserSeries.ts`, `skillResolver.ts`, `audit.ts`, `pii.ts`
- `__capture_helpers.ts`, `__capture_state.ts`
- All files in `prompts/` (research.md, strategy.md, system prompts)
- Chat-only tools: `tools/fetchOhlc.ts`, `tools/returnDataset.ts`, `tools/returnStrategy.ts`, `tools/index.ts` (registry)

## Bridge flow

1. CLI (running in PTY, `src/terminal/TerminalPanel`) invokes an MCP tool (e.g., `mcp__autoplot__validate_strategy`).
2. Rust `ipc_bridge.rs` receives the tool invocation, emits a `bridge:request` event to the React frontend.
3. `bridgeRoundtrip.ts` listens for the event, extracts the tool name + params, dispatches to the matching handler.
4. Handler (e.g., `tools/validateStrategy.ts`) runs the validation logic synchronously, returns a result.
5. `bridgeRoundtrip` replies via `bridge_reply` Tauri command with the result.
6. Rust awaits the reply, forwards it back to the CLI.
7. The CLI's artifact renderer (`StrategyArtifactPanel`, etc.) receives the result and updates the UI.

## Schema migration

When you add a new field to `Dataset` / `Strategy`:
1. Update the Zod schema in `schemas.ts`.
2. Update the Rust serde struct in `src-tauri/src/commands/db.rs` (e.g., `AiStrategy`).
3. Add an append-only migration in `src-tauri/migrations/` per ADR-0005.
4. Update `seedDatasets.ts` / `seedStrategies.ts` if the seed templates need the new field.

## Permissions

Tool invocation requires user consent via the MCP bridge. The `mcp.autoApprove` setting (`prompt` | `session-allow` | `always`) is read by `ipc_bridge.rs` to determine consent behavior. When `prompt`, the CLI receives a consent dialog before the tool runs. When `session-allow`, tools approved in the same session skip re-prompting. When `always`, all tools auto-approve.

## Artifact panels

When a tool returns an artifact (e.g., strategy JSON), the result is fed to:
- **`StrategyArtifactPanel`** (display + edit) — mounted in `AppShell.tsx`.
- **`DatasetCard`, `StrategyCard`** — inline previews in artifact results, used by bridge artifact rendering.
- **`RuleGraph`** — visualizes strategy rules on the chart as nodes + connectors.

These are **not** called by the chat UI anymore; they are called by the MCP bridge artifact renderer.
