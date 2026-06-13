---
name: autoplot-onboarding
description: Auto-loaded house guide for the autoplot app. Covers the mcp__autoplot__* tool surface, indicator/strategy schemas, consent semantics, and a paper-trading-only guardrail. Invoke before suggesting chart mutations.
---

# Trading-Portal Onboarding

This skill is the authoritative reference for every agent operating inside the autoplot app's isolated Claude profile. Read it before suggesting any chart mutation or MCP tool call.

---

## Available MCP tools

All tools are prefixed `mcp__autoplot__`. They are served by the `autoplot-mcp` sidecar over a local Unix-domain socket / named pipe. If the app is not running, every call returns `{ code: "app_not_running" }`.

### Read-only tools (no consent required)

| Tool | Purpose | Primary argument shape |
|---|---|---|
| `fetch_ohlc` | Fetch OHLC bars from the exchange REST API | `{ symbol: string, timeframe: string, limit: number }` |
| `compute_indicator` | Compute a named indicator over a bar array | `{ name: Indicator, bars: OhlcBar[], params?: Record<string,number> }` |
| `get_current_symbol` | Return the symbol currently shown on the chart | _(no args)_ |
| `get_visible_range` | Return `{ start: number, end: number, timeframe: string }` for the visible window | _(no args)_ |
| `list_overlays` | List all active overlays and strategy overlays on the chart | _(no args)_ |
| `list_assets` | Return the full list of tradable assets available in the app | _(no args)_ |
| `list_attachments` | List user-uploaded files available for the current session | `{ session?: string }` |
| `read_attachment` | Read the content of a user-uploaded file (CSV, JSON, text) | `{ file_id: string }` |
| `validate_strategy` | Validate a Strategy DSL object against the schema; returns errors or `{ valid: true }` | `{ strategy: Strategy }` |
| `backtest_strategy` | Run a strategy against historical OHLC data; returns `PerfStats` | `{ strategy: Strategy, symbol: string, timeframe: string, range?: { start: number, end: number } }` |
| `list_datasets` | List persisted named datasets | `{ filter?: { symbol?: string, timeframe?: string, kind?: string } }` |
| `load_dataset` | Load a persisted dataset by id | `{ id: string }` |
| `list_strategies` | List saved strategies | `{ filter?: { symbol?: string } }` |
| `load_strategy` | Load a saved strategy by id | `{ id: string }` |
| `list_research_notes` | List saved research notes | `{ filter?: { symbol?: string, tags?: string[] } }` |
| `get_paper_pnl` | Return current paper-trading P&L summary | _(no args)_ |

### Mutation tools (consent required unless `mcp.autoApprove = always`)

| Tool | Purpose | Primary argument shape |
|---|---|---|
| `apply_dataset` | Render a Dataset as a chart overlay | `{ dataset: Dataset }` |
| `remove_dataset` | Remove a dataset overlay by id | `{ id: string }` |
| `apply_timeline_events` | Add a named event layer to the chart time axis | `{ id: string, name: string, events: TimelineEvent[] }` |
| `remove_timeline_layer` | Remove a timeline event layer by id | `{ id: string }` |
| `apply_strategy` | Render entry/exit markers + signal overlay for a saved strategy | `{ id: string }` |
| `remove_strategy_overlay` | Clear a strategy overlay by id | `{ id: string }` |
| `open_strategy_artifact` | Open the Strategy Artifact Panel and select a strategy | `{ id: string }` |
| `save_dataset` | Persist a named dataset to the DB | `{ dataset: Dataset }` |
| `save_strategy` | Persist a strategy; optional `overwrite: true` replaces existing | `{ strategy: Strategy, overwrite?: boolean }` |
| `update_strategy` | Apply a partial patch, creating a new revision | `{ id: string, patch: Partial<Strategy> }` |
| `delete_strategy` | Soft-delete a strategy | `{ id: string }` |
| `save_research_note` | Persist a research note | `{ title: string, body: string, tags?: string[] }` |
| `paper_open_position` | Open a paper-trading position | `{ symbol: string, side: "long"\|"short", qty: number, ref_price: number }` |
| `paper_close_position` | Close a paper-trading position by id | `{ id: string }` |
| `delete_dataset` | Delete a persisted dataset | `{ id: string }` |

