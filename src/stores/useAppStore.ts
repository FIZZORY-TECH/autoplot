/**
 * src/stores/useAppStore.ts — Global app state stub
 *
 * P1+ will tighten these types and add actions.
 * Keep this file minimal — it is a skeleton only.
 *
 * P2.5 added: `activeTool` (mark/comment/rangeScope/none) and `marks` (mirror of SQLite).
 * P2.6 added: `rangeScope` (selected bar-index range).
 * P2.1 added: `hoveredBarIdx`, `paletteOpen`.
 * P2.2 added: `setChartType`, `setTf` — Dock activates these. Defaults added here.
 * P2.4 added: `indicatorFlags`, `setIndicatorFlag`, `customSeries`, `customSeriesEnabled`,
 *             `setCustomSeries`, `setCustomSeriesEnabled`.
 * P3.1 added: `hydrated` (SQLite hydration complete), `viewport` (chart x-window),
 *             `setActiveSym`, `setViewport`.
 * P3.2 added: `addAssetModalOpen` (controls AddAssetModal visibility).
 * P4.5 added: `lastTickAt` (unix ms of last successful real-time tick or fetch;
 *             null until first event). The Headline reads this to render the
 *             degraded "stale" badge when no ticks land for >60s. Session-only
 *             — NOT persisted to SQLite.
 * Chrome agents own all other fields added in P2.x.
 */

import { create } from 'zustand';
import type { Mark, TrendRow } from '../lib/db';
import type { ChartType } from '../chart/ChartCanvas';
import type { Tf } from '../data/MarketDataProvider';
import type { Trade } from '../engine/backtest';

export type ActiveTool = 'none' | 'mark' | 'comment' | 'rangeScope' | 'trend';

/** A trend-line draft mid-creation — anchor 1 set, anchor 2 follows the cursor. */
export interface TrendDraft {
  /** Bar timestamp (unix ms) of the first anchor. */
  x1_ts: number;
  /** Price of the first anchor. */
  y1_price: number;
  /** Live cursor position — second anchor as the user drags. */
  x2_ts: number;
  y2_price: number;
}

/** Chart viewport — bar-index start/end, persisted to app_state as JSON. */
export interface Viewport {
  start: number;
  end: number;
}

/**
 * Canonical active-asset descriptor (ADR-0009 §1).
 *
 * `activeSym` widens to `activeAsset: { sym, provider, quote }` because the
 * canonical instrument identity is now `(provider, sym, quote)` — SOL/USDT
 * and SOL/USDC are different markets and the active selection must
 * disambiguate them. Step 5b adds this additively alongside the legacy
 * `activeSym`; Step 7 widens downstream callsites; Step 11 prunes
 * `activeSym` / `setActiveSym`.
 */
export interface ActiveAsset {
  sym: string;
  provider: string;
  quote: string;
}

interface AppState {
  /** Currently active symbol (e.g. "BTC"). Set by P3 watchlist select. */
  activeSym?: string;
  setActiveSym: (sym: string) => void;
  /**
   * ADR-0009 — canonical active-instrument tuple. Optional during the Step
   * 5b→Step 11 transition window; once Step 11 lands this becomes required
   * and `activeSym` is removed.
   */
  activeAsset?: ActiveAsset;
  /**
   * Setter for the canonical active-asset tuple. When called with a value,
   * also mirrors the `sym` half into the legacy `activeSym` slot so existing
   * downstream readers (Step 7 hasn't widened yet) still see the right
   * symbol. When called with `undefined`, leaves `activeSym` untouched —
   * legacy callers preserve their pre-Step-5b behavior.
   */
  setActiveAsset: (asset: ActiveAsset | undefined) => void;
  /** Active chart type. Set by P2.2 Dock. */
  chartType: ChartType;
  setChartType: (ct: ChartType) => void;
  /** Active timeframe — 4-tier ONLY (locked per G-4). Set by P2.2 Dock. */
  tf: Tf;
  setTf: (tf: Tf) => void;

  // ---- P3.1 additions -----------------------------------------------------
  /**
   * True once `hydrateAppState()` has finished loading values from SQLite.
   * The debounced write-back subscription skips writes while this is false
   * to avoid persisting defaults before hydration completes.
   */
  hydrated: boolean;
  setHydrated: (v: boolean) => void;
  /**
   * Chart x-window (bar-index start + end). Persisted to app_state as JSON.
   * Undefined before the first bar fetch; hydration restores last session value.
   */
  viewport?: Viewport;
  setViewport: (v: Viewport) => void;

