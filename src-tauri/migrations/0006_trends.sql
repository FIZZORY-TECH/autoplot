-- Migration 0006: trend lines (two-anchor segment annotations).
-- This file is IMMUTABLE once written. Append new migrations as 0007_*.sql, etc.
--
-- A trend line is anchored by two points (ts, price). Each point's `ts` is a
-- bar timestamp (unix ms) — the renderer projects (ts, price) → (x, y) using
-- the same view + layout math as marks, so trends pan/zoom with the chart.
--
-- `color` mirrors the marks-table convention (one of the 5 swatch tokens, or
-- the default 'accent' string which the renderer maps to var(--accent)).

CREATE TABLE IF NOT EXISTS trends (
    id          TEXT PRIMARY KEY,
    sym         TEXT NOT NULL,
    tf          TEXT NOT NULL,
    x1_ts       INTEGER NOT NULL,
    y1_price    REAL NOT NULL,
    x2_ts       INTEGER NOT NULL,
    y2_price    REAL NOT NULL,
    color       TEXT NOT NULL DEFAULT 'accent',
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_trends_sym_tf ON trends(sym, tf);
