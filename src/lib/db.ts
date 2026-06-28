/**
 * src/lib/db.ts — Typed Tauri command wrappers (DB layer)
 *
 * Per A9: the frontend NEVER opens SQLite directly.
 * All reads/writes flow through typed Tauri commands declared in
 * src-tauri/src/commands/db.rs and invoked here via `invoke`.
 *
 * Phases:
 *   P2.5  → db_marks_*   (this file)
 *   P3    → db_watchlist_*
 *   P4    → db_bars_*
 *
 * Field naming: Rust serializes struct fields as snake_case by default.
 * Our `Mark` interface mirrors snake_case for `created_at` so the TS shape
 * matches the JSON wire format exactly — no per-row remapping needed.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Bar, Tf } from '../data/MarketDataProvider';
import type { Mode } from '../ai/types';

/**
 * A persisted chart annotation. `note == null` ⇒ Mark; non-null ⇒ Comment.
 *
 * ADR-0009 (Step 11) — `quote` joins the canonical key tuple alongside
 * `(sym, provider)`. Migration 0016 backfilled existing rows; all reads/writes
 * thread the quote so BTC/USDT and BTC/USDC marks stay isolated.
 */
export interface Mark {
  id: number;
  sym: string;
  /** Provider that owns this row — ADR-0008 mandates `provider` in every key. */
  provider: string;
  /** Canonical quote token (ADR-0009). */
  quote: string;
  price: number;
  /** Bar timestamp the mark anchors to (unix ms). */
  ts: number;
  /** One of the 5 swatch tokens (oklch(...)). */
  color: string;
  /** Comment body. `null` for plain Marks. */
  note: string | null;
  /** When the mark was saved (unix ms). */
  created_at: number;
}

/**
 * List all marks for `(sym, provider, quote)`, ordered by `ts` ascending.
 * ADR-0008/0009: `provider` and `quote` are mandatory — collisions across the
 * key tuple are silent data corruption otherwise.
 */
export const dbMarksList = (sym: string, provider: string, quote: string) =>
  invoke<Mark[]>('db_marks_list', { sym, provider, quote });

/**
 * Insert a new mark. Returns the new row's `id`.
 * Pass `note: undefined` (or omit) for a plain Mark; pass a string for a Comment.
 * ADR-0008/0009: `provider` and `quote` are mandatory.
 */
export const dbMarksInsert = (args: {
  sym: string;
  provider: string;
  quote: string;
  price: number;
  ts: number;
  color: string;
  note?: string | null;
}): Promise<number> =>
  invoke<number>('db_marks_insert', {
    sym: args.sym,
    provider: args.provider,
    quote: args.quote,
    price: args.price,
    ts: args.ts,
    color: args.color,
    note: args.note ?? null,
  });

/** Delete a single mark by id. */
export const dbMarksDelete = (id: number): Promise<void> =>
  invoke<void>('db_marks_delete', { id });

// ---------------------------------------------------------------------------
// Watchlist (P3.1)
// ---------------------------------------------------------------------------

/**
 * One entry in the user's watchlist.
 * `added_at` is a unix ms timestamp (mirrors Rust snake_case serialisation).
 */
export interface WatchlistEntry {
  sym: string;
  provider: string;
  added_at: number;
}

/** List all watchlist entries ordered by `added_at` ascending. */
export const dbWatchlistList = (): Promise<WatchlistEntry[]> =>
  invoke<WatchlistEntry[]>('db_watchlist_list');

/** Add a symbol+provider pair. Duplicate adds are safe no-ops (PK enforced). */
export const dbWatchlistAdd = (sym: string, provider: string): Promise<void> =>
  invoke<void>('db_watchlist_add', { sym, provider });

/** Remove a symbol+provider pair. Removing a non-existent entry is a safe no-op. */
export const dbWatchlistRemove = (sym: string, provider: string): Promise<void> =>
  invoke<void>('db_watchlist_remove', { sym, provider });

// ---------------------------------------------------------------------------
// Watchlist v2 (ADR-0009 — multi-quote)
// ---------------------------------------------------------------------------