  // ---- P2.5 additions -----------------------------------------------------
  /** Which dock tool is active. P2.2 sets it; P2.5/P2.6 read it. */
  activeTool: ActiveTool;
  setActiveTool: (tool: ActiveTool) => void;
  /** Marks for the currently-active symbol; mirrors SQLite. */
  marks: Mark[];
  setMarks: (marks: Mark[]) => void;

  // ---- Step 4 additions — trend lines -------------------------------------
  /** Trend lines for the currently-active (sym, tf); mirrors SQLite. */
  trends: TrendRow[];
  setTrends: (trends: TrendRow[]) => void;
  /** Currently-selected trend id (null when nothing selected). Backspace deletes. */
  selectedTrendId: string | null;
  setSelectedTrendId: (id: string | null) => void;
  /** In-progress trend draft (mid-drag). Null when not drawing. */
  trendDraft: TrendDraft | null;
  setTrendDraft: (d: TrendDraft | null) => void;

  // ---- P2.6 additions -----------------------------------------------------
  /** P2.6 — Range Scope: selected bar-index range (inclusive start, exclusive end). Null when cleared. */
  rangeScope: { start: number; end: number } | null;
  /** P2.6 action — set or clear the range scope. */
  setRangeScope: (r: { start: number; end: number } | null) => void;

  // ---- P2.1 additions -----------------------------------------------------
  /** P2.1 — Index of bar under the crosshair. Null when crosshair is not active. */
  hoveredBarIdx: number | null;
  setHoveredBarIdx: (idx: number | null) => void;
  /** P2.1 — Command palette open state. P2.3 renders the palette. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  // ---- P2.4 additions -----------------------------------------------------
  /** P2.4 — Indicator toggle flags. MA20/MA50/Bollinger on/off. */
  indicatorFlags: { ma20: boolean; ma50: boolean; bollinger: boolean };
  setIndicatorFlag: (key: 'ma20' | 'ma50' | 'bollinger', value: boolean) => void;
  /** P2.4 — User-pasted custom series (parsed float values). */
  customSeries: number[];
  customSeriesEnabled: boolean;
  setCustomSeries: (series: number[]) => void;
  setCustomSeriesEnabled: (enabled: boolean) => void;

  // ---- P3.2 additions -----------------------------------------------------
  /** P3.2 — AddAssetModal open state. AssetPanel "Add asset" button toggles it. */
  addAssetModalOpen: boolean;
  setAddAssetModalOpen: (open: boolean) => void;

  // ---- P4.5 additions -----------------------------------------------------
  /**
   * P4.5 — Unix-ms timestamp of the last successful realtime tick or
   * `fetchHistory` resolution. `null` until the first event lands. The
   * Headline renders a "stale" badge when `Date.now() - lastTickAt > 60_000`.
   * Session-only — NOT persisted.
   */
  lastTickAt: number | null;
  setLastTickAt: (ts: number | null) => void;

  // ---- Asset-switch transition additions ----------------------------------
  /**
   * Asset-switch loading phase. Drives the coordinated exit → loading → reveal
   * → idle transition across Chart, Headline, AssetPanel, and EquityCredsBanner.
   * Session-only — NOT persisted.
   */
  loadingPhase: 'idle' | 'exit' | 'loading' | 'reveal';
  setLoadingPhase: (phase: 'idle' | 'exit' | 'loading' | 'reveal') => void;

  // ---- P6 W4-B additions — AI Research dataset overlay ---------------------
  /**
   * Currently-plotted AI dataset id (mutually exclusive across all chips/cards).
   * `null` = no AI overlay active. Setting this auto-replaces any prior id —
   * see `setAiOverlayDataset`. Session-only — NOT persisted.
   */
  aiOverlayDatasetId: string | null;
  /**
   * Mutually-exclusive setter: pass an id to plot, or `null` to clear the
   * active overlay. Toggling a new id auto-clears the prior. The `×` on a
   * chip/card calls this with `null` — it does NOT delete from library.
   */
  setAiOverlayDataset: (id: string | null) => void;

