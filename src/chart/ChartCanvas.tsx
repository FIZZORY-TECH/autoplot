/**
 * src/chart/ChartCanvas.tsx — Canvas substrate.
 *
 * Owns:
 *   - The <canvas> element with DPR scaling.
 *   - ResizeObserver for layout changes (debounced one frame).
 *   - Theme tokens read from CSS custom properties on :root.
 *   - The render loop (reactive — RAF only when something changed).
 *   - Grid + last-price guideline + axes.
 *   - Smooth chart-type morph via alpha cross-fade over --t-med (320ms), cubic-out.
 *
 * P1.4 added:
 *   - Mouse + touch interaction wiring via `createChartInteraction()`.
 *   - Crosshair overlay (DOM, glass readout) lifted into ChartCanvas state.
 *   - Range-select event surface (P2.6 will render the band).
 *
 * Does NOT own:
 *   - Keyboard handling — `R` reset lives in AppShell standalone (P2.7 will
 *     replace with the unified dispatcher).
 *
 * Perf budget per A7: 60fps with 600 bars + 2 overlays + crosshair on M1 dev.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bar } from '../data/MarketDataProvider';
import { useAnimatedRange } from '../hooks/useAnimatedRange';
import { drawGrid, drawXAxis, drawYAxis } from './axes';
import {
  createChartInteraction,
  type CrosshairState,
  type RangeSelectEvent,
} from './interaction';
import { Crosshair } from '../components/Crosshair';
import type { Mark, TrendRow } from '../lib/db';
import { dbTrendsInsert, dbTrendsList } from '../lib/db';
import { createMarksRenderer, projectMarks, type ProjectedMark } from './marks';
import { createTrendsRenderer, findTrendAt } from './trends';
import { hitTest, hitResultKey, type HitRegion, type HitResult } from './hitRegions';
import { useAppStore } from '../stores/useAppStore';
import { ASSETS } from '../data/assets';
import { defaultQuoteForProvider } from '../stores/useWatchlistStore';

import type {
  ChartLayout,
  ChartRenderer,
  RenderContext,
  ThemeTokens,
  ViewWindow,
} from './types';

// Plot-area gutters (CSS px). Matches chart.jsx padR/padB/padT/padL.
const PAD_RIGHT = 60;
const PAD_BOTTOM = 22;
const PAD_TOP = 16;
const PAD_LEFT = 12;

// Morph duration in ms (--t-med = 320ms).
const MORPH_DURATION = 320;

/** Cubic-out easing: fast start, decelerates to 1. */
function cubicOut(t: number): number {
  const t1 = t - 1;
  return t1 * t1 * t1 + 1;
}

export type ChartType = 'candles' | 'heikin' | 'bars' | 'line' | 'area' | 'mountain';

interface ChartCanvasProps {
  bars: Bar[];
  view: ViewWindow;
  chartType?: ChartType;
  /** Base renderer (P1.3 supplies one of candles/heikin/bars/line/area/mountain). */
  renderer?: ChartRenderer;
  /** Drawn after the base renderer — MA20/MA50/Bollinger etc. */
  overlays?: ChartRenderer[];
  /** When true, log avg FPS to console for the first 5 seconds (A7 perf check). */
  profile?: boolean;
  /**
   * Optional setter for the view (P1.4 interaction). When provided, the canvas
   * wires mouse/touch handlers for pan + zoom + range select. Without it, the
   * canvas is read-only.
   */
  onViewChange?: (next: ViewWindow) => void;
  /** P1.4 → P2.6: emitted when user shift+drags a range. */
  onRangeSelect?: (range: RangeSelectEvent | null) => void;
  /**
   * P2.5 — list of persisted marks to render. When non-empty the canvas
   * renders LED dots + price tags + (for Comments) hover popovers via DOM.
   */
  marks?: Mark[];
  /**
   * P2.5 — fired on a click-without-drag (mousedown→mouseup with movement
   * below the TAP threshold). Provides chart-space coordinates so callers
   * can position floating composers without re-doing the px→price math.
   */
  onChartClick?: (info: {
    barIdx: number;
    price: number;
    ts: number;
    canvasX: number;
    canvasY: number;
  }) => void;
  /**
   * P2.1 — fired whenever the crosshair moves to a new bar (or clears).
   * Used by Headline to show the OHLCV readout for the hovered bar.
   */
  onHoverBar?: (idx: number | null) => void;
  /**
   * P2.2 — when 'rangeScope', plain drag (without Shift) triggers range-select
   * instead of pan. The interaction module reads this via a live ref so the
   * interaction controller does not need to be recreated on tool changes.
   */
  activeTool?: string;
  /**
   * Step 5 — fired when the pointer hovers an overlay hotspot (or clears).
   * Delivers the nearest hit plus the full coincident set (CSS-px space). The
   * next step's `<OverlayInfoPanel>` consumes this. Fired only when the hit
   * result IDENTITY changes (see `hitResultKey`) to avoid re-render storms.
   */
  onHotspotChange?: (hit: HitResult | null) => void;
}

