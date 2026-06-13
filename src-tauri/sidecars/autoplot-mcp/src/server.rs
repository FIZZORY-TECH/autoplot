//! MCP server handler — implements `ServerHandler` for `TradingPortalServer`.
//!
//! All tools forward to the IPC bridge.  The server remains usable even when
//! the bridge is unreachable: `tools/list` always succeeds; `tools/call`
//! returns an MCP error with message `app_not_running: <reason>`.
//!
//! Step 6 adds the full non-read-only surface (~22 new tools).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rmcp::{
    ErrorData as McpError,
    RoleServer,
    ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, Content, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
    },
    service::{MaybeSendFuture, RequestContext},
};
use serde_json::{Value, json};

use crate::bridge::{self, BridgeState, CallResult};

// Bridge error codes (mirrors ipc_bridge.rs constants).
const ERR_USER_DENIED: i32 = -32006;

// ---------------------------------------------------------------------------
// Server struct
// ---------------------------------------------------------------------------

/// The MCP server that bridges Claude CLI ↔ autoplot app.
pub struct TradingPortalServer {
    bridge: Arc<BridgeState>,
    sock_path: PathBuf,
    token: String,
    tools: Vec<Tool>,
}

impl TradingPortalServer {
    pub fn new(bridge: BridgeState, sock_path: PathBuf, token: String) -> Self {
        Self {
            bridge: Arc::new(bridge),
            sock_path,
            token,
            tools: build_tool_list(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool list builder — JSON-Schema shapes mirror src/ai/schemas.ts
// ---------------------------------------------------------------------------

fn build_tool_list() -> Vec<Tool> {
    vec![
        // ----------------------------------------------------------------
        // READ-ONLY TOOLS (Step 5)
        // ----------------------------------------------------------------

        // 1. fetch_ohlc
        Tool::new(
            "fetch_ohlc",
            "Fetch OHLCV bar data for a trading symbol and timeframe.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "symbol": { "type": "string", "description": "Symbol to fetch. Bare ticker for equities (e.g. 'AAPL', 'IONQ'); BASE-QUOTE for crypto (e.g. 'BTC-USD')." },
                    "timeframe": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
                },
                "required": ["symbol", "timeframe"]
            })),
        ),

        // 2. compute_indicator
        Tool::new(
            "compute_indicator",
            "Compute a technical indicator over an OHLCV bar series returned by fetch_ohlc.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "enum": [
                            "close","open","high","low","volume",
                            "sma","ema","rsi","atr",
                            "bollinger_upper","bollinger_middle","bollinger_lower",
                            "donchian_high","donchian_low","realized_vol"
                        ]
                    },
                    "bars": { "type": "array", "items": { "type": "object" } },
                    "params": { "type": "object", "additionalProperties": { "type": "number" } }
                },
                "required": ["name", "bars"]
            })),
        ),

        // 3. list_assets
        Tool::new(
            "list_assets",
            "List all registered trading assets/symbols available in the app.",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 4. get_current_symbol
        Tool::new(
            "get_current_symbol",
            "Get the trading symbol currently selected on the chart panel.",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 5. get_visible_range
        Tool::new(
            "get_visible_range",
            "Get the visible time range (start_ts, end_ts in ms) on the chart panel.",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 6. list_overlays
        Tool::new(
            "list_overlays",
            "List everything currently rendered on the chart. Returns an object with four \
             arrays: `overlays` (datasets from apply_dataset), `timelineLayers` (from \
             apply_timeline_events), `strategyOverlays` (from apply_strategy), and \
             `researchOverlays` (from apply_research_overlay).",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 7. read_attachment
        Tool::new(
            "read_attachment",
            "Read the contents of an uploaded file attachment by its file_id. \
             Returns { name, mime, base64 }. Max 5 MiB.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "file_id": { "type": "string", "description": "Opaque file identifier from the attachment upload path." }
                },
                "required": ["file_id"]
            })),
        ),

        // 8. list_attachments
        Tool::new(
            "list_attachments",
            "List uploaded file attachments staged in the attachment jail.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "session": { "type": "string", "description": "Optional session filter." }
                }
            })),
        ),

        // ----------------------------------------------------------------
        // MUTATION TOOLS — chart mutations (consent required)
        // ----------------------------------------------------------------

        // 9. apply_dataset
        Tool::new(
            "apply_dataset",
            "Apply a dataset as a chart overlay — the LIGHTWEIGHT single-series path. Consent required. \
             The dataset is rendered on the price axis (overlay) or a sub-pane (series). \
             For anything richer than one bare numeric series (markers, bands, horizontal lines, \
             event marks, text, hover panels, or multi-element studies) PREFER apply_research_overlay.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "label": { "type": "string" },
                    "kind": { "type": "string", "enum": ["overlay", "series"] },
                    "align": { "type": "string", "enum": ["right", "index"] },
                    "sym": { "type": "string" },
                    "tf": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] },
                    "values": { "type": "array", "items": {} }
                },
                "required": ["id", "label", "kind", "align", "sym", "tf", "values"]
            })),
        ),

        // 10. remove_dataset
        Tool::new(
            "remove_dataset",
            "Remove a dataset overlay from the chart. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 11. apply_timeline_events
        Tool::new(
            "apply_timeline_events",
            "Apply a named timeline events layer to the chart (pins, vlines, ranges). \
             Consent required. Each event: { ts, label, color?, kind: 'pin'|'vline'|'range' }.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Optional stable layer id; generated if absent." },
                    "name": { "type": "string", "description": "Human-readable layer name." },
                    "events": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ts": { "type": "number", "description": "Unix ms timestamp." },
                                "label": { "type": "string" },
                                "color": { "type": "string" },
                                "kind": { "type": "string", "enum": ["pin", "vline", "range"] }
                            },
                            "required": ["ts", "label"]
                        }
                    }
                },
                "required": ["name", "events"]
            })),
        ),

        // 12. remove_timeline_layer
        Tool::new(
            "remove_timeline_layer",
            "Remove a timeline events layer from the chart. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 13. apply_strategy
        Tool::new(
            "apply_strategy",
            "Render a saved strategy's entry/exit markers and signal overlay on the chart. \
             Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Strategy id from save_strategy." } },
                "required": ["id"]
            })),
        ),

        // 14. remove_strategy_overlay
        Tool::new(
            "remove_strategy_overlay",
            "Remove a strategy overlay from the chart. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 15. open_strategy_artifact
        Tool::new(
            "open_strategy_artifact",
            "Open the Strategy Artifact Panel and load a saved strategy for review/editing. \
             Consent required (lighter 'open panel?' prompt).",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 15b. apply_research_overlay
        Tool::new(
            "apply_research_overlay",
            "Apply a rich, multi-element research overlay to the chart. Consent required. \
             PREFER this over apply_dataset for anything beyond a single bare numeric series — \
             use apply_dataset only for one plain line/series; use apply_research_overlay for \
             markers, bands, horizontal lines, event marks, free text, hover panels, or any \
             multi-element study.\n\
             \n\
             Shape: { id, sym, tf ('1h'|'4h'|'1d'|'1w'), label, color?, elements[] }. \
             `elements` is a discriminated union on `type` with SEVEN kinds:\n\
             - line:       { type:'line', values:(number|null)[], align:'right'|'index', color?, width?, dash? }\n\
             - band:       { type:'band', upper:(number|null)[], lower:(number|null)[], align:'right'|'index', color?, opacity? }\n\
             - hline:      { type:'hline', price:number, label?, color?, dash? }\n\
             - markers:    { type:'markers', points:[{ ts:number, price?:number, anchor?:'above'|'below', shape:'triangle-up'|'triangle-down'|'circle'|'diamond', color?, label? }] }\n\
             - event_mark: { type:'event_mark', kind:'pin'|'vline'|'range', ts:number, ts_end?:number, label:string, color? }\n\
             - text:       { type:'text', ts:number, price:number, content:string, color?, size? }\n\
             - hotspot:    { type:'hotspot', ts:number, price?:number, panel:{ title?, rows:[{ label, value, color?, glyph? }], footer? } }\n\
             \n\
             Size caps (exceeding any → validation error): max 50 elements; line/band value \
             arrays max 500; markers max 100 points; text.content max 200 chars; hotspot panel \
             max 16 rows.\n\
             \n\
             align: 'right' anchors the last value to the last bar of the dataset (it stays \
             pinned to those bars when you pan or as older history loads); 'index' is \
             positional (values[i] → bar i, anchored to the first loaded bar). ts fields are \
             Unix ms.\n\
             \n\
             Invalid payloads return per-field diagnostics as a JSON array of \
             { path, message } objects (in the error `data.issues`) so you can self-correct \
             and retry.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "sym": { "type": "string" },
                    "tf": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] },
                    "label": { "type": "string" },
                    "color": { "type": "string" },
                    "elements": {
                        "type": "array",
                        "maxItems": 50,
                        "items": { "type": "object" },
                        "description": "Discriminated union on `type`: line | band | hline | markers | event_mark | text | hotspot. See the tool description for each element's fields and size caps."
                    }
                },
                "required": ["id", "sym", "tf", "label", "elements"]
            })),
        ),

        // 15c. remove_research_overlay
        Tool::new(
            "remove_research_overlay",
            "Remove a research overlay from the chart by id. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // ----------------------------------------------------------------
        // PERSISTENCE TOOLS — datasets
        // ----------------------------------------------------------------

        // 16. save_dataset
        Tool::new(
            "save_dataset",
            "Persist a dataset to the SQLite ai_datasets table. Returns { id }.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "label": { "type": "string" },
                    "kind": { "type": "string", "enum": ["overlay", "series"] },
                    "align": { "type": "string", "enum": ["right", "index"] },
                    "sym": { "type": "string" },
                    "tf": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] },
                    "values": { "type": "array", "items": {} }
                },
                "required": ["id", "label", "kind", "align", "sym", "tf", "values"]
            })),
        ),

        // 17. list_datasets
        Tool::new(
            "list_datasets",
            "List all persisted datasets.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "filter": { "type": "string", "description": "Optional free-text filter." }
                }
            })),
        ),

        // 18. load_dataset
        Tool::new(
            "load_dataset",
            "Load one dataset by id.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 19. delete_dataset (consent)
        Tool::new(
            "delete_dataset",
            "Delete a dataset from the database. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // ----------------------------------------------------------------
        // PERSISTENCE TOOLS — research overlays (library)
        // ----------------------------------------------------------------

        // 19a. save_research_overlay (consent)
        Tool::new(
            "save_research_overlay",
            "Persist a research overlay to the saved-overlay library for later reuse. Consent required (writes disk). \
             Returns { id }.\n\
             \n\
             Use this to keep a multi-element study around after the session ends; reload it later with \
             load_research_overlay and re-apply via apply_research_overlay. This is the durable library — \
             distinct from the session-only remove_research_overlay, which only clears the live chart.\n\
             \n\
             Takes the same payload as apply_research_overlay: \
             { id, sym, tf ('1h'|'4h'|'1d'|'1w'), label, color?, elements[] }. See apply_research_overlay \
             for the full `elements` discriminated union and size caps.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "sym": { "type": "string" },
                    "tf": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] },
                    "label": { "type": "string" },
                    "color": { "type": "string" },
                    "elements": {
                        "type": "array",
                        "maxItems": 50,
                        "items": { "type": "object" },
                        "description": "Discriminated union on `type`: line | band | hline | markers | event_mark | text | hotspot. See apply_research_overlay for each element's fields and size caps."
                    }
                },
                "required": ["id", "sym", "tf", "label", "elements"]
            })),
        ),

        // 19b. list_research_overlays
        Tool::new(
            "list_research_overlays",
            "List metadata for all saved research overlays in the library. Returns \
             { overlays: [{ id, sym, tf, label, created_at }] } — metadata only, not the full element payload. \
             Load a full overlay with load_research_overlay.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "object",
                        "description": "Optional filter on saved overlays.",
                        "properties": {
                            "sym": { "type": "string" },
                            "tf": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] }
                        }
                    }
                }
            })),
        ),

        // 19c. load_research_overlay
        Tool::new(
            "load_research_overlay",
            "Load one saved research overlay by id, returning the full ResearchOverlay \
             { id, sym, tf, label, color?, elements[] } so it can be re-applied to the chart via \
             apply_research_overlay.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 19d. delete_research_overlay (consent)
        Tool::new(
            "delete_research_overlay",
            "Delete a saved research overlay from the library by id. Consent required. \
             This removes it from durable storage — distinct from remove_research_overlay, which only \
             clears the overlay from the live chart for the current session. Returns { id }.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // ----------------------------------------------------------------
        // COMPUTE TOOLS (round-trip to TS, no consent)
        // ----------------------------------------------------------------

        // 20. validate_strategy
        Tool::new(
            "validate_strategy",
            "Validate a Strategy DSL object using the canonical Zod schema. \
             Returns { ok: true, strategy } or { ok: false, error }.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "json": { "type": "object", "description": "Strategy DSL JSON to validate." }
                },
                "required": ["json"]
            })),
        ),

        // 21. backtest_strategy
        Tool::new(
            "backtest_strategy",
            "Run a backtest for a Strategy DSL over historical OHLC data. \
             Returns perf stats, trades, and an equity curve.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "strategy": { "type": "object" },
                    "sym": { "type": "string" },
                    "tf": { "type": "string", "enum": ["1h", "4h", "1d", "1w"] },
                    "count": { "type": "integer", "minimum": 10, "maximum": 2000 }
                },
                "required": ["strategy", "sym", "tf"]
            })),
        ),

        // ----------------------------------------------------------------
        // PERSISTENCE TOOLS — strategies
        // ----------------------------------------------------------------

        // 22. save_strategy
        Tool::new(
            "save_strategy",
            "Persist a Strategy DSL to the ai_strategies table (creates revision 1). \
             Returns { id }.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["id", "name"],
                "additionalProperties": true
            })),
        ),

        // 23. list_strategies
        Tool::new(
            "list_strategies",
            "List all persisted strategies, ordered by updated_at DESC.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "filter": { "type": "string" }
                }
            })),
        ),

        // 24. load_strategy
        Tool::new(
            "load_strategy",
            "Load one strategy by id.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // 25. update_strategy (consent — appends revision per ADR-0005)
        Tool::new(
            "update_strategy",
            "Update a strategy with a new body. Consent required. \
             Appends a new strategy_revisions row (append-only per ADR-0005).",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "body_json": { "type": "string", "description": "JSON-serialised Strategy DSL." }
                },
                "required": ["id", "body_json"]
            })),
        ),

        // 26. delete_strategy (consent)
        Tool::new(
            "delete_strategy",
            "Delete a strategy and all its revisions. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            })),
        ),

        // ----------------------------------------------------------------
        // PERSISTENCE TOOLS — research notes
        // ----------------------------------------------------------------

        // 27. save_research_note
        Tool::new(
            "save_research_note",
            "Persist a research note to the research_notes table.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "symbol": { "type": "string" },
                    "timeframe": { "type": "string" }
                },
                "required": ["title", "body"]
            })),
        ),

        // 28. list_research_notes
        Tool::new(
            "list_research_notes",
            "List all persisted research notes, ordered by created_at DESC.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "filter": { "type": "string" }
                }
            })),
        ),

        // ----------------------------------------------------------------
        // PAPER TRADING
        // ----------------------------------------------------------------

        // 29. paper_open_position (consent)
        Tool::new(
            "paper_open_position",
            "Open a new paper-trade position. Consent required. Paper trading only — never places real orders.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "symbol": { "type": "string" },
                    "side": { "type": "string", "enum": ["long", "short"] },
                    "qty": { "type": "number", "minimum": 0 },
                    "ref_price": { "type": "number", "minimum": 0 }
                },
                "required": ["symbol", "side", "qty", "ref_price"]
            })),
        ),

        // 30. paper_close_position (consent)
        Tool::new(
            "paper_close_position",
            "Close an open paper-trade position. Consent required.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "close_price": { "type": "number" }
                },
                "required": ["id"]
            })),
        ),

        // 31. get_paper_pnl (read-only aggregate)
        Tool::new(
            "get_paper_pnl",
            "Get aggregate paper-trade P&L summary (realized + unrealized).",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // ----------------------------------------------------------------
        // PORTFOLIO TOOLS — research-only position tracking
        // ----------------------------------------------------------------

        // 32. portfolio_list_holdings (read-only)
        Tool::new(
            "portfolio_list_holdings",
            "List all portfolio holdings as a raw array of rows. \
             Returns [{sym, provider, quote, asset_class, qty, avg_cost, currency, note, created_at, updated_at}]. \
             Use portfolio_get_summary for a version enriched with live prices and P&L.",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 33. portfolio_get_summary (read-only, fetches live prices)
        Tool::new(
            "portfolio_get_summary",
            "Get the full portfolio with total value, cost, unrealized P&L, and per-holding \
             breakdown with current prices and weights. Use this to analyze the user's holdings. \
             Returns { total_value, total_cost, unrealized_pnl, unrealized_pnl_pct, holding_count, \
             priced_count, holdings: [{sym, provider, quote, asset_class, qty, avg_cost, price, \
             value, cost, unrealized_pnl, unrealized_pnl_pct, weight_pct}] }. \
             price/value/unrealized fields are null when the live-price fetch fails for a holding.",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 34. portfolio_get_allocation (read-only, fetches live prices)
        Tool::new(
            "portfolio_get_allocation",
            "Get portfolio allocation breakdown: by asset_class (crypto/equity/etc.) and by \
             individual holding, plus best and worst performer by unrealized P&L %. \
             Returns { total_value, by_class: [{asset_class, value, weight_pct}], \
             by_holding: [{sym, provider, quote, weight_pct}], best_performer, worst_performer }. \
             Use this to understand concentration risk and top/bottom movers.",
            schema_to_arc(json!({ "type": "object", "properties": {} })),
        ),

        // 35. portfolio_set_holding (consent-gated mutation)
        Tool::new(
            "portfolio_set_holding",
            "Set (create or replace) a portfolio holding by providing the full position. \
             Consent required. Use this to initialize a holding or correct an existing one. \
             For adding a new lot to an existing position, prefer portfolio_add_lot which \
             correctly weight-averages the cost basis.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "sym": { "type": "string", "description": "Asset symbol, e.g. 'BTC', 'ETH', 'AAPL'." },
                    "provider": { "type": "string", "description": "Data provider id, e.g. 'coinbase', 'binance', 'alpaca'." },
                    "quote": { "type": "string", "description": "Quote currency, e.g. 'USD', 'USDT', 'USDC'." },
                    "qty": { "type": "number", "description": "Total quantity held (must be >= 0).", "minimum": 0 },
                    "avg_cost": { "type": "number", "description": "Average cost per unit.", "minimum": 0 },
                    "asset_class": { "type": "string", "description": "Asset class: 'crypto' or 'equity'. Required as 'equity' for stocks (NASDAQ/NYSE tickers)." },
                    "currency": { "type": "string", "description": "Settlement currency for P&L (e.g. 'USD'). Defaults to 'USD'." },
                    "note": { "type": "string", "description": "Optional free-text note about the position." }
                },
                "required": ["sym", "provider", "quote", "qty", "avg_cost"]
            })),
        ),

        // 36. portfolio_add_lot (consent-gated mutation)
        Tool::new(
            "portfolio_add_lot",
            "Add a new purchase lot to an existing portfolio holding, correctly weight-averaging \
             the cost basis: new_avg_cost = (old_qty * old_avg_cost + add_qty * add_price) / (old_qty + add_qty). \
             If the holding does not exist yet it is created. Consent required. add_qty must be > 0.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "sym": { "type": "string", "description": "Asset symbol, e.g. 'BTC'." },
                    "provider": { "type": "string", "description": "Data provider id." },
                    "quote": { "type": "string", "description": "Quote currency, e.g. 'USD'." },
                    "add_qty": { "type": "number", "description": "Quantity of this lot (must be > 0).", "exclusiveMinimum": 0 },
                    "add_price": { "type": "number", "description": "Price per unit for this lot.", "minimum": 0 },
                    "asset_class": { "type": "string", "description": "Asset class: 'crypto' or 'equity'. Required as 'equity' for stocks (NASDAQ/NYSE tickers)." },
                    "currency": { "type": "string", "description": "Settlement currency. Defaults to 'USD'." },
                    "note": { "type": "string", "description": "Optional note for this lot." }
                },
                "required": ["sym", "provider", "quote", "add_qty", "add_price"]
            })),
        ),

        // 37. portfolio_reduce_holding (consent-gated mutation)
        Tool::new(
            "portfolio_reduce_holding",
            "Partially reduce (sell down) an existing portfolio holding by sell_qty. \
             The weight-average cost basis (avg_cost) is left UNCHANGED — no realized P&L is \
             captured here. If the resulting quantity drops to <= 0 the holding row is deleted. \
             Consent required. Identified by the (sym, provider, quote) triple; no-op if the \
             holding does not exist. sell_qty must be > 0. \
             For removing a holding entirely regardless of quantity, use portfolio_remove_holding.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "sym": { "type": "string", "description": "Asset symbol to reduce." },
                    "provider": { "type": "string", "description": "Data provider id." },
                    "quote": { "type": "string", "description": "Quote currency." },
                    "sell_qty": { "type": "number", "description": "Quantity to sell/reduce (must be > 0). The row is deleted when remaining qty <= 0.", "exclusiveMinimum": 0 }
                },
                "required": ["sym", "provider", "quote", "sell_qty"]
            })),
        ),

        // 38. portfolio_remove_holding (consent-gated mutation)
        Tool::new(
            "portfolio_remove_holding",
            "Remove a holding entirely from the portfolio. Consent required. \
             Identified by the (sym, provider, quote) triple. No-op if the holding does not exist.",
            schema_to_arc(json!({
                "type": "object",
                "properties": {
                    "sym": { "type": "string", "description": "Asset symbol to remove." },
                    "provider": { "type": "string", "description": "Data provider id." },
                    "quote": { "type": "string", "description": "Quote currency." }
                },
                "required": ["sym", "provider", "quote"]
            })),
        ),
    ]
}

