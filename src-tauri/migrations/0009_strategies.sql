-- Migration 0009: AI Strategy persistence (P7 / W5-C3).
-- This file is IMMUTABLE once written. Append new migrations as 0010_*.sql, etc.
--
-- A strategy is the result of a Strategy-mode round-trip: a validated DSL blob
-- that the user can apply to the chart as buy/sell signals, re-backtest, and
-- edit via follow-up prompts. The full Strategy shape lives in
-- `src/ai/schemas.ts` (W5-A); here we persist the JSON blob verbatim,
-- keyed by stable id.
--
-- `created_at` is unix ms (consistent with the datasets/trends/marks tables).

CREATE TABLE IF NOT EXISTS strategies (
    id          TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_strategies_created_at ON strategies(created_at);