/**
 * One entry in the multi-quote watchlist (`watchlist_v2`).
 * Canonical identity is `(sym, provider, quote)` — ADR-0009 §1.
 */
export interface WatchlistEntryV2 {
  sym: string;
  provider: string;
  quote: string;
  added_at: number;
}

export const dbWatchlistV2List = (): Promise<WatchlistEntryV2[]> =>
  invoke<WatchlistEntryV2[]>('db_watchlist_v2_list');

export const dbWatchlistV2Add = (
  sym: string,
  provider: string,
  quote: string,
): Promise<void> =>
  invoke<void>('db_watchlist_v2_add', { sym, provider, quote });

export const dbWatchlistV2Remove = (
  sym: string,
  provider: string,
  quote: string,
): Promise<void> =>
  invoke<void>('db_watchlist_v2_remove', { sym, provider, quote });

// ---------------------------------------------------------------------------
// App state (P3.1)
// ---------------------------------------------------------------------------

/** Get a persisted app-state value by key. Returns `null` if the key has never been set. */
export const dbAppStateGet = (key: string): Promise<string | null> =>
  invoke<string | null>('db_app_state_get', { key });

/** Set (or overwrite) a persisted app-state value. */
export const dbAppStateSet = (key: string, value: string): Promise<void> =>
  invoke<void>('db_app_state_set', { key, value });

// ---------------------------------------------------------------------------
// Bars warm cache (P4.1)
// ---------------------------------------------------------------------------

/**
 * Read cached bars for `(provider, sym, tf)` whose `ts` is in
 * `[sinceTs, untilTs]` inclusive. Returned ascending by `ts`.
 */
export const dbBarsGetRange = (args: {
  provider: string;
  sym: string;
  tf: Tf;
  sinceTs: number;
  untilTs: number;
}): Promise<Bar[]> =>
  // Tauri serialises camelCase command args as snake_case kebabs at the
  // boundary; we explicitly name the keys to match the Rust signature.
  invoke<Bar[]>('db_bars_get_range', {
    provider: args.provider,
    sym: args.sym,
    tf: args.tf,
    sinceTs: args.sinceTs,
    untilTs: args.untilTs,
  });

/** Upsert a batch of bars into the SQLite warm cache. */
export const dbBarsUpsert = (args: {
  provider: string;
  sym: string;
  tf: Tf;
  bars: Bar[];
}): Promise<void> =>
  invoke<void>('db_bars_upsert', {
    provider: args.provider,
    sym: args.sym,
    tf: args.tf,
    bars: args.bars,
  });

// ---------------------------------------------------------------------------
// Bars v2 warm cache (ADR-0009 — multi-quote, `bars_v2` table)
// ---------------------------------------------------------------------------

/**
 * Read cached bars for `(provider, sym, quote, tf)` whose `ts` is in
 * `[sinceTs, untilTs]` inclusive. Returned ascending by `ts`.
 */
export const dbBarsV2GetRange = (args: {
  provider: string;
  sym: string;
  quote: string;
  tf: Tf;
  sinceTs: number;
  untilTs: number;
}): Promise<Bar[]> =>
  invoke<Bar[]>('db_bars_v2_get_range', {
    provider: args.provider,
    sym: args.sym,
    quote: args.quote,
    tf: args.tf,
    sinceTs: args.sinceTs,
    untilTs: args.untilTs,
  });

export const dbBarsV2Upsert = (args: {
  provider: string;
  sym: string;
  quote: string;
  tf: Tf;
  bars: Bar[];
}): Promise<void> =>
  invoke<void>('db_bars_v2_upsert', {
    provider: args.provider,
    sym: args.sym,
    quote: args.quote,
    tf: args.tf,
    bars: args.bars,
  });

// ---------------------------------------------------------------------------
// Symbol catalog (ADR-0009 — `symbol_catalog_*` Tauri commands)
// ---------------------------------------------------------------------------

/**
 * One catalog row — wire-compatible 1:1 with `src-tauri/src/providers/catalog.rs::SymbolRow`.
 * snake_case field naming matches the project IPC convention.
 */