/// Convert a `serde_json::Value` (must be an object) into `Arc<serde_json::Map<String, Value>>`.
fn schema_to_arc(v: Value) -> Arc<serde_json::Map<String, Value>> {
    match v {
        Value::Object(m) => Arc::new(m),
        _ => panic!("schema_to_arc: expected JSON object"),
    }
}

// ---------------------------------------------------------------------------
// Bridge call helper
// ---------------------------------------------------------------------------

/// Map method + bridge-translated params → BridgeState call → CallToolResult.
async fn dispatch_to_bridge(
    bridge: &Arc<BridgeState>,
    sock_path: &Path,
    token: &str,
    method: &str,
    params: Value,
) -> Result<CallToolResult, McpError> {
    let result = bridge::reconnect_call(bridge, sock_path, token, method, params).await;

    match result {
        CallResult::Ok(v) => {
            let text = if v.is_string() {
                v.as_str().unwrap_or("").to_string()
            } else {
                serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string())
            };
            Ok(CallToolResult::success(vec![Content::text(text)]))
        }
        CallResult::Err { code, message } => {
            let text = if code == bridge::ERR_NOT_IMPLEMENTED {
                format!("not_implemented: {method}")
            } else if code == ERR_USER_DENIED {
                // Spec: code -32006 becomes is_error:true + "User denied this action."
                "User denied this action.".to_string()
            } else {
                format!("error({}): {}", code, message)
            };
            Ok(CallToolResult::error(vec![Content::text(text)]))
        }
    }
}

