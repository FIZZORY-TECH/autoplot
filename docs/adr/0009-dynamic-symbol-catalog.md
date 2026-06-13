# ADR-0009: Dynamic Symbol Catalog + `(provider, sym, quote)`-Mandatory-In-Key

Status: Accepted (2026-05-24)

Supersedes: nothing.
Extends: [ADR-0008](./0008-equities-provider.md) — widens the `provider`-mandatory-in-WHERE invariant by adding a mandatory `quote` dimension to the key.
Reaffirms: [ADR-0001](./0001-market-data-provider-frozen.md) — the three-method `MarketDataProvider` interface stays frozen; catalog discovery is exposed as a separate Rust trait + Tauri command surface, not a fourth method.

## Context

The 19-row hardcoded `ASSETS` constant in `src/data/assets.ts:7-29` is the only thing standing between the user and the ~12k pairs/tickers our four providers actually list (Binance ~2k, Coinbase ~500, Kraken ~700, Alpaca ~10k). It also hides a structural assumption: each adapter binds a single implicit quote per base (Binance → `USDT`, Coinbase → `USD`, Alpaca → `USD`). Real markets quote a base against many quotes, and SOL/USDT and SOL/USDC are not the same instrument — they have different liquidity, fees, and prices.

Lifting the hardcoded list forces three intertwined decisions:

1. **What is the canonical identity of a tradeable instrument?** Today it is `(provider, sym)`. ADR-0008 froze that as the WHERE-clause invariant. With a dynamic catalog, it must widen.
2. **Where does the searchable catalog live?** A per-keystroke REST call to four providers is unworkable (rate limits, latency, offline-hostile). The catalog must be cached locally.
3. **Can we change `AssetMeta`?** `src/data/MarketDataProvider.ts` carries a "FROZEN INTERFACE — STOP and surface for explicit user review" header. The freeze covers the three-method shape; the `Provider` and `AssetClass` unions have already been widened by ADR-0008 without breaking the freeze contract.

A pre-implementation review pass also surfaced two SQLite-shaped traps:

- **`watchlist` PK is `(sym, provider)`** — adding a `quote` column without a new table would forbid a user from ever holding both `BTC/USDT` and `BTC/USDC` on Binance, defeating the entire feature.
- **`bars` PK is `(provider, sym, tf, ts)`** — same trap one level down: cached BTC/USDT and BTC/USDC bars at the same timestamp would collide on the PK.

Because [ADR-0005](./0005-append-only-migrations.md) forbids editing or dropping a prior migration, the legacy tables cannot be redefined. The escape is forward-only: new `_v2` tables become the write path, and the legacy tables are backfilled into v2 by the migration and then frozen.

## Decision

The following seven rules are frozen as binding contract.

### 1. Canonical instrument identity widens to `(provider, sym, quote)`

Every read or write against `bars`, `marks`, `watchlist`, or `trends` MUST include `quote` in the key, in addition to the `(provider, sym)` requirement frozen by ADR-0008.

`sym` remains the canonical base token (e.g. `BTC`, `AAPL`). `quote` is the canonical quote token (e.g. `USDT`, `USDC`, `USD`). Provider-native wire strings (`BTCUSDT`, `BTC-USD`, `XXBTZUSD`) remain adapter-internal — exposed in the new `symbols.native_sym` column for callers that need to round-trip them.

Equity rows always carry `quote = 'USD'`. The mandatory column is unconditional — there is no NULL or empty-string escape hatch.

### 2. `AssetMeta` widens transitionally; `MarketDataProvider` stays frozen

```ts
// src/data/MarketDataProvider.ts
export interface AssetMeta {
  sym: string;
  quote?: string;           // ADR-0009 — transitional optional; tightened to `string` after Step 11
  name: string;
  provider: Provider;
  class: AssetClass;
}
```

`quote` lands as **optional** so the cross-cutting refactor (~30 callsites, including mocks, test factories, and MCP trace fixtures) can proceed in stages. The final commit of Step 11 flips it to required. Code that constructs an `AssetMeta` without a quote during the transitional window is acceptable only inside test fixtures and the legacy `realProvider.providerFor(sym)` path that this ADR deletes.

The three frozen methods on `MarketDataProvider` (`fetchHistory`, `subscribeRealtime`, `search`) are unchanged. The widening of `AssetMeta` is precedented by ADR-0008's widening of the `Provider` and `AssetClass` unions.

### 3. Catalog discovery lives on a separate trait + command surface

```rust
// src-tauri/src/providers/catalog.rs
pub trait CatalogFetcher: Send + Sync {
    fn id(&self) -> &'static str;
    async fn fetch_catalog(&self) -> Result<Vec<SymbolRow>, ProviderError>;
}
```

`CatalogFetcher` is implemented by each provider adapter alongside its existing bar-fetcher impl, but it is **not** a method on the frozen `MarketDataProvider` trait. The frontend invokes catalog fetches via the new `symbol_catalog_*` Tauri commands; the existing `getProvider(provider).search(q)` method continues to satisfy the frozen interface contract (it routes through the new commands in production, through the mock fixture in `vite dev` / Playwright).

### 4. New `_v2` tables for over-constrained PKs

The legacy PKs over-constrain the `(provider, sym, quote)` invariant and SQLite cannot redefine a PK in place. Two new tables are introduced by the migrations shipped with this ADR:

