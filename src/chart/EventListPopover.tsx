/**
 * src/chart/EventListPopover.tsx — Step S6
 *
 * A floating list popover opened by a CLICK on an event-hotspot notch (a
 * clustered dispatch-notch carrying `{ eventIds: string[] }`). It resolves each
 * id back to its full event data and renders a scrollable, keyboard-navigable
 * list — title, content preview, timestamp, source badge — with a per-row
 * expand control that seams into S8's fullscreen reader via `onExpand`.
 *
 * Relationship to OverlayInfoPanel: that panel is the HOVER readout (a single
 * row, pointer-events off). This is the CLICK interaction (the full LIST). They
 * are independent surfaces; this one mirrors OverlayInfoPanel's viewport-clamp +
 * pointer-events discipline and integrates into the SAME click→hit dispatch flow
 * (AppShell's `handleChartClick` reads the current hover hit and, when it is an
 * event hotspot, calls `openEventPopover` on `useOverlayHitStore`).
 *
 * Data resolution (S5 id scheme — REUSE the layer id-builders, never split):
 *   research:<overlayId>:<elementIndex> → useChartMutationStore.researchOverlays
 *       [overlayId].elements[elementIndex] (an EventMarkElement — full content).
 *   timeline:<layerId>:<eventIndex>      → useChartMutationStore.timelineLayers
 *       [layerId].events[eventIndex] (a TimelineEvent — DEGRADED: title+ts only).
 *
 * Edge cases (plan-mandated):
 *   - degraded timeline row → title + timestamp only (no preview/badge/expand).
 *   - loading → referenced overlay not yet in the store → skeleton row.
 *   - empty → zero resolvable ids → never opens (popover closes).
 *   - error → a referenced overlay/layer was deleted (id → undefined) → inline
 *     error message, no crash.
 *   - removed-while-open → subscribe to the store; if the source overlay/layer
 *     is removed while open, close immediately + return focus to the canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayHitStore } from '../stores/useOverlayHitStore';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import { useReducedMotion } from '../lib/reducedMotion';
import { eventMarkId } from './layers/GenericResearchLayer';
import { timelineEventId } from './layers/TimelineEventsLayer';
import { SourceBadge } from './SourceBadge';
import type { EventMarkElement } from '../ai/schemas';
import type { TimelineEvent } from '../stores/useChartMutationStore';
import { fmtTs } from './chartTimeFormat';

// ---------------------------------------------------------------------------
// Resolved-event model — the discriminated shape each row renders from, and the
// exact payload handed to `onExpand` for S8.
// ---------------------------------------------------------------------------

/** A fully-resolved research `event_mark` (carries content + optional source). */
export interface ResolvedResearchEvent {
  source: 'research';
  /** Stable id (research:<overlayId>:<elementIndex>) — also the row React key. */
  id: string;
  overlayId: string;
  elementIndex: number;
  label: string;
  ts: number;
  content?: string;
  sourceUrl?: string;
  sourceName?: string;
  color?: string;
}

/** A DEGRADED timeline event — title + timestamp only (no content/source). */
export interface ResolvedTimelineEvent {
  source: 'timeline';
  id: string;
  layerId: string;
  eventIndex: number;
  label: string;
  ts: number;
  color?: string;
}

/** An id that referenced a now-deleted overlay/layer or out-of-range element. */
export interface UnresolvedEvent {
  source: 'error';
  id: string;
}

export type ResolvedEvent =
  | ResolvedResearchEvent
  | ResolvedTimelineEvent
  | UnresolvedEvent;

/**
 * The event-data shape S8 receives via `onExpand`. Only resolvable events with
 * content expose an expand control, so `onExpand` is only ever called with a
 * research event that has `content` — but the union is exported in full so S8
 * can type its handler against the same model.
 */
