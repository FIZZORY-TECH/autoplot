# ADR-0010: Portfolio holdings model

**Status:** Accepted
**Date:** 2026-06-06

## Context

No holdings tracking existed before this decision. The app needed a way to
record paper-trading positions so the Portfolio panel and MCP agent tools could
read and mutate them.

Two models were considered:

1. **Transaction ledger** — append-only rows per buy/sell event; realized P&L
   and FIFO cost-basis accounting are computable from history but add significant
   complexity for a v1 feature.

2. **Denormalized holdings** — one row per `(sym, provider, quote)` that stores
   the current qty and a rolling weighted-average cost; simpler to read and write,
   adequate for paper-trading without real brokerage integration.

The denormalized model was chosen for v1. Identity follows ADR-0008/0009:
`(sym, provider, quote)` is the canonical composite primary key so BTC/USDT and
BTC/USDC are stored as distinct rows. Currency defaults to USD; no FX conversion
is performed (stablecoins are treated as ≈$1). Agent access is via
consent-gated MCP tools (`portfolio_*` in the sidecar).

The portfolio is now fully CLI-controllable from the in-app terminal via the
seven `portfolio_*` MCP tools: `portfolio_list_holdings`,
`portfolio_get_summary`, `portfolio_get_allocation` (read) and
`portfolio_set_holding`, `portfolio_add_lot`, `portfolio_reduce_holding`
(partial sell), `portfolio_remove_holding` (mutation). Each mutation emits a
`portfolio:changed` Tauri event so the Portfolio panel refreshes live.

## Decision

- Holdings MUST be stored one row per `(sym, provider, quote)` in
  `portfolio_holdings`. The composite PK is enforced by the migration schema.
- `avg_cost` MUST be maintained as a weighted average blended on every
  `db_portfolio_add_lot` call. The formula is:
  `new_avg = (existing_qty × existing_avg + add_qty × add_price) / (existing_qty + add_qty)`.
- Realized P&L, FIFO cost basis, and a transaction ledger MUST NOT be
  implemented in v1. Deferral is explicit.
- `value` and unrealized P&L MUST be computed at read time by the frontend
  (`src/lib/portfolioMath.ts`) using the current market price; they MUST NOT
  be stored in the DB.
- Agent mutations (add lot, set holding, reduce, remove) MUST go through the MCP
  consent routing in `ipc_bridge.rs` — direct DB writes from the agent are
  forbidden.

### Accepted risk: silent CLI-driven mutation

The chat-era consent toast (`MCPConsentToast`) was removed when the chat UI was
deleted (CLI/Terminal is now the only AI surface). With no UI to render a
prompt, `mcp.autoApprove` defaults to `"always"`, so the consent routing in
`ipc_bridge.rs` applies CLI-driven portfolio mutations WITHOUT a user prompt.

This is an **ACCEPTED RISK** for this research / paper-only surface: no real
orders are ever placed and holdings are paper positions only. It is mitigated by
the onboarding skill
(`src-tauri/resources/profile-assets/skills/autoplot-onboarding/SKILL.md`),
which instructs the agent to echo the intended change back to the user before
calling any `portfolio_*` mutation tool. If a real-money or higher-stakes
surface is ever added, a new superseding ADR MUST reintroduce an explicit
confirmation gate.

## Consequences

**Forbidden:**
- Editing or dropping `src-tauri/migrations/0018_portfolio.sql` (ADR-0005 append-only rule).
- Storing computed value/P&L columns in `portfolio_holdings`.
- Implementing FIFO or realized-P&L without a new superseding ADR.

**Required:**
- All DB writes go through `src-tauri/src/commands/db.rs` helpers
  (`holding_add_lot`, `holdings_list`, etc.) and surface as Tauri commands.
- New holdings-related schema changes append a new migration file.
- Frontend math lives in `src/lib/portfolioMath.ts` and is covered by
  `src/stores/usePortfolioStore.test.ts`.

**Observable behavior:**
- Adding a second lot to an existing position blends `avg_cost`; removing the
  position deletes the row entirely.
- The panel header shows total value and unrealized P&L recomputed on every
  price tick — no stale DB values.

**Source:**
- Schema enforcement: `src-tauri/migrations/0018_portfolio.sql`
- Logic enforcement: `holding_add_lot` and `holdings_list` helpers in
  `src-tauri/src/commands/db.rs` (lines 1383+, 1327+)
