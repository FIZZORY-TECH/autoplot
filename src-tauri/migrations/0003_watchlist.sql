-- 0003_watchlist.sql — P3.1
-- Append-only per A1: do NOT modify earlier migrations.

CREATE TABLE watchlist (
  sym        TEXT    NOT NULL,
  provider   TEXT    NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (sym, provider)
);

CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
