-- Migration 0001: bootstrap _migrations table.
-- This file is IMMUTABLE once written. Later phases add 0002_*.sql, etc.
-- Applied by db::run_migrations() on every app start; idempotent via
-- the version check against the _migrations table.

CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL  -- Unix seconds (UTC)
);
