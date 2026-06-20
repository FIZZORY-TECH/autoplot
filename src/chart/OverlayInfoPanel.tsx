/**
 * src/chart/OverlayInfoPanel.tsx — Step 6
 *
 * ONE shared glass info card that consumes the hit-region result emitted by
 * `ChartCanvas` (`onHotspotChange` → `HitResult`) and renders:
 *   (a) built-in per-kind content for every existing overlay kind, derived from
 *       the payload each renderer pushes during its draw pass, and
 *   (b) a generic agent-authored `PanelSpec` (for `research` hotspots).
 *
 * Positioning mirrors `src/components/Crosshair.tsx`: absolutely positioned
 * inside the chart-wrap, anchored near the hit point, clamped horizontally with
 * the same `clampPopoverX` precedent (mirrored here).
 *
 * Interaction model (discoverable, clean):
 *   - HOVER: the panel follows the nearest hit and fades in (var(--t-fast),
 *     instant under prefers-reduced-motion). pointer-events are OFF so it never
 *     blocks chart interaction.
 *   - CLICK on a hotspot (a hover hit is active when the click lands) PINS the
 *     panel. While pinned it stays put as the mouse moves, pointer-events turn
 *     ON so its actions (× / cycler) are usable.
 *   - UNPIN via the × button, the Escape key, or clicking elsewhere on the chart
 *     (a click that lands with no active hover hit clears the pin).
 *   - COINCIDENT CYCLER: when pinned with >1 coincident hit, the header shows
 *     `‹ N/M ›` buttons that step through the coincident stack.
 *
 * This component owns NO hit-region/registry logic — it is a pure consumer of
 * the `HitResult` identity the substrate already de-duplicates.
 */

import { useEffect, useRef, useState } from 'react';
import type { Bar } from '../data/MarketDataProvider';
import { fmtPrice, fmtPct } from '../engine/indicators';
import { PanelSpec as PanelSpecSchema, type PanelSpec } from '../ai/schemas';
import { useOverlayHitStore } from '../stores/useOverlayHitStore';
import type { HitRegion, HitResult } from './hitRegions';
import type { Trade } from '../engine/backtest';
import type { Mark, TrendRow } from '../lib/db';
import type { TimelineEvent } from '../stores/useChartMutationStore';

// ---------------------------------------------------------------------------
// Public imperative handle — lets the parent read the currently-pinned mark.
// ---------------------------------------------------------------------------

/** A mark/comment region that is currently pinned in the info panel. */
export interface PinnedMark {
  mark: Mark;
  isComment: boolean;
}

