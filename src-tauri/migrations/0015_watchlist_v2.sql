-- Migration 0015: watchlist_v2 — multi-quote watchlist (ADR-0009).
-- This file is IMMUTABLE once written. Append new migrations as 0016_*.sql, etc.
--
-- Rationale: the legacy `watchlist` PK is (sym, provider) — adding a `quote`
-- column without a new table would forbid a user from ever holding both
-- BTC/USDT and BTC/USDC on the same provider. ADR-0005 forbids dropping the
-- legacy PK, so we create a forward-only v2 table.
--
-- Legacy `watchlist` is preserved untouched for audit. All reads + writes from
-- this migration forward route through `watchlist_v2`.
--
-- Per-provider backfill (verified by cargo test against captured legacy rows):
--   binance  → 'USDT'   adapter appended `usdt` to every shipped symbol.
--   coinbase → 'USD'    adapter uses `-USD`.
--   kraken   → 'USD'    Kraken trades USDT pairs too, but the legacy curated
--                       set (MATIC/ADA/DOT) is USD-only — no Kraken row in a
--                       shipped install can be a USDT pair. A cargo test pins
--                       this against captured legacy data.
--   alpaca   → 'USD'    USD-only equity feed.

CREATE TABLE watchlist_v2 (
  sym      TEXT    NOT NULL,
  provider TEXT    NOT NULL,
  quote    TEXT    NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (sym, provider, quote)
);

INSERT INTO watchlist_v2 (sym, provider, quote, added_at)
SELECT
  sym,
  provider,
  CASE provider
    WHEN 'binance'  THEN 'USDT'
    WHEN 'coinbase' THEN 'USD'
    WHEN 'kraken'   THEN 'USD'
    WHEN 'alpaca'   THEN 'USD'
    ELSE 'USD'
  END AS quote,
  added_at
FROM watchlist;