/// Translate `CallToolRequestParams.arguments` (which is `Option<JsonObject>`) to a `Value`.
fn args_to_value(args: Option<&serde_json::Map<String, Value>>) -> Value {
    match args {
        Some(m) => Value::Object(m.clone()),
        None => json!({}),
    }
}

// ---------------------------------------------------------------------------
// ServerHandler implementation
// ---------------------------------------------------------------------------

impl ServerHandler for TradingPortalServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "autoplot MCP server — full app tool surface for research, strategy, and chart analysis.",
            )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + MaybeSendFuture + '_
    {
        let tools = self.tools.clone();
        async move {
            Ok(ListToolsResult {
                meta: None,
                next_cursor: None,
                tools,
            })
        }
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + MaybeSendFuture + '_
    {
        let bridge = Arc::clone(&self.bridge);
        let sock_path = self.sock_path.clone();
        let token = self.token.clone();

        async move {
            let method = request.name.as_ref();
            let params = args_to_value(request.arguments.as_ref());

            match method {
                // --------------------------------------------------------
                // fetch_ohlc — translate schema field names
                // --------------------------------------------------------
                "fetch_ohlc" => {
                    let mut bridge_params = serde_json::Map::new();
                    if let Some(s) = params.get("symbol").and_then(|v| v.as_str()) {
                        bridge_params.insert("sym".to_string(), json!(s));
                    }
                    if let Some(tf) = params.get("timeframe").and_then(|v| v.as_str()) {
                        bridge_params.insert("tf".to_string(), json!(tf));
                    }
                    if let Some(n) = params.get("limit").and_then(|v| v.as_u64()) {
                        bridge_params.insert("count".to_string(), json!(n));
                    }
                    if !bridge_params.contains_key("provider") {
                        bridge_params.insert(
                            "provider".to_string(),
                            json!(params
                                .get("provider")
                                .and_then(|v| v.as_str())
                                .unwrap_or("coinbase")),
                        );
                    }
                    dispatch_to_bridge(
                        &bridge,
                        &sock_path,
                        &token,
                        "fetch_ohlc",
                        Value::Object(bridge_params),
                    )
                    .await
                }

                // --------------------------------------------------------
                // All other tools — pass through 1:1 to bridge method name
                // --------------------------------------------------------
                "compute_indicator"
                | "get_current_symbol"
                | "get_visible_range"
                | "list_overlays"
                | "list_assets"
                | "read_attachment"
                | "list_attachments"
                | "apply_dataset"
                | "remove_dataset"
                | "apply_timeline_events"
                | "remove_timeline_layer"
                | "apply_strategy"
                | "remove_strategy_overlay"
                | "apply_research_overlay"
                | "remove_research_overlay"
                | "open_strategy_artifact"
                | "save_dataset"
                | "list_datasets"
                | "load_dataset"
                | "delete_dataset"
                | "save_research_overlay"
                | "list_research_overlays"
                | "load_research_overlay"
                | "delete_research_overlay"
                | "validate_strategy"
                | "backtest_strategy"
                | "save_strategy"
                | "list_strategies"
                | "load_strategy"
                | "update_strategy"
                | "delete_strategy"
                | "save_research_note"
                | "list_research_notes"
                | "paper_open_position"
                | "paper_close_position"
                | "get_paper_pnl"
                | "portfolio_list_holdings"
                | "portfolio_get_summary"
                | "portfolio_get_allocation"
                | "portfolio_set_holding"
                | "portfolio_add_lot"
                | "portfolio_reduce_holding"
                | "portfolio_remove_holding" => {
                    dispatch_to_bridge(&bridge, &sock_path, &token, method, params).await
                }

                _ => {
                    Ok(CallToolResult::error(vec![Content::text(format!(
                        "unknown tool: {method}"
                    ))]))
                }
            }
        }
    }
}
