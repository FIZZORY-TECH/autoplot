# ADR-0003: Claude CLI Profile Isolation (Wave 0)

Status: Accepted (2026-05-10)

## Context

The app spawns the `claude` CLI as a subprocess for AI co-research / co-strategy. The user's primary `~/.claude/` profile holds their personal credentials, MCP servers, plugins, slash commands, and project history. Letting the app read or write that directory would (a) leak the user's keys/credentials into the app's runtime, (b) corrupt their personal profile with app-specific state, and (c) make uninstalling the app messy.

Wave 0 introduced an app-managed profile under `<dirs::data_dir>/autoplot/claude-home/`, mirroring the `~/.claude` layout (settings.json, .claude.json, agents/, skills/, commands/, plugins/) but completely isolated. Every subprocess spawn sets `CLAUDE_CONFIG_DIR=<claude-home>` and `env_remove`s a documented set of leaky variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) so a stray export in the user's shell can't shadow the isolated profile.

`env_clear()` is explicitly NOT used: it would strip macOS bootstrap vars (Keychain socket, locale, NODE_*, DYLD_*) and break OAuth and JS-bundle shebangs.

## Decision

Every `claude` CLI subprocess MUST be configured with `CLAUDE_CONFIG_DIR=<claude-home>` and MUST `env_remove` every key in `profile::ENV_REMOVE_KEYS`. The app MUST NEVER read or write `~/.claude*`. The single permitted exception is the user-triggered, read-only one-shot `mcp_import_from_user_profile`. New subprocess spawn sites MUST go through the shared isolation helper rather than calling `Command::new("claude")` directly.

## Consequences

- Adding a `Command::new("claude")` (or equivalent) without `CLAUDE_CONFIG_DIR` + `ENV_REMOVE_KEYS` is forbidden — a unit test (`env_remove_keys_cover_documented_leaky_set`) guards the key set.
- Reading or writing any path under `~/.claude*` from Rust or TS is forbidden outside `mcp_import_from_user_profile`.
- `env_clear()` is forbidden on `claude` spawns — inherit env, then selectively `env_remove`.
- Bootstrap is idempotent and pre-seeds `settings.json={}` and `.claude.json={"mcpServers":{}}`; the CLI then owns subsequent writes to `.claude.json`.
- Login/logout/auth-status flows reuse `configure_isolated_command` so no spawn site can drift.

Source: src-tauri/src/profile.rs:524-535, src-tauri/src/profile.rs:138-144, src-tauri/src/lib.rs:99-114, src-tauri/src/commands/ai.rs:639-660