### TimelineEvent shape

```json
{
  "timestamp": 1704067200000,
  "label": "FOMC Meeting",
  "color": "#f59e0b",
  "kind": "vline"
}
```

`kind` options: `"pin"` (floating callout above bar), `"vline"` (full-height vertical line), `"range"` (shaded horizontal band — requires `endTimestamp`).

---

## Indicator enum (15 entries)

Verbatim from `src/ai/schemas.ts`:

```
'close'
'open'
'high'
'low'
'volume'
'sma'
'ema'
'rsi'
'atr'
'bollinger_upper'
'bollinger_middle'
'bollinger_lower'
'donchian_high'
'donchian_low'
'realized_vol'
```

These are the only valid values for the `indicator` field in `StrategyCondition` and the `name` argument in `compute_indicator`. Anything else will be rejected by the schema.

---

## Strategy schema

```
Strategy {
  id:        string            — stable UUID
  name:      string            — short human name
  thesis:    string            — why this edge exists
  rules: {
    entry:   StrategyCondition[]  — min 1; AND logic only
    exit:    StrategyCondition[]  — min 1; AND logic only
    filters: StrategyCondition[]  — optional; applied before entry
  }
  perf:      PerfStats | null   — set after backtest; null before
  version:   1                 — always literal 1
  createdAt: number            — Unix milliseconds
}

StrategyCondition {
  indicator: Indicator                       — one of the 15 enum values
  op:        '<'|'>'|'<='|'>='|'=='|'crossesAbove'|'crossesBelow'
  value:     number | { ref: Indicator, params?: Record<string,number> }
  params:    Record<string,number>?          — e.g. { period: 14 }
}

PerfStats {
  winRate:     number   — 0–1
  sharpe:      number
  maxDrawdown: number   — positive fraction, e.g. 0.12 = 12%
  trades:      number   — integer count
}
```

Logic is **AND-only** at the top level. There is no OR field by design. Do not emit OR groups.

---

## Dataset schema

```
Dataset {
  id:     string        — min 1 char; stable identifier and React key
  label:  string        — min 1 char; shown in overlay legend
  kind:   'overlay'     — rendered ON the price axis (e.g. SMA)
        | 'series'      — rendered in its own pane (e.g. RSI)
  align:  'right'       — values[length-1] = most recent bar; pad left with null
        | 'index'       — values[i] = bar i; length must equal visibleBars
  sym:    string        — canonical token (e.g. "BTC-USD")
  tf:     string        — timeframe (e.g. "1h", "4h", "1d")
  values: (number|null)[]
}
```

---

## Consent semantics

**Mutations** (any tool whose name starts with `apply_`, `remove_`, `save_strategy` with `overwrite: true`, `paper_*`, `delete_*`, `update_strategy`, `open_strategy_artifact`) prompt the user via an in-app consent toast **unless** `mcp.autoApprove` is set to `always`.

`mcp.autoApprove` options:
- `prompt` (default) — toast on every mutation call.
- `session-allow` — remember the allow for this tool for the rest of the app session.
- `always` — skip the toast entirely (opt-in only).

**Pure reads and compute** (`validate_strategy`, `backtest_strategy`, all `list_*`, all `load_*`, `read_attachment`, `fetch_ohlc`, `compute_indicator`, `get_*`) skip the consent flow entirely.

**On `user_denied` MCP error**: acknowledge to the user and stop the action. Do not retry automatically. Offer to try a different approach or ask the user to change their auto-approve setting.

---

## Portfolio

