/**
 * src/AppShell.tsx — Main application shell.
 *
 * P1.4: hosts ChartCanvas with full interaction wiring + Crosshair + AnimNum demo.
 *   - Uses MockMarketDataProvider (P1.1) for bar data.
 *   - chartType state drives renderer selection + smooth morph.
 *   - Indicators: ma20/ma50/bollinger flags in Zustand (defaulting off).
 *     Hardcoded ma20=true here so overlay rendering is visible during dev.
 *   - User-controlled view (start/end) — enables pan/zoom/range-select via
 *     ChartCanvas onViewChange wiring. The y-axis bounds are still derived
 *     from the visible window every render so y-zoom remains automatic.
 *   - Keyboard `R` resets view to last 200 bars.
 *   - VITE_DEMO_MORPH=1 env flag activates a 1.5s cycle through all 6 chart
 *     types — for visual-diff capture only; not on by default.
 *
 *   The Ctrl+Shift+S symbol cycler from P1.3 has been REMOVED — interaction
 *   tests run against a stable shell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hydrateAppState, mountAppStateSync, mountSettingsSync } from './lib/hydrate';
import ChartCanvas from './chart/ChartCanvas';
import type { ChartType } from './chart/ChartCanvas';
import OverlayInfoPanel from './chart/OverlayInfoPanel';
import { candlesRenderer } from './chart/renderers/candles';
import { heikinRenderer } from './chart/renderers/heikin';
import { barsRenderer } from './chart/renderers/bars';
import { lineRenderer } from './chart/renderers/line';
import { areaRenderer } from './chart/renderers/area';
import { mountainRenderer } from './chart/renderers/mountain';
import { buildOverlays } from './chart/overlays';
import { collectOverlayExtremes } from './chart/overlayExtremes';
import type { OverlayValueSource } from './chart/overlayExtremes';
import { useOverlayData } from './chart/useOverlayData';
import { signalsOverlay } from './chart/signals';
import type { Bar } from './data/MarketDataProvider';
import { getProvider, resolveEffectiveProvider } from './data/providerRegistry';
import { ohlcCache } from './data/ohlcCache';
import { useScrollBack } from './hooks/useScrollBack';
import { realtime, mergeTick } from './data/realtime';
import { ASSETS } from './data/assets';
import { lookupSymbolMeta, peekSymbolMeta, warmEquityCatalogIfConfigured } from './data/symbolCatalog';
import type { ViewWindow } from './chart/types';
import type { ChartRenderer } from './chart/types';
import type { RangeSelectEvent } from './chart/interaction';
import { useAppStore } from './stores/useAppStore';
import { useDockStore } from './stores/useDockStore';
import { defaultQuoteForProvider } from './stores/useWatchlistStore';
import type { Provider } from './data/MarketDataProvider';
import { useKeyboardDispatcher } from './stores/keyboard';
import { createRangeScopeRenderer } from './chart/rangeScope';
import { RangeStats } from './chrome/RangeStats';
import { dbMarksInsert, dbMarksList, dbMarksDelete } from './lib/db';
import type { Mark } from './lib/db';
import { MarkComposer } from './chrome/MarkComposer';
import { fmtPrice } from './engine/indicators';
import { Headline } from './chrome/Headline';
import { Actions } from './chrome/Actions';
import { ActivityBar } from './chrome/ActivityBar';
import { Dock } from './chrome/Dock';
import { Palette } from './chrome/Palette';
import { LegendHUD } from './chrome/LegendHUD';
import { useDatasetStore } from './stores/useDatasetStore';
import { seedDefaultDatasetsIfNeeded } from './ai/seedDatasets';
import { useStrategyStore } from './stores/useStrategyStore';
import { seedDefaultStrategiesIfNeeded } from './ai/seedStrategies';
import { IndicatorPanel } from './panels/IndicatorPanel';
import { AssetPanel } from './panels/AssetPanel';
import { AddAssetModal } from './panels/AddAssetModal';
import { TerminalPanel } from './panels/TerminalPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { FirstRun } from './panels/FirstRun';
import { useSettingsUiStore } from './stores/useSettingsUiStore';
import { MockBadge } from './components/MockBadge';
import { ToastHost } from './components/ToastHost';
import { EquityCredsBanner, EquityChartEmpty } from './components/EquityCredsBanner';
import { subscribeEquityCredStatus, getEquityCredStatus } from './data/equityCredStatus';
import { useToastStore } from './stores/useToastStore';
import { listen } from '@tauri-apps/api/event';
import { mountBridgeRoundtrip } from './ai/bridgeRoundtrip';
import { isTauriRuntime } from './lib/runtime';
import { useReducedMotion } from './lib/reducedMotion';
import { usePortfolioStore } from './stores/usePortfolioStore';
import { useChartMutationStore, overlayKey } from './stores/useChartMutationStore';
import type { OverlayFamily, TimelineLayer, StrategyOverlay } from './stores/useChartMutationStore';
import type { ResearchOverlay } from './ai/schemas';
import { useOverlayHitStore } from './stores/useOverlayHitStore';
import { timelineEventsOverlay } from './chart/layers/TimelineEventsLayer';
import { strategyOverlaysRenderer } from './chart/layers/StrategyOverlayLayer';
import { genericResearchOverlay, researchOverlayValueSources } from './chart/layers/GenericResearchLayer';
import { StrategyArtifactPanel } from './panels/StrategyArtifactPanel';
import { PortfolioPanel } from './panels/PortfolioPanel';
import { ResearchLibrary } from './panels/ResearchLibrary';
import { useResearchOverlayLibraryStore } from './stores/useResearchOverlayLibraryStore';
import { CHART_RESERVE_TOP, CHART_RESERVE_BOTTOM } from './lib/layout';

const HISTORY_BARS = 600;
const VISIBLE_BARS = 200;

// Plot-area padding — mirrors ChartCanvas.tsx constants (PAD_RIGHT/BOTTOM/TOP/LEFT).
// Kept in sync here so RangeStats positions correctly without a prop-drilling callback.
const PAD_LEFT = 12;
const PAD_RIGHT = 60;
const PAD_TOP = 16;
const PAD_BOTTOM = 22;

// Renderer lookup
const RENDERERS: Record<ChartType, ChartRenderer> = {
  candles:  candlesRenderer,
  heikin:   heikinRenderer,
  bars:     barsRenderer,
  line:     lineRenderer,
  area:     areaRenderer,
  mountain: mountainRenderer,
};

const CHART_TYPE_ORDER: ChartType[] = ['candles', 'heikin', 'bars', 'line', 'area', 'mountain'];

/**
 * Compute y-axis bounds from the visible slice of bars, then extend the range
 * to include any overlay value sources (Bollinger bands, custom series, AI
 * dataset overlays) so that wide overlays are never clipped at the top/bottom.
 *
 * @param bars     Full bar series.
 * @param start    Fractional visible start index (ViewWindow.start).
 * @param end      Fractional visible end index   (ViewWindow.end).
 * @param overlays Optional overlay value sources to union into the y-range.
 *                 Pass additional (number|null)[] arrays here — see
 *                 collectOverlayExtremes() in src/chart/overlayExtremes.ts for
 *                 alignment semantics.
 */
