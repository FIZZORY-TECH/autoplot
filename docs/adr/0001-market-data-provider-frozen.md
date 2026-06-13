# ADR-0001: MarketDataProvider Interface Is Frozen (A3)

Status: Accepted (2026-05-10)

## Context

`src/data/MarketDataProvider.ts` defines the canonical contract every market-data adapter must satisfy: `fetchHistory`, `subscribeRealtime`, `search`. The file's header comment (lines 1–3) declares the interface FROZEN per Architectural Decision A3 — "No phase after P1.1 may mutate this file."

Three real adapters (Binance P4.2, Coinbase P4.3, Kraken P4.4) and one fixture (`MockMarketDataProvider`, P1.1) already implement the interface. Downstream consumers — `providerRegistry`, `AppShell`, the chart pipeline, and the Zustand stores — bind to this exact shape. Mutating it cascades through the entire app.

The interface is also the layer where the Rust/TS process split is hidden: REST goes through Rust commands, WebSockets stay in TS, and the registry falls back to the mock when Tauri runtime is missing. That hiding only works if the contract is stable.

## Decision

Do NOT modify `src/data/MarketDataProvider.ts`. New providers MUST implement the existing three methods exactly as declared. Adapters MUST internally map the canonical token (e.g. `'BTC'`) to provider-specific symbols (`BTCUSDT` / `BTC-USD` / `XBT/USD`). If a real-world gap is found that genuinely cannot be expressed under the current interface, STOP and surface the gap to the user for explicit review — do not add a method, parameter, or generic on your own.

## Consequences

- New methods, parameters, generics, or `Tf` extensions on this interface are forbidden.
- New providers (e.g. a future stocks adapter) MUST adopt the existing three-method shape; per-row symbol remapping is adapter-internal.
- Refactors that "improve" the contract are blocked at review.
- The `MockMarketDataProvider` remains the deterministic test/offline fixture; it MUST also satisfy the same shape.
- Any proposed change requires a new ADR superseding this one and explicit user approval.

Source: src/data/MarketDataProvider.ts:1-3, src/data/MarketDataProvider.ts:41-54
