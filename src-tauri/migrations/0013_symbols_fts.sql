-- Migration 0013: dynamic symbol catalog (ADR-0009).
-- This file is IMMUTABLE once written. Append new migrations as 0014_*.sql, etc.
--
-- Stores the per-provider catalog of tradeable instruments populated by the new
-- `symbol_catalog_fetch` Tauri command. The catalog is queried by `AddAssetModal`
-- and `Palette` search; FTS5 makes substring/prefix lookup over 12k+ rows fast
-- enough for per-keystroke (debounced) search.
--
-- Canonical instrument identity is `(provider, sym, quote)` — ADR-0009 extends
-- ADR-0008's `provider`-mandatory-in-key invariant with the `quote` dimension.

CREATE TABLE symbols (
  provider   TEXT NOT NULL,
  sym        TEXT NOT NULL,       -- canonical base, e.g. 'BTC', 'SOL', 'AAPL'
  quote      TEXT NOT NULL,       -- canonical quote, e.g. 'USDT', 'USDC', 'USD'
  name       TEXT,                -- human display name where provider returns one
  class      TEXT NOT NULL,       -- 'crypto' | 'equity'
  status     TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'halted' | 'delisted'
  native_sym TEXT NOT NULL,       -- provider-native string (e.g. 'BTCUSDT', 'BTC-USD', 'XXBTZUSD')
  PRIMARY KEY (provider, sym, quote)
);

CREATE INDEX symbols_provider_idx ON symbols(provider);

-- One-row-per-provider freshness ledger consulted by the "Refresh catalog" UI.
CREATE TABLE symbols_meta (
  provider   TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,    -- unix ms
  row_count  INTEGER NOT NULL
);

-- FTS5 virtual table mirroring (sym, name) for sub-millisecond substring search.
-- Contentless table (`content=`) is unsuitable here because we want triggers to
-- keep FTS in sync with INSERTs to `symbols`; we use the rowid linkage pattern.
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  sym,
  name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Keep symbols_fts in sync with the symbols table. rowid in FTS maps to the
-- rowid of the source row in `symbols` so we can JOIN back for the full record.
CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, sym, name) VALUES (new.rowid, new.sym, COALESCE(new.name, ''));
END;

CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, sym, name) VALUES('delete', old.rowid, old.sym, COALESCE(old.name, ''));
END;

CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, sym, name) VALUES('delete', old.rowid, old.sym, COALESCE(old.name, ''));
  INSERT INTO symbols_fts(rowid, sym, name) VALUES (new.rowid, new.sym, COALESCE(new.name, ''));
END;