export type { PinnedMark as OverlayPinnedMark };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OverlayInfoPanelProps {
  /** Visible bars — used to resolve OHLC / timestamps from bar indices. */
  bars: Bar[];
  /** Plot-area layout (CSS px) — bounds the panel to the plot, like Crosshair. */
  layout: { x: number; y: number; w: number; h: number };
  /** Chart-wrap width (CSS px) for horizontal clamping. */
  wrapW: number;
  /**
   * Called when the user clicks × on a pinned mark/comment.
   * The parent is responsible for the DB delete + state refresh + undo toast.
   */
  onDeleteMark?: (mark: Mark, isComment: boolean) => void;
  /**
   * Called when the user clicks ✎ on a pinned comment.
   * The parent reopens MarkComposer prefilled with the existing text/color.
   */
  onEditMark?: (mark: Mark) => void;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const PANEL_W = 200;

/** Clamp the panel left so it stays inside the chart-wrap (mirrors ChartCanvas). */
function clampPanelX(left: number, wrapW: number): number {
  return Math.max(8, Math.min(wrapW - PANEL_W - 8, left));
}

/** Compact local timestamp (date + HH:MM) for overlay metadata. */
function fmtTs(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ▲ for up / ▼ for down / · for flat — color is paired, never sole signal. */
function dirGlyph(n: number): string {
  if (n > 0) return '▲';
  if (n < 0) return '▼';
  return '·';
}

/** Up/down/neutral color token by sign. */
function dirColor(n: number): string {
  if (n > 0) return 'var(--up)';
  if (n < 0) return 'var(--down)';
  return 'var(--ink-2)';
}

// ---------------------------------------------------------------------------
// Per-kind → PanelSpec adapters
//
// Each adapter turns a renderer-pushed payload into the same generic PanelSpec
// shape the agent surface uses, so there is exactly ONE render path below.
// ---------------------------------------------------------------------------

function signalPanel(payload: { trade: Trade; edge: 'entry' | 'exit' }, bars: Bar[]): PanelSpec {
  const { trade, edge } = payload;
  const entryBar = bars[trade.entryBar];
  const exitBar = bars[trade.exitBar];
  const rows: PanelSpec['rows'] = [
    {
      label: 'Entry',
      value: fmtPrice(trade.entryPrice),
      glyph: '▲',
      color: 'var(--up)',
    },
    {
      label: 'Exit',
      value: trade.openAtEnd ? `${fmtPrice(trade.exitPrice)} (open)` : fmtPrice(trade.exitPrice),
      glyph: '▼',
      color: 'var(--down)',
    },
    {
      label: 'PnL',
      value: `${fmtPrice(trade.pnl)} (${fmtPct(trade.pnlPct)})`,
      glyph: dirGlyph(trade.pnl),
      color: dirColor(trade.pnl),
    },
  ];
  if (entryBar) rows.push({ label: 'Entry ts', value: fmtTs(entryBar.ts) });
  if (exitBar) rows.push({ label: 'Exit ts', value: fmtTs(exitBar.ts) });
  return { title: `Trade — ${edge}`, rows };
}

function strategySignalPanel(payload: {
  signal: { ts: number; side: 'long' | 'short'; price?: number };
}): PanelSpec {
  const { signal } = payload;
  const up = signal.side === 'long';
  const rows: PanelSpec['rows'] = [
    {
      label: 'Side',
      value: signal.side,
      glyph: up ? '▲' : '▼',
      color: up ? 'var(--up)' : 'var(--down)',
    },
  ];
  if (signal.price !== undefined) rows.push({ label: 'Price', value: fmtPrice(signal.price) });
  rows.push({ label: 'Time', value: fmtTs(signal.ts) });
  return { title: 'Strategy signal', rows };
}

function trendPanel(payload: TrendRow): PanelSpec {
  const delta = payload.y1_price === 0 ? 0 : (payload.y2_price - payload.y1_price) / payload.y1_price;
  return {
    title: 'Trend',
    rows: [
      {
        label: 'Δ%',
        value: fmtPct(delta),
        glyph: dirGlyph(delta),
        color: dirColor(delta),
      },
      { label: 'From', value: fmtPrice(payload.y1_price) },
      { label: 'To', value: fmtPrice(payload.y2_price) },
    ],
  };
}

function rangeEdgePanel(
  payload: { edge: 'start' | 'end'; range: { start: number; end: number } },
  bars: Bar[],
): PanelSpec {
  const idx = payload.edge === 'start' ? payload.range.start : payload.range.end;
  // Edge falls on a fractional bar boundary; clamp to a real bar for OHLC.
  const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(idx)))];
  const startBar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(payload.range.start)))];
  const endBar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(payload.range.end)))];
  const rows: PanelSpec['rows'] = [];
  if (bar) {
    rows.push({ label: 'O', value: fmtPrice(bar.o) });
    rows.push({ label: 'H', value: fmtPrice(bar.h) });
    rows.push({ label: 'L', value: fmtPrice(bar.l) });
    rows.push({ label: 'C', value: fmtPrice(bar.c) });
  }
  if (startBar && endBar && startBar.c !== 0) {
    const delta = (endBar.c - startBar.c) / startBar.c;
    rows.push({
      label: 'Range Δ%',
      value: fmtPct(delta),
      glyph: dirGlyph(delta),
      color: dirColor(delta),
    });
  }
  return { title: `Range — ${payload.edge}`, rows };
}

function indicatorLastPanel(payload: {
  label: string;
  value: number;
  color: string;
  barIdx: number;
}): PanelSpec {
  return {
    title: payload.label,
    rows: [{ label: 'Last', value: fmtPrice(payload.value), color: payload.color }],
  };
}

function markPanel(payload: Mark, isComment: boolean): PanelSpec {
  const rows: PanelSpec['rows'] = [
    { label: isComment ? 'Note' : 'Mark', value: payload.note ?? '(no text)', color: payload.color },
    { label: 'Price', value: fmtPrice(payload.price) },
    { label: 'Time', value: fmtTs(payload.ts) },
  ];
  return { title: isComment ? 'Comment' : 'Mark', rows };
}

function timelinePanel(payload: TimelineEvent): PanelSpec {
  const rows: PanelSpec['rows'] = [
    { label: 'Label', value: payload.label || '(unlabeled)', color: payload.color },
    { label: 'Time', value: fmtTs(payload.ts) },
  ];
  return { title: `Timeline — ${payload.kind}`, rows };
}