function computeYBounds(
  bars: Bar[],
  start: number,
  end: number,
  overlays?: OverlayValueSource[],
): { yMin: number; yMax: number } {
  const lo0 = Math.max(0, Math.floor(start));
  const hi0 = Math.min(bars.length, Math.ceil(end));
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = lo0; i < hi0; i++) {
    const b = bars[i];
    if (!b) continue;
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }

  // Union overlay extremes into the bar-based range so that indicators such as
  // Bollinger bands, custom series, and AI dataset overlays are never clipped.
  if (overlays && overlays.length > 0) {
    const ext = collectOverlayExtremes(overlays, start, end, bars.length);
    if (Number.isFinite(ext.lo) && ext.lo < lo) lo = ext.lo;
    if (Number.isFinite(ext.hi) && ext.hi > hi) hi = ext.hi;
  }

  const pad = (hi - lo) * 0.1 || hi * 0.02 || 1;
  return { yMin: lo - pad, yMax: hi + pad };
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export default function AppShell() {
  // P3.1 — hydration flag. True once SQLite state has been loaded.
  const hydrated = useAppStore((s) => s.hydrated);
  const storeActiveSym = useAppStore((s) => s.activeSym);
  // ADR-0009 / Step 7 — read the canonical (provider, sym, quote) tuple.
  // `activeSym` is mirrored from `activeAsset.sym` by the store setter, so
  // legacy readers still resolve correctly; new code derives provider+quote
  // from `activeAsset` so quote switches (BTC/USDT → BTC/USDC) re-fetch.
  const activeAsset = useAppStore((s) => s.activeAsset);
  // P3.2 — track the store's active symbol live so row clicks in AssetPanel
  // re-fetch bars and re-render the chart. Falls back to 'BTC' if unset.
  const activeSym = activeAsset?.sym ?? storeActiveSym ?? 'BTC';
  // Active provider + quote. The canonical `activeAsset` tuple carries
  // provider+quote (ADR-0009 §1, useAppStore.ts:65-69), so when it is present
  // we trust it UNCONDITIONALLY — an equity must never be re-derived through
  // the crypto-only ASSETS table and silently mis-routed to 'binance'.
  //
  // The ASSETS→'binance' fallback applies ONLY at true cold start, before
  // hydration has populated `activeAsset`. At that point `activeSym` is the
  // crypto default ('BTC'), so the fallback only ever resolves a crypto row.
  const activeProvider: Provider = activeAsset?.provider
    ? (activeAsset.provider as Provider)
    : ((ASSETS.find((a) => a.sym === activeSym)?.provider ?? 'binance') as Provider);
  const activeQuote: string =
    activeAsset?.quote ?? defaultQuoteForProvider(activeProvider);
  const loadingPhase = useAppStore((s) => s.loadingPhase);
  const [bars, setBars] = useState<Bar[]>([]);
  // aria-live announcement message — updated as loadingPhase changes.
  const [ariaLiveMsg, setAriaLiveMsg] = useState('');
  const [credRefetchNonce, setCredRefetchNonce] = useState(0);
  // Layer 3b — monotonic subscription-generation counter. Incremented each time
  // the subscribe effect fires (i.e. on every (sym, tf, provider, quote) change).
  // Ticks whose closure carries an old generation value are dropped, preventing
  // stray old-subscription ticks from populating an otherwise-empty bar array.
  const subscriptionVersion = useRef(0);
  // Step 2a — re-clamp the dock reserve vars on mount and window resize so the
  // chart-column min-width guard tracks the live window size. No drawer UI is
  // wired up yet; this is the only reader of useDockStore this step.
  useEffect(() => {
    const recompute = () => useDockStore.getState().recomputeReserve();
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, []);
  useEffect(() => {
    let prev = getEquityCredStatus();
    return subscribeEquityCredStatus((next) => {
      const wentGood =
        (prev.failed && !next.failed) ||
        (next.connectedAt ?? 0) > (prev.connectedAt ?? 0);
      prev = next;
      if (wentGood) setCredRefetchNonce((n) => n + 1);
    });
  }, []);
  // P2.2 — chartType is now owned by useAppStore so the Dock can set it.
  // The local setter is intentionally removed; AppShell reads from the store.
  const chartType = useAppStore((s) => s.chartType);
  const setChartType = useAppStore((s) => s.setChartType);
  const tf = useAppStore((s) => s.tf);
  const setLastTickAt = useAppStore((s) => s.setLastTickAt);
  const setLoadingPhase = useAppStore((s) => s.setLoadingPhase);
  // aria-live phase announcements. The display name resolves through the
  // shared catalog helper so equities (absent from the crypto-only ASSETS
  // table) get a real name; ASSETS remains the synchronous crypto fallback.
  const ariaAssetRef = useRef<{ sym: string; name: string }>({ sym: 'BTC', name: '' });
  useEffect(() => {
    let cancelled = false;
    const cryptoName = ASSETS.find((a) => a.sym === activeSym)?.name;
    const cached = peekSymbolMeta(activeSym, activeProvider)?.name;
    ariaAssetRef.current = { sym: activeSym, name: cached ?? cryptoName ?? activeSym };
    void lookupSymbolMeta(activeSym, activeProvider).then((meta) => {
      if (cancelled) return;
      ariaAssetRef.current = { sym: activeSym, name: meta.name ?? cryptoName ?? activeSym };
    });
    return () => { cancelled = true; };
  }, [activeSym, activeProvider]);

  useEffect(() => {
    const { sym, name } = ariaAssetRef.current;
    if (loadingPhase === 'loading') {
      setAriaLiveMsg(`Loading ${sym} ${name}`);
    } else if (loadingPhase === 'reveal') {
      // Use latest bar close for the "Loaded at $price" announcement.
      const lastBar = bars[bars.length - 1];
      const priceStr = lastBar ? fmtPrice(lastBar.c) : '';
      setAriaLiveMsg(`Loaded ${sym}${priceStr ? ` at ${priceStr}` : ''}`);
    } else if (loadingPhase === 'idle') {
      // ADR-0009: prefer the canonical active provider (covers catalog-added
      // symbols not in the static ASSETS table).
      const isEquity = activeProvider === 'alpaca';
      const credsFailed = getEquityCredStatus().failed;
      if (isEquity && credsFailed) {
        setAriaLiveMsg(`${sym} unavailable — Alpaca credentials required`);
      }
      // Otherwise leave previous message; it will be cleared on next sym change.
    }
  }, [loadingPhase, bars, activeProvider]);

  // P2.4 — Indicator flags and custom series from store (IndicatorPanel sets them).
  const indicatorFlags = useAppStore((s) => s.indicatorFlags);
  const customSeries = useAppStore((s) => s.customSeries);
  const customSeriesEnabled = useAppStore((s) => s.customSeriesEnabled);

  // Step 11b — chart mutation store refs for the live-overlay renderers.
  // We use refs (not subscriptions) so renderer objects are stable and don't
  // trigger chart morph re-creation on every store update.
  const timelineLayersRef = useRef<ReturnType<typeof useChartMutationStore.getState>['timelineLayers']>({});
  const strategyOverlaysRef = useRef<ReturnType<typeof useChartMutationStore.getState>['strategyOverlays']>({});
  const researchOverlaysRef = useRef<ReturnType<typeof useChartMutationStore.getState>['researchOverlays']>({});

  // Subscribe to chart mutation store updates and update the refs.
  useEffect(() => {
    const unsub = useChartMutationStore.subscribe((s) => {
      timelineLayersRef.current = s.timelineLayers;
      strategyOverlaysRef.current = s.strategyOverlays;
      researchOverlaysRef.current = s.researchOverlays;
      // Force a canvas repaint by triggering a dummy state update if needed.
      // The canvas re-renders when its dependencies change; since the refs are
      // read each frame by the overlay renderers, a re-render is only needed
      // when the MCP store changes. We trigger it by flushing through a noop
      // state update trick — actually the simplest approach is to just let the
      // renderers re-read refs each frame (they already do via the getLayers fn).
    });
    return unsub;
  }, []);

  // P6 W4-B — AI dataset overlay (active id + dataset values + token color).
  const aiOverlayDatasetId = useAppStore((s) => s.aiOverlayDatasetId);
  const datasets = useDatasetStore((s) => s.datasets);
  const hydrateDatasets = useDatasetStore((s) => s.hydrate);
  const datasetsHydrated = useDatasetStore((s) => s.hydrated);

  // P7 W5-C3 — AI strategy store.
  const hydrateStrategies = useStrategyStore((s) => s.hydrate);
  const strategiesHydrated = useStrategyStore((s) => s.hydrated);

  // Step 7 — Research Library store. Hydrated (list only) on boot so the
  // Research Library drawer can list saved overlays; it never auto-paints.
  const hydrateResearchLibrary = useResearchOverlayLibraryStore((s) => s.hydrate);
  const researchLibraryHydrated = useResearchOverlayLibraryStore((s) => s.hydrated);

  // Step 7 — subscribed research overlays (reactive). The RENDERER reads the
  // stable ref each frame; this subscription drives the y-range union recompute
  // and the clear-on-switch prune effect (both must react to store changes).
  const researchOverlays = useChartMutationStore((s) => s.researchOverlays);
  // Step 7 — monotonic counter bumped on every research-overlay mutation
  // (apply/remove/effective prune). Added as a dep to the `overlays` memo so a
  // fresh overlays-array reference is produced on every change, forcing a
  // ChartCanvas repaint while keeping the renderer refs themselves stable.
  const researchOverlayVersion = useChartMutationStore((s) => s.researchOverlayVersion);

  // Step 8 (D12) — client-side overlay visibility. The id-keyed hidden set
  // lives in LOCAL UI state (never in the bridge/mutation store slices, which
  // is the point of D12). The eye toggle in LegendHUD flips membership; the
  // renderer closures below + the aiOverlay memo + the y-range union all filter
  // these ids out so a hidden overlay neither paints nor widens the y-range.
  // A ref mirrors the live set so the once-created renderer closures (which are
  // never re-created, to avoid chart-morph re-trigger) read it each frame.
  const [hiddenOverlayIds, setHiddenOverlayIds] = useState<Set<string>>(() => new Set());
  const hiddenOverlayIdsRef = useRef(hiddenOverlayIds);
  hiddenOverlayIdsRef.current = hiddenOverlayIds;

  // User-controlled x-window. Y-bounds are recomputed from the visible slice.
  const [xWindow, setXWindow] = useState<{ start: number; end: number }>({
    start: 0,
    end: 1,
  });

  // P2.6 — range scope from Zustand store.
  const rangeScope = useAppStore((s) => s.rangeScope);
  const setRangeScope = useAppStore((s) => s.setRangeScope);

  // P2.5 — mark tools + persisted marks list (mirrors SQLite for current sym).
  const activeTool = useAppStore((s) => s.activeTool);
  const setActiveTool = useAppStore((s) => s.setActiveTool);
  const marks = useAppStore((s) => s.marks);
  const setMarks = useAppStore((s) => s.setMarks);

  // P2.1 — hovered bar for Headline OHLCV readout.
  const setHoveredBarIdx = useAppStore((s) => s.setHoveredBarIdx);

  // P2.5 — composer is anchored at the click position. Cleared on save/cancel/Esc.
  const [composer, setComposer] = useState<{
    mode: 'mark' | 'comment';
    at: { x: number; y: number };
    price: number;
    ts: number;
  } | null>(null);

  // P2.5 — load marks from SQLite for the active symbol. Tauri's `invoke` is
  // unavailable in plain `vite dev` (no Tauri runtime), so we swallow that
  // error and fall back to an empty list — keeps dev-server hot reload usable.
  const reloadMarks = useCallback(async (sym: string, provider: string, quote: string) => {
    // ADR-0008/0009 (Step 11): marks queries MUST include `provider` AND
    // `quote`. Resolve from the canonical `activeAsset` (passed in) so we
    // don't have to re-look up in ASSETS.
    try {
      const list = await dbMarksList(sym, provider, quote);
      setMarks(list);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[marks] dbMarksList failed (running outside Tauri?)', err);
      setMarks([]);
    }
  }, [setMarks]);

  useEffect(() => { reloadMarks(activeSym, activeProvider, activeQuote); }, [activeSym, activeProvider, activeQuote, reloadMarks]);

  // P2.6 — track chart container size so RangeStats can be positioned correctly.
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const [chartSize, setChartSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  // Step 6 — overlay info panel hover/pin signal now lives in useOverlayHitStore
  // (NOT React state), so hotspot enter/leave + chart click no longer re-render
  // the whole shell. OverlayInfoPanel is the sole subscriber.
  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setChartSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Derive plot-area layout for stats card positioning.
  const chartLayout = useMemo(() => ({
    x: PAD_LEFT,
    y: PAD_TOP,
    w: Math.max(1, chartSize.w - PAD_LEFT - PAD_RIGHT),
    h: Math.max(1, chartSize.h - PAD_TOP - PAD_BOTTOM),
  }), [chartSize]);

  // Load bars from the real provider (Rust REST via getProvider) and start
  // the realtime WS subscription for live deltas. Mocked transparently when
  // `localStorage.use-mock-provider === '1'` or running outside Tauri.
  //
  // Lifecycle:
  //   1. On (activeSym, tf) change → fire exit → loading → fetch → reveal → idle
  //      phase sequence (asset-switch transition spec).
  //   2. Subscribe via the singleton orchestrator — a single global WS at any
  //      time, switching cleanly between assets.
  //   3. Register a tick listener that merges incoming bars into local state.
  //   4. On cleanup: unregister listener (orchestrator owns the WS lifetime).
  useEffect(() => {
    let cancelled = false;
    // Track timers + completion state so a fast (microtask/cache-hit/mock)
    // fetch doesn't get clobbered by a still-pending exit timer.
    const timers: number[] = [];
    let fetchResolved = false;
    let exitElapsed = false;
    // Captured fetch result, used when the fetch resolves BEFORE the 180ms
    // exit phase completes (we defer applying it until exit finishes so the
    // exit fade still plays for a moment, but we never clobber the data).
    let pendingBars: Bar[] | null = null;
    let pendingError: unknown = null;
    // ADR-0009 — provider + quote come from `activeAsset`; legacy fallback
    // through ASSETS preserves boot UX when hydrate hasn't run yet.
    const provider = activeProvider;
    const quote = activeQuote;

    const schedule = (fn: () => void, ms: number): void => {
      const id = window.setTimeout(() => {
        if (cancelled) return;
        fn();
      }, ms);
      timers.push(id);
    };

    // Step 1: exit phase — surfaces begin fading.
    setLoadingPhase('exit');

    // Drive the reveal → idle tail of the timeline. Used by both the
    // success and failure paths; collapses the duplicated code while
    // making the "go to reveal then idle" intent explicit.
    const enterRevealThenIdle = (revealDelay: number): void => {
      schedule(() => {
        setLoadingPhase('reveal');
        schedule(() => setLoadingPhase('idle'), 320); // var(--t-med)
      }, revealDelay);
    };

    // Record fetch start for minimum-display-time math.
    const fetchStart = performance.now();

    // Step 2: after 180ms (var(--t-fast)) the exit fade is done. If the
    // fetch is still pending, enter `loading` and clear bars so the chart
    // shows the shimmer over an empty plot. If the fetch already resolved
    // (cache hit, mock provider, sub-180ms network), apply the cached
    // result here and head straight to reveal — DO NOT clear bars.
    schedule(() => {
      exitElapsed = true;
      if (fetchResolved) {
        // Fast path: apply the buffered fetch result (success or error)
        // now that the exit fade has finished, then run the reveal tail.
        if (pendingBars) {
          setBars(pendingBars);
          setLastTickAt(Date.now());
          setXWindow({
            start: Math.max(0, pendingBars.length - VISIBLE_BARS),
            end: pendingBars.length,
          });
        } else if (pendingError !== undefined && pendingError !== null) {
          // Already toasted in the .catch — just keep bars cleared so the
          // empty-state overlay (banner/EquityChartEmpty) can crossfade in.
          setBars([]);
        }
        // We spent ~180ms in `exit` already; no extra loading-min wait.
        enterRevealThenIdle(0);
        return;
      }
      // Slow path: fetch still in flight; enter loading state.
      setBars([]);
      setLoadingPhase('loading');
    }, 180);

    getProvider(provider, quote)
      .fetchHistory(activeSym, tf, HISTORY_BARS)
      .then((data) => {
        if (cancelled) return;
        fetchResolved = true;
        if (!exitElapsed) {
          // Buffer the result; the exit timer will apply it once it fires
          // (avoids racing the bars-cleared boundary).
          pendingBars = data;
          return;
        }
        setBars(data);
        // Initial freshness stamp — keeps the stale badge hidden until the
        // 60s threshold elapses without any subsequent ticks.
        setLastTickAt(Date.now());
        setXWindow({
          start: Math.max(0, data.length - VISIBLE_BARS),
          end: data.length,
        });
        // Enforce minimum loading display time (220ms feels intentional).
        const elapsed = performance.now() - fetchStart;
        const delay = Math.max(0, 220 - elapsed);
        enterRevealThenIdle(delay);
      })
      .catch((err) => {
        if (cancelled) return;
        fetchResolved = true;
        pendingError = err ?? new Error('unknown');
        // eslint-disable-next-line no-console
        console.warn(`[history] fetch failed for ${activeSym}@${tf}:`, err);
        // For equity hard-fails the EquityCredsBanner already surfaces the
        // user-facing notice; suppress the generic error toast so we don't
        // show two overlapping alerts.
        const isEquityFail =
          provider === 'alpaca' &&
          (err instanceof Error
            ? err.message.includes('adapter not registered')
            : String(err).includes('adapter not registered'));
        if (!isEquityFail) {
          useToastStore.getState().push({
            kind: 'error',
            title: 'Market data unavailable',
            detail: `${activeSym} ${tf} history failed to load`,
          });
        }
        if (!exitElapsed) {
          // Buffer; the exit timer will run the reveal tail.
          return;
        }
        // On failure: still transition through reveal → idle so error overlays
        // (EquityCredsBanner, ChartEmpty) can crossfade in gated on idle+failed.
        // Bars already cleared at the 180ms boundary; prev bars stay at 0.18
        // opacity underneath the error overlay per spec.
        const elapsed = performance.now() - fetchStart;
        const delay = Math.max(0, 220 - elapsed);
        enterRevealThenIdle(delay);
      });

    // Realtime subscription — singleton handles teardown of any prior stream.
    //
    // Root-cause-A fix (crypto reroute): the history fetch above may reroute a
    // (tf, quote) the pinned `provider` can't serve to a fallback (e.g.
    // coinbase/kraken @1w → binance) and cache + render under the EFFECTIVE
    // provider. The WS must target that SAME effective provider, or live ticks
    // never arrive and the price freezes. Resolve it the same pure way the
    // fetch path does so history (cache key) and realtime (WS target) agree.
    const effectiveProvider = resolveEffectiveProvider(provider, activeSym, tf, quote);

    // Re-seed on provider switch: when a reroute happened, the active `bars`
    // could still be pinned-provider-fetched (or empty pre-fetch). Candle
    // boundaries differ across providers (coinbase weekly = Thursday vs
    // binance/kraken = Monday), so letting fallback-provider WS ticks merge
    // into pinned-fetched bars would synthesise hybrid OHLC bars. If the
    // effective provider's history is already warm, seed straight from it so
    // any tick merges against a homogeneous, effective-provider bar series.
    if (effectiveProvider !== provider) {
      const seeded = ohlcCache.get(effectiveProvider, activeSym, quote, tf);
      if (seeded && seeded.length) {
        setBars(seeded);
        setXWindow({
          start: Math.max(0, seeded.length - VISIBLE_BARS),
          end: seeded.length,
        });
      }
    }

    // Layer 3b — capture the current generation for this subscription.
    // Any tick whose closure carries an older value is from a superseded
    // (sym, tf) subscription and must be dropped — this closes the
    // empty-bars race where a stray old tick would become the sole bar.
    const myVersion = ++subscriptionVersion.current;

    realtime.subscribe(effectiveProvider, activeSym, tf, quote);
    const unsubTick = realtime.onTick((tick) => {
      if (subscriptionVersion.current !== myVersion) return; // stale-generation tick
      setBars((prev) => mergeTick(prev, tick));
    });

    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
      unsubTick();
    };
  }, [activeSym, activeProvider, activeQuote, tf, setLastTickAt, setLoadingPhase, credRefetchNonce]);

  // Unmount-only WS teardown. The per-render effect above does NOT call
  // realtime.unsubscribe() in its cleanup because on a symbol/tf/provider
  // switch the new subscribe() call tears down the old stream internally —
  // unsubscribing in that cleanup would kill the stream a moment before the
  // new one starts. This dedicated empty-deps effect fires only on true
  // component unmount and ensures the WS socket is closed when AppShell leaves
  // the tree (e.g. during hot-reload or a future route change).
  useEffect(() => () => { realtime.unsubscribe(); }, []);

  // ChartCanvas hands us new x-window candidates from pan/zoom.
  // We re-derive y-bounds from the new visible slice (same approach as init).
  const handleViewChange = useCallback((next: ViewWindow) => {
    setXWindow({ start: next.start, end: next.end });
  }, []);

  // Step 4 (Part A) — lazy scroll-back pagination. When the user pans to the
  // left (past) edge, this hook fetches an OLDER page via
  // `getProvider(...).fetchHistoryBefore`, prepends it, and shifts the x-window
  // by the inserted count so the on-screen viewport stays fixed. It owns its
  // own dedup/merge/race-guard logic; the initial fetch above remains the
  // first page (history is no longer assumed to be fetched once and frozen).
  // `setXWindow` accepts the bare {start,end}; y-bounds are recomputed by the
  // `view` memo below from the grown bar slice.
  useScrollBack({
    bars,
    setBars,
    xWindow,
    setXWindow,
    sym: activeSym,
    tf,
    provider: activeProvider,
    quote: activeQuote,
  });

  // Step 5a — minimal Playwright test hook. Exposed only in DEV so production
  // bundles carry no dead weight. Playwright reads window.__scrollbackTest to
  // assert bar-count growth, earliest ts, and no-duplicate invariants without
  // needing DOM instrumentation on the canvas.
  //
  // The hook also exposes `triggerScrollLeft()` so Playwright can programmatically
  // set the x-window to start=0 (left edge), which is equivalent to the user
  // panning all the way to the left — this avoids flaky multi-pan UI simulation
  // since the canvas width and bar density vary by viewport.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = {
      barCount: bars.length,
      earliestTs: bars[0]?.ts ?? null,
      tsList: bars.map((b) => b.ts),
      /** Programmatically snap the x-window to bar index 0 so the scroll-back
       *  hook's left-edge guard fires on the next render. */
      triggerScrollLeft: () => {
        // Set start=0, keep the same span (end - start) so the chart doesn't
        // flash to a single bar — this mirrors what a full left-pan produces.
        setXWindow((prev) => ({ start: 0, end: prev.end - prev.start }));
      },
    };
    (window as unknown as Record<string, unknown>).__scrollbackTest = hook;
  }, [bars, setXWindow]);

  // Step 12 — DEV-only Playwright test hook for research overlay injection.
  // Exposes apply/remove/getState so e2e specs can drive the store without
  // needing Tauri IPC. Stripped in production bundles.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apply: (overlay: any) => useChartMutationStore.getState().applyResearchOverlay(overlay),
      remove: (id: string) => useChartMutationStore.getState().removeResearchOverlay(id),
      getState: () => useChartMutationStore.getState().researchOverlays,
    };
    (window as unknown as Record<string, unknown>).__researchOverlayTest = hook;
  }, []);

  // P2.6: forward range-select events into the Zustand store.
  const handleRangeSelect = useCallback((r: RangeSelectEvent | null) => {
    setRangeScope(r);
  }, [setRangeScope]);

  // P2.5 — click handler. Only opens the composer when a mark/comment tool is active.
  const handleChartClick = useCallback((info: {
    barIdx: number;
    price: number;
    ts: number;
    canvasX: number;
    canvasY: number;
  }) => {
    // Step 6 — every genuine click (below the pan threshold) bumps the store's
    // pin signal so OverlayInfoPanel pins the hovered hit (or unpins if none is
    // hovered). Goes through the store (not React state) so the shell does not
    // re-render on click.
    useOverlayHitStore.getState().pin();
    if (activeTool !== 'mark' && activeTool !== 'comment') return;
    setComposer({
      mode: activeTool,
      at: { x: info.canvasX, y: info.canvasY },
      price: info.price,
      ts: info.ts,
    });
  }, [activeTool]);

  // P2.5 — composer Save → persist + reload + close.
  const handleComposerSave = useCallback(async (payload: { color: string; note: string | null }) => {
    if (!composer) return;
    try {
      // ADR-0008/0009: provider AND quote are mandatory on every write.
      // Step 11 — sourced from the canonical `activeAsset` triple.
      await dbMarksInsert({
        sym: activeSym,
        provider: activeProvider,
        quote: activeQuote,
        price: composer.price,
        ts: composer.ts,
        color: payload.color,
        note: payload.note,
      });
      await reloadMarks(activeSym, activeProvider, activeQuote);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[marks] dbMarksInsert failed', err);
    }
    setComposer(null);
    setActiveTool('none');
  }, [composer, activeSym, activeProvider, activeQuote, reloadMarks, setActiveTool]);

  // Step 9 — delete a mark/comment: DB delete → refresh → undo toast.
  const handleDeleteMark = useCallback(async (mark: Mark, isComment: boolean) => {
    // Optimistically remove from local state.
    setMarks(marks.filter((m) => m.id !== mark.id));
    try {
      await dbMarksDelete(mark.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[marks] dbMarksDelete failed', err);
      // Roll back: reload from DB.
      void reloadMarks(activeSym, activeProvider, activeQuote);
      useToastStore.getState().push({ kind: 'warn', title: 'Delete failed', detail: 'Mark could not be removed' });
      return;
    }
    // Push undo toast — re-inserts the full row on click.
    useToastStore.getState().push({
      kind: 'info',
      title: isComment ? 'Comment deleted' : 'Mark deleted',
      action: {
        label: 'Undo',
        onClick: () => {
          dbMarksInsert({
            sym: mark.sym,
            provider: mark.provider,
            quote: mark.quote,
            price: mark.price,
            ts: mark.ts,
            color: mark.color,
            note: mark.note,
          })
            .then(() => reloadMarks(activeSym, activeProvider, activeQuote))
            .catch((e) => console.warn('[marks] undo re-insert failed', e));
        },
      },
    });
  }, [activeSym, activeProvider, activeQuote, reloadMarks, setMarks]);

  // Step 9 — edit a comment: open composer prefilled at the existing mark's position.
  // We reuse the composer state; the save path will delete-then-reinsert.
  const [editingMark, setEditingMark] = useState<Mark | null>(null);

  const handleEditMark = useCallback((mark: Mark) => {
    // Open the composer in comment mode, prefilled with the mark's existing color/note.
    setComposer({
      mode: 'comment',
      at: { x: chartSize.w / 2, y: chartSize.h / 2 },
      price: mark.price,
      ts: mark.ts,
    });
    setEditingMark(mark);
  }, [chartSize]);

  // Step 9 — composer save when editing: delete original + reinsert updated row.
  const handleComposerSaveWithEdit = useCallback(async (payload: { color: string; note: string | null }) => {
    if (editingMark) {
      // Delete the original mark first.
      try {
        await dbMarksDelete(editingMark.id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[marks] edit delete failed', err);
      }
      // Reinsert with updated fields.
      try {
        await dbMarksInsert({
          sym: editingMark.sym,
          provider: editingMark.provider,
          quote: editingMark.quote,
          price: editingMark.price,
          ts: editingMark.ts,
          color: payload.color,
          note: payload.note,
        });
        await reloadMarks(activeSym, activeProvider, activeQuote);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[marks] edit reinsert failed', err);
      }
      setEditingMark(null);
      setComposer(null);
      setActiveTool('none');
      return;
    }
    // Normal (non-edit) save path.
    await handleComposerSave(payload);
  }, [editingMark, activeSym, activeProvider, activeQuote, reloadMarks, handleComposerSave, setActiveTool]);

  // Active renderer from chartType.
  const renderer = RENDERERS[chartType];

  // P6 W4-B — resolve the active AI dataset (silently mapped to a palette
  // color by index in the persisted list). Length-mismatches with the
  // visible bars window clamp silently inside `aiOverlayGlow`.
  const aiOverlay = useMemo(() => {
    if (aiOverlayDatasetId === null) return undefined;
    // Step 8 (D12) — respect the client-side hidden set. A hidden dataset
    // overlay draws nothing AND drops out of the y-range union below.
    if (hiddenOverlayIds.has(overlayKey('dataset', aiOverlayDatasetId))) return undefined;
    const idx = datasets.findIndex((d) => d.id === aiOverlayDatasetId);
    if (idx < 0) return undefined;
    const ds = datasets[idx];
    // Inline palette ref (also exported from useDatasetStore.colorForIndex).
    const palette = [
      'oklch(0.82 0.14 215)',
      'oklch(0.78 0.18 320)',
      'oklch(0.85 0.16 80)',
      'oklch(0.78 0.16 150)',
      'oklch(0.78 0.20 25)',
    ];
    // Filter null gaps (cold-start bars); buildOverlays expects number[].
    const values = ds.values.filter((v): v is number => v !== null);
    return {
      values,
      color: palette[((idx % palette.length) + palette.length) % palette.length],
    };
  }, [aiOverlayDatasetId, datasets, hiddenOverlayIds]);

  // Overlay renderers — memoized when flags, custom series, or enabled state change.
  // P2.4: pass customSeries to buildOverlays when customSeriesEnabled is true.
  // P6 W4-B: AI overlay glow pass appended last so it renders on top.
  const baseOverlays = useMemo(
    () => buildOverlays(
      indicatorFlags,
      customSeriesEnabled ? customSeries : undefined,
      aiOverlay,
    ),
    [indicatorFlags, customSeries, customSeriesEnabled, aiOverlay],
  );

  // Pre-compute indicator arrays (BB upper/lower) for the y-bounds extension
  // below.  Computed once here so the view memo and the overlay renderers share
  // the same cached result.
  const overlayData = useOverlayData(bars, activeSym, tf);

  // Overlay value sources that widen the y-range beyond bar OHLC. Depends only
  // on the overlay slices / flags / data — NOT on the x-window — so it is hoisted
  // into its own memo and rebuilt only when an overlay changes (not on every
  // pan/zoom pointer event). The `view` memo below consumes it.
  const overlaySources = useMemo<OverlayValueSource[]>(() => {
    const sources: OverlayValueSource[] = [];

    // Bollinger bands (bar-aligned — same length as bars, sparse nulls at head).
    if (indicatorFlags.bollinger) {
      sources.push({ values: overlayData.bbResult.upper, align: 'bar-aligned' });
      sources.push({ values: overlayData.bbResult.lower, align: 'bar-aligned' });
    }

    // Custom series (right-aligned — last value maps to last visible bar).
    if (customSeriesEnabled && customSeries.length > 0) {
      sources.push({ values: customSeries, align: 'right-aligned' });
    }

    // AI dataset overlay (right-aligned, mirrors aiOverlayGlow renderer alignment).
    if (aiOverlay && aiOverlay.values.length > 0) {
      sources.push({ values: aiOverlay.values, align: 'right-aligned' });
    }

    // Research overlays join the union so line/band/hline are never clipped.
    // Element→value-source extraction (incl. the align→mode mapping + the hline
    // constant) lives beside the renderer in GenericResearchLayer. Step 8 (D12):
    // a hidden research overlay drops out of the union too, so toggling it re-fits.
    for (const ro of Object.values(researchOverlays)) {
      if (hiddenOverlayIds.has(overlayKey('research', ro.id))) continue;
      sources.push(...researchOverlayValueSources(ro));
    }

    return sources;
  }, [indicatorFlags, overlayData, customSeries, customSeriesEnabled, aiOverlay, researchOverlays, hiddenOverlayIds]);

  // Compose the full ViewWindow from xWindow + computed y-bounds. The y-bounds
  // are extended (via the hoisted overlaySources) to include all visible overlay
  // extremes so Bollinger bands, custom series, and research overlays are never
  // clipped. This memo re-runs per pan/zoom, but only re-runs the extremes union
  // — it no longer rebuilds the sources array.
  const view: ViewWindow = useMemo(() => {
    if (!bars.length) return { start: 0, end: 1, yMin: 0, yMax: 1 };
    const y = computeYBounds(bars, xWindow.start, xWindow.end, overlaySources);
    return { start: xWindow.start, end: xWindow.end, ...y };
  }, [bars, xWindow, overlaySources]);

  // Step 7 (D8) — clear-on-switch prune. When the active symbol or timeframe
  // changes, drop any research overlay whose (sym, tf) no longer matches the
  // active context so stale agent overlays never paint on the wrong instrument.
  // The sym/tf match predicate lives in the store action.
  useEffect(() => {
    useChartMutationStore.getState().pruneResearchOverlays(activeSym, tf);
  }, [activeSym, tf]);

  // P2.6 — Range scope renderer: use a ref for the live value so the
  // renderer object is stable and doesn't trigger morph re-creation.
  const rangeScopeRef = useRef<{ start: number; end: number } | null>(rangeScope);
  rangeScopeRef.current = rangeScope;
  // Renderer created once; reads rangeScope live via the ref every frame.
  const rangeScopeRenderer = useRef(createRangeScopeRenderer(() => rangeScopeRef.current));

  // Step 8 (D12) — per-family memoized hidden-filter. The renderer closures run
  // EVERY canvas frame, so re-filtering a slice per frame (fresh Record + key
  // walk + string concat) would allocate continuously whenever ≥1 overlay is
  // hidden. Instead each family keeps a 1-entry cache keyed on the slice-object
  // identity + the hidden-set identity: a frame that sees the same pair returns
  // the cached Record (a bare ref read). Same-reference fast path when nothing
  // is hidden allocates nothing at all.
  const makeHiddenFilter = useRef(<T,>(family: OverlayFamily) => {
    let cacheSlice: Record<string, T> | null = null;
    let cacheHidden: Set<string> | null = null;
    let cacheOut: Record<string, T> = {};
    return (slice: Record<string, T>): Record<string, T> => {
      const hidden = hiddenOverlayIdsRef.current;
      if (slice === cacheSlice && hidden === cacheHidden) return cacheOut;
      cacheSlice = slice;
      cacheHidden = hidden;
      if (hidden.size === 0) {
        cacheOut = slice;
        return slice;
      }
      let any = false;
      const out: Record<string, T> = {};
      for (const k of Object.keys(slice)) {
        if (hidden.has(overlayKey(family, k))) { any = true; continue; }
        out[k] = slice[k];
      }
      cacheOut = any ? out : slice;
      return cacheOut;
    };
  }).current;

  // Step 11b — Timeline-events and strategy-overlays renderers.
  // Both are created once and read from stable refs each frame (same pattern
  // as rangeScopeRenderer). Order: timeline below strategy markers.
  // Step 8 (D12): the getData closures filter out hidden ids (memoized per family).
  const timelineFilter = useRef(makeHiddenFilter<TimelineLayer>('timeline')).current;
  const strategyFilter = useRef(makeHiddenFilter<StrategyOverlay>('strategy')).current;
  const researchFilter = useRef(makeHiddenFilter<ResearchOverlay>('research')).current;
  const timelineEventsRenderer = useRef(
    timelineEventsOverlay(() => timelineFilter(timelineLayersRef.current)),
  );
  const strategyOverlayRenderer = useRef(
    strategyOverlaysRenderer(() => strategyFilter(strategyOverlaysRef.current)),
  );
  // Step 7 — generic research overlay renderer (created once; reads the stable
  // researchOverlaysRef each frame). Composed above strategy/timeline.
  // Step 8 (D12): hidden research overlays are filtered out of the closure.
  const researchOverlayRenderer = useRef(
    genericResearchOverlay(() => researchFilter(researchOverlaysRef.current)),
  );

  // P7 W5-C12 — strategy signals overlay. Cached trades come from
  // `useAppStore.aiActiveStrategyTrades` (set by Composer when a strategy
  // is applied). When null/empty, the renderer is omitted entirely. This
  // pass survives chart-type morph because it lives in the overlays array,
  // independent of the base renderer swap.
  const aiActiveStrategyId = useAppStore((s) => s.aiActiveStrategyId);
  const aiActiveStrategyTrades = useAppStore((s) => s.aiActiveStrategyTrades);
  const signalsRenderer = useMemo(() => {
    if (aiActiveStrategyId === null) return null;
    if (!aiActiveStrategyTrades || aiActiveStrategyTrades.length === 0) return null;
    return signalsOverlay(aiActiveStrategyTrades);
  }, [aiActiveStrategyId, aiActiveStrategyTrades]);

  // Compose overlays: data overlays first, range scope band, timeline events
  // (above base but below signals), strategy overlay, signals last so
  // backtest triangles render above every other layer.
  const overlays = useMemo(
    () =>
      signalsRenderer
        ? [
            ...baseOverlays,
            rangeScopeRenderer.current,
            timelineEventsRenderer.current,
            strategyOverlayRenderer.current,
            researchOverlayRenderer.current,
            signalsRenderer,
          ]
        : [
            ...baseOverlays,
            rangeScopeRenderer.current,
            timelineEventsRenderer.current,
            strategyOverlayRenderer.current,
            researchOverlayRenderer.current,
          ],
    // Step 8 (D12): `hiddenOverlayIds` is a dep so a fresh overlays-array
    // reference is produced on every visibility toggle — this forces a
    // ChartCanvas repaint even for families (timeline/strategy) whose toggle
    // doesn't change the y-range (and thus wouldn't change `view`). The
    // renderer objects themselves are stable refs; only the array wrapper is new.
    // Step 7: researchOverlayVersion bumps on apply/remove/prune so a re-applied
    // overlay from the Research Library repaints even though the renderer reads
    // the stable researchOverlaysRef (not this memo). It is a dep-only signal —
    // the value itself isn't read in the memo body.
    [baseOverlays, signalsRenderer, hiddenOverlayIds, researchOverlayVersion],
  );

  // -------------------------------------------------------------------------
  // Optional demo-morph sequencer — only active when VITE_DEMO_MORPH=1.
  // Cycles through all 6 chart types every 1.5s for visual-diff capture.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (import.meta.env.VITE_DEMO_MORPH !== '1') return;
    let idx = 0;
    const id = setInterval(() => {
      idx = (idx + 1) % CHART_TYPE_ORDER.length;
      setChartType(CHART_TYPE_ORDER[idx]);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // -------------------------------------------------------------------------
  // P2.1 — resetView extracted as a named callback so Actions.tsx can call it.
  // Keyboard `R` and the Actions reset button both invoke this.
  // -------------------------------------------------------------------------
  const resetView = useCallback(() => {
    setXWindow({
      start: Math.max(0, bars.length - VISIBLE_BARS),
      end: bars.length || 1,
    });
  }, [bars.length]);

  // -------------------------------------------------------------------------
  // P2.7 dispatcher — single global keydown handler.
  // Handles: ⌘K/Ctrl+K, /, D, M, C, R, Esc (precedence chain).
  // See src/stores/keyboard.ts for full documentation.
  // -------------------------------------------------------------------------
  const handleComposerReset = useCallback(() => {
    setComposer(null);
    setActiveTool('none');
  }, [setActiveTool]);

  // W2-A — toggle the Settings panel via ⌘, / Ctrl+,.
  const handleToggleSettings = useCallback(() => {
    useDockStore.getState().toggle('settings');
  }, []);

  // Portfolio panel toggle via ⌘P / Ctrl+P.
  const handleTogglePortfolio = useCallback(() => {
    useDockStore.getState().toggle('portfolio');
  }, []);

  // Terminal drawer toggle via ⌘` / Ctrl+`.
  const handleToggleTerminal = useCallback(() => {
    useDockStore.getState().toggle('terminal');
  }, []);

  // W2-G — Esc closes the Inspect-payload modal ahead of the composer rung.
  // Returns `true` if the modal was open (Esc consumed); `false` falls through
  // to the next rung in the precedence chain.
  const handleCloseInspectModal = useCallback((): boolean => {
    const s = useSettingsUiStore.getState();
    if (s.inspectOpen) {
      s.setInspectOpen(false);
      return true;
    }
    return false;
  }, []);

  useKeyboardDispatcher({
    composerOpen: composer !== null,
    resetComposer: handleComposerReset,
    resetView,
    onToggleSettings: handleToggleSettings,
    onCloseInspectModal: handleCloseInspectModal,
    onTogglePortfolio: handleTogglePortfolio,
    onToggleTerminal: handleToggleTerminal,
    // Step 9 — Backspace deletes the pinned mark/comment when the info panel
    // has one pinned (only fires when no trend is selected — trend-delete takes
    // priority in the dispatcher). Reads the pinned mark synchronously from the
    // overlay-hit store (published by OverlayInfoPanel).
    onDeletePinnedMark: () => {
      const hitStore = useOverlayHitStore.getState();
      const pm = hitStore.pinnedMark;
      if (!pm) return false;
      void handleDeleteMark(pm.mark, pm.isComment);
      hitStore.setPinnedMark(null);
      return true;
    },
  });

  // P3.1 — Hydrate from SQLite on mount, then mount the debounced write-back.
  // We render with default values immediately and let hydration overwrite them
  // once it resolves — avoids a blocking "Loading…" splash.
  useEffect(() => {
    let unmountAppSync: (() => void) | null = null;
    let unmountSettingsSync: (() => void) | null = null;
    hydrateAppState().then(() => {
      unmountAppSync = mountAppStateSync();
      unmountSettingsSync = mountSettingsSync();
      // Warm the Alpaca equity catalog on startup when creds are configured, so
      // stock search (e.g. "IONQ") works everywhere without first browsing the
      // NASDAQ/NYSE chip. No-op without creds / outside Tauri; TTL-gated.
      void warmEquityCatalogIfConfigured();
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[hydrate] hydrateAppState failed', err);
      // Still mount sync even if hydration partially failed so writes work going forward.
      unmountAppSync = mountAppStateSync();
      unmountSettingsSync = mountSettingsSync();
    });
    return () => {
      unmountAppSync?.();
      unmountSettingsSync?.();
    };
  }, []);

  // Suppress the unused-variable lint warning — `hydrated` is exposed for
  // P3.2's UI to gate loading states if desired.
  void hydrated;

  // P6 W4-B — hydrate the AI Datasets store + run the idempotent first-run
  // seed. Both gates are internal to `useDatasetStore.hydrate` and the seed
  // helper, so re-mounts (StrictMode double-effect) are no-ops.
  useEffect(() => {
    if (!datasetsHydrated) {
      void hydrateDatasets().then(() => seedDefaultDatasetsIfNeeded());
    } else {
      void seedDefaultDatasetsIfNeeded();
    }
    // datasetsHydrated/hydrateDatasets are stable selectors; safe deps.
  }, [datasetsHydrated, hydrateDatasets]);

  // P7 W5-C3 — hydrate the AI Strategies store + run the idempotent first-run
  // seed. Mirrors the datasets hydrate pattern above exactly.
  useEffect(() => {
    if (!strategiesHydrated) {
      void hydrateStrategies().then(() => seedDefaultStrategiesIfNeeded());
    } else {
      void seedDefaultStrategiesIfNeeded();
    }
    // strategiesHydrated/hydrateStrategies are stable selectors; safe deps.
  }, [strategiesHydrated, hydrateStrategies]);

  // Step 7 — hydrate the Research Library store (list only) once on boot so the
  // Research Library drawer can render saved overlays. Hydrate NEVER paints
  // anything onto the chart; applying an overlay is an explicit user action in
  // the drawer. The `hydrated` gate is internal to the store, so StrictMode
  // double-effect is a no-op.
  useEffect(() => {
    if (!researchLibraryHydrated) void hydrateResearchLibrary();
    // researchLibraryHydrated/hydrateResearchLibrary are stable selectors; safe deps.
  }, [researchLibraryHydrated, hydrateResearchLibrary]);

  // Step 6 — Mount the IPC bridge round-trip listener exactly once.
  // Subscribes to `bridge:request` events emitted by ipc_bridge.rs and
  // dispatches to TS handlers (compute_indicator, apply_dataset, etc.).
  // The Tauri `listen` API is not available in browser-only mode — guard it.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    mountBridgeRoundtrip().then((fn) => { unlisten = fn; }).catch((err) => {
      console.warn('[AppShell] mountBridgeRoundtrip failed:', err);
    });
    return () => { unlisten?.(); };
  }, []);

  // Step 4 — Listen for `portfolio:changed` events emitted by Rust after each
  // successful CLI/MCP-originated portfolio mutation (add_lot, reduce, remove,
  // upsert). Triggers a store refresh so PortfolioPanel stays live without a
  // full reload. The in-app AddHoldingModal path already self-refreshes through
  // the store's own write actions and does NOT need this listener.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    listen('portfolio:changed', () => {
      void usePortfolioStore.getState().refresh();
    }).then((fn) => { unlisten = fn; }).catch((err) => {
      console.warn('[AppShell] portfolio:changed listener failed:', err);
    });
    return () => { unlisten?.(); };
  }, []);

  // Step 2a — spring the chart inset as drawers open/close, but neutralize the
  // motion under prefers-reduced-motion (this is an inline style the global
  // reduced-motion CSS block can't reach). The reactive hook subscribes to the
  // media query's `change` event so the flag tracks live OS toggles, not just
  // the value at first render. SSR/jsdom-safe (guards window/matchMedia).
  const reducedMotion = useReducedMotion();
  const chartInsetTransition = reducedMotion
    ? undefined
    : 'left var(--t-med) var(--ease-spring), right var(--t-med) var(--ease-spring)';

  return (
    <main
      style={{
        minHeight: '100vh',
        height: '100vh',
        background: 'var(--bg-0)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <MockBadge />
      <EquityCredsBanner />
      <ToastHost />

      {/* Step 4 — Activity-bar rail. Right side only; the left edge is now the
          static vertical toolbar (Step 3/4). */}
      <ActivityBar side="right" />

      {/* Asset-switch aria-live region — announces loading/loaded/unavailable
          to screen readers. Visually hidden; the shimmer and overlays are
          aria-hidden so this is the sole audio channel for transitions. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {ariaLiveMsg}
      </div>

      {/* P2.3 — Command Palette: centered glass modal for fuzzy asset search.
           Controls its own visibility via useAppStore.paletteOpen; rendered
           once here so it is always mounted when the store flag flips. */}
      <Palette />

      {/* P2.4 — Indicator Panel: right-edge slide-in for MA/BB toggles + custom series.
           Renders at the drawer/chrome tier below modals, per the --z-* token scale
           defined in tokens.css (see ADR-0012). No z-index is set inline here. */}
      <IndicatorPanel />

      {/* P3.2 — Asset Panel + Add modal. AssetPanel writes --reserve-left so
           Headline shifts. AddAssetModal is mounted unconditionally and gates
           on useAppStore.addAssetModalOpen. */}
      <AssetPanel />
      <AddAssetModal />

      {/* P2.1 — Headline: SYM/QUOTE · PROVIDER (ADR-0009 Step 7). */}
      <Headline
        bars={bars}
        activeSym={activeSym}
        provider={activeProvider}
        quote={activeQuote}
      />

      {/* Step 8 — Legend HUD: TradingView-style transparent legend top-left under
           the Headline. Lists one row per active overlay across every family
           (indicators / dataset / strategy / timeline / research) with dash +
           label + eye (hover/focus-within only) + ×. Collapses to a minimal
           chip that opens the IndicatorPanel. Visibility is client-side only
           (hiddenOverlayIds); × calls the real store remove paths. */}
      <LegendHUD
        hiddenOverlayIds={hiddenOverlayIds}
        setHiddenOverlayIds={setHiddenOverlayIds}
      />

      {/* P2.1 — Actions: top-right glass button cluster */}
      <Actions onResetView={resetView} />

      {/* Chart canvas */}
      <div
        ref={chartWrapRef}
        style={{
          position: 'absolute',
          top: CHART_RESERVE_TOP,
          bottom: CHART_RESERVE_BOTTOM,
          // Step 2a — left inset: chart's left edge (static toolbar gutter today, no
          // left drawer reserve). Shared with the floating headline via --chart-left-edge.
          // right inset: right rail + right drawer reserve (written by useDockStore).
          // top/bottom unchanged.
          left: 'var(--chart-left-edge)',
          right: 'calc(var(--rail-w) + var(--reserve-right))',
          // Spring the inset on open/close. Gated on prefers-reduced-motion
          // since this is an inline style the global CSS block can't reach.
          transition: chartInsetTransition,
          // Stacking-context isolation: chart children (Crosshair, RangeStats,
          // OverlayInfoPanel) use --z-chart-* tokens and are ordered locally;
          // they never compete with the global Dock or modal tiers.
          isolation: 'isolate',
        }}
      >
        <ChartCanvas
          bars={bars}
          view={view}
          renderer={renderer}
          overlays={overlays}
          profile={import.meta.env.DEV}
          onViewChange={handleViewChange}
          onRangeSelect={handleRangeSelect}
          marks={marks}
          onChartClick={handleChartClick}
          onHoverBar={setHoveredBarIdx}
          onHotspotChange={(hit) => useOverlayHitStore.getState().setHit(hit)}
          activeTool={activeTool}
        />
        {/* Step 6 — shared overlay info card. Subscribes to useOverlayHitStore
            for the hover hit + click signal (so the shell never re-renders on
            hover/click); hover shows it, click pins it, ‹N/M› cycles coincident
            hits. Step 9 — onDeleteMark / onEditMark wired. */}
        <OverlayInfoPanel
          bars={bars}
          layout={chartLayout}
          wrapW={chartSize.w}
          onDeleteMark={handleDeleteMark}
          onEditMark={handleEditMark}
        />
        {/* P2.6 — Range stats card, floats above the selection band. */}
        {rangeScope !== null && bars.length > 0 && (
          <RangeStats
            range={rangeScope}
            bars={bars}
            layout={chartLayout}
            view={view}
            onClear={() => setRangeScope(null)}
          />
        )}
        {/* P2.5 — Mark/Comment composer, anchored at click position.
            Step 9 — prefilled with editingMark data when editing an existing comment. */}
        {composer && (
          <MarkComposer
            at={composer.at}
            price={composer.price}
            mode={composer.mode}
            onSave={handleComposerSaveWithEdit}
            onCancel={() => { setEditingMark(null); handleComposerReset(); }}
            formatPrice={(n: number) => fmtPrice(n)}
            initialColor={editingMark?.color}
            initialNote={editingMark?.note ?? undefined}
          />
        )}
        {/* P-UX wave — equity empty-state overlay. Mounts above the chart
            canvas when the active symbol's provider is Alpaca, credentials
            are missing, and no bars have been loaded. Self-gates on Tauri
            runtime + cred status; renders nothing otherwise. */}
        <EquityChartEmpty
          provider={activeProvider}
          noBars={bars.length === 0}
        />
      </div>

      {/* P2.2 — Dock: bottom-center glass capsule with chart-type toggle,
           4-tier tf scrubber (1h/4h/1d/1w), and tools cluster.
           Rendered via `position:fixed` inside the Dock component so it sits
           above the chart and below modals without the bottom reserve div. */}
      <Dock />

      {/* Step 12 — Terminal docked panel. DockDrawer(mountOnOpen) owns PTY
          teardown: XtermPanel unmounts after the close animation, its cleanup
          effect disposes the PTY. TerminalPanel is always mounted so
          DockDrawer can manage its own open/close lifecycle. */}
      <TerminalPanel />

      {/* P5 W2-A — Settings panel + first-run gate. The gate runs a one-shot
          `claudeTestConnection` on mount; the right rail's gear icon toggles the
          panel (⌘, / Ctrl+,) and the seven inline tabs (3 wired, 4 stubbed) bind
          to `useSettingsStore`. */}
      <SettingsPanel />
      <FirstRun />

      {/* Strategy Artifact Panel: CodeMirror strategy editor in right dock drawer.
          DockDrawer's mountOnOpen + the open gate (open==='strategy' && !!selectedId)
          handle mount/unmount; the panel itself is always in the tree. */}
      <StrategyArtifactPanel />

      {/* Portfolio panel. The right rail's briefcase icon toggles the
          'portfolio' drawer. Shortcut: ⌘P / Ctrl+P. */}
      <PortfolioPanel />

      {/* Step 7 — Research Library drawer. The right rail's stacked-layers icon
          toggles the 'research' drawer. Lists saved overlays + datasets; apply
          actions re-paint via useChartMutationStore / useAppStore overlay id. */}
      <ResearchLibrary />

    </main>
  );
}
