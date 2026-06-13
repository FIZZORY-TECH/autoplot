# App-Shipped Slash Commands

These markdown files are bundled with the autoplot app and seeded into the user's isolated Claude profile (`<data_dir>/autoplot/claude-home/commands/`) on first launch (see Step 7 of the implementation plan and `src-tauri/src/profile.rs::seed_profile_assets`).

Seeding is **idempotent**: a file is copied only if it does not yet exist, and is refreshed when the app version bumps (tracked via `claude-home/.assets-version`). The user (or the CLI) owns subsequent edits — re-seeding does not overwrite user modifications.

## Commands

| File | Slash command | Purpose |
|---|---|---|
| `research.md` | `/research <question>` | Co-Research persona — web research + chart mutations (dataset, timeline) |
| `strategy.md` | `/strategy <intent>` | Co-Strategy persona — validate → backtest → save → artifact handoff |
| `save-current.md` | `/save-current [title]` | Snapshot current chart view as a research note |
| `explain.md` | `/explain` | Narrate chart state in plain language (read-only) |

## MCP tool names

All commands reference `mcp__autoplot__*` tools exposed by the `autoplot-mcp` sidecar MCP server. These tools are only available when the autoplot app is running. See `src-tauri/sidecars/autoplot-mcp/` for the server implementation and `docs/reference/tauri-ipc.md` for the IPC surface.
