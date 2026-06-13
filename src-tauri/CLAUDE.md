# src-tauri — CLAUDE.md

Rust backend: SQLite (rusqlite, bundled), market-data REST adapters, per-provider token-bucket rate limiters, Claude CLI subprocess host.

## Migrations — append-only

See [ADR-0005](../docs/adr/0005-append-only-migrations.md). To add a schema change:

1. Add a new file `migrations/000N_<name>.sql` (next index, never reuse).
2. Append a new entry to the `MIGRATIONS` array in `src/db.rs` (embedded via `include_str!` at compile time).
3. **Never edit a prior migration file or array entry.**

Migration failure on startup is a panic (ADR-A1) — refuse to run on a broken schema rather than silently degrade.

## Wire format

Rust structs serialize as **snake_case**; TS types in `src/lib/db.ts` and elsewhere mirror exactly so no per-row remap is needed at the IPC boundary.

## Commands

Every `#[tauri::command]` is enumerated in [docs/reference/tauri-ipc.md](../docs/reference/tauri-ipc.md). That file is **generated** — regenerate via `node scripts/gen-tauri-ipc-doc.mjs`. Do not hand-edit it.

Commands are organised by file under `src/commands/{ai,db,market,mcp}.rs`.

## Profile isolation

Claude CLI subprocess profile isolation is enforced in `src/profile.rs` — see [ADR-0003](../docs/adr/0003-claude-profile-isolation.md).

## Credentials

Provider credentials (Alpaca key ID + secret) live in a single **plaintext JSON file** at `<OS data dir>/autoplot/credentials.json` — the same `autoplot` data root as the Claude profile and `mcp.json` (resolved via `profile::data_root()`). No keychain, no `keyring`/`security-framework`, no encryption. On Unix the file is chmod'd `0o600`; on Windows that is a no-op (relies on the user-profile dir ACL — documented limitation).

Lookup precedence in `src/commands/credentials.rs`: env vars `ALPACA_KEY_ID` + `ALPACA_SECRET_KEY` (both required) → the file → `None` (mock fallback). `npm run tauri:dev` is plain `tauri dev` — no `--runner`, no codesign step, no keychain setup. The secret is never returned to the frontend and never logged (a source-level test enforces no log macros in the read/write helpers).

See [docs/reference/credential-storage.md](../docs/reference/credential-storage.md) for the full path/format/precedence and the one-time re-entry note for users upgrading from the old keychain build (no automated migration).