export type ExpandableEvent = ResolvedResearchEvent;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EventListPopoverProps {
  /** Plot-area layout (CSS px) — clamps the card to the plot, like OverlayInfoPanel. */
  layout: { x: number; y: number; w: number; h: number };
  /** Chart-wrap width (CSS px) for horizontal clamping. */
  wrapW: number;
  /** Chart-wrap canvas element — focus returns here on Esc / removed-while-open. */
  canvasFocusEl?: HTMLElement | null;
  /**
   * S9 — optional focus-return override. When provided, called on Esc / removed-
   * while-open instead of falling back to `canvasFocusEl`. Enables
   * `ChartHotspotFocusOverlay` to return focus to the originating notch button
   * rather than the chart canvas.
   */
  onReturnFocus?: () => void;
  /**
   * S8 seam: open the fullscreen reader for an event. Called with the full
   * resolved research event (always has `content` — expand is gated on it).
   */
  onExpand?: (event: ExpandableEvent) => void;
}

const POPOVER_W = 280;
const ESTIMATED_ROW_H = 64;
const MAX_VISIBLE_ROWS = 6;
const EDGE_PAD = 8;

/** Clamp the popover left so it stays inside the chart-wrap (mirrors OverlayInfoPanel). */
function clampLeft(left: number, wrapW: number): number {
  return Math.max(EDGE_PAD, Math.min(wrapW - POPOVER_W - EDGE_PAD, left));
}


// ---------------------------------------------------------------------------
// Resolution — id → full event data, ordered newest-first.
//
// Pure so it is unit-testable. `loading` is returned when EVERY id references a
// research overlay absent from the store (store not yet hydrated for it); a
// per-id miss on a present-but-shrunken overlay is an `error` row instead.
// ---------------------------------------------------------------------------

interface ResolveResult {
  events: ResolvedEvent[];
  /** True when no overlay/layer for ANY id is present yet (hydration pending). */
  loading: boolean;
}

export function resolveEventIds(
  eventIds: readonly string[],
  researchOverlays: Record<string, { elements: unknown[] } | undefined>,
  timelineLayers: Record<string, { events: unknown[] } | undefined>,
): ResolveResult {
  const events: ResolvedEvent[] = [];
  let anySourcePresent = false;

  for (const id of eventIds) {
    if (id.startsWith('research:')) {
      // research:<overlayId>:<elementIndex> — overlayId may itself contain ':'
      // is NOT expected (ids minted by eventMarkId use a plain overlay id), so
      // parse from the ends: prefix + trailing numeric index.
      const lastColon = id.lastIndexOf(':');
      const overlayId = id.slice('research:'.length, lastColon);
      const elementIndex = Number(id.slice(lastColon + 1));
      // Guard the parse against the canonical builder (the format authority),
      // so we never diverge from `eventMarkId` if its scheme ever changes.
      if (eventMarkId(overlayId, elementIndex) !== id) {
        events.push({ source: 'error', id });
        continue;
      }
      const overlay = researchOverlays[overlayId];
      if (!overlay) {
        // Overlay not present — could be pre-hydration (loading) or deleted
        // (error). We classify at the aggregate level below.
        events.push({ source: 'error', id });
        continue;
      }
      anySourcePresent = true;
      const el = overlay.elements[elementIndex] as EventMarkElement | undefined;
      if (!el || el.type !== 'event_mark') {
        events.push({ source: 'error', id });
        continue;
      }
      events.push({
        source: 'research',
        id,
        overlayId,
        elementIndex,
        label: el.label,
        ts: el.ts,
        content: el.content,
        sourceUrl: el.source_url,
        sourceName: el.source_name,
        color: el.color,
      });
    } else if (id.startsWith('timeline:')) {
      const lastColon = id.lastIndexOf(':');
      const layerId = id.slice('timeline:'.length, lastColon);
      const eventIndex = Number(id.slice(lastColon + 1));
      if (timelineEventId(layerId, eventIndex) !== id) {
        events.push({ source: 'error', id });
        continue;
      }
      const layer = timelineLayers[layerId];
      if (!layer) {
        events.push({ source: 'error', id });
        continue;
      }
      anySourcePresent = true;
      const evt = layer.events[eventIndex] as TimelineEvent | undefined;
      if (!evt) {
        events.push({ source: 'error', id });
        continue;
      }
      events.push({
        source: 'timeline',
        id,
        layerId,
        eventIndex,
        label: evt.label,
        ts: evt.ts,
        color: evt.color,
      });
    } else {
      events.push({ source: 'error', id });
    }
  }

  // Loading vs error disambiguation: if NO source is present at all AND there is
  // at least one id, treat it as hydration-pending (skeleton) rather than a hard
  // error — the overlay may still arrive. Once any source is present, missing
  // ids are genuine errors (deleted element).
  const loading = eventIds.length > 0 && !anySourcePresent;

  // Newest-first by ts. Error rows have no ts → sort them last (stable).
  const tsOf = (e: ResolvedEvent): number =>
    e.source === 'error' ? Number.NEGATIVE_INFINITY : e.ts;
  events.sort((a, b) => tsOf(b) - tsOf(a));

  return { events, loading };
}

