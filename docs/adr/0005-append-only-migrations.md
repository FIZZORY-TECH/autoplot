# ADR-0005: Append-Only SQLite Migrations (A1)

Status: Accepted (2026-05-10)

## Context

The Rust backend embeds every migration into the binary at compile time via `include_str!` macros in `src-tauri/src/db.rs`. The `MIGRATIONS` array is a fixed `&[(u32, &str)]` of `(version, sql)` pairs read from `src-tauri/migrations/000N_*.sql`. The current set spans versions 1, 2, 3, 4, 6, 7, 8, 9.

`run_migrations` applies each pending migration inside its own transaction, atomically inserting the version row alongside the schema change so a crash mid-migration leaves the DB in a known state. Per Architectural Decision A1, migration failure is fatal — `lib.rs`'s `setup` calls `.expect("Database migration failed — cannot start app")`, panicking before any window is shown.

Because the binary is the only source of truth for migration SQL, editing a previously-shipped migration file would silently produce a different schema on installs that already applied the old version (their `_migrations.version` row blocks re-application), corrupting databases in the field. Forward-only, append-only is the only safe mode.

## Decision

To change the schema, ADD a new migration file `src-tauri/migrations/000N_<name>.sql` with the next unused version number, AND append a matching `(N, include_str!("../migrations/000N_<name>.sql"))` entry to the `MIGRATIONS` array in `src-tauri/src/db.rs`. NEVER edit a previously shipped migration file. NEVER reorder, remove, or rewrite an existing entry in the `MIGRATIONS` array. NEVER reuse a version number. Migration failure stays fatal — do not catch and continue.

## Consequences

- Editing `0001_init.sql` … `0009_strategies.sql` after they have shipped is forbidden.
- Reusing a version number, reordering entries, or removing an entry from `MIGRATIONS` is forbidden.
- Schema fixes are expressed as new forward migrations (e.g. `ALTER TABLE` / data backfills), never as rewrites of prior files.
- Migration failure on startup MUST remain a panic (per A1) — the app cannot run on a half-migrated DB.
- A new migration N requires both the file at `src-tauri/migrations/000N_*.sql` AND the array entry; missing either is a build/runtime error.

Source: src-tauri/src/db.rs:23-32, src-tauri/src/db.rs:62-85, src-tauri/src/lib.rs:57-62