// ---------------------------------------------------------------------------
// Theme — read CSS vars once on mount. Exposed as a hook so we can re-read on
// (future) theme-change events without re-mounting the canvas.
// ---------------------------------------------------------------------------

function readTheme(): ThemeTokens {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      up: '#7CC59C',
      down: '#E08A7E',
      grid: 'rgba(255,255,255,0.04)',
      hairline: 'rgba(255,255,255,0.08)',
      fg: '#A7B0BD',
      bg: '#0A0E14',
    };
  }
  const root = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => {
    const v = root.getPropertyValue(name).trim();
    return v.length ? v : fallback;
  };
  return {
    up: get('--up', 'oklch(0.78 0.16 150)'),
    down: get('--down', 'oklch(0.70 0.20 25)'),
    grid: 'rgba(255,255,255,0.04)',
    hairline: get('--hairline', 'rgba(255,255,255,0.08)'),
    fg: get('--ink-2', 'oklch(0.55 0.010 260)'),
    bg: get('--bg-0', 'oklch(0.11 0.008 260)'),
  };
}

// ---------------------------------------------------------------------------
// Morph state
// ---------------------------------------------------------------------------

interface MorphState {
  /** The renderer that is fading OUT. */
  prevRenderer: ChartRenderer;
  /** Wall-clock timestamp when the morph started. */
  startTime: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Px movement threshold below which a mousedown→mouseup is treated as a click. */
const CLICK_TAP_PX = 4;

export function ChartCanvas({
  bars,
  view,
  renderer,
  overlays,
  profile = false,
  onViewChange,
  onRangeSelect,
  marks,
  onChartClick,
  onHoverBar,
  activeTool,
  onHotspotChange,
}: ChartCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [theme, setTheme] = useState<ThemeTokens>(() => readTheme());

  // Re-read theme tokens once after mount.
  useEffect(() => {
    setTheme(readTheme());
  }, []);

  // Animated y-range
  const { yMin: animYMin, yMax: animYMax } = useAnimatedRange(view.yMin, view.yMax);
  const animatedView: ViewWindow = useMemo(
    () => ({ start: view.start, end: view.end, yMin: animYMin, yMax: animYMax }),
    [view.start, view.end, animYMin, animYMax],
  );

  // ResizeObserver — debounced one frame.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    let pending: { w: number; h: number } | null = null;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const r = entry.contentRect;
      pending = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pending) setSize(pending);
        pending = null;
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Layout in CSS pixels.
  const layout: ChartLayout = useMemo(
    () => ({
      x: PAD_LEFT,
      y: PAD_TOP,
      w: Math.max(1, size.w - PAD_LEFT - PAD_RIGHT),
      h: Math.max(1, size.h - PAD_TOP - PAD_BOTTOM),
    }),
    [size.w, size.h],
  );

  // -------------------------------------------------------------------------
  // Chart-type morph state
  // When the `renderer` prop changes, we capture the old renderer and start
  // a cross-fade morph from it to the new one over MORPH_DURATION ms.
  // -------------------------------------------------------------------------
  const morphRef = useRef<MorphState | null>(null);
  const prevRendererRef = useRef<ChartRenderer | undefined>(renderer);
  const morphRafRef = useRef<number>(0);

  useEffect(() => {
    // Detect renderer change
    if (prevRendererRef.current && renderer && prevRendererRef.current !== renderer) {
      // Cancel any in-flight morph
      if (morphRafRef.current) {
        cancelAnimationFrame(morphRafRef.current);
        morphRafRef.current = 0;
      }
      morphRef.current = {
        prevRenderer: prevRendererRef.current,
        startTime: performance.now(),
      };
    }
    prevRendererRef.current = renderer;
  }, [renderer]);

  // -------------------------------------------------------------------------
  // P1.4 — Interaction wiring.
  //
  // The interaction module is a pure DOM-event controller. We hold "live"
  // refs to view + bars + layout so the controller always sees current state
  // without re-binding every render.
  // -------------------------------------------------------------------------
  const viewRef = useRef<ViewWindow>(view);
  const layoutRef = useRef<ChartLayout>(layout);
  const barsRef = useRef<Bar[]>(bars);
  const onViewChangeRef = useRef<typeof onViewChange>(onViewChange);
  const onRangeSelectRef = useRef<typeof onRangeSelect>(onRangeSelect);

