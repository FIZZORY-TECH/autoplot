-- Migration 0008: AI Research datasets (P6 / W4-B).
-- This file is IMMUTABLE once written. Append new migrations as 0009_*.sql, etc.
--
-- A dataset is the result of a Research-mode round-trip: an AI-computed numeric
-- series the user can plot as an overlay glow pass on the chart, and re-plot
-- across symbols. The full Dataset shape lives in `src/ai/schemas.ts` (W4-A);
-- here we persist the JSON blob verbatim, keyed by stable id.
--
-- `created_at` is unix ms (consistent with the trends/marks tables).

CREATE TABLE IF NOT EXISTS datasets (
    id          TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_datasets_created_at ON datasets(created_at);
