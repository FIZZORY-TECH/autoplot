-- Migration 0010: AI workspace tables — research notes, rich datasets,
-- strategies with revision history, and paper-trade ledger.
-- This file is IMMUTABLE once written. Append new migrations as 0011_*.sql, etc.
--
-- Note: `datasets` (0008) and `strategies` (0009) already exist as simpler
-- blob-storage tables used by Co-Research / Co-Strategy commands.  The richer
-- structured tables below are named `ai_datasets` and `ai_strategies` to avoid
-- collision.  They serve the MCP persistence layer (Step 2 of the Terminal /
-- MCP-bridge plan).
--
-- All timestamp columns are unix milliseconds (INTEGER), consistent with the
-- existing marks / bars / trends / ai_sessions tables.

-- -------------------------------------------------------------------------
-- research_notes
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS research_notes (
    id          TEXT    PRIMARY KEY,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    tags_json   TEXT    NOT NULL DEFAULT '[]',
    symbol      TEXT,
    timeframe   TEXT,
    created_at  INTEGER NOT NULL   -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_research_notes_created
    ON research_notes(created_at DESC);

-- -------------------------------------------------------------------------
-- ai_datasets — richer than the existing `datasets` blob table.
-- `kind`        : 'overlay' | 'series'   (mirrors Dataset.kind in schemas.ts)
-- `values_json` : serialised Dataset.values array
-- `source`      : 'ai' | 'upload' | 'user'
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_datasets (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    timeframe   TEXT    NOT NULL,
    kind        TEXT    NOT NULL,           -- 'overlay' | 'series'
    values_json TEXT    NOT NULL,           -- JSON array of numeric values
    source      TEXT    NOT NULL DEFAULT 'ai',  -- 'ai' | 'upload' | 'user'
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_datasets_symbol
    ON ai_datasets(symbol, timeframe);

-- -------------------------------------------------------------------------
-- ai_strategies — head record; body_json holds the current revision DSL.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_strategies (
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    body_json         TEXT    NOT NULL,     -- canonical Strategy DSL JSON for current_revision
    current_revision  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

-- -------------------------------------------------------------------------
-- strategy_revisions — append-only history; existing rows are NEVER mutated.
-- Each update_strategy call inserts a new row with rev = current_revision + 1
-- and bumps ai_strategies.current_revision.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strategy_revisions (
    id          TEXT    PRIMARY KEY,
    strategy_id TEXT    NOT NULL REFERENCES ai_strategies(id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    body_json   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (strategy_id, rev)
);
CREATE INDEX IF NOT EXISTS idx_strategy_revisions_sid
    ON strategy_revisions(strategy_id, rev DESC);

-- -------------------------------------------------------------------------
-- paper_positions — open and closed paper-trade positions.
-- `side`      : 'long' | 'short'
-- `closed_at` : NULL while position is open
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_positions (
    id          TEXT    PRIMARY KEY,
    symbol      TEXT    NOT NULL,
    side        TEXT    NOT NULL,   -- 'long' | 'short'
    qty         REAL    NOT NULL,
    ref_price   REAL    NOT NULL,
    opened_at   INTEGER NOT NULL,
    closed_at   INTEGER,            -- NULL while open
    close_price REAL
);
CREATE INDEX IF NOT EXISTS idx_paper_positions_open
    ON paper_positions(closed_at) WHERE closed_at IS NULL;

-- -------------------------------------------------------------------------
-- paper_fills — individual fill events for a position.
-- `kind` : 'open' | 'close' | 'adjust'
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_fills (
    id          TEXT    PRIMARY KEY,
    position_id TEXT    NOT NULL REFERENCES paper_positions(id) ON DELETE CASCADE,
    ts          INTEGER NOT NULL,
    qty         REAL    NOT NULL,
    price       REAL    NOT NULL,
    kind        TEXT    NOT NULL    -- 'open' | 'close' | 'adjust'
);