  // Always-fresh refs for the interaction controller's getters.
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { barsRef.current = bars; }, [bars]);
  useEffect(() => { onViewChangeRef.current = onViewChange; }, [onViewChange]);
  useEffect(() => { onRangeSelectRef.current = onRangeSelect; }, [onRangeSelect]);

  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null);
  const crosshairRef = useRef<CrosshairState | null>(null);
  useEffect(() => { crosshairRef.current = crosshair; }, [crosshair]);
  const [isPanningCursor, setIsPanningCursor] = useState(false);

  // P2.1 — stable ref for the onHoverBar callback. Lets the interaction
  // controller call it without needing to be recreated when the prop changes.
  const onHoverBarRef = useRef<typeof onHoverBar>(onHoverBar);
  useEffect(() => { onHoverBarRef.current = onHoverBar; }, [onHoverBar]);

  // P2.2 — live ref for activeTool so interaction controller can check it
  // without being re-created on every tool change.
  const activeToolRef = useRef<string | undefined>(activeTool);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);

  // Step 5 — shared overlay-hotspot registry. ONE array, held here, reset in
  // place (`length = 0`) at the TOP of each draw and pushed into by every
  // interactive overlay renderer during its draw pass. Queried on mousemove
  // against the last completed draw. CSS-px space (same as the draw + pointer).
  const hitRegionsRef = useRef<HitRegion[]>([]);
  const onHotspotChangeRef = useRef<typeof onHotspotChange>(onHotspotChange);
  useEffect(() => { onHotspotChangeRef.current = onHotspotChange; }, [onHotspotChange]);
  // Last emitted hit-result identity — gate so we only fire the callback (and
  // thus re-render the panel) when the hit identity actually changes.
  const lastHotspotKeyRef = useRef<string>('');

  // Asset-switch loading phase — drives phase-aware drawing.
  const loadingPhase = useAppStore((s) => s.loadingPhase);
  const loadingPhaseRef = useRef<'idle' | 'exit' | 'loading' | 'reveal'>(loadingPhase);
  useEffect(() => { loadingPhaseRef.current = loadingPhase; }, [loadingPhase]);

  // Reveal tween: tracks globalAlpha 0→1 over MORPH_DURATION when reveal starts.
  const revealStartRef = useRef<number | null>(null);
  const revealRafRef = useRef<number>(0);

  useEffect(() => {
    if (loadingPhase === 'reveal') {
      revealStartRef.current = performance.now();
      // Kick off the RAF loop for the reveal cross-fade.
      const tick = () => {
        drawFrame.current?.();
        if (revealStartRef.current !== null) {
          const elapsed = performance.now() - revealStartRef.current;
          if (elapsed < MORPH_DURATION) {
            revealRafRef.current = requestAnimationFrame(tick);
          } else {
            revealStartRef.current = null;
            revealRafRef.current = 0;
          }
        }
      };
      revealRafRef.current = requestAnimationFrame(tick);
    } else {
      revealStartRef.current = null;
      if (revealRafRef.current) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = 0;
      }
    }
    return () => {
      if (revealRafRef.current) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = 0;
      }
    };
  }, [loadingPhase]); // drawFrame ref is always-fresh via its own useEffect above

  // Reduced-motion detection for chart phase behavior.
  const reducedMotionRef = useRef<boolean>(
    typeof window !== 'undefined' && !!window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fn = (e: MediaQueryListEvent) => { reducedMotionRef.current = e.matches; };
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, []);

  // Skeleton baseline RAF pump — drives the breathing alpha while loading.
  // Only runs when !reducedMotion; reduced-motion uses static alpha 0.45 on
  // each prop-change redraw (no extra loop needed).
  const skelRafRef = useRef<number>(0);
  useEffect(() => {
    if (loadingPhase === 'loading' && !reducedMotionRef.current) {
      const tick = () => {
        drawFrame.current?.();
        if (loadingPhaseRef.current === 'loading' && !reducedMotionRef.current) {
          skelRafRef.current = requestAnimationFrame(tick);
        } else {
          skelRafRef.current = 0;
        }
      };
      skelRafRef.current = requestAnimationFrame(tick);
    } else {
      if (skelRafRef.current) {
        cancelAnimationFrame(skelRafRef.current);
        skelRafRef.current = 0;
      }
    }
    return () => {
      if (skelRafRef.current) {
        cancelAnimationFrame(skelRafRef.current);
        skelRafRef.current = 0;
      }
    };
  }, [loadingPhase]);

  // Trend-line state (persisted list, in-progress draft, current selection)
  // is held in the app store. Live refs below let the interaction controller
  // read fresh values without re-creating its config on every change.
  const trends = useAppStore((s) => s.trends);
  const setTrends = useAppStore((s) => s.setTrends);
  const trendDraft = useAppStore((s) => s.trendDraft);
  const setTrendDraft = useAppStore((s) => s.setTrendDraft);
  const selectedTrendId = useAppStore((s) => s.selectedTrendId);
  const setSelectedTrendId = useAppStore((s) => s.setSelectedTrendId);
  const activeSym = useAppStore((s) => s.activeSym);
  // ADR-0009 — prefer the canonical provider from `activeAsset` for marks +
  // trend lookups (Step 7 leaves the wire on the legacy schema; quote is not
  // threaded into the trends/marks Tauri commands yet — see plan locked
  // decision #5).
  const activeAsset = useAppStore((s) => s.activeAsset);
  const tf = useAppStore((s) => s.tf);

  // Live refs so the interaction controller's getters always see fresh state
  // without needing to be re-created on every change.
  const trendsRef = useRef<TrendRow[]>(trends);
  const setTrendDraftRef = useRef(setTrendDraft);
  const setTrendsRef = useRef(setTrends);
  const setSelectedTrendIdRef = useRef(setSelectedTrendId);
  const activeSymRef = useRef<string | undefined>(activeSym);
  const tfRef = useRef<string | undefined>(tf);
  const trendDraftRef = useRef(trendDraft);
  const selectedTrendIdRef = useRef(selectedTrendId);
  useEffect(() => { trendsRef.current = trends; }, [trends]);
  useEffect(() => { trendDraftRef.current = trendDraft; }, [trendDraft]);
  useEffect(() => { selectedTrendIdRef.current = selectedTrendId; }, [selectedTrendId]);
  useEffect(() => { setTrendDraftRef.current = setTrendDraft; }, [setTrendDraft]);
  useEffect(() => { setTrendsRef.current = setTrends; }, [setTrends]);
  useEffect(() => { setSelectedTrendIdRef.current = setSelectedTrendId; }, [setSelectedTrendId]);
  useEffect(() => { activeSymRef.current = activeSym; }, [activeSym]);
  useEffect(() => { tfRef.current = tf; }, [tf]);

  // Single TrendsRenderer that reads its inputs from refs each frame, so we
  // don't allocate a new renderer object on every draw.
  const trendsRendererRef = useRef<ChartRenderer | null>(null);
  if (trendsRendererRef.current === null) {
    trendsRendererRef.current = createTrendsRenderer({
      get trends() { return trendsRef.current; },
      get draft() { return trendDraftRef.current; },
      get selectedId() { return selectedTrendIdRef.current; },
    });
  }

  // Load persisted trends whenever (sym, tf) changes. Mirrors the marks load
  // path in AppShell — failure is logged + falls back to an empty list so
  // `vite dev` (no Tauri runtime) keeps working.
  useEffect(() => {
    if (!activeSym || !tf) return;
    let cancelled = false;
    // ADR-0008/0009 (Step 11): trends queries include `provider` AND `quote`.
    // Sourced from `activeAsset` first (covers catalog-added symbols); falls
    // back to the legacy ASSETS lookup + per-provider default quote so users
    // whose hydrated state predates the localStorage migration shim still see
    // their trend lines.
    const provider =
      activeAsset?.provider ??
      ASSETS.find((a) => a.sym === activeSym)?.provider ??
      'binance';
    const quote = activeAsset?.quote ?? defaultQuoteForProvider(provider);
    dbTrendsList(activeSym, tf, provider, quote)
      .then((list) => {
        if (cancelled) return;
        setTrends(list);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('[trends] dbTrendsList failed (running outside Tauri?)', err);
        setTrends([]);
      });
    return () => { cancelled = true; };
  }, [activeSym, tf, activeAsset, setTrends]);

  // Build a stable interaction controller. We always build it; if onViewChange
  // is undefined the setView callback is a no-op so the chart stays read-only.
  const interactionRef = useRef<ReturnType<typeof createChartInteraction> | null>(null);
  if (!interactionRef.current) {
    interactionRef.current = createChartInteraction({
      getView: () => viewRef.current,
      getBarCount: () => barsRef.current.length,
      getLayout: () => layoutRef.current,
      setView: (next) => onViewChangeRef.current?.(next),
      setCrosshair: (next) => {
        setCrosshair(next);
        // P2.1 — notify Headline of the hovered bar index.
        onHoverBarRef.current?.(next !== null ? next.barIdx : null);
      },
      onRangeSelect: (r) => onRangeSelectRef.current?.(r),
      isCrosshairVisible: () => crosshairRef.current != null,
      // P2.2 — Range Scope tool: plain drag triggers range-select when active.
      isRangeDragActive: () => activeToolRef.current === 'rangeScope',
      // Trend tool: plain drag captures two anchors and persists.
      isTrendDragActive: () => activeToolRef.current === 'trend',
      setTrendDraft: (anchors) => {
        if (!anchors) {
          setTrendDraftRef.current?.(null);
          return;
        }
        const bs = barsRef.current;
        if (!bs.length) return;
        // Map fractional bar-index → ts (clamp + linear interp). The
        // controller hands us bar-index (continuous); we need a ts for
        // persistence so the trend re-projects correctly across pans/zooms.
        const tsAt = (idx: number): number => {
          const lo = Math.max(0, Math.min(bs.length - 1, Math.floor(idx)));
          const hi = Math.max(0, Math.min(bs.length - 1, Math.ceil(idx)));
          if (lo === hi) return bs[lo]!.ts;
          const f = idx - lo;
          return bs[lo]!.ts + (bs[hi]!.ts - bs[lo]!.ts) * f;
        };
        setTrendDraftRef.current?.({
          x1_ts: tsAt(anchors.x1Idx),
          y1_price: anchors.y1Price,
          x2_ts: tsAt(anchors.x2Idx),
          y2_price: anchors.y2Price,
        });
      },
      commitTrend: (anchors) => {
        const bs = barsRef.current;
        if (!bs.length) return;
        const sym = activeSymRef.current;
        const tfNow = tfRef.current;
        if (!sym || !tfNow) return;
        const tsAt = (idx: number): number => {
          const lo = Math.max(0, Math.min(bs.length - 1, Math.floor(idx)));
          const hi = Math.max(0, Math.min(bs.length - 1, Math.ceil(idx)));
          if (lo === hi) return bs[lo]!.ts;
          const f = idx - lo;
          return bs[lo]!.ts + (bs[hi]!.ts - bs[lo]!.ts) * f;
        };
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // ADR-0008/0009 (Step 11): `provider` AND `quote` are mandatory on
        // every trend row. Read live from `useAppStore.activeAsset` (the
        // canonical source); fall back to legacy ASSETS + per-provider default
        // quote so trends still persist before hydrate fully resolves.
        const activeNow = useAppStore.getState().activeAsset;
        const provider =
          activeNow?.provider ??
          ASSETS.find((a) => a.sym === sym)?.provider ??
          'binance';
        const quote = activeNow?.quote ?? defaultQuoteForProvider(provider);
        const row: TrendRow = {
          id,
          sym,
          provider,
          quote,
          tf: tfNow,
          x1_ts: tsAt(anchors.x1Idx),
          y1_price: anchors.y1Price,
          x2_ts: tsAt(anchors.x2Idx),
          y2_price: anchors.y2Price,
          color: 'accent',
          created_at: Date.now(),
        };
        // Optimistic local update — append immediately so the trend renders
        // without waiting for the round-trip; persistence is fire-and-forget.
        setTrendsRef.current?.([...trendsRef.current, row]);
        dbTrendsInsert(row).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[chart] dbTrendsInsert failed', err);
          import('../stores/useToastStore').then((m) =>
            m.useToastStore.getState().push({
              kind: 'warn',
              title: 'Trend not saved',
              detail: 'Drawing kept on screen but failed to persist',
            }),
          );
        });
      },
    });
  }
  const interaction = interactionRef.current;

  // P2.5 — click-without-drag detector. Tracks mousedown position; when the
  // matching mouseup happens within CLICK_TAP_PX of the start, fires
  // onChartClick with chart-space coordinates. Runs alongside the interaction
  // controller (which only acts on movement); a stationary click is no-op for
  // pan/range, so this layer doesn't conflict.
  const clickStartRef = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const onChartClickRef = useRef<typeof onChartClick>(onChartClick);
  useEffect(() => { onChartClickRef.current = onChartClick; }, [onChartClick]);

  // Bind/unbind DOM events on the wrap element.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !interaction) return;
    const onDown = (e: MouseEvent) => {
      interaction.onMouseDown(e);
      // Track for click detection (left button only, no shift/range drag).
      if (e.button === 0 && !e.shiftKey) {
        const rect = el.getBoundingClientRect();
        clickStartRef.current = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          shift: e.shiftKey,
        };
      } else {
        clickStartRef.current = null;
      }
    };
    const onMove = (e: MouseEvent) => {
      interaction.onMouseMove(e);
      setIsPanningCursor(interaction.isPanning());

      // Step 5 — overlay hotspot query against the last completed draw.
      // Pointer is in CSS px relative to the wrap (same space as the regions).
      // Skip while actively panning (the user is navigating, not inspecting).
      const cb = onHotspotChangeRef.current;
      if (cb && !interaction.isPanning()) {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const hit = hitTest(hitRegionsRef.current, px, py);
        const key = hitResultKey(hit);
        if (key !== lastHotspotKeyRef.current) {
          lastHotspotKeyRef.current = key;
          cb(hit);
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      interaction.onMouseUp(e);
      setIsPanningCursor(false);
      // Click-detection: fire only if movement stayed below threshold.
      const start = clickStartRef.current;
      clickStartRef.current = null;
      const cb = onChartClickRef.current;
      if (start) {
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (Math.abs(x - start.x) <= CLICK_TAP_PX && Math.abs(y - start.y) <= CLICK_TAP_PX) {
          const v = viewRef.current;
          const lay = layoutRef.current;
          const bs = barsRef.current;
          if (bs.length && lay.w > 0) {
            // Step 4 — When no tool is active, a click might be selecting a
            // trend line. Hit-test trends in pixel space; if one is hit, set
            // it as the selection (Backspace deletes it). Otherwise clear
            // the selection so a click on empty chart deselects.
            if (activeToolRef.current === 'none' || activeToolRef.current === undefined) {
              const hit = findTrendAt(
                trendsRef.current,
                bs,
                v,
                lay,
                x,
                y,
                /* thresholdPx */ 8,
              );
              if (hit) {
                setSelectedTrendIdRef.current?.(hit.id);
                // Don't fall through — selecting a trend shouldn't open the
                // mark composer or any other click consumer.
                return;
              }
              // Click on empty chart space — clear selection.
              setSelectedTrendIdRef.current?.(null);
            }

            if (cb) {
              const span = Math.max(1e-9, v.end - v.start);
              const fIdx = v.start + ((x - lay.x) / lay.w) * span;
              const idx = Math.max(0, Math.min(bs.length - 1, Math.floor(fIdx)));
              const range = Math.max(1e-9, v.yMax - v.yMin);
              const price = v.yMin + (1 - (y - lay.y) / lay.h) * range;
              const ts = bs[idx]!.ts;
              cb({ barIdx: idx, price, ts, canvasX: x, canvasY: y });
            }
          }
        }
      }
    };
    const onLeave = (e: MouseEvent) => {
      interaction.onMouseLeave(e);
      // Step 5 — clear any active overlay hotspot when the pointer leaves.
      if (lastHotspotKeyRef.current !== '') {
        lastHotspotKeyRef.current = '';
        onHotspotChangeRef.current?.(null);
      }
    };
    const onWheel = (e: WheelEvent) => interaction.onWheel(e);
    const onTStart = (e: TouchEvent) => interaction.onTouchStart(e);
    const onTMove = (e: TouchEvent) => interaction.onTouchMove(e);
    const onTEnd = (e: TouchEvent) => interaction.onTouchEnd(e);

    el.addEventListener('mousedown', onDown);
    el.addEventListener('mousemove', onMove);
    // Listen for mouseup on window so dragging off the canvas still ends cleanly.
    window.addEventListener('mouseup', onUp);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTStart, { passive: false });
    el.addEventListener('touchmove', onTMove, { passive: false });
    el.addEventListener('touchend', onTEnd);
    el.addEventListener('touchcancel', onTEnd);
    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTStart);
      el.removeEventListener('touchmove', onTMove);
      el.removeEventListener('touchend', onTEnd);
      el.removeEventListener('touchcancel', onTEnd);
      interaction.reset();
    };
  }, [interaction]);

  // -------------------------------------------------------------------------
  // The single render effect.
  // We spin a RAF loop when morphing is active; otherwise we depend on React
  // re-renders (triggered by animatedView, bars, etc.) for reactivity.
  // -------------------------------------------------------------------------
  const drawFrame = useRef<(() => void) | null>(null);

  // Keep drawFrame always up-to-date without stale closure issues.
  useEffect(() => {
    drawFrame.current = () => {
      const cnv = canvasRef.current;
      if (!cnv) return;
      const dpr = window.devicePixelRatio || 1;

      cnv.width = Math.floor(size.w * dpr);
      cnv.height = Math.floor(size.h * dpr);
      cnv.style.width = `${size.w}px`;
      cnv.style.height = `${size.h}px`;

      const ctx = cnv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);

      // Step 5 — reset the shared hotspot registry ONCE per frame, in place
      // (no realloc). Renderers repopulate it during their draw passes below.
      hitRegionsRef.current.length = 0;

      const phase = loadingPhaseRef.current;
      const reduced = reducedMotionRef.current;

      // Grid first.
      drawGrid(ctx, layout, animatedView, theme);

      // Skeleton baseline — drawn during loading phase in place of shimmer/glow.
      if (phase === 'loading') {
        let a = 0.45;
        if (!reduced) {
          const t = (performance.now() % 560) / 560;
          a = 0.35 + 0.20 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
        }
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = theme.hairline;
        ctx.lineWidth = 1;
        const yMid = Math.round(layout.y + layout.h / 2) + 0.5;
        ctx.beginPath();
        ctx.moveTo(layout.x, yMid);
        ctx.lineTo(layout.x + layout.w, yMid);
        ctx.stroke();
        ctx.restore();
      }

      const makeRc = (): RenderContext => ({
        ctx,
        bars,
        view: animatedView,
        theme,
        dpr,
        layout,
        hitRegions: hitRegionsRef.current,
      });

      // Phase-aware bars alpha. Exit: 0.18. Loading: 0.18 (bars likely []
      // anyway after AppShell clears them). Reveal: animated 0→1. Idle: 1.
      let barsAlpha = 1;
      if (phase === 'exit' || phase === 'loading') {
        barsAlpha = reduced ? 0 : 0.18;
      } else if (phase === 'reveal') {
        if (reduced) {
          barsAlpha = 1;
        } else {
          const start = revealStartRef.current;
          const elapsed = start !== null ? performance.now() - start : MORPH_DURATION;
          const raw = Math.min(elapsed / MORPH_DURATION, 1);
          barsAlpha = cubicOut(raw);
        }
      }

      // Determine morph progress (chart-type morph is independent of phase).
      const morph = morphRef.current;
      if (morph && renderer && bars.length) {
        const elapsed = performance.now() - morph.startTime;
        const raw = Math.min(elapsed / MORPH_DURATION, 1);
        const t = cubicOut(raw);

        const rc = makeRc();

        // Fade out old renderer
        ctx.save();
        ctx.globalAlpha = (1 - t) * barsAlpha;
        morph.prevRenderer.render(rc);
        ctx.restore();

        // Fade in new renderer
        ctx.save();
        ctx.globalAlpha = t * barsAlpha;
        renderer.render(rc);
        ctx.restore();

        if (raw < 1) {
          // Continue morphing via RAF
          morphRafRef.current = requestAnimationFrame(() => {
            // Force a re-draw by calling drawFrame directly
            drawFrame.current?.();
          });
        } else {
          // Morph complete
          morphRef.current = null;
          morphRafRef.current = 0;
          // Final draw at correct phase alpha.
          ctx.clearRect(0, 0, size.w, size.h);
          drawGrid(ctx, layout, animatedView, theme);
          if (barsAlpha < 1) {
            ctx.save();
            ctx.globalAlpha = barsAlpha;
            renderer.render(makeRc());
            ctx.restore();
          } else {
            renderer.render(makeRc());
          }
        }
      } else if (renderer && bars.length) {
        if (barsAlpha < 1) {
          ctx.save();
          ctx.globalAlpha = barsAlpha;
          renderer.render(makeRc());
          ctx.restore();
        } else {
          renderer.render(makeRc());
        }
      }

      // Overlays — only in idle/reveal; skip during exit/loading where bars
      // are being ghosted or empty.
      if (overlays && overlays.length && bars.length && phase !== 'exit' && phase !== 'loading') {
        const rc = makeRc();
        for (const o of overlays) o.render(rc);
      }

      // P2.5 — Marks layer (LED dots + price tags). DOM popover for Comment
      // notes is rendered separately (React) using `projectedMarks`.
      if (marks && marks.length && bars.length && phase === 'idle') {
        const rc = makeRc();
        createMarksRenderer(marks).render(rc);
      }

      // Trend lines (persisted) + in-progress draft, drawn after marks so a
      // freshly-placed trend reads above any nearby price tag.
      if ((trendsRef.current.length || trendDraft) && bars.length && phase === 'idle') {
        trendsRendererRef.current?.render(makeRc());
      }

      // Last-price guideline — skip during exit and loading.
      const showGuideline = phase !== 'exit' && phase !== 'loading';
      if (bars.length && showGuideline) {
        const last = bars[bars.length - 1]!;
        const prev = bars.length > 1 ? bars[bars.length - 2]! : last;
        const isUp = last.c >= prev.c;
        const color = isUp ? theme.up : theme.down;
        const range = animatedView.yMax - animatedView.yMin;
        if (range > 0 && isFinite(last.c)) {
          const yPx =
            layout.y + (1 - (last.c - animatedView.yMin) / range) * layout.h;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          const yCrisp = Math.round(yPx) + 0.5;
          ctx.moveTo(layout.x, yCrisp);
          ctx.lineTo(layout.x + layout.w, yCrisp);
          ctx.stroke();
          ctx.restore();
        }
        drawYAxis(ctx, layout, animatedView, theme, last.c);
      } else if (bars.length) {
        // Exit/loading: y-axis labels faded to ink-3 at 30% — draw without last-price
        ctx.save();
        ctx.globalAlpha = 0.3;
        drawYAxis(ctx, layout, animatedView, theme);
        ctx.restore();
      } else {
        drawYAxis(ctx, layout, animatedView, theme);
      }

      drawXAxis(ctx, layout, bars, animatedView, theme);
    };
  });

  // Trigger draw whenever reactive inputs change.
  useEffect(() => {
    drawFrame.current?.();
  }, [bars, animatedView, layout, theme, size.w, size.h, renderer, overlays, marks, trends, trendDraft, selectedTrendId, loadingPhase]);

  // P2.5 — Project marks for the DOM hover layer (Comments only need a popover).
  const projectedMarks: ProjectedMark[] = useMemo(() => {
    if (!marks || !marks.length || !bars.length) return [];
    return projectMarks(marks, bars, animatedView, layout);
  }, [marks, bars, animatedView, layout]);

  // P2.5 — DOM hover state for Comment popovers.
  const [hoverMarkId, setHoverMarkId] = useState<number | null>(null);

  // Cleanup any in-flight morph RAF on unmount.
  useEffect(() => {
    return () => {
      if (morphRafRef.current) cancelAnimationFrame(morphRafRef.current);
    };
  }, []);

  // -------------------------------------------------------------------------
  // A7 perf probe
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!profile) return;
    let raf = 0;
    let frameCount = 0;
    let firstTs = 0;
    let lastTs = 0;
    let stopped = false;
    const tick = (now: number) => {
      if (!firstTs) firstTs = now;
      lastTs = now;
      frameCount += 1;
      if (now - firstTs >= 5000 || stopped) {
        const elapsed = (lastTs - firstTs) / 1000;
        const fps = frameCount / Math.max(elapsed, 1e-6);
        // eslint-disable-next-line no-console
        console.info(`[ChartCanvas perf] ${frameCount} frames in ${elapsed.toFixed(2)}s = ${fps.toFixed(1)} fps`);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [profile]);

  // Cursor: grabbing while pan-dragging; otherwise the active tool dictates
  // the affordance. Step 4 maps each tool to its conventional cursor:
  //   mark/comment/trend → 'crosshair' (point-to-place semantic)
  //   rangeScope         → 'col-resize' (drag-horizontally semantic)
  //   none               → 'default'
  function cursorFor(tool: string | undefined): string {
    if (tool === 'mark' || tool === 'comment' || tool === 'trend') return 'crosshair';
    if (tool === 'rangeScope') return 'col-resize';
    return 'default';
  }
  const cursorStyle = onViewChange
    ? isPanningCursor
      ? 'grabbing'
      : cursorFor(activeTool)
    : 'default';

  // Step 4 — Active-tool affordance: subtle inset-left glow on the canvas
  // wrapper when any tool is active, so the user has unambiguous chart-side
  // feedback that "now click to drop X" beyond just the Dock highlight.
  // The prototype design guidance prefers a single subtle glow over a thick
  // border (Principle 04) — we use color-mix with var(--accent) at 40%.
  const toolActive = activeTool !== undefined && activeTool !== 'none';
  const toolGlow = toolActive
    ? 'inset 4px 0 12px color-mix(in oklab, var(--accent, #7CC9F0) 40%, transparent)'
    : 'none';

  return (
    <div
      ref={wrapRef}
      data-active-tool={activeTool ?? 'none'}
      data-loading-phase={loadingPhase}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // Required for mobile so 1-finger pan / 2-finger pinch don't scroll the page.
        touchAction: 'none',
        cursor: cursorStyle,
        boxShadow: toolGlow,
        transition: 'box-shadow var(--t-fast, 160ms) var(--ease, ease-out)',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />

      {/* Skeleton baseline test marker — present during loading, absent otherwise.
          Hidden from layout; canvas draws the actual baseline line. */}
      {loadingPhase === 'loading' && (
        <span data-testid="chart-skeleton-baseline" hidden />
      )}

      <Crosshair state={crosshair} bars={bars} layout={layout} />

      {/* P2.5 — Comment hover popovers + invisible hit targets for hover detect.
          Only Comment marks (note != null) get a popover; plain Marks have a
          tag rendered on canvas already. */}
      {projectedMarks.map((p) =>
        p.isComment ? (
          <div
            key={p.mark.id}
            // 20×20 hit target centered on the dot.
            style={{
              position: 'absolute',
              left: Math.round(p.x - 10),
              top: Math.round(p.y - 10),
              width: 20,
              height: 20,
              borderRadius: '50%',
              cursor: 'help',
              // No background — purely a pointer hit area.
            }}
            onMouseEnter={() => setHoverMarkId(p.mark.id)}
            onMouseLeave={() => setHoverMarkId((id) => (id === p.mark.id ? null : id))}
          >
            {hoverMarkId === p.mark.id && p.mark.note ? (
              <div
                role="tooltip"
                className="glass-strong"
                style={{
                  position: 'absolute',
                  // Position above the dot; clamp horizontally within wrapper.
                  bottom: 24,
                  left: clampPopoverX(p.x, size.w),
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  padding: '8px 10px',
                  borderRadius: 8,
                  maxWidth: 240,
                  fontSize: 12,
                  lineHeight: 1.4,
                  color: 'var(--ink-1, #E6EAF2)',
                  whiteSpace: 'pre-wrap',
                  zIndex: 5,
                  boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
                }}
              >
                {p.mark.note}
              </div>
            ) : null}
          </div>
        ) : null,
      )}
    </div>
  );
}

/** Clamp the popover's left position so it doesn't overflow the canvas. */
function clampPopoverX(centerX: number, wrapperW: number): number {
  const half = 120; // half of maxWidth
  return Math.max(half + 8, Math.min(wrapperW - half - 8, centerX));
}

export default ChartCanvas;
