/**
 * src/ai/schemas.ts — Wave 4 / W4-A — Zod schemas for the Co-Research tool
 * round-trip layer.
 *
 * These schemas are the contract between the model's `return_dataset` tool
 * call and the panel UI that renders the resulting dataset. Enums are
 * **pinned**: the model is constrained to the exact identifier set defined
 * here, and any drift surfaces as a Zod parse error inside the
 * `return_dataset` handler.
 *
 * Tf is reused from `../data/MarketDataProvider` (FROZEN per Architectural
 * Decision A3 — `'1h' | '4h' | '1d' | '1w'`). Tool functions reject any `tf`
 * outside the locked 4-tier set.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tf — re-exported from the FROZEN MarketDataProvider interface so consumers
// have one import surface. Do NOT introduce a new enum here; this MUST track
// the upstream type identically.
// ---------------------------------------------------------------------------
export type { Tf } from '../data/MarketDataProvider';

/** Runtime guard for the 4-tier set. Used by tool handlers. */
export const TF_VALUES: ReadonlyArray<'1h' | '4h' | '1d' | '1w'> = [
  '1h',
  '4h',
  '1d',
  '1w',
];

export const TfSchema = z.enum(['1h', '4h', '1d', '1w']);

// ---------------------------------------------------------------------------
// Indicator enum — verbatim, pinned. Adding/renaming an entry here is a
// breaking change for the system prompt and the `compute_indicator` handler.
// ---------------------------------------------------------------------------
export const Indicator = z.enum([
  'close',
  'open',
  'high',
  'low',
  'volume',
  'sma',
  'ema',
  'rsi',
  'atr',
  'bollinger_upper',
  'bollinger_middle',
  'bollinger_lower',
  'donchian_high',
  'donchian_low',
  'realized_vol',
]);
export type Indicator = z.infer<typeof Indicator>;

// ---------------------------------------------------------------------------
// Op — comparison operators allowed in conditions. AND-only at the parent
// level; the model MUST NOT emit OR groups (enforced by the system prompt
// and by Dataset's lack of an `or` field).
// ---------------------------------------------------------------------------
export const Op = z.enum([
  '<',
  '>',
  '<=',
  '>=',
  '==',
  'crossesAbove',
  'crossesBelow',
]);
export type Op = z.infer<typeof Op>;

// ---------------------------------------------------------------------------
// IndicatorRef — references one of the pinned Indicator values plus an
// optional bag of numeric parameters (period, k, etc.).
// ---------------------------------------------------------------------------
export const IndicatorRef = z.object({
  ref: Indicator,
  params: z.record(z.string(), z.number()).optional(),
});
export type IndicatorRef = z.infer<typeof IndicatorRef>;

// ---------------------------------------------------------------------------
// Condition — single AND-clause comparison. RHS may be either a literal
// number or an `IndicatorRef`. There is no `or` field by design.
// ---------------------------------------------------------------------------
export const Condition = z.object({
  left: IndicatorRef,
  op: Op,
  value: z.union([z.number(), IndicatorRef]),
});
export type Condition = z.infer<typeof Condition>;

// ---------------------------------------------------------------------------
// Dataset — terminal payload returned via `return_dataset`.
//
//   `kind: 'overlay'` — series rendered ON the price axis (e.g. SMA(20)).
//   `kind: 'series'`  — series rendered in its own pane (e.g. RSI(14)).
//
//   `align: 'right'`  — right-anchored values: `values[length-1]` aligns to
//                       the last visible bar; the consumer pads the LEFT
//                       with `null` if `values.length < visibleBars`.
//   `align: 'index'`  — positional: `values.length === visibleBars` and
//                       `values[i]` aligns to bar `i` of the visible window.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// W5-A — Strategy schema (P7 Co-Strategy)
//
// `StrategyCondition` differs in shape from W4-A's `Condition`: a strategy
// rule references an indicator directly (`indicator: Indicator`) plus an
// optional `params` bag, while W4-A's dataset `Condition` wraps the LHS in
// an `IndicatorRef`. The two coexist; we keep W4-A's `Condition` exported
// unchanged to avoid breaking callers.
// ---------------------------------------------------------------------------
export const StrategyCondition = z.object({
  indicator: Indicator,
  op: Op,
  value: z.union([z.number(), IndicatorRef]),
  params: z.record(z.string(), z.number()).optional(),
});
export type StrategyCondition = z.infer<typeof StrategyCondition>;