// ---------------------------------------------------------------------------
// Removed-while-open guard — does the store still contain every source the open
// popover depends on? When a source disappears, the popover must close.
// ---------------------------------------------------------------------------

function sourcesStillPresent(
  eventIds: readonly string[],
  researchOverlays: Record<string, unknown>,
  timelineLayers: Record<string, unknown>,
): boolean {
  for (const id of eventIds) {
    if (id.startsWith('research:')) {
      const lastColon = id.lastIndexOf(':');
      const overlayId = id.slice('research:'.length, lastColon);
      if (!researchOverlays[overlayId]) return false;
    } else if (id.startsWith('timeline:')) {
      const lastColon = id.lastIndexOf(':');
      const layerId = id.slice('timeline:'.length, lastColon);
      if (!timelineLayers[layerId]) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventListPopover({
  layout,
  wrapW,
  canvasFocusEl,
  onReturnFocus,
  onExpand,
}: EventListPopoverProps): JSX.Element | null {
  const request = useOverlayHitStore((s) => s.eventPopover);
  const close = useOverlayHitStore((s) => s.closeEventPopover);

  const researchOverlays = useChartMutationStore((s) => s.researchOverlays);
  const timelineLayers = useChartMutationStore((s) => s.timelineLayers);

  const reduced = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Resolve the request's ids → full event data (newest-first). Recomputes when
  // the store slices change so a removal/edit is reflected live.
  const { events, loading } = useMemo(() => {
    if (!request) return { events: [] as ResolvedEvent[], loading: false };
    return resolveEventIds(request.eventIds, researchOverlays, timelineLayers);
  }, [request, researchOverlays, timelineLayers]);

  // S9 — stable focus-return callback. Calls `onReturnFocus` when provided by
  // ChartHotspotFocusOverlay (returns focus to the originating notch button),
  // otherwise falls back to the chart canvas element. Wrapped in useCallback so
  // the identity is stable across renders and safe to use as an effect dep.
  const returnFocus = useCallback((): void => {
    if (onReturnFocus) {
      onReturnFocus();
    } else {
      canvasFocusEl?.focus();
    }
  }, [onReturnFocus, canvasFocusEl]);

  // Removed-while-open: if any referenced source vanished from the store, close
  // immediately and return focus (stale ids never render).
  useEffect(() => {
    if (!request) return;
    if (!sourcesStillPresent(request.eventIds, researchOverlays, timelineLayers)) {
      close();
      returnFocus();
    }
  }, [request, researchOverlays, timelineLayers, close, returnFocus]);

  // Empty: a request that resolves to zero events (and is not loading) closes.
  useEffect(() => {
    if (request && !loading && events.length === 0) {
      close();
    }
  }, [request, loading, events.length, close]);

  // Reset selection + focus the list when a new request opens.
  useEffect(() => {
    if (!request) return;
    setSelectedIdx(0);
    // Focus after paint so the listbox can receive arrow keys immediately.
    const t = window.setTimeout(() => listRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [request]);

  // Esc closes + returns focus to the originating button (or canvas fallback);
  // arrow keys move selection; Enter opens the reader for the selected row.
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        returnFocus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(events.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        const ev = events[selectedIdx];
        if (ev && ev.source === 'research' && ev.content && onExpand) {
          e.preventDefault();
          onExpand(ev);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, events, selectedIdx, close, returnFocus, onExpand]);

  // Dismiss on outside click (mirror OverlayInfoPanel's click-elsewhere unpin).
  useEffect(() => {
    if (!request) return;
    const onDown = (e: PointerEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        close();
      }
    };
    // Defer binding to the next tick so the opening click doesn't immediately
    // close the popover.
    const t = window.setTimeout(() => {
      window.addEventListener('pointerdown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [request, close]);

  if (!request) return null;
  // Empty/closed-pending: render nothing (the effect above will close it).
  if (!loading && events.length === 0) return null;

  // Anchor near the notch; clamp to the plot/wrap. Flip above when near the
  // bottom (mirror OverlayInfoPanel's flip logic).
  const rowCount = loading ? 1 : events.length;
  const estimatedH = Math.min(rowCount, MAX_VISIBLE_ROWS) * ESTIMATED_ROW_H + 8;
  const left = clampLeft(request.anchorX + 14, wrapW);
  const flipUp = request.anchorY + estimatedH + 16 > layout.y + layout.h;
  const top = flipUp
    ? Math.max(layout.y + 4, request.anchorY - estimatedH - 14)
    : Math.min(layout.y + layout.h - estimatedH - 4, request.anchorY + 14);

  return (
    <div
      ref={cardRef}
      className={reduced ? 'event-popover' : 'event-popover popover-enter'}
      style={{
        position: 'absolute',
        left,
        top,
        width: POPOVER_W,
        maxHeight: MAX_VISIBLE_ROWS * ESTIMATED_ROW_H,
        zIndex: 'var(--z-popover)',
      }}
    >
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Events at this point"
        tabIndex={0}
        className="event-popover-list"
      >
        {loading ? (
          <li className="event-popover-row event-popover-skeleton" aria-busy="true">
            <div className="event-popover-skel-line" style={{ width: '60%' }} />
            <div className="event-popover-skel-line" style={{ width: '38%' }} />
          </li>
        ) : (
          events.map((ev, i) => (
            <EventRow
              key={ev.id}
              event={ev}
              selected={i === selectedIdx}
              onSelect={() => setSelectedIdx(i)}
              onExpand={onExpand}
            />
          ))
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function EventRow({
  event,
  selected,
  onSelect,
  onExpand,
}: {
  event: ResolvedEvent;
  selected: boolean;
  onSelect: () => void;
  onExpand?: (event: ExpandableEvent) => void;
}): JSX.Element {
  // Error row — a referenced overlay/layer was deleted. Inline message, no crash.
  if (event.source === 'error') {
    return (
      <li role="option" aria-selected={false} className="event-popover-row event-popover-error">
        <span className="event-popover-error-text">Event no longer available</span>
      </li>
    );
  }

  // Degraded timeline row — title + timestamp ONLY. Branch-excluded: no preview,
  // no badge, no expand (TimelineEvent carries no content/source).
  if (event.source === 'timeline') {
    return (
      <li
        role="option"
        aria-selected={selected}
        className={`event-popover-row${selected ? ' is-selected' : ''}`}
        onMouseEnter={onSelect}
        onClick={onSelect}
      >
        <div className="event-popover-row-main">
          <span className="event-popover-title">{event.label || '(unlabeled)'}</span>
          <span className="event-popover-ts">{fmtTs(event.ts)}</span>
        </div>
      </li>
    );
  }

  // Research row — full content. Preview + source badge + expand when content.
  const hasContent = !!event.content;
  const preview = event.content?.trim() ?? '';
  return (
    <li
      role="option"
      aria-selected={selected}
      className={`event-popover-row${selected ? ' is-selected' : ''}`}
      onMouseEnter={onSelect}
      onClick={onSelect}
    >
      <div className="event-popover-row-main">
        <div className="event-popover-row-head">
          <span className="event-popover-title">{event.label || '(unlabeled)'}</span>
          {hasContent && onExpand && (
            <button
              type="button"
              className="event-popover-expand"
              aria-label={`Open “${event.label}” in reader`}
              onClick={(e) => {
                e.stopPropagation();
                onExpand(event);
              }}
            >
              {/* Expand glyph — corners-out (Lucide maximize-2 style). */}
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
        </div>
        {hasContent && <p className="event-popover-preview">{preview}</p>}
        <span className="event-popover-ts">{fmtTs(event.ts)}</span>
        {event.sourceUrl && (
          <div className="event-popover-source">
            <SourceBadge
              sourceUrl={event.sourceUrl}
              sourceName={event.sourceName ?? event.sourceUrl}
            />
          </div>
        )}
      </div>
    </li>
  );
}

export default EventListPopover;
