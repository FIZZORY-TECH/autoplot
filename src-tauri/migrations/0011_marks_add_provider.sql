-- Migration 0011: add `provider` column to `marks` (ADR-0008).
-- This file is IMMUTABLE once written. Append new migrations as 0012_*.sql, etc.
--
-- Rationale: ADR-0008 freezes the `provider`-mandatory-in-WHERE invariant for
-- every read against bars/marks/watchlist/trends. The marks table predates the
-- multi-provider era and keyed only on `sym`; without `provider`, equity-era
-- collisions like ('alpaca','SPY') vs ('binance','SPY') would silently fuse.
--
-- Backfill rule: prefer the provider already chosen in `watchlist` for this
-- sym; fall back to 'binance' so historical rows remain queryable. Pre-equity
-- installs only ever held crypto rows so this default never mis-attributes
-- an equity mark.

ALTER TABLE marks ADD COLUMN provider TEXT NOT NULL DEFAULT 'binance';

UPDATE marks
   SET provider = COALESCE(
        (SELECT w.provider FROM watchlist w WHERE w.sym = marks.sym LIMIT 1),
        'binance'
   );

CREATE INDEX IF NOT EXISTS marks_sym_provider_idx ON marks(sym, provider);