export const PerfStats = z.object({
  winRate: z.number(),
  sharpe: z.number(),
  maxDrawdown: z.number(),
  trades: z.number(),
});
export type PerfStats = z.infer<typeof PerfStats>;

export const Strategy = z.object({
  id: z.string(),
  name: z.string(),
  thesis: z.string(),
  rules: z.object({
    entry: z.array(StrategyCondition).min(1),
    exit: z.array(StrategyCondition).min(1),
    filters: z.array(StrategyCondition).optional(),
  }),
  perf: PerfStats.nullable().optional(),
  version: z.literal(1),
  createdAt: z.number(),
});
export type Strategy = z.infer<typeof Strategy>;

export const Dataset = z.object({
  /** Stable identifier used as React key + DB row id (W4-B). */
  id: z.string().min(1),
  /** Human-readable label rendered in the LibraryTab / overlay legend. */
  label: z.string().min(1),
  kind: z.enum(['overlay', 'series']),
  /**
   * Alignment of `values` against the visible bar window.
   *
   * - `'right'`: right-anchored. `values[length-1]` corresponds to the most
   *   recent visible bar; positions to the left are padded with `null` by
   *   the consumer when `values.length < visibleBars`. Use this when the
   *   producer doesn't know the visible window length.
   * - `'index'`: positional. `values.length === visibleBars` exactly and
   *   `values[i]` corresponds to bar `i`. Use this when the producer was
   *   told the visible window up front.
   */
  align: z.enum(['right', 'index']),
  /** Symbol (canonical token) the dataset was computed against. */
  sym: z.string().min(1),
  /** Timeframe the dataset was computed against. */
  tf: TfSchema,
  /** Optional ANDed conditions. OR groups are not representable. */
  conditions: z.array(Condition).optional(),
  /** Numeric value series. `null` entries are gaps (cold-start, no data). */
  values: z.array(z.union([z.number(), z.null()])),
  /** Optional free-form provenance / explanation rendered as a tooltip. */
  notes: z.string().optional(),
});
export type Dataset = z.infer<typeof Dataset>;

// ---------------------------------------------------------------------------
// ResearchOverlay (Step 4 — generic research overlay)
//
// A single richer-than-Dataset overlay: one `ResearchOverlay` bundles up to
// 50 heterogeneous `Element`s (lines, bands, horizontal lines, markers, event
// marks, free text, hotspot panels) all keyed to one `(sym, tf)`. Agents
// should PREFER this over `apply_dataset` for anything beyond a single bare
// numeric series — `apply_dataset` remains the lightweight single-series path.
//
// Wire shape is snake_case to mirror the Rust serde / Dataset convention.
// Size caps are enforced as Zod `.max()` constraints so an oversized payload
// fails at dispatch with field-level diagnostics instead of bloating the chart.
// ---------------------------------------------------------------------------

/** Alignment of a positional value series against the visible bar window
 *  — identical semantics to `Dataset.align`. */
const OverlayAlign = z.enum(['right', 'index']);

/** `line` — a single numeric series drawn as a polyline on the price axis. */
export const LineElement = z.object({
  type: z.literal('line'),
  values: z.array(z.union([z.number(), z.null()])).max(500),
  align: OverlayAlign,
  color: z.string().optional(),
  width: z.number().optional(),
  dash: z.string().optional(),
});
export type LineElement = z.infer<typeof LineElement>;

