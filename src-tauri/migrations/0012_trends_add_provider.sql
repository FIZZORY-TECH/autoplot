-- Migration 0012: add `provider` column to `trends` (ADR-0008).
-- This file is IMMUTABLE once written. Append new migrations as 0013_*.sql, etc.
--
-- Same rationale as 0011_marks_add_provider.sql — the trends table previously
-- keyed only on (sym, tf) which silently collides across providers once the
-- equity adapter lands. Backfill mirrors marks: prefer the watchlist row for
-- this sym, default to 'binance' otherwise.

ALTER TABLE trends ADD COLUMN provider TEXT NOT NULL DEFAULT 'binance';

UPDATE trends
   SET provider = COALESCE(
        (SELECT w.provider FROM watchlist w WHERE w.sym = trends.sym LIMIT 1),
        'binance'
   );

CREATE INDEX IF NOT EXISTS trends_sym_tf_provider_idx ON trends(sym, tf, provider);
