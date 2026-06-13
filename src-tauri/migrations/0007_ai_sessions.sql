-- Migration 0007: ai_sessions — one row per Claude CLI conversation thread.
-- This file is IMMUTABLE once written. Append new migrations as 0008_*.sql, etc.
--
-- `id` holds the CLI-issued session_id once the first stream-json `system`
-- event arrives. For the brief window before that we may insert with a
-- placeholder UUID (the same UUID we used to name the cwd jail dir) and
-- later replace the row with the real CLI id; see commands/ai.rs for the
-- timeout-fallback flow.
--
-- `cwd_path` is the absolute path of the per-conversation jail dir, kept
-- here so resume can reuse the existing dir without re-deriving it from
-- (potentially-changed) data-dir resolution.

CREATE TABLE IF NOT EXISTS ai_sessions (
    id           TEXT PRIMARY KEY,
    mode         TEXT NOT NULL,            -- 'research' | 'strategy'
    cwd_path     TEXT NOT NULL,            -- absolute path to jail dir
    model        TEXT,                     -- model used last
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    summary      TEXT                      -- short label, populated later (P8)
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_mode_lastused
    ON ai_sessions(mode, last_used_at DESC);