  // ---- P7 W5-C12 additions — AI Strategy active state ----------------------
  /**
   * Currently-applied AI strategy id (mutually exclusive across strategies,
   * but coexists with `aiOverlayDatasetId`). `null` = no strategy applied.
   * Setting this auto-replaces any prior id — see `setAiActiveStrategy`.
   * Session-only — NOT persisted.
   */
  aiActiveStrategyId: string | null;
  /** Cached trades for the currently-applied strategy (set by Composer once
   * the backtest runs after `strategy_returned`). `null` when no strategy is
   * applied or while the backtest hasn't completed. Session-only. */
  aiActiveStrategyTrades: Trade[] | null;
  /**
   * Mutually-exclusive setter for the active strategy. Pass `null` to clear.
   * Toggling a new id auto-clears the prior; trades are passed alongside so
   * the chart signals layer can render immediately without a round-trip.
   */
  setAiActiveStrategy: (id: string | null, trades?: Trade[] | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeSym: undefined,
  setActiveSym: (sym) => set({ activeSym: sym }),
  activeAsset: undefined,
  setActiveAsset: (asset) =>
    set(
      asset === undefined
        ? // Clearing the canonical tuple — leave `activeSym` untouched so
          // legacy callers retain their last symbol (preserves boot UX).
          { activeAsset: undefined }
        : { activeAsset: asset, activeSym: asset.sym },
    ),
  chartType: 'candles',
  setChartType: (ct) => set({ chartType: ct }),
  tf: '1h',
  setTf: (tf) => set({ tf }),

  hydrated: false,
  setHydrated: (v) => set({ hydrated: v }),
  viewport: undefined,
  setViewport: (v) => set({ viewport: v }),

  activeTool: 'none',
  setActiveTool: (tool) => set({ activeTool: tool }),
  marks: [],
  setMarks: (marks) => set({ marks }),

  // Step 4 — trend-line tool defaults.
  trends: [],
  setTrends: (trends) => set({ trends }),
  selectedTrendId: null,
  setSelectedTrendId: (id) => set({ selectedTrendId: id }),
  trendDraft: null,
  setTrendDraft: (d) => set({ trendDraft: d }),

  rangeScope: null,
  setRangeScope: (r) => set({ rangeScope: r }),

  hoveredBarIdx: null,
  setHoveredBarIdx: (idx) => set({ hoveredBarIdx: idx }),
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),

  indicatorFlags: { ma20: true, ma50: false, bollinger: false },
  setIndicatorFlag: (key, value) =>
    set((s) => ({ indicatorFlags: { ...s.indicatorFlags, [key]: value } })),
  customSeries: [],
  customSeriesEnabled: false,
  setCustomSeries: (series) => set({ customSeries: series }),
  setCustomSeriesEnabled: (enabled) => set({ customSeriesEnabled: enabled }),

  addAssetModalOpen: false,
  setAddAssetModalOpen: (open) => set({ addAssetModalOpen: open }),

  // P4.5 — Initial null so the "stale" badge stays hidden until the first
  // tick arrives. Updated by realtime orchestrator + history fetches.
  lastTickAt: null,
  setLastTickAt: (ts) => set({ lastTickAt: ts }),

  // Asset-switch transition — starts idle.
  loadingPhase: 'idle',
  setLoadingPhase: (phase) => set({ loadingPhase: phase }),

  // P6 W4-B — AI overlay dataset id; mutual exclusion enforced in setter.
  aiOverlayDatasetId: null,
  setAiOverlayDataset: (id) => set({ aiOverlayDatasetId: id }),

  // P7 W5-C12 — AI strategy active id + cached trades.
  aiActiveStrategyId: null,
  aiActiveStrategyTrades: null,
  setAiActiveStrategy: (id, trades = null) =>
    set({ aiActiveStrategyId: id, aiActiveStrategyTrades: id === null ? null : trades }),
}));

/**
 * Derived selector — returns a stable string id for the canonical active
 * asset (`${provider}:${sym}/${quote}`) suitable as a React effect key.
 * Returns `undefined` when no asset is active.
 *
 * ADR-0009: the canonical instrument identity is `(provider, sym, quote)`;
 * effect keys must include all three so a quote switch (BTC/USDT → BTC/USDC)
 * re-runs subscriptions and clears caches.
 */
export function selectActiveAssetId(
  s: Pick<AppState, 'activeAsset'>,
): string | undefined {
  const a = s.activeAsset;
  return a ? `${a.provider}:${a.sym}/${a.quote}` : undefined;
}
