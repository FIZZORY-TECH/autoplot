-- 0004_bars.sql — P4.1 warm cache for OHLCV bars (per A1)
--
-- Stores history fetched via Rust REST adapters (Binance / Coinbase / Kraken)
-- so that subsequent loads of the same (provider, sym, tf) range can be served
-- from disk and topped up from the network rather than re-fetched in full.
--
-- PK is composite (provider, sym, tf, ts) — the same canonical token (e.g. BTC)
-- routed through different providers stays in distinct rows; upserts are
-- idempotent on bar identity.

CREATE TABLE bars (
  provider TEXT NOT NULL,
  sym      TEXT NOT NULL,
  tf       TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  o        REAL NOT NULL,
  h        REAL NOT NULL,
  l        REAL NOT NULL,
  c        REAL NOT NULL,
  v        REAL NOT NULL,
  PRIMARY KEY (provider, sym, tf, ts)
);

-- Range queries always hit (provider, sym, tf, ts DESC) — most recent first.
CREATE INDEX idx_bars_lookup ON bars(provider, sym, tf, ts DESC);