- **`watchlist_v2`** — `PRIMARY KEY (sym, provider, quote)`. All v1 rows are copied into v2 by the migration with per-provider quote backfill. v2 is the write path going forward. `watchlist` v1 is preserved untouched for historical audit only.
- **`bars_v2`** — `PRIMARY KEY (provider, sym, quote, tf, ts)`. All v1 rows are copied into v2 with the same per-provider backfill. v2 is the read + write path going forward. `bars` v1 is preserved untouched.

`marks` and `trends` do not need v2 tables — their PKs are surrogate (`AUTOINCREMENT` id and `TEXT id` respectively), and they are looked up via secondary indexes which can simply gain the `quote` column.

### 5. Per-provider quote backfill is deterministic and auditable

| Provider  | Default quote | Justification |
|-----------|---------------|---------------|
| binance   | `USDT`        | adapter literally appends `usdt` to the canonical sym before every REST call — every legacy row is a USDT pair |
| coinbase  | `USD`         | adapter uses `-USD` — every legacy row is a USD pair |
| kraken    | **per-row audit** | Kraken historically lists both USD and USDT pairs (e.g. `XBTUSDT` exists in their catalog). The migration must inspect each row's historical `sym` against the adapter's symbol map and pick the correct quote; default to `USD` only when the row matches a Z-suffix pair, otherwise `USDT`. A cargo migration test pins this against captured legacy rows. |
| alpaca    | `USD`         | USD-only equity feed; tradeable equities are quoted in USD |

The backfill is verified by a cargo test that synthesizes representative legacy rows and asserts every backfilled `quote` matches the adapter's actual symbol map.

### 6. Catalog cache is SQLite-resident with FTS5 search

The catalog itself is materialised in a new `symbols` table keyed by `(provider, sym, quote)`. A SQLite **FTS5** virtual table `symbols_fts` mirrors `(sym, name)` via insert/update/delete triggers, providing sub-millisecond substring + prefix search across the full 12k-row catalog without the `LIKE '%q%'` table-scan tax. A `symbols_meta` ledger records freshness per provider (`fetched_at`, `row_count`) for the refresh UI.

Refresh policy: lazy first-fetch on first use, 24h TTL, explicit refresh button. The TTL helper in `src/data/symbolCatalog.ts` uses an in-flight `Map<Provider, Promise<void>>` to dedupe concurrent refresh calls (e.g. rapid chip-switch storms). No app-boot prefetch — first user interaction is the trigger.

### 7. Rollback is forward-only

Once the `quote` column lands on the four widened tables and `watchlist_v2`/`bars_v2` go live, there is **no rollback path** that complies with ADR-0005. If the widening turns out to be wrong, the only remedy is another append-only migration (e.g. introducing a `_v3` table). This ADR exists in part to make that constraint visible and force the design conversation before the schema ships.

## Consequences

- Any SELECT / UPDATE / DELETE against `bars_v2`, `watchlist_v2`, `marks`, or `trends` that omits `quote` from the key is a build-breaker at review. `bars` and `watchlist` v1 are frozen — write paths route to v2.
- `marks` and `trends` gain a `quote TEXT NOT NULL DEFAULT ''` column + secondary index; their callers MUST pass `quote` in WHERE/INSERT (ADR-0008 invariant extended).
- Catalog size grows the SQLite footprint by a few MB (12k rows × ~80 bytes). Acceptable; the FTS5 virtual table approximately doubles that and is required for snappy search.
- `AssetMeta.quote` is optional only until Step 11; relying on the optionality past that point is a regression.
- The MCP bridge tool `list_assets` (ADR-0007 / ADR-0008) MUST now bound its response — cap to 50 rows and accept an optional `sym_prefix` filter so the LLM context isn't bloated by a 10k-row Alpaca dump.
- Coinbase's known 4h/1w granularity limit (ADR-0008 §5) now affects ~500 discoverable Coinbase pairs instead of the 4 originally curated. This is an accepted, surfaced regression — the existing `[TODO P8 toast]` marker covers it.
- The frontend's persistent state (`useAppStore.activeSym: string` in localStorage/Zustand) requires a hydrate shim to derive `{provider, quote}` for existing users; without it, the chart boot path breaks for anyone with prior session state.
- Adding a fifth provider remains gated by ADR-0008; that ADR's union-widening rule still applies.

## Source

- `src/data/MarketDataProvider.ts:33-38` — `AssetMeta` shape extension (transitional `quote?`)
- `src/data/assets.ts:7-29` — `ASSETS` constant slated for deletion (kept as `FEATURED_ASSETS` empty-state)
- `src-tauri/src/providers/catalog.rs` — new `SymbolRow` + `CatalogFetcher` trait
- `src-tauri/src/commands/symbols.rs` — new `symbol_catalog_fetch/list/search/meta` commands
- `src-tauri/migrations/0013_symbols_fts.sql` — `symbols` + `symbols_meta` + FTS5 virtual + triggers
- `src-tauri/migrations/0014_bars_v2.sql` — new `bars_v2` table + per-provider quote backfill
- `src-tauri/migrations/0015_watchlist_v2.sql` — new `watchlist_v2` table + per-provider quote backfill (Kraken per-row)
- `src-tauri/migrations/0016_marks_add_quote.sql` — `quote` column + secondary index
- `src-tauri/migrations/0017_trends_add_quote.sql` — `quote` column + secondary index
- `src/data/symbolCatalog.ts` — TTL helper + in-flight dedupe
- `src/stores/useAppStore.ts` — `activeAsset` replaces `activeSym` + Zustand hydrate shim for legacy strings
