-- Migration 0014: bars_v2 — multi-quote OHLCV cache (ADR-0009).
-- This file is IMMUTABLE once written. Append new migrations as 0015_*.sql, etc.
--
-- Rationale: the legacy `bars` PK is (provider, sym, tf, ts) — adding a `quote`
-- column without a new table would forbid caching both BTC/USDT and BTC/USDC
-- bars at the same timestamp (PK collision). ADR-0005 forbids editing the
-- legacy PK, so we create a forward-only v2 table.
--
-- Legacy `bars` is preserved untouched. All reads + writes from this migration
-- forward route through `bars_v2`. The migration copies every v1 row into v2
-- with per-provider quote backfill — every legacy crypto row produced by the
-- shipped adapters carries the deterministic quote noted below.
--
-- Per-provider backfill (verified by cargo test against captured legacy rows):
--   binance  → 'USDT'   (adapter appends `usdt` before every REST call)
--   coinbase → 'USD'    (adapter uses `-USD`)
--   kraken   → 'USD'    (legacy adapter only registered USD pairs; the catalog
--                       era will surface USDT pairs going forward and write
--                       them with the correct quote)
--   alpaca   → 'USD'    (USD-only equity feed)

CREATE TABLE bars_v2 (
  provider TEXT NOT NULL,
  sym      TEXT NOT NULL,
  quote    TEXT NOT NULL,
  tf       TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  o        REAL NOT NULL,
  h        REAL NOT NULL,
  l        REAL NOT NULL,
  c        REAL NOT NULL,
  v        REAL NOT NULL,
  PRIMARY KEY (provider, sym, quote, tf, ts)
);

CREATE INDEX idx_bars_v2_lookup ON bars_v2(provider, sym, quote, tf, ts DESC);

INSERT INTO bars_v2 (provider, sym, quote, tf, ts, o, h, l, c, v)
SELECT
  provider,
  sym,
  CASE provider
    WHEN 'binance'  THEN 'USDT'
    WHEN 'coinbase' THEN 'USD'
    WHEN 'kraken'   THEN 'USD'
    WHEN 'alpaca'   THEN 'USD'
    ELSE 'USD'
  END AS quote,
  tf,
  ts, o, h, l, c, v
FROM bars;
