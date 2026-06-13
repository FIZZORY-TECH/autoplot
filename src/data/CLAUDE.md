# src/data — CLAUDE.md

> **FROZEN interface, widened unions.** The 3-method `MarketDataProvider` interface (`fetchHistory`, `subscribeRealtime`, `search`) and the `Bar` shape in `MarketDataProvider.ts` are FROZEN — see [ADR-0001](../../docs/adr/0001-market-data-provider-frozen.md). `Tf` is locked to `'1h' | '4h' | '1d' | '1w'` — see [ADR-0002](../../docs/adr/0002-timeframe-set-locked.md). Do not add 5m/15m even though the prototype shows them.
>
> **Equity support added (2026-05-23).** `Provider` now includes `'alpaca'`; `AssetClass` now includes `'equity'` (see [ADR-0008](../../docs/adr/0008-equities-provider.md)). The interface itself is unchanged — only the unions widened. Adding a sixth provider or a third asset class requires a new ADR.

## Provider registry

`providerRegistry.ts` routes `Provider` ids to adapters in `adapters/{coinbase,binance,kraken,alpaca}.ts`. Falls back to `MockMarketDataProvider` (`mockProvider.ts`) when the Tauri runtime is missing or an adapter isn't registered. `localStorage['use-mock-provider']=1` forces the mock for **quotes and history**, but the symbol **catalog/search** is NOT mocked — `searchSymbols()` returns `[]` (with a `[TODO P8 toast]` warn) when there is no Tauri runtime; the real FTS5 SQLite catalog via `invoke` is required. `mockProvider.ts` provides only synthetic quote/history data; the former `MOCK_CATALOG` fixture was removed in the live-catalog pivot (2026-06-07).

## Symbol mapping

Canonical token (`'BTC'`) → provider-specific symbol (`BTCUSDT` / `BTC-USD` / `XBT/USD`) is **internal to each adapter**. App state and IPC carry only the canonical token.

## Process split

- **REST history** goes through Rust (`market_fetch_history` Tauri command — see [docs/reference/tauri-ipc.md](../../docs/reference/tauri-ipc.md)). Rust enforces per-provider rate limits and writes through `db_bars_upsert`.
- **WebSocket realtime** is in TS, here in `adapters/`, surfaced via `realtime.ts`. The `subscribeRealtime` callback returns an unsubscribe — callers MUST invoke it on cleanup.
