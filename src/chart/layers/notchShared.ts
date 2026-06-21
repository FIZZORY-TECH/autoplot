/**
 * src/chart/layers/notchShared.ts
 *
 * Shared primitives for the clustered dispatch-notch pass used by BOTH
 * `GenericResearchLayer` (kind:'research') and `TimelineEventsLayer`
 * (kind:'timelinePin').
 *
 * Exports:
 *   - `NotchTokens` interface + `resolveNotchTokens()` + `_resetNotchTokens()`
 *     — one resolved-CSS-var cache shared across both layers.
 *   - `hoveredClusterFirstId()` — reads the hovered cluster from the
 *     overlay-hit store; both layers use the same hover logic.
 *   - `columnHalfWidths()` — neighbour-aware column half-width calculation.
 *   - `renderNotchPass()` — the generic clustered-notch render loop;
 *     parameterised over the per-layer differences via callbacks/params.
 *
 * DO NOT import directly from the two layer files — import from this module
 * to avoid circular dependencies.
 */

import type { HitRegionKind } from '../hitRegions';
import {
  drawTimelineGlyph,
  drawDispatchSpine,
  drawHoverGuideLine,
  GLYPH_LABEL_FONT,
  NOTCH_W,
} from '../glyphs';
import { useOverlayHitStore } from '../../stores/useOverlayHitStore';
import type { RenderContext } from '../types';

// ---------------------------------------------------------------------------
// Dispatch-notch token resolution (S5)
//
// Resolved CSS-var color strings — canvas cannot read CSS vars. Read once from
// getComputedStyle, cache for the process lifetime (tokens don't change at
// runtime). SSR/test fallbacks embedded.
// ---------------------------------------------------------------------------

/** Resolved CSS-var color strings for the dispatch spine, notch, and badge. */
export interface NotchTokens {
  /** Faint hairline color for the dispatch spine + base (idle) notch fill. */
  spine: string;
  /** Active/hover notch fill + ring (resolved `--accent`). */
  accent: string;
  /** Count-badge background (resolved `--surface-overlay-strong`). */
  badgeBg: string;
  /** Count-badge ink (resolved `--ink-0`). */
  badgeInk: string;
}

let _notchTokens: NotchTokens | null = null;

/** TEST-ONLY: clear the resolved-token cache. */
export function _resetNotchTokens(): void {
  _notchTokens = null;
}

export function resolveNotchTokens(): NotchTokens {
  if (_notchTokens) return _notchTokens;
  // Fallbacks usable under SSR / jsdom where getComputedStyle returns ''.
  let tk: NotchTokens = {
    spine: 'oklch(0.36 0.010 260)',
    accent: 'oklch(0.82 0.14 215)',
    badgeBg: '#1e2230',
    badgeInk: '#e2e8f0',
  };
  if (typeof document !== 'undefined') {
    const s = getComputedStyle(document.documentElement);
    const pick = (token: string, fb: string): string => s.getPropertyValue(token).trim() || fb;
    tk = {
      spine: pick('--ink-3', tk.spine),
      accent: pick('--accent', tk.accent),
      badgeBg: pick('--surface-overlay-strong', tk.badgeBg),
      badgeInk: pick('--ink-0', tk.badgeInk),
    };
  }
  _notchTokens = tk;
  return tk;
}

// ---------------------------------------------------------------------------
// Hover state
// ---------------------------------------------------------------------------

/**
 * Read the first eventId of the currently-hovered event cluster (if any) from
 * the shared overlay-hit store. Used to brighten the hovered notch to its
 * active state + draw the hover guide line. First id is a stable per-cluster
 * identity (clustering is order-preserving). Returns null when nothing is hovered.
 */