export interface SymbolRow {
  provider: string;
  sym: string;
  quote: string;
  name: string | null;
  class: 'crypto' | 'equity';
  status: string;
  /** Provider-native string (e.g. 'BTCUSDT', 'BTC-USD', 'XXBTZUSD'). */
  native_sym: string;
}

/** Returned by `symbol_catalog_fetch`. */
export interface CatalogFetchResult {
  provider: string;
  row_count: number;
  fetched_at: number;
}

/** Returned by `symbol_catalog_list`. */
export interface CatalogListResult {
  rows: SymbolRow[];
  total: number;
}

/** Per-provider freshness ledger entry. */
export interface SymbolsMeta {
  provider: string;
  fetched_at: number;
  row_count: number;
}

/**
 * Pull a provider's catalog from its public REST endpoint, upsert to the
 * `symbols` table, and bump freshness. Throws `AuthFailed` for Alpaca when
 * credentials are missing (callers route this to `AlpacaCredentialsModal`).
 */
export const symbolCatalogFetch = (provider: string): Promise<CatalogFetchResult> =>
  invoke<CatalogFetchResult>('symbol_catalog_fetch', { provider });

/**
 * Paged browse from the local cache. Limit caps at 200 in the modal's empty-query
 * mode; large catalogs (Alpaca ~10k) require pagination via `offset`.
 */
export const symbolCatalogList = (
  provider: string,
  limit: number,
  offset: number,
): Promise<CatalogListResult> =>
  invoke<CatalogListResult>('symbol_catalog_list', { provider, limit, offset });

/**
 * FTS5-backed cross-provider search. The `query` is passed straight to SQLite's
 * `MATCH` — append `*` for prefix matching (e.g. `'btc*'`). Empty/whitespace
 * queries return no rows; callers should fall back to `symbolCatalogList` for
 * browse mode.
 */
export const symbolCatalogSearch = (
  query: string,
  providers: string[] | null,
  limit: number,
): Promise<SymbolRow[]> =>
  invoke<SymbolRow[]>('symbol_catalog_search', { query, providers, limit });

/** Returns the freshness ledger across all providers. */
export const symbolCatalogMeta = (): Promise<SymbolsMeta[]> =>
  invoke<SymbolsMeta[]>('symbol_catalog_meta');

// ---------------------------------------------------------------------------
// Portfolio (paper-trading holdings)
// ---------------------------------------------------------------------------

/**
 * One paper-trading holding row. Wire-compatible 1:1 with the Rust
 * `HoldingRow` struct (snake_case field naming — no per-row remapping needed).
 */
