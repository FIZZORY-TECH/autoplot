# ADR-0008: Equities Provider Added — Union Widening + Provider-Mandatory-In-WHERE Invariant

Status: Accepted (2026-05-23)

Supersedes: the closed-union portion of [ADR-0001](./0001-market-data-provider-frozen.md) (specifically the implicit assumption that `Provider` and `AssetClass` were crypto-only). The rest of ADR-0001 — the three-method interface, the frozen `Bar` shape, the adapter-internal symbol remap — remains in force unchanged.

## Context

Phase plan extends the workspace to cover US equities alongside crypto. The codebase was scaffolded with this widening in mind: `AddAssetModal` already has NASDAQ/NYSE chips, the DB schema for `bars`/`watchlist` is asset-class-agnostic, and ADR-0001 explicitly permits new providers as long as they adopt the frozen three-method `MarketDataProvider` shape.

Equity support introduces a fourth provider (**Alpaca Markets**, IEX free tier with optional SIP upgrade) and a second asset class (`'equity'`). Without a freezing decision now, two latent hazards land with the first equity row:

1. **Symbol collisions across providers.** `('binance', 'SPY')` and `('alpaca', 'SPY')` could collide silently in `bars`/`marks`/`watchlist`/`trends` reads that key only on `sym`.
2. **4h bucket drift.** Alpaca returns session-aligned 4h bars by default (US market hours); crypto adapters return UTC-aligned bars. Mixing both on one chart axis would render visually misaligned candles.

Step 0 of the equities plan audited `src/lib/db.ts` and `src-tauri/src/commands/db.rs` and found two queries that read `marks` and `trends` with `sym` alone in the WHERE clause. Those violations are corrected by the migrations and SQL changes shipped alongside this ADR.

## Decision

The following five rules are frozen as binding contract for any new provider, equity or otherwise.

### 1. Union widening (closed → wider closed)

```ts
// src/data/MarketDataProvider.ts
export type Provider = 'binance' | 'coinbase' | 'kraken' | 'alpaca';
export type AssetClass = 'crypto' | 'equity';
```

The unions remain CLOSED (no `string` escape hatch). Adding a sixth provider or a third asset class requires a new ADR superseding this one.

### 2. Interface, `Bar`, and `Tf` remain frozen (re-affirms ADR-0001 / ADR-0002)

- The 3-method `MarketDataProvider` interface (`fetchHistory`, `subscribeRealtime`, `search`) is unchanged.
- The `Bar` shape (`{ ts, o, h, l, c, v }`) is unchanged.
- The `Tf` set is unchanged: `'1h' | '4h' | '1d' | '1w'`. No minute, tick, pre-market, or session-extended timeframes are permitted.

### 3. `list_assets` return shape (frozen)

Both `src-tauri/src/ipc_bridge.rs::list_assets` and any future TS-side wrapper MUST return rows of exactly this shape, with snake_case wire fields:

```ts
{ provider: Provider; sym: string; class: AssetClass; name?: string }[]
```

No additional required fields, no renaming, no `displayName` collapse onto `name` — `name` stays optional. Adapters that lack a human-readable name omit the field rather than echoing the symbol.

### 4. `provider`-mandatory-in-WHERE invariant (frozen, enforced now)

Every read or write against `bars`, `marks`, `watchlist`, or `trends` MUST include `provider` in the key. The schema must back this — every one of these four tables carries a `provider TEXT NOT NULL` column. Queries that key only on `sym` are forbidden and will be rejected at review.

This invariant exists because once equities land, `('alpaca', 'SPY')` and a hypothetical future `('binance', 'SPY')` collide silently otherwise. The crash mode is data corruption, not an error — there is no acceptable way to relax this rule.

Concretely:
- `bars` — already correct (PK is `(provider, sym, tf, ts)`).
- `watchlist` — already correct (PK is `(sym, provider)`).
- `marks` — `provider` column added by migration `0011_marks_add_provider.sql`; backfilled from `watchlist` when possible, defaulted to `'binance'` otherwise. Index `marks_sym_provider_idx ON marks(sym, provider)`.
- `trends` — `provider` column added by migration `0012_trends_add_provider.sql`; same backfill + default rule. Index `trends_sym_tf_provider_idx ON trends(sym, tf, provider)`.

### 5. 4h alignment for equities — UTC-bucketed (frozen)

The equity adapter (Alpaca) MUST return UTC-aligned 4h bars matching the crypto adapter behavior. If the upstream API returns session-aligned 4h bars, the adapter MUST resample to UTC buckets internally. The chart axis is one timeline; mixing alignments per-asset is not permitted.

### 6. Equity accent token — `var(--emerald)` (provisional)

The equity asset class is keyed to the CSS token `var(--emerald)` for accent dots, chips, and headline glyph color. Crypto remains on `var(--accent)`.

**Follow-up (gating Step 4):** `--emerald` is not currently defined in `src/styles/tokens.css` (audited 2026-05-23 — the file declares `--accent: oklch(0.82 0.14 215)` but no emerald variant). Before Step 4 ships the NASDAQ/NYSE chip enablement, one of the following must hold:

- Add `--emerald` to `src/styles/tokens.css` with an OKLCH value that meets the contrast budget against `--bg-0` / `--ink-0`, and re-run the `brand-icons` generator if any icon raster depends on the token.
- OR the user explicitly approves an alternative token name; this ADR is then amended (new ADR superseding this one).

The chips MUST NOT ship using `var(--ink-2)` (which signals "disabled" elsewhere) or `var(--accent)` (which is the crypto color).

## Consequences

- New providers MUST satisfy the existing three-method `MarketDataProvider` shape; ADR-0001's per-row adapter-internal symbol remap rule continues to apply (e.g., Alpaca maps the canonical token `AAPL` to its own wire format).
- Any SELECT / UPDATE / DELETE against `bars` / `marks` / `watchlist` / `trends` that omits `provider` from the key is a build-breaker at review.
- The four storage tables now uniformly carry a `provider` column; the migration set is append-only (see [ADR-0005](./0005-append-only-migrations.md)).
- The `Tf` and `Bar` constraints from ADR-0001 / ADR-0002 are reinforced — equities do NOT unlock minute bars, pre-market, or session-aligned 4h.
- Until `--emerald` is defined and approved, Step 4 (the UI enablement of NASDAQ/NYSE chips) is blocked.
- Any later asset class (forex, options, fixed income) requires a new ADR widening the union, plus a credentials/keychain story; this ADR does not pre-authorize them.

## Source

- src/data/MarketDataProvider.ts:1-3, src/data/MarketDataProvider.ts:41-54
- src-tauri/src/commands/db.rs (marks_list, marks_insert, trends_list, trends_insert — updated to include `provider` in WHERE/INSERT per this ADR)
- src-tauri/migrations/0011_marks_add_provider.sql (new, this ADR)
- src-tauri/migrations/0012_trends_add_provider.sql (new, this ADR)
- src/styles/tokens.css (audit: `--emerald` not yet defined; follow-up required before Step 4)
