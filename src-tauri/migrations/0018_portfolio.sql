-- Migration 0018: portfolio_holdings — simple position store.
-- This file is IMMUTABLE once written. Append new migrations as 0019_*.sql, etc.
--
-- Rationale: tracks open positions as one editable row per (sym, provider, quote)
-- triple. NOT a transaction ledger — only qty + avg_cost are stored. P&L is
-- computed at read time from live prices in the TS layer.
--
-- Design decisions (locked per ADR-0005):
--   - `asset_class` column for crypto / equity routing, defaulting to 'crypto'.
--   - `currency` column defaults to 'USD'; no FX logic in this layer — reserved
--     for future multi-currency support.
--   - avg_cost is per-unit in the `quote` currency.
--   - created_at / updated_at are unix milliseconds supplied by the caller
--     (matches the marks / trends convention).

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  sym         TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  quote       TEXT    NOT NULL,
  asset_class TEXT    NOT NULL DEFAULT 'crypto',  -- 'crypto' | 'equity'
  qty         REAL    NOT NULL,
  avg_cost    REAL    NOT NULL,                   -- per-unit, in `quote` currency
  currency    TEXT    NOT NULL DEFAULT 'USD',
  note        TEXT,
  created_at  INTEGER NOT NULL,                   -- unix ms
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (sym, provider, quote)
);