export interface HoldingRow {
  sym: string;
  provider: string;
  quote: string;
  asset_class: 'crypto' | 'equity';
  qty: number;
  avg_cost: number;
  currency: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

/** List all holdings (unordered — callers sort as needed). */
export const dbPortfolioList = (): Promise<HoldingRow[]> =>
  invoke<HoldingRow[]>('db_portfolio_list');

/** Full-row upsert — overwrites an existing `(sym, provider, quote)` row. */
export const dbPortfolioUpsert = (holding: HoldingRow): Promise<void> =>
  invoke<void>('db_portfolio_upsert', { holding });

/**
 * Add shares/coins to a position (or create it). Rust recalculates `avg_cost`
 * from the weighted average of existing qty + new lot.
 */
export const dbPortfolioAddLot = (args: {
  sym: string;
  provider: string;
  quote: string;
  asset_class: string;
  add_qty: number;
  add_price: number;
  currency: string;
  note?: string | null;
  now_ms: number;
}): Promise<void> =>
  // Tauri v2 maps camelCase JS keys → snake_case Rust params (default
  // `#[tauri::command]`, no rename_all). Multi-word keys MUST be camelCase here,
  // matching the `sinceTs`/`untilTs` convention used by db_bars_* above.
  invoke<void>('db_portfolio_add_lot', {
    sym: args.sym,
    provider: args.provider,
    quote: args.quote,
    assetClass: args.asset_class,
    addQty: args.add_qty,
    addPrice: args.add_price,
    currency: args.currency,
    note: args.note ?? null,
    nowMs: args.now_ms,
  });

/**
 * Reduce a position by `sell_qty`. Rust decrements qty (and removes the row
 * when qty reaches 0).
 */
export const dbPortfolioReduce = (args: {
  sym: string;
  provider: string;
  quote: string;
  sell_qty: number;
  now_ms: number;
}): Promise<void> =>
  // camelCase keys — see note on dbPortfolioAddLot above.
  invoke<void>('db_portfolio_reduce', {
    sym: args.sym,
    provider: args.provider,
    quote: args.quote,
    sellQty: args.sell_qty,
    nowMs: args.now_ms,
  });

/** Remove a holding entirely regardless of qty. */
export const dbPortfolioRemove = (args: {
  sym: string;
  provider: string;
  quote: string;
}): Promise<void> =>
  invoke<void>('db_portfolio_remove', {
    sym: args.sym,
    provider: args.provider,
    quote: args.quote,
  });

// ---------------------------------------------------------------------------
// Trends (Step 4 — trend-line tool)
// ---------------------------------------------------------------------------

/**
 * One persisted trend line. Two anchor points (`x_ts`, `y_price`) define a
 * segment that the chart projects through the standard view-transform.
 *
 * Field naming mirrors the Rust serde shape (snake_case) — no per-row
 * remapping is needed at the boundary.
 */
export interface TrendRow {
  /** Stable id (TEXT primary key); the TS side generates a UUID on insert. */
  id: string;
  sym: string;
  /** Provider that owns this row — ADR-0008 mandates `provider` in every key. */
  provider: string;
  /** Canonical quote token (ADR-0009 / Step 11). */
  quote: string;
  /** Timeframe key — one of the locked 4-tier set ('1h' | '4h' | '1d' | '1w'). */
  tf: string;
  /** First anchor: bar timestamp (unix ms). */
  x1_ts: number;
  /** First anchor: price. */
  y1_price: number;
  /** Second anchor: bar timestamp (unix ms). */
  x2_ts: number;
  /** Second anchor: price. */
  y2_price: number;
  /** Color token — defaults to 'accent' (renderer maps to var(--accent)). */
  color: string;
  /** When the trend was saved (unix ms). */
  created_at: number;
}

/**
 * List all trend lines for a (sym, tf, provider, quote) tuple, ordered by
 * creation time. ADR-0008/0009: `provider` and `quote` are mandatory.
 */
export const dbTrendsList = (
  sym: string,
  tf: string,
  provider: string,
  quote: string,
): Promise<TrendRow[]> =>
  invoke<TrendRow[]>('db_trends_list', { sym, tf, provider, quote });

/**
 * Insert a new trend line. Caller supplies the full row (including `id` and
 * `provider` — ADR-0008).
 */
export const dbTrendsInsert = (trend: TrendRow): Promise<void> =>
  invoke<void>('db_trends_insert', { trend });

/** Delete a single trend line by id. */
export const dbTrendsDelete = (id: string): Promise<void> =>
  invoke<void>('db_trends_delete', { id });

// ---------------------------------------------------------------------------
// Datasets (P6 W4-B — AI Research result rows)
//
// We persist the full Dataset JSON blob keyed by stable id. The Dataset shape
// is owned by W4-A in `src/ai/schemas.ts`; until that schema lands, this layer
// keeps `json` as a raw string so callers stringify/parse at the edge.
// ---------------------------------------------------------------------------

/** Wire row exactly as Rust serialises it (snake_case `created_at`). */
export interface DatasetRow {
  id: string;
  /** Full Dataset JSON blob (parsed on read by callers). */
  json: string;
  created_at: number;
}

export const dbDatasetsList = (): Promise<DatasetRow[]> =>
  invoke<DatasetRow[]>('db_datasets_list');

export const dbDatasetsUpsert = (row: DatasetRow): Promise<void> =>
  invoke<void>('db_datasets_upsert', { row });

export const dbDatasetsDelete = (id: string): Promise<void> =>
  invoke<void>('db_datasets_delete', { id });

// ---------------------------------------------------------------------------
// Strategies (P7 W5-C3 — AI Co-Strategy result rows)
//
// We persist the full Strategy JSON blob keyed by stable id. The Strategy shape
// is owned by W5-A in `src/ai/schemas.ts`; this layer keeps `json` as a raw
// string so callers stringify/parse at the edge, mirroring the datasets pattern.
// ---------------------------------------------------------------------------

/** Wire row exactly as Rust serialises it (snake_case `created_at`). */
export interface StrategyRow {
  id: string;
  /** Full Strategy JSON blob (parsed on read by callers). */
  json: string;
  created_at: number;
}

export const dbStrategiesList = (): Promise<StrategyRow[]> =>
  invoke<StrategyRow[]>('db_strategies_list');

export const dbStrategiesUpsert = (row: StrategyRow): Promise<void> =>
  invoke<void>('db_strategies_upsert', { row });

export const dbStrategiesDelete = (id: string): Promise<void> =>
  invoke<void>('db_strategies_delete', { id });

// ---------------------------------------------------------------------------
// Research Overlays (Step 4 — generic multi-element research overlay rows)
//
// We persist the full ResearchOverlay JSON blob keyed by stable id. The
// ResearchOverlay shape is owned by `src/ai/schemas.ts`; this layer keeps
// `json` as a raw string so callers stringify/parse at the edge, mirroring
// the datasets and strategies pattern.
// ---------------------------------------------------------------------------

/** Wire row exactly as Rust serialises it (snake_case `created_at`). */
export interface ResearchOverlayRow {
  id: string;
  /** Full ResearchOverlay JSON blob (parsed on read by callers). */
  json: string;
  created_at: number;
}

export const dbResearchOverlaysList = (): Promise<ResearchOverlayRow[]> =>
  invoke<ResearchOverlayRow[]>('db_research_overlays_list');

export const dbResearchOverlaysUpsert = (row: ResearchOverlayRow): Promise<void> =>
  invoke<void>('db_research_overlays_upsert', { row });

export const dbResearchOverlaysDelete = (id: string): Promise<void> =>
  invoke<void>('db_research_overlays_delete', { id });

// ---------------------------------------------------------------------------
// Market data (P4.1)
// ---------------------------------------------------------------------------

/**
 * Orchestrating Tauri command — picks the registered adapter for `provider`,
 * acquires a rate-limit token, fetches bars, upserts them into the warm
 * cache, and returns them.
 *
 * ## Choice (a) — widen in place
 *
 * Step 7 (ADR-0009) chose option (a) of the widening menu: the same
 * `marketFetchHistory` wrapper accepts a `quote` argument that switches it
 * onto the v2 Tauri command (`market_fetch_history_v2`). This way every
 * downstream callsite (`providerRegistry`, `_barFetcher`, etc.) keeps the same
 * name and the v1 path stays available for legacy Tauri commands that have
 * not yet been re-pointed.
 *
 * When `quote` is omitted (e.g. legacy callers that still pass three string
 * args), the v1 command is used as before — preserving the pre-Step-7 wire.
 * Warm cache writes go to `bars_v2` on the v2 path; `bars` (v1) on the legacy
 * path. The in-memory `ohlcCache` is keyed by `(provider, sym, quote, tf)`
 * either way (Step 5b).
 */
export const marketFetchHistory = (
  provider: string,
  sym: string,
  tf: Tf,
  count: number,
  quote?: string,
): Promise<Bar[]> => {
  if (typeof quote === 'string' && quote.length > 0) {
    return invoke<Bar[]>('market_fetch_history_v2', {
      provider,
      sym,
      quote,
      tf,
      count,
    });
  }
  return invoke<Bar[]>('market_fetch_history', { provider, sym, tf, count });
};

/**
 * Fetch the single latest **1-minute** bar for `(provider, sym, quote)`.
 *
 * Fix A (1h stale-price bug): the chart seed must not fetch `count=1` of the
 * chart's *own* timeframe — for a 1h chart that returns the last *completed*
 * hour (≤59 min stale). This maps to the dedicated `market_fetch_latest_1m`
 * Rust command, which forces the `1m`/`1Min` REST timeframe and **bypasses the
 * 4-tier `tf_ms` gate** (`'1m'` is intentionally NOT in the frozen `Tf` set —
 * ADR-0002). The returned bar is at most ~60s old; the Alpaca adapter takes its
 * close and re-stamps it onto the current chart bucket.
 *
 * Resolves to `null` when the provider returns no 1m data (e.g. market closed).
 */
export const marketFetchLatest1m = (
  provider: string,
  sym: string,
  quote: string,
): Promise<Bar | null> =>
  invoke<Bar | null>('market_fetch_latest_1m', { provider, sym, quote });

/**
 * Fetch historical OHLCV bars **ending strictly before** `before` (epoch-ms).
 *
 * Maps to the same `market_fetch_history_v2` Rust command as `marketFetchHistory`
 * but passes the optional `before` field so the Rust handler applies an upper-
 * bound timestamp filter. Returns `count` bars ordered ascending by `ts`, all
 * with `ts < before`.
 *
 * Step 3 (Part A) — used exclusively by `fetchHistoryBefore` in providerRegistry.
 * The `before` argument maps to `Option<i64>` on the Rust side; passing it
 * selects the older-page window without affecting the v1/legacy paths.
 */
export const marketFetchHistoryBefore = (
  provider: string,
  sym: string,
  tf: Tf,
  count: number,
  quote: string,
  before: number,
): Promise<Bar[]> =>
  invoke<Bar[]>('market_fetch_history_v2', {
    provider,
    sym,
    quote,
    tf,
    count,
    before,
  });

/**
 * Test the Claude CLI connection by spawning `<cli> --version` (W2-A General tab).
 * Resolves with the trimmed version string on success; rejects with `"CliNotFound"`
 * or `"CliRuntime: <reason>"` on failure. 5s timeout enforced in Rust.
 */
export const claudeTestConnection = (cliPathOverride?: string): Promise<string> =>
  invoke<string>('claude_test_connection', {
    cliPathOverride: cliPathOverride ?? null,
  });

// ---------------------------------------------------------------------------
// AI sessions table (W1-A migration 0007_ai_sessions.sql)
//
// Field naming mirrors the Rust serde shape (snake_case) — the Tauri command
// returns rows directly without remapping.
// ---------------------------------------------------------------------------

/** One persisted CLI session. Mirrors the `ai_sessions` row exactly. */
export interface AiSession {
  id: string;
  mode: Mode;
  cwd_path: string;
  model: string | null;
  created_at: number;
  last_used_at: number;
  summary: string | null;
  title: string | null;
}

/** List sessions for a given mode, newest-first (Rust orders by `last_used_at DESC`). */
export const dbAiSessionsList = (mode: Mode): Promise<AiSession[]> =>
  invoke<AiSession[]>('db_ai_sessions_list', { mode });

/** Fetch one session by id; returns `null` when the row is absent. */
export const dbAiSessionsGet = (id: string): Promise<AiSession | null> =>
  invoke<AiSession | null>('db_ai_sessions_get', { id });

/** Delete one session row. The on-disk cwd jail cleanup is deferred to P8. */
export const dbAiSessionsDelete = (id: string): Promise<void> =>
  invoke<void>('db_ai_sessions_delete', { id });

/** Upsert (insert-or-replace) one session row. */
export const dbAiSessionsUpsert = (row: AiSession): Promise<void> =>
  invoke<void>('db_ai_sessions_upsert', { row });

// ---------------------------------------------------------------------------
// MCP (W2-B) — merged-config IO + health checks.
//
// Three sources are merged inside Rust (`commands/mcp.rs`) with documented
// `app > user > project` precedence:
//
//   - app:     `<dirs::data_dir>/autoplot/mcp.json`
//   - user:    `~/.claude.json` (`mcpServers` key)
//   - project: `<cwd>/.mcp.json`
//
// Field naming mirrors Rust serde snake_case so the TS shape matches the wire
// format directly (no per-row remapping at the boundary).
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpSource = 'app' | 'user' | 'project';

/** One MCP server row — flattened across the three config sources. */
export interface McpServer {
  name: string;
  transport: McpTransport;
  /** stdio only. */
  command?: string;
  /** stdio only. */
  args?: string[];
  /** stdio only. */
  env?: Record<string, string>;
  /** http / sse only. */
  url?: string;
  /** Where this row was read from. Edit/remove allowed only when `source === 'app'`. */
  source: McpSource;
}

/** Most recent health-check result for one server. */
export interface McpStatus {
  name: string;
  healthy: boolean;
  /** Unix ms when the check completed. */
  last_checked: number;
  /** Present when `healthy === false`. */
  error?: string;
}

/** Read all merged MCP server rows (stable name order). */
export const mcpListMerged = (): Promise<McpServer[]> =>
  invoke<McpServer[]>('mcp_list_merged');

/**
 * Absolute path to the app-managed MCP config file. The Rust side seeds it
 * with `{ "mcpServers": {} }` if missing.
 */
export const mcpAppConfigPath = (): Promise<string> =>
  invoke<string>('mcp_app_config_path');

/** Add or replace a server in the app-managed config. */
export const mcpAppConfigUpsert = (server: McpServer): Promise<void> =>
  invoke<void>('mcp_app_config_upsert', { server });

/** Remove a server from the app-managed config. No-op if absent. */
export const mcpAppConfigRemove = (name: string): Promise<void> =>
  invoke<void>('mcp_app_config_remove', { name });

/**
 * Run a one-shot health check. `stdio` transports `<cmd> --help` with a 1s
 * timeout (any spawn that doesn't error counts as healthy); `http`/`sse`
 * transports HEAD the URL with a 1s timeout.
 */
export const mcpHealthCheck = (server: McpServer): Promise<McpStatus> =>
  invoke<McpStatus>('mcp_health_check', { server });

/**
 * Write a filtered copy of the merged MCP config (excluding `disabled` names)
 * into the session jail dir; returns the absolute path to the temp config so
 * `ai_invoke` can pass `--mcp-config <path>`.
 */
export const mcpEmitTempConfig = (
  disabled: string[],
  sessionId: string,
): Promise<string> =>
  invoke<string>('mcp_emit_temp_config', { disabled, sessionId });

// ---------------------------------------------------------------------------
// Skills + slash commands (W2-C)
// ---------------------------------------------------------------------------

export type SkillSource = 'app' | 'user' | 'plugin' | 'project';

/** One discovered skill row. `shadowed` is true when a higher-precedence
 *  layer overrides the same name; the UI fades shadowed rows. */
export interface Skill {
  name: string;
  description: string | null;
  source: SkillSource;
  path: string;
  shadowed: boolean;
}

/** One discovered slash command. `body` is the raw markdown template that
 *  gets pasted into the composer when the user picks it from the palette. */
export interface SlashCommand {
  name: string;
  description: string | null;
  source: SkillSource;
  path: string;
  body: string;
  shadowed: boolean;
}

export const skillsListMerged = (): Promise<Skill[]> =>
  invoke<Skill[]>('skills_list_merged');

export const slashCommandsListMerged = (): Promise<SlashCommand[]> =>
  invoke<SlashCommand[]>('slash_commands_list_merged');

export const skillSetEnabled = (name: string, enabled: boolean): Promise<void> =>
  invoke<void>('skill_set_enabled', { name, enabled });

export const slashCommandInstallAppShipped = (): Promise<void> =>
  invoke<void>('slash_command_install_app_shipped');

// ---------------------------------------------------------------------------
// Settings + hooks + audit + subagents (W2-D1)
// ---------------------------------------------------------------------------

/** One discovered subagent row. */
export interface SubagentMeta {
  name: string;
  description: string | null;
  source: string;
  path: string;
  model: string | null;
}

/** Path to the app-managed `settings.json` (passed to `claude --settings`). */
export const settingsAppPath = (): Promise<string> =>
  invoke<string>('settings_app_path');

/** Read the app-managed settings JSON (returns `{}` when absent). */
export const settingsAppGet = (): Promise<unknown> =>
  invoke<unknown>('settings_app_get');

/** Replace the `hooks` key in the app-managed settings JSON. Validates shape. */
export const settingsAppSetHooks = (hooks: unknown): Promise<void> =>
  invoke<void>('settings_app_set_hooks', { hooks });

/** Append one JSONL entry to `<dirs::data_dir>/autoplot/logs/audit.log`. */
export const auditLogAppend = (entry: unknown): Promise<void> =>
  invoke<void>('audit_log_append', { entry });

/** Path to the audit log file. */
export const auditLogPath = (): Promise<string> =>
  invoke<string>('audit_log_path');

/** Discover subagents under `<claude-home>/agents/` and plugin agent dirs.
 *  Wave 0 — sources are rebased onto the isolated profile; the user's main
 *  `~/.claude/agents` is never read. */
export const subagentsList = (): Promise<SubagentMeta[]> =>
  invoke<SubagentMeta[]>('subagents_list');

// ---------------------------------------------------------------------------
// Wave 0 — Profile isolation
// ---------------------------------------------------------------------------

/** Canonical profile paths surfaced from Rust. Field names mirror the
 *  serde camelCase output of `ProfilePaths` exactly. */
export interface ProfilePaths {
  /** `<dirs::data_dir>/autoplot/claude-home/`. */
  claudeHome: string;
  agents: string;
  skills: string;
  commands: string;
  plugins: string;
  /** `<claude-home>/settings.json` — pre-seeded `{}` by bootstrap. */
  settings: string;
  /** `<claude-home>/.claude.json` — CLI-owned, never pre-seeded by us. */
  mcp: string;
}

/** Idempotently bootstrap the isolated profile dir. Returns the absolute
 *  path of `<claude-home>` on success. */
export const profileInit = (): Promise<string> =>
  invoke<string>('profile_init');

/** Fetch the canonical profile paths so the UI can render help text without
 *  hard-coding `~/.claude` strings. */
export const profilePaths = (): Promise<ProfilePaths> =>
  invoke<ProfilePaths>('profile_paths');

/** Persist `ANTHROPIC_API_KEY` into `<claude-home>/settings.json`'s `env`
 *  block so the CLI can authenticate without going through OAuth. */
export const profileSetApiKey = (key: string): Promise<void> =>
  invoke<void>('profile_set_api_key', { key });

/** Auth-status shape returned by Rust (camelCase on the wire). */
export interface ProfileAuthStatus {
  signedIn: boolean;
  mode: 'oauth' | 'apiKey' | 'none';
  account?: string;
}

/** Spawn `<cli> auth login --claudeai` under the isolated profile. Streams
 *  stdout/stderr lines via the `auth:login:line` Tauri event. Resolves on
 *  exit 0; rejects on non-zero exit. Single-flight on the Rust side. */
export const profileLogin = (cliPath?: string): Promise<void> =>
  invoke<void>('profile_login', { cliPath: cliPath ?? null });

/** Cancel the in-flight `profile_login` child if any. Idempotent. */
export const profileLoginCancel = (): Promise<void> =>
  invoke<void>('profile_login_cancel');

/** Run `<cli> auth logout` under the isolated profile, then strip
 *  `ANTHROPIC_API_KEY` from `<claude-home>/settings.json`. Tolerant of CLI
 *  failure — local API key is still cleaned. */
export const profileLogout = (cliPath?: string): Promise<void> =>
  invoke<void>('profile_logout', { cliPath: cliPath ?? null });

/** Query the CLI's `auth status --json` under the isolated profile. Falls
 *  back gracefully on CLI failure (`signedIn: false, mode: 'none'`). */
export const profileAuthStatus = (cliPath?: string): Promise<ProfileAuthStatus> =>
  invoke<ProfileAuthStatus>('profile_auth_status', { cliPath: cliPath ?? null });

/** Result of `mcp_import_from_user_profile`. */
export interface McpImportResult {
  imported: number;
  skipped: number;
  source_path: string;
}

/** READ-ONLY one-shot copy of `~/.claude.json`'s `mcpServers` map into the
 *  app-managed config. Does NOT modify the source file (verified in cargo
 *  test by pre/post byte-equality). Idempotent — running twice imports zero
 *  the second time. */
export const mcpImportFromUserProfile = (): Promise<McpImportResult> =>
  invoke<McpImportResult>('mcp_import_from_user_profile');