/** Research hotspot: prefer an explicit agent `panel`, else default fields. */
function researchPanel(payload: unknown): PanelSpec {
  if (payload && typeof payload === 'object' && 'panel' in payload) {
    const parsed = PanelSpecSchema.safeParse((payload as { panel: unknown }).panel);
    if (parsed.success) return parsed.data;
  }
  // Default fields from a bare research payload (label / value / ts as present).
  const p = (payload ?? {}) as Record<string, unknown>;
  const rows: PanelSpec['rows'] = [];
  if (typeof p['label'] === 'string') rows.push({ label: 'Label', value: p['label'] });
  if (typeof p['value'] === 'number') rows.push({ label: 'Value', value: fmtPrice(p['value']) });
  else if (typeof p['value'] === 'string') rows.push({ label: 'Value', value: p['value'] });
  if (typeof p['ts'] === 'number') rows.push({ label: 'Time', value: fmtTs(p['ts']) });
  return { title: 'Research', rows };
}

/** Map any hit region to the generic PanelSpec the renderer below consumes. */
function regionToPanel(region: HitRegion, bars: Bar[]): PanelSpec {
  const payload = region.payload;
  switch (region.kind) {
    case 'signal':
      return signalPanel(payload as { trade: Trade; edge: 'entry' | 'exit' }, bars);
    case 'strategySignal':
      return strategySignalPanel(
        payload as { signal: { ts: number; side: 'long' | 'short'; price?: number } },
      );
    case 'trend':
      return trendPanel(payload as TrendRow);
    case 'rangeEdge':
      return rangeEdgePanel(
        payload as { edge: 'start' | 'end'; range: { start: number; end: number } },
        bars,
      );
    case 'indicatorLast':
      return indicatorLastPanel(
        payload as { label: string; value: number; color: string; barIdx: number },
      );
    case 'mark':
      return markPanel(payload as Mark, false);
    case 'comment':
      return markPanel(payload as Mark, true);
    case 'timelinePin':
    case 'timelineVline':
    case 'timelineRange':
      return timelinePanel(payload as TimelineEvent);
    case 'research':
      return researchPanel(payload);
    default:
      return { title: 'Overlay', rows: [] };
  }
}

