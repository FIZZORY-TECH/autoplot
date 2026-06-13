-- Migration 0017: add `quote` column to `trends` (ADR-0009).
-- This file is IMMUTABLE once written. Append new migrations as 0018_*.sql, etc.
--
-- Same shape as 0016_marks_add_quote.sql — surrogate TEXT id PK, secondary
-- index enforces the (provider, sym, quote) invariant in caller queries.

ALTER TABLE trends ADD COLUMN quote TEXT NOT NULL DEFAULT '';

UPDATE trends
   SET quote = COALESCE(
        (SELECT w.quote FROM watchlist_v2 w
          WHERE w.sym = trends.sym AND w.provider = trends.provider LIMIT 1),
        CASE trends.provider
          WHEN 'binance'  THEN 'USDT'
          WHEN 'coinbase' THEN 'USD'
          WHEN 'kraken'   THEN 'USD'
          WHEN 'alpaca'   THEN 'USD'
          ELSE 'USD'
        END
   )
 WHERE quote = '';

CREATE INDEX IF NOT EXISTS trends_sym_tf_provider_quote_idx ON trends(sym, tf, provider, quote);
