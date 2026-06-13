-- Migration 0002: marks (price annotations + comments).
-- This file is IMMUTABLE once written. Append new migrations as 0003_*.sql, etc.
-- A `note` of NULL distinguishes a Mark from a Comment (note != NULL).
-- `ts` anchors the mark to a specific bar timestamp (unix milliseconds).

CREATE TABLE marks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sym        TEXT    NOT NULL,
  price      REAL    NOT NULL,
  ts         INTEGER NOT NULL,         -- bar timestamp (unix ms)
  color      TEXT    NOT NULL,         -- one of the 5 swatch tokens
  note       TEXT,                     -- nullable; null = Mark, non-null = Comment
  created_at INTEGER NOT NULL          -- unix ms
);

CREATE INDEX idx_marks_sym ON marks(sym);