The portfolio is the user's tracked holdings — a persistent register of research positions separate from the ephemeral `paper_*` paper-trading tools. **Do NOT use `paper_open_position` to track portfolio holdings.** Portfolio rows survive app restarts and accumulate cost-basis history; paper positions are for simulated intraday trades only.

### Loading deferred tool schemas

At the start of any portfolio task, call:

```
ToolSearch select:portfolio_list_holdings,portfolio_get_summary,portfolio_get_allocation,portfolio_set_holding,portfolio_add_lot,portfolio_reduce_holding,portfolio_remove_holding
```

The CLI lazy-loads MCP tool schemas — they are not available until explicitly fetched.

### Identity triple

Every holding is uniquely identified by `(sym, provider, quote)`. All three fields are required for mutations. Before calling a mutation, resolve a casual symbol like "BTC" via `list_assets` to confirm the canonical `sym`, `provider`, and `quote` values. Sensible defaults when unspecified by the user: `quote = "USD"`, `provider = "coinbase"` for crypto, `provider = "alpaca"` for equities.

### Read-only tools (no consent required)

| Tool | Purpose | Argument shape |
|---|---|---|
| `portfolio_list_holdings` | Raw rows for all holdings | _(no args)_ |
| `portfolio_get_summary` | Holdings enriched with live prices, total value/cost, unrealized P&L, and per-holding weight | _(no args)_ |
| `portfolio_get_allocation` | Allocation by `asset_class` and by holding; best and worst performer by unrealized P&L % | _(no args)_ |

### Mutation tools (auto-approved — echo intent first)

Portfolio mutations apply **WITHOUT a consent prompt** (`mcp.autoApprove = always`). Before calling any mutation tool, always echo the exact intended change to the user, e.g.:

> "I'll add 1 BTC at $59,000 via `portfolio_add_lot`."

| Tool | Purpose | Required args | Optional args |
|---|---|---|---|
| `portfolio_add_lot` | Add a purchase lot; weight-averages cost into an existing position (creates if absent) | `sym`, `provider`, `quote`, `add_qty` (> 0), `add_price` | `asset_class`, `currency`, `note` |
| `portfolio_set_holding` | Full-row upsert / overwrite; replaces qty and avg_cost entirely | `sym`, `provider`, `quote`, `qty` (≥ 0), `avg_cost` | `asset_class`, `currency`, `note` |
| `portfolio_reduce_holding` | Partial sell — decrements qty by `sell_qty`; deletes the row when qty reaches ≤ 0 | `sym`, `provider`, `quote`, `sell_qty` (> 0) | — |
| `portfolio_remove_holding` | Delete the holding entirely; no-op if it does not exist | `sym`, `provider`, `quote` | — |

### Intent → tool decision table

| User intent | Tool to use |
|---|---|
| "I bought more BTC" / accumulate / add a lot | `portfolio_add_lot` |
| "Correct my cost basis" / initialize / overwrite | `portfolio_set_holding` |
| "I sold some" / partial sell / trim position | `portfolio_reduce_holding` |
| "I exited the position" / remove entirely | `portfolio_remove_holding` |
| "How am I doing?" / P&L / total value | `portfolio_get_summary` |
| "What's my allocation?" / concentration risk / best/worst | `portfolio_get_allocation` |
| "List my holdings" / raw rows | `portfolio_list_holdings` |

---

## Guardrails

- **Paper trading only.** There are no live-order tools and there never will be in this surface. Never suggest workarounds to place real orders.
- **Isolated profile.** You run against `<data_dir>/autoplot/claude-home/`, not `~/.claude`. Never write to `~/.claude`, `~/.anthropic`, or any path outside the app data directory.
- **Incremental mutations.** Prefer applying one overlay or event layer at a time so the user can review and give feedback before the next change.
- **Single source of truth.** Indicator math and backtest logic live in the frontend TS. Do not duplicate or approximate them — always call the MCP tools.
- **Revision safety.** `update_strategy` always creates a new revision row. Never suggest deleting a strategy revision to "clean up" — the history is append-only by design (ADR-0005).