/** `band` — a shaded region between an `upper` and `lower` series. */
export const BandElement = z.object({
  type: z.literal('band'),
  upper: z.array(z.union([z.number(), z.null()])).max(500),
  lower: z.array(z.union([z.number(), z.null()])).max(500),
  align: OverlayAlign,
  color: z.string().optional(),
  opacity: z.number().optional(),
});
export type BandElement = z.infer<typeof BandElement>;

/** `hline` — a horizontal price line spanning the full chart width. */
export const HLineElement = z.object({
  type: z.literal('hline'),
  price: z.number(),
  label: z.string().optional(),
  color: z.string().optional(),
  dash: z.string().optional(),
});
export type HLineElement = z.infer<typeof HLineElement>;

/** A single point inside a `markers` element. */
export const MarkerPoint = z.object({
  ts: z.number(),
  price: z.number().optional(),
  anchor: z.enum(['above', 'below']).optional(),
  shape: z.enum(['triangle-up', 'triangle-down', 'circle', 'diamond']),
  color: z.string().optional(),
  label: z.string().optional(),
});
export type MarkerPoint = z.infer<typeof MarkerPoint>;

/** `markers` — up to 100 discrete glyphs placed at timestamps. */
export const MarkersElement = z.object({
  type: z.literal('markers'),
  points: z.array(MarkerPoint).max(100),
});
export type MarkersElement = z.infer<typeof MarkersElement>;

/** `event_mark` — a time-anchored pin / vertical line / range (NOT an annotation). */
export const EventMarkElement = z.object({
  type: z.literal('event_mark'),
  kind: z.enum(['pin', 'vline', 'range']),
  ts: z.number(),
  ts_end: z.number().optional(),
  label: z.string(),
  color: z.string().optional(),
});
export type EventMarkElement = z.infer<typeof EventMarkElement>;

/** `text` — free-form text anchored to a `(ts, price)` coordinate. */
export const TextElement = z.object({
  type: z.literal('text'),
  ts: z.number(),
  price: z.number(),
  content: z.string().max(200),
  color: z.string().optional(),
  size: z.number().optional(),
});
export type TextElement = z.infer<typeof TextElement>;

/** One row inside a `PanelSpec`. */
export const PanelRow = z.object({
  label: z.string(),
  value: z.string(),
  color: z.string().optional(),
  glyph: z.string().optional(),
});
export type PanelRow = z.infer<typeof PanelRow>;

/** Tabular readout shown by a `hotspot` element (max 16 rows). */
export const PanelSpec = z.object({
  title: z.string().optional(),
  rows: z.array(PanelRow).max(16),
  footer: z.string().optional(),
});
export type PanelSpec = z.infer<typeof PanelSpec>;

/** `hotspot` — a point that reveals a `PanelSpec` readout on hover/click. */
export const HotspotElement = z.object({
  type: z.literal('hotspot'),
  ts: z.number(),
  price: z.number().optional(),
  panel: PanelSpec,
});
export type HotspotElement = z.infer<typeof HotspotElement>;

/** Discriminated union over the seven research-overlay element kinds. */
export const Element = z.discriminatedUnion('type', [
  LineElement,
  BandElement,
  HLineElement,
  MarkersElement,
  EventMarkElement,
  TextElement,
  HotspotElement,
]);
export type Element = z.infer<typeof Element>;

export const ResearchOverlay = z.object({
  /** Stable identifier used as React key + store key. */
  id: z.string().min(1),
  /** Symbol (canonical token) the overlay was computed against. */
  sym: z.string().min(1),
  /** Timeframe the overlay was computed against (FROZEN 4-tier set). */
  tf: TfSchema,
  /** Human-readable label rendered in the overlay legend. */
  label: z.string(),
  /** Optional default color for elements that omit their own. */
  color: z.string().optional(),
  /** Heterogeneous element list — max 50. */
  elements: z.array(Element).max(50),
});
export type ResearchOverlay = z.infer<typeof ResearchOverlay>;