/** Kinds that carry a (later-wired) × delete affordance. */
function hasDeleteAffordance(kind: HitRegion['kind']): boolean {
  return kind === 'mark' || kind === 'comment';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OverlayInfoPanel({
  bars,
  layout,
  wrapW,
  onDeleteMark,
  onEditMark,
}: OverlayInfoPanelProps): JSX.Element | null {
  // Hover hit + click signal come from the dedicated store (not props), so the
  // app shell no longer re-renders on hotspot enter/leave or chart click — this
  // panel is the ONLY subscriber and thus the only thing that re-renders.
  const hover = useOverlayHitStore((s) => s.hit);
  const clickTick = useOverlayHitStore((s) => s.clickTick);
  const setPinnedMarkInStore = useOverlayHitStore((s) => s.setPinnedMark);

  // Pinned hit + the coincident index being viewed. null pin = hover mode.
  const [pinned, setPinned] = useState<HitResult | null>(null);
  const [coincidentIdx, setCoincidentIdx] = useState<number>(0);

  // Pin / unpin on each chart click: pin the current hover, or clear if none.
  const lastClickTickRef = useRef<number>(clickTick);
  useEffect(() => {
    if (clickTick === lastClickTickRef.current) return;
    lastClickTickRef.current = clickTick;
    if (hover) {
      setPinned(hover);
      setCoincidentIdx(0);
    } else {
      setPinned(null);
    }
  }, [clickTick, hover]);

  // Escape unpins.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  // Active result: pinned wins; otherwise the live hover.
  const active = pinned ?? hover;

  const coincident = active ? (active.coincident.length ? active.coincident : [active.nearest]) : [];
  const idx = pinned && active ? Math.min(coincidentIdx, coincident.length - 1) : 0;
  const region = active ? (coincident[idx] ?? active.nearest) : null;

  // Publish the currently-pinned mark/comment to the store so the keyboard
  // Backspace handler can read it synchronously via getState(). (`setPinnedMark`
  // is a stable zustand action.)
  useEffect(() => {
    if (!pinned || !region || !hasDeleteAffordance(region.kind)) {
      setPinnedMarkInStore(null);
      return;
    }
    setPinnedMarkInStore({
      mark: region.payload as Mark,
      isComment: region.kind === 'comment',
    });
  // region is derived from pinned+coincidentIdx — including pinned + coincidentIdx is sufficient.
  }, [pinned, coincidentIdx, region, setPinnedMarkInStore]);

  if (!active || !region) return null;

  const spec = regionToPanel(region, bars);
  const showCycler = !!pinned && coincident.length > 1;
  const showDelete = !!pinned && hasDeleteAffordance(region.kind);
  // Show the edit (✎) button only for comments (mark with note), when onEditMark is wired.
  const showEdit = showDelete && region.kind === 'comment' && !!onEditMark;
  const interactive = showCycler || showDelete;

  // Anchor near the hit point; clamp to the plot/wrap. Flip above when near
  // the bottom so the card never spills off the plot.
  const anchorX = active.clientX;
  const anchorY = active.clientY;
  const left = clampPanelX(anchorX + 14, wrapW);
  const ESTIMATED_H = 28 + spec.rows.length * 18 + (spec.footer ? 18 : 0);
  const flipUp = anchorY + ESTIMATED_H + 16 > layout.y + layout.h;
  const top = flipUp
    ? Math.max(layout.y + 4, anchorY - ESTIMATED_H - 14)
    : Math.min(layout.y + layout.h - ESTIMATED_H - 4, anchorY + 14);

  return (
    <div
      role="dialog"
      aria-label={spec.title ?? 'Overlay details'}
      className="glass-card overlay-enter"
      style={{
        position: 'absolute',
        left,
        top,
        width: PANEL_W,
        padding: 'var(--sp-6) var(--sp-8)',
        zIndex: 'var(--z-chart-panel)',
        background: 'var(--surface-overlay-strong)',
        pointerEvents: interactive ? 'auto' : 'none',
        color: 'var(--ink-1)',
        fontSize: 'var(--fs-meta, 11px)',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {/* Header — title + cycler + close (when pinned). */}
      {(spec.title || showCycler || showDelete) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--sp-8)',
            marginBottom: 'var(--sp-4, 4px)',
            color: 'var(--ink-3)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          <span>{spec.title}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4, 4px)' }}>
            {showCycler && (
              <>
                <button
                  type="button"
                  aria-label="Previous overlay at this point"
                  onClick={() =>
                    setCoincidentIdx((i) => (i - 1 + coincident.length) % coincident.length)
                  }
                  style={cyclerBtnStyle}
                >
                  ‹
                </button>
                <span aria-hidden style={{ color: 'var(--ink-2)' }}>
                  {idx + 1}/{coincident.length}
                </span>
                <button
                  type="button"
                  aria-label="Next overlay at this point"
                  onClick={() => setCoincidentIdx((i) => (i + 1) % coincident.length)}
                  style={cyclerBtnStyle}
                >
                  ›
                </button>
              </>
            )}
            {showEdit && (
              <button
                type="button"
                aria-label="Edit comment"
                onClick={() => {
                  if (onEditMark) onEditMark(region.payload as Mark);
                  setPinned(null);
                }}
                style={cyclerBtnStyle}
              >
                ✎
              </button>
            )}
            {showDelete && (
              <button
                type="button"
                aria-label="Delete mark"
                onClick={() => {
                  if (onDeleteMark) {
                    onDeleteMark(region.payload as Mark, region.kind === 'comment');
                  }
                  setPinned(null);
                }}
                style={cyclerBtnStyle}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      {/* Rows — label | glyph+value, mono + tabular-nums. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--sp-12)', rowGap: 'var(--sp-4, 4px)' }}>
        {spec.rows.map((row, i) => (
          <PanelRowView key={`${row.label}-${i}`} row={row} />
        ))}
      </div>

      {spec.footer && (
        <div style={{ marginTop: 'var(--sp-4, 4px)', color: 'var(--ink-3)' }}>{spec.footer}</div>
      )}
    </div>
  );
}

const cyclerBtnStyle: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  font: 'inherit',
  lineHeight: 1,
  padding: '0 2px',
};

function PanelRowView({ row }: { row: PanelSpec['rows'][number] }): JSX.Element {
  return (
    <>
      <span style={{ color: 'var(--ink-3)' }}>{row.label}</span>
      <span style={{ textAlign: 'right', color: row.color ?? 'var(--ink-1)' }}>
        {row.glyph ? <span style={{ marginRight: 4 }}>{row.glyph}</span> : null}
        {row.value}
      </span>
    </>
  );
}

export default OverlayInfoPanel;
