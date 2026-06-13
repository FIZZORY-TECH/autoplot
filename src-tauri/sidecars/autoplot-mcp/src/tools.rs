//! JSON-Schema input types for all MCP tools (read-only + mutation + persistence + compute).
//!
//! These types mirror the Zod schemas in `src/ai/schemas.ts` exactly.
//! They are used as reference/documentation for the JSON schemas
//! returned by `tools/list`.
//! `schemars::JsonSchema` drives schema generation inside rmcp.

#![allow(dead_code)]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared enums (pinned — mirrors schemas.ts)
// ---------------------------------------------------------------------------

/// Timeframe — frozen 4-tier set per MarketDataProvider contract.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub enum Timeframe {
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "4h")]
    FourHour,
    #[serde(rename = "1d")]
    OneDay,
    #[serde(rename = "1w")]
    OneWeek,
}

/// Indicator — 15-entry pinned enum (schemas.ts:38-54).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Indicator {
    Close,
    Open,
    High,
    Low,
    Volume,
    Sma,
    Ema,
    Rsi,
    Atr,
    BollingerUpper,
    BollingerMiddle,
    BollingerLower,
    DonchianHigh,
    DonchianLow,
    RealizedVol,
}

// ---------------------------------------------------------------------------
// Tool parameter structs — read-only tools (Step 5)
// ---------------------------------------------------------------------------

/// `fetch_ohlc` — fetch OHLC bars for a symbol/timeframe.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FetchOhlcParams {
    pub symbol: String,
    pub timeframe: Timeframe,
    pub limit: Option<u32>,
}

/// `compute_indicator` — compute a technical indicator over a bar series.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ComputeIndicatorParams {
    pub name: Indicator,
    pub bars: Vec<serde_json::Value>,
    pub params: Option<serde_json::Value>,
}

/// `list_assets` — list all registered assets/symbols.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListAssetsParams {}

/// `get_current_symbol` — return the symbol currently selected on the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GetCurrentSymbolParams {}

/// `get_visible_range` — return the visible time range on the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GetVisibleRangeParams {}

/// `list_overlays` — list all dataset overlays rendered on the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListOverlaysParams {}

/// `read_attachment` — read an uploaded file attachment by its file_id.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReadAttachmentParams {
    pub file_id: String,
}

// ---------------------------------------------------------------------------
// Tool parameter structs — mutation tools (Step 6)
// ---------------------------------------------------------------------------

/// `apply_dataset` — render a dataset overlay on the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ApplyDatasetParams {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub align: String,
    pub sym: String,
    pub tf: String,
    pub values: Vec<serde_json::Value>,
}

/// `remove_dataset` — remove a dataset overlay from the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RemoveDatasetParams {
    pub id: String,
}

/// `apply_timeline_events` — render a named timeline events layer on the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ApplyTimelineEventsParams {
    pub id: Option<String>,
    pub name: String,
    pub events: Vec<serde_json::Value>,
}

/// `remove_timeline_layer` — remove a timeline events layer from the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RemoveTimelineLayerParams {
    pub id: String,
}

/// `apply_strategy` — render a saved strategy's entry/exit overlay on the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ApplyStrategyParams {
    pub id: String,
}

/// `remove_strategy_overlay` — remove a strategy overlay from the chart.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RemoveStrategyOverlayParams {
    pub id: String,
}

/// `open_strategy_artifact` — open the Strategy Artifact Panel for a strategy.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct OpenStrategyArtifactParams {
    pub id: String,
}

// ---------------------------------------------------------------------------
// Tool parameter structs — persistence tools (Step 6)
// ---------------------------------------------------------------------------

/// `save_dataset` — persist a dataset to the SQLite ai_datasets table.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SaveDatasetParams {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub align: String,
    pub sym: String,
    pub tf: String,
    pub values: Vec<serde_json::Value>,
}

/// `list_datasets` — list all saved datasets.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListDatasetsParams {
    pub filter: Option<String>,
}

/// `load_dataset` — load one dataset by id.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LoadDatasetParams {
    pub id: String,
}

/// `delete_dataset` — delete a dataset (consent required).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct DeleteDatasetParams {
    pub id: String,
}

/// `save_research_overlay` — persist a research overlay to the library (consent required).
/// Same payload shape as `apply_research_overlay`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SaveResearchOverlayParams {
    pub id: String,
    pub sym: String,
    pub tf: String,
    pub label: String,
    pub color: Option<String>,
    pub elements: Vec<serde_json::Value>,
}

/// `list_research_overlays` — list saved-overlay metadata (optionally filtered by sym/tf).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListResearchOverlaysParams {
    pub filter: Option<ResearchOverlayFilter>,
}

/// Optional filter for `list_research_overlays`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ResearchOverlayFilter {
    pub sym: Option<String>,
    pub tf: Option<String>,
}

/// `load_research_overlay` — load one saved research overlay by id.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LoadResearchOverlayParams {
    pub id: String,
}

/// `delete_research_overlay` — delete a saved research overlay from the library (consent required).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct DeleteResearchOverlayParams {
    pub id: String,
}

/// `validate_strategy` — validate a Strategy DSL object (round-trip to TS).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ValidateStrategyParams {
    pub json: serde_json::Value,
}

/// `backtest_strategy` — run a backtest (round-trip to TS).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BacktestStrategyParams {
    pub strategy: serde_json::Value,
    pub sym: String,
    pub tf: String,
    pub count: Option<u32>,
}

/// `save_strategy` — persist a strategy to the ai_strategies table.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SaveStrategyParams {
    pub id: String,
    pub name: String,
}

/// `list_strategies` — list all saved strategies.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListStrategiesParams {
    pub filter: Option<String>,
}

/// `load_strategy` — load one strategy by id.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LoadStrategyParams {
    pub id: String,
}

/// `update_strategy` — update a strategy with a new body (consent required; appends revision).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateStrategyParams {
    pub id: String,
    pub body_json: String,
}

/// `delete_strategy` — delete a strategy and all its revisions (consent required).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct DeleteStrategyParams {
    pub id: String,
}

/// `save_research_note` — persist a research note.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SaveResearchNoteParams {
    pub title: String,
    pub body: String,
    pub tags: Option<Vec<String>>,
    pub symbol: Option<String>,
    pub timeframe: Option<String>,
}

/// `list_research_notes` — list all research notes.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListResearchNotesParams {
    pub filter: Option<String>,
}

/// `paper_open_position` — open a new paper-trade position (consent required).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PaperOpenPositionParams {
    pub symbol: String,
    pub side: String,
    pub qty: f64,
    pub ref_price: f64,
}

/// `paper_close_position` — close an open paper-trade position (consent required).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PaperClosePositionParams {
    pub id: String,
    pub close_price: Option<f64>,
}

/// `get_paper_pnl` — get aggregate paper-trade P&L.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GetPaperPnlParams {}

/// `list_attachments` — list files in the attachment jail.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListAttachmentsParams {
    pub session: Option<String>,
}
