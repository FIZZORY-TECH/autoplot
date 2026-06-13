-- Migration 0019: Research overlays (blob store).
-- This file is IMMUTABLE once written. Append new migrations as 0020_*.sql, etc.
--
-- A research overlay is a persisted analysis pass the user can render over the
-- chart. As with `datasets`, we store the full JSON blob verbatim, keyed by a
-- stable id generated on the TS side; the shape lives in the frontend.
--
-- `created_at` is unix ms (consistent with the trends/marks/datasets tables).

CREATE TABLE IF NOT EXISTS research_overlays (
    id          TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_research_overlays_created_at ON research_overlays(created_at);
