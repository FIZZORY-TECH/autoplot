-- Migration 0016: add `quote` column to `marks` (ADR-0009).
-- This file is IMMUTABLE once written. Append new migrations as 0017_*.sql, etc.
--
-- `marks` keys on a surrogate AUTOINCREMENT id; the (provider, sym, quote)
-- invariant is enforced by callers through the secondary index. Adding the
-- column + backfill avoids the PK-rewrite problem `bars` and `watchlist` hit.
--
-- Backfill priority:
--   1. The quote already present in watchlist_v2 for this (sym, provider),
--      preserving any catalog-era selection the user made before this
--      migration runs (defensive — at migration time watchlist_v2 is fresh
--      from 0015 with deterministic quotes, but the COALESCE survives future
--      schema growth).
--   2. The deterministic per-provider default — same table as 0014/0015.

ALTER TABLE marks ADD COLUMN quote TEXT NOT NULL DEFAULT '';

UPDATE marks
   SET quote = COALESCE(
        (SELECT w.quote FROM watchlist_v2 w
          WHERE w.sym = marks.sym AND w.provider = marks.provider LIMIT 1),
        CASE marks.provider
          WHEN 'binance'  THEN 'USDT'
          WHEN 'coinbase' THEN 'USD'
          WHEN 'kraken'   THEN 'USD'
          WHEN 'alpaca'   THEN 'USD'
          ELSE 'USD'
        END
   )
 WHERE quote = '';

CREATE INDEX IF NOT EXISTS marks_sym_provider_quote_idx ON marks(sym, provider, quote);