export function hoveredClusterFirstId(): string | null {
  try {
    const hit = useOverlayHitStore.getState().hit;
    const p = hit?.nearest.payload as { eventIds?: unknown } | undefined;
    const ids = p?.eventIds;
    if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string') {
      return ids[0];
    }
  } catch {
    /* store unavailable (test stub) — no hover highlight. */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Column geometry
// ---------------------------------------------------------------------------

/**
 * Half-width (CSS px) of the full-pane-height dispatch COLUMN hit region. The
 * drawn notch is only NOTCH_W wide, but the click target is a tall column at
 * the event x spanning the full pane height — so a click ANYWHERE at that
 * timestamp resolves the hit (Fitts's law: a tall target needs no vertical
 * precision; ±18 → ≥36px wide, exceeding the 44pt touch-target minimum once
 * height counts).
 */
const COLUMN_HALF_W_PX = 18;

/**
 * Minimum gap (CSS px) to keep between two adjacent columns so neighbours
 * never overlap (touch-spacing). When two clusters are closer than
 * 2·HALF + GAP, each column's half-width shrinks toward the midpoint so a
 * ≥GAP dead-zone remains.
 */
const COLUMN_MIN_GAP_PX = 8;

/**
 * Compute each cluster's column half-width so adjacent columns keep a ≥
 * COLUMN_MIN_GAP_PX dead-zone between them. `centers` must be sorted
 * ascending. For each cluster the half-width is the lesser of COLUMN_HALF_W_PX
 * and half the room to the nearer neighbour (minus half the gap). Returns
 * parallel half-widths.
 */
export function columnHalfWidths(centers: number[]): number[] {
  return centers.map((cx, i) => {
    let half = COLUMN_HALF_W_PX;
    const prev = i > 0 ? centers[i - 1] : undefined;
    const next = i < centers.length - 1 ? centers[i + 1] : undefined;
    if (prev !== undefined) {
      half = Math.min(half, (cx - prev - COLUMN_MIN_GAP_PX) / 2);
    }
    if (next !== undefined) {
      half = Math.min(half, (next - cx - COLUMN_MIN_GAP_PX) / 2);
    }
    return Math.max(0, half);
  });
}

// ---------------------------------------------------------------------------
// Generic notch item type
// ---------------------------------------------------------------------------

/**
 * Minimum shape a collected event must expose for `renderNotchPass` to group,
 * sort, and render it. Each layer maps its own richer event type to this shape
 * before calling the pass.
 */
export interface NotchItem {
  /** Stable per-event identifier (e.g. `research:ov:3` or `timeline:l:7`). */
  eventId: string;
  /** Bar index in the bars array — used as the cluster key. */
  barIdx: number;
  /** Projected center-x pixel for the bar (CSS px). */
  cx: number;
  /**
   * Color for a single-member cluster. Multi-member clusters use the spine ink
   * (no single overlay's color implies ownership of the stack).
   */
  color: string;
}

// ---------------------------------------------------------------------------
// Memoisation cache for cluster grouping + geometry
// ---------------------------------------------------------------------------

interface MemoKey {
  items: readonly NotchItem[];
  layoutX: number;
  layoutY: number;
  layoutW: number;
  layoutH: number;
}

interface MemoValue {
  groups: NotchItem[][];
  centers: number[];
  halfWidths: number[];
}

let _memoKey: MemoKey | null = null;
let _memoValue: MemoValue | null = null;

/**
 * Compute cluster groups + column geometry, memoised on the items array
 * identity and layout dimensions. When the caller passes the same inputs as
 * last frame the result is reused without rebuilding the Map, sorting, or
 * recalculating widths — which is the common case during animation.
 *
 * The notch DRAW still runs every frame; only grouping and geometry are cached.
 */
function computeClusters(items: readonly NotchItem[], rc: RenderContext): MemoValue {
  const { layout } = rc;
  // Shallow identity check: same array ref + same layout dimensions → hit.
  if (
    _memoKey !== null &&
    _memoValue !== null &&
    _memoKey.items === items &&
    _memoKey.layoutX === layout.x &&
    _memoKey.layoutY === layout.y &&
    _memoKey.layoutW === layout.w &&
    _memoKey.layoutH === layout.h
  ) {
    return _memoValue;
  }

  // Build cluster map, sort left-to-right, compute column widths.
  const clusterMap = new Map<number, NotchItem[]>();
  for (const item of items) {
    const arr = clusterMap.get(item.barIdx);
    if (arr) arr.push(item);
    else clusterMap.set(item.barIdx, [item]);
  }

  const groups = [...clusterMap.values()].sort((a, b) => a[0]!.cx - b[0]!.cx);
  const centers = groups.map((g) => g[0]!.cx);
  const halfWidths = columnHalfWidths(centers);

  const result: MemoValue = { groups, centers: centers, halfWidths };
  _memoKey = { items, layoutX: layout.x, layoutY: layout.y, layoutW: layout.w, layoutH: layout.h };
  _memoValue = result;
  return result;
}

// ---------------------------------------------------------------------------
// Generic notch render pass
// ---------------------------------------------------------------------------

/**
 * Callbacks that differ between GenericResearchLayer and TimelineEventsLayer.
 * The caller provides these to parameterise the shared loop without altering
 * the hit-region shape model or the draw vocabulary.
 */
export interface NotchPassCallbacks<T extends NotchItem> {
  /**
   * HitRegion kind to stamp on every column region pushed in this pass.
   *   - GenericResearchLayer → `'research'`
   *   - TimelineEventsLayer  → `'timelinePin'`
   */
  hitKind: HitRegionKind;
  /**
   * Build the payload for the column HitRegion from the cluster group and the
   * computed notch center x. The payload is opaque to the substrate; the info
   * panel reads it.
   *
   * @param group     — all items in the cluster, order-preserving from the
   *                    input collected array.
   * @param cxCenter  — center x of the notch tab (CSS px); stamped separately
   *                    on the payload (not derivable from the column x..x2
   *                    because x is the column LEFT edge, not the notch center).
   * @param paneIndex — pane the spine belongs to (S4 seam).
   */
  buildPayload: (group: T[], cxCenter: number, paneIndex: number) => unknown;
}

/**
 * Clustered dispatch-notch pass. Groups all collected events by projected bar
 * index (coincident = same bar → same pixel x), renders ONE notch per group
 * with a count badge when N > 1, draws the dispatch spine once, and pushes
 * one full-pane-height COLUMN HitRegion per cluster.
 *
 * This is identical geometry for both layers — what differs is the HitRegion
 * `kind` and the payload shape, supplied via `callbacks`.
 *
 * @param ctx        — 2D canvas context (already in the right save state)
 * @param rc         — render context (layout, hitRegions, ...)
 * @param items      — collected events for this pass (any subtype of NotchItem)
 * @param paneIndex  — pane the spine rides on (S4 seam; 0 for the main pane)
 * @param callbacks  — per-layer discriminators (kind + payload builder)
 */
export function renderNotchPass<T extends NotchItem>(
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  items: readonly T[],
  paneIndex: number,
  callbacks: NotchPassCallbacks<T>,
): void {
  if (!items.length) return;
  const { layout } = rc;
  const tk = resolveNotchTokens();

  // Spine hairline — once per pane, riding the BOTTOM edge above the time axis.
  drawDispatchSpine(ctx, layout.x, layout.y, layout.w, layout.h, tk.spine);

  // Cluster grouping + geometry (memoised — reused when inputs are unchanged).
  const { groups, halfWidths } = computeClusters(items, rc);
  const hoveredId = hoveredClusterFirstId();

  ctx.save();
  ctx.font = GLYPH_LABEL_FONT;
  groups.forEach((group, gi) => {
    const typedGroup = group as T[];
    const first = typedGroup[0]!;
    const count = typedGroup.length;
    const isHovered = hoveredId !== null && first.eventId === hoveredId;

    // Hover affordance: a faint full-height guide line at the event x makes
    // the invisible column discoverable. Drawn UNDER the notch.
    if (isHovered) {
      drawHoverGuideLine(ctx, first.cx, layout.y, layout.h, tk.accent);
    }

    // Single member uses its own color; a multi-event cluster uses the spine
    // ink so no single overlay's color implies ownership of the stack.
    const baseColor = count === 1 ? first.color : tk.spine;
    const anchor = drawTimelineGlyph(
      ctx,
      'notch',
      { cx: first.cx, layout },
      baseColor,
      undefined,
      isHovered,
      count,
      tk.accent,
      tk.badgeBg,
      tk.badgeInk,
    );

    // Click target: tall full-pane-height COLUMN at the event x (±half-width,
    // neighbour-capped) so a click anywhere vertically at that timestamp
    // resolves the hit — no vertical travel, no precision required.
    const cxCenter = anchor.x + NOTCH_W / 2;
    const half = halfWidths[gi]!;
    rc.hitRegions?.push({
      x: cxCenter - half,
      y: layout.y,
      x2: cxCenter + half,
      y2: layout.y + layout.h,
      shape: 'column',
      kind: callbacks.hitKind,
      payload: callbacks.buildPayload(typedGroup, cxCenter, paneIndex),
    });
  });
  ctx.restore();
}
