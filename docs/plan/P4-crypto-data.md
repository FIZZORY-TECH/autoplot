# P4 — Real Crypto Data Layer

## Status

**Completed** — landed in session 1 (P4.1 sequential + P4.2/P4.3/P4.4 parallel + P4.5 sequential). Verified via:
- `npm run lint && npm run typecheck && npm test && cargo test` all green
- Live REST smokes against Binance, Coinbase, and Kraken production APIs — succeeded
- Live BTC tick renders on chart; offline shows stale badge + cached bars
- Rate-limiter unit-tested in Rust (cargo test green)
- Vitest adapter fixture tests and TS WS message handler tests green
- 10-minute soak test stub exists at `tests/e2e/p4-soak.spec.ts` — hard-skipped by default; run manually with `SOAK=1`

The full dispatch record for this phase is retained in the project history.

**Key deviations from original spec:**
- *REST through Rust / WS through TS (A2):* original P4 spec placed all adapters in `src/data/adapters/*.ts` (TS-side). Per A2, REST (`klines`/`candles`/`OHLC`) runs **inside Rust Tauri commands** (`src-tauri/src/providers/{binance,coinbase,kraken}.rs`); WS subscriptions run in `src/data/adapters/*.ts` (TS). This eliminates CORS and centralises rate-limiting in Rust.
- *Rate-limiter in Rust:* `src-tauri/src/providers/rate_limit.rs` token-bucket (Binance 1200/min, Coinbase 10/s, Kraken 1/s) — originally implied to be in TS per P4-15 phrasing; landed in Rust per A2.
- *`MarketDataProvider` interface NOT mutated:* confirmed FROZEN per A3; no structural changes were made. P4.1 verified the shape before building adapters and found no gap requiring escalation.
- *Coinbase 4h/1w rejection:* Coinbase REST API does not support `4h` or `1w` granularity. This is an API limitation, not a bug. Documented in `src/data/adapters/coinbase.ts`; affected timeframes fall back gracefully.
- *P4-16 toast UX:* toast component (P8) does not exist yet. Network failures emit `console.warn` with `[TODO P8 toast]` markers; a `staleAt` timestamp is set on the headline for a 'stale' badge when cache is older than 60s.
- *`0004_bars.sql` migration:* `bars(provider, sym, tf, ts, o, h, l, c, v, PRIMARY KEY(provider, sym, tf, ts))` added per A1.
- *Two Rust cargo tests `#[ignore]`d:* they hit live APIs; run manually with `cargo test -- --ignored`.

**Hand-off:** P5 — Claude CLI Full Capability Surface. See `docs/plan/HAND-OFF.md`.

---

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of P0–P3 (or [P1](./P1-core-charting.md) minimum). Locked-in: crypto only, free public APIs.

**Goal:** replace `MockMarketDataProvider` with real Coinbase / Binance / Kraken adapters; cache; rate-limit; live updates.

## Checklist

### Interface
- [x] **P4-1** `MarketDataProvider` TS interface verified FROZEN in `src/data/MarketDataProvider.ts` per A3. No structural changes made — P4.1 confirmed no gap requiring escalation.
- [x] **P4-2** Rust trait `MarketDataProvider` defined in `src-tauri/src/providers/mod.rs`; implemented by Binance, Coinbase, Kraken adapters.

### REST adapters
- [x] **P4-3** ~~`src/data/adapters/binance.ts`~~ — *REST lands in Rust per A2: `src-tauri/src/providers/binance.rs`, `GET /api/v3/klines`, mapped to `Bar`.*
- [x] **P4-4** ~~`src/data/adapters/coinbase.ts`~~ — *REST lands in Rust per A2: `src-tauri/src/providers/coinbase.rs`, `GET /products/{id}/candles`. Note: Coinbase rejects `4h` and `1w` granularity (API limitation, documented in source).*
- [x] **P4-5** ~~`src/data/adapters/kraken.ts`~~ — *REST lands in Rust per A2: `src-tauri/src/providers/kraken.rs`, `GET /0/public/OHLC`.*
- [x] **P4-6** Per-provider symbol mapping: `BTC → BTCUSDT` (Binance), `BTC → BTC-USD` (Coinbase), Kraken pair conventions. In Rust adapters.
- [x] **P4-7** Pagination/backfill — Binance 1000-bar cap per call; chain calls if `count > 1000`. In Rust adapter.

### WebSocket realtime
- [x] **P4-8** Binance WS `wss://stream.binance.com:9443/ws/{sym}@kline_{tf}` — in `src/data/adapters/binance.ts` (TS, per A2). Exponential backoff with jitter on reconnect.
- [x] **P4-9** Coinbase WS `wss://ws-feed.exchange.coinbase.com` ticker channel — in `src/data/adapters/coinbase.ts` (TS, per A2). Backoff with jitter.
- [x] **P4-10** Kraken WS `wss://ws.kraken.com` ohlc subscription — in `src/data/adapters/kraken.ts` (TS, per A2). Backoff with jitter.
- [x] **P4-11** Single active subscription at a time (active asset only); auto-resub on reconnect with exponential backoff.

### Cache layer
- [x] **P4-12** `src/data/ohlcCache.ts` — memory LRU keyed by `(provider, sym, tf)`.
- [x] **P4-13** SQLite warm cache `bars(provider, sym, tf, ts, o, h, l, c, v)` with `(provider, sym, tf, ts)` PK. *Migration: `0004_bars.sql` per A1.*
- [x] **P4-14** Cache flow: TS calls Rust command `market_fetch_history` → Rust serves cache → updates from network through rate-limiter → upserts to `bars` → returns to TS.

### Rate limiting / errors
- [x] **P4-15** Token-bucket per provider in Rust (`src-tauri/src/providers/rate_limit.rs`): Binance 1200/min, Coinbase 10/s, Kraken 1/s. Unit-tested; cargo test green.
- [x] **P4-16** ~~Toast UX~~ — *P8 toast component does not exist yet. Network failures emit `console.warn` with `[TODO P8 toast]` markers. `staleAt` timestamp set on headline; 'stale' badge renders when cache is older than 60s.*
- [x] **P4-17** Sparkline polling for watchlist: throttled to 30s, batched per provider where supported.
- [x] **P4-18** Graceful degraded mode — if all providers unreachable, render cached bars with "stale" badge. Tested manually (kill network → stale shows; restore → recovers).

### Routing
- [x] **P4-19** `useWatchlistStore` and chart data hook wired to real providers via Rust `market_fetch_history` command + TS WS adapters. `MockMarketDataProvider` retained for tests + offline dev (`localStorage.setItem('use-mock-provider', '1')` in DevTools triggers fallback).

### Tests
- [x] **P4-20** Vitest: adapter response parsing with recorded JSON fixtures (Rust unit tests for parsers; TS unit tests for WS message handlers).
- [x] **P4-21** Vitest: Rust rate-limit token bucket unit-tested (cargo test).
- [x] **P4-22** Manual smoke: live BTC tick renders on chart (confirmed). *Two cargo tests `#[ignore]`d — hit live APIs; run manually with `cargo test -- --ignored`.* *10-min soak test stub at `tests/e2e/p4-soak.spec.ts` hard-skipped; run manually with `SOAK=1`.*

## Acceptance

Switching asset fetches real bars; chart updates live; turning off network shows graceful cached state with toast.

## Risks

- CORS — Tauri's webview can fetch arbitrary origins because requests are made via Rust if needed. If browser-side fetch hits CORS, route through Rust command.
- WS reconnect storms — verify backoff jitter.

## Hands off to

[P5 — Claude CLI Full Capability Surface](./P5-claude-cli.md).
