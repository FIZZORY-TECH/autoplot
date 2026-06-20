/**
 * src/chrome/Dock.tsx — Static vertical toolbar bar pinned to the LEFT edge,
 * with per-group click-to-toggle flyouts.
 *
 * The toolbar root is TRANSPARENT (no glass fill, no blur, no shadow) — it is
 * an invisible gutter. Individual orbs carry all surface treatment.
 *
 * Each of the three groups (chart-type, timeframe, drawing-tools) ALWAYS shows
 * ONLY its currently-selected item as a single always-visible orb
 * (.dock-btn.active). CLICKING the orb TOGGLES that group's flyout open/closed.
 * Only ONE group can be open at a time — opening a new group closes the previous.
 *
 * `.dock-group--collapsible` is the per-group cell; `.dock-group__flyout` is the
 * reveal container. CSS (motion.css) reveals via `.dock-group--open` ONLY —
 * there is NO :hover or :focus-within CSS reveal; the flyout is purely
 * click-driven on all devices. Collapsed flyout siblings are visibility:hidden,
 * which removes them from the keyboard Tab order until the group is open.
 *
 * Keyboard a11y: the orb is a <button aria-haspopup="true" aria-expanded>.
 * Enter/Space (native button activation) toggle it open. Esc closes + restores
 * focus to the orb. focusout (focus leaving the group entirely) closes. The
 * `:focus-visible` ring is preserved.
 *
 * Three logical sections stack vertically, separated by hairline dividers:
 *  1. Chart-type (6): candles / heikin / bars / line / area / mountain
 *  2. Timeframe (4-tier — USER-LOCKED): 1h / 4h / 1d / 1w  (DO NOT add 5m or 15m)
 *  3. Tools (4): Scope range / Price mark / Comment / Trend line
 *
 * Tooltips use .glabel--top (top-centered with downward caret) so they rise
 * ABOVE the hovered element and never overlap the rightward flyout modal.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ChartType } from '../chart/ChartCanvas';
import { useAppStore } from '../stores/useAppStore';
import type { ActiveTool } from '../stores/useAppStore';
import type { Tf } from '../data/MarketDataProvider';
import { RESERVE_TOP, RESERVE_BOTTOM } from '../lib/layout';

// ---------------------------------------------------------------------------
// Item descriptors. Each group is a flat list of { id, label, icon }; the group
// renders the selected id as the always-visible orb and the rest in the flyout.
// ---------------------------------------------------------------------------

interface DockItem<T extends string> {
  id: T;
  label: string;
  icon: JSX.Element;
}

// Timeframe — 4-tier ONLY. DO NOT add 5m or 15m (hard requirement per G-4 / A3).
// Mono labels are rendered via `.dock-btn--tf` (Geist Mono) — same orb chrome.
const TF_ITEMS: DockItem<Tf>[] = [
  { id: '1h', label: '1h', icon: <span className="dock-tf-label">1h</span> },
  { id: '4h', label: '4h', icon: <span className="dock-tf-label">4h</span> },
  { id: '1d', label: '1d', icon: <span className="dock-tf-label">1d</span> },
  { id: '1w', label: '1w', icon: <span className="dock-tf-label">1w</span> },
];

const CHART_TYPE_ITEMS: DockItem<ChartType>[] = [
  {
    id: 'candles',
    label: 'Candles',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <line x1="5" y1="2" x2="5" y2="14" stroke="currentColor" strokeWidth="1.6" />
        <rect x="3" y="5" width="4" height="6" fill="currentColor" />
        <line x1="11" y1="3" x2="11" y2="13" stroke="currentColor" strokeWidth="1.6" />
        <rect x="9" y="6" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    id: 'heikin',
    label: 'Heikin Ashi',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <line x1="4" y1="3" x2="4" y2="13" stroke="currentColor" strokeWidth="1.6" />
        <rect x="2.5" y="5" width="3" height="6" fill="currentColor" />
        <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.6" />
        <rect x="6.5" y="4" width="3" height="7" fill="currentColor" />
        <line x1="12" y1="3" x2="12" y2="13" stroke="currentColor" strokeWidth="1.6" />
        <rect x="10.5" y="3.5" width="3" height="6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'bars',
    label: 'OHLC Bars',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <line x1="4" y1="3" x2="4" y2="12" />
        <line x1="2.5" y1="5" x2="4" y2="5" />
        <line x1="4" y1="10" x2="5.5" y2="10" />
        <line x1="11" y1="2" x2="11" y2="13" />
        <line x1="9.5" y1="4" x2="11" y2="4" />
        <line x1="11" y1="11" x2="12.5" y2="11" />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'Line',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2 11l3-4 3 2 3-5 3 3" />
      </svg>
    ),
  },
  {
    id: 'area',
    label: 'Area',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M2 11l3-4 3 2 3-5 3 3v6H2z" fill="currentColor" fillOpacity="0.2" />
        <path d="M2 11l3-4 3 2 3-5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'mountain',
    label: 'Pulse',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <line x1="3" y1="11" x2="3" y2="9" />
        <line x1="5" y1="11" x2="5" y2="6" />
        <line x1="7" y1="11" x2="7" y2="8" />
        <line x1="9" y1="11" x2="9" y2="4" />
        <line x1="11" y1="11" x2="11" y2="7" />
        <line x1="13" y1="11" x2="13" y2="9" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Tool icon helpers
// ---------------------------------------------------------------------------
function MarkIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M2 8h6" /><path d="M11 8h3" />
      <circle cx="9.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function CommentIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
      <path d="M3 4h10v6H7l-3 2.5V10H3z" />
    </svg>
  );
}
function RangeScopeIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M3 4v8M13 4v8M3 8h10" />
    </svg>
  );
}
function TrendIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <line
        x1="2"
        y1="14"
        x2="14"
        y2="2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
// Neutral fallback glyph for the tools group when activeTool === 'none' — a
// small toolbox/pen-nib so the always-visible cell is never blank.
function ToolsGlyphIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 2.5l2.5 2.5-7 7-3 .5.5-3z" />
      <path d="M9.5 4l2.5 2.5" />
    </svg>
  );
}

// Tools group is keyed by ActiveTool; the always-visible orb shows the active
// tool (or the neutral glyph when 'none').
const TOOL_ITEMS: DockItem<ActiveTool>[] = [
  { id: 'rangeScope', label: 'Scope range', icon: <RangeScopeIcon /> },
  { id: 'mark', label: 'Price mark', icon: <MarkIcon /> },
  { id: 'comment', label: 'Comment', icon: <CommentIcon /> },
  { id: 'trend', label: 'Trend line', icon: <TrendIcon /> },
];

// Keyboard-shortcut hints relocated into the drawing-tools flyout footer (Step
// 4). Rendered after a hairline divider inside the tools flyout only.
const SHORTCUT_HINTS: { key: string; label: string }[] = [
  { key: 'M', label: 'mark' },
  { key: 'C', label: 'comment' },
  { key: 'S', label: 'range' },
  { key: 'T', label: 'trend' },
  { key: 'Esc', label: 'cancel' },
];

// ---------------------------------------------------------------------------
// DockGroup — the uniform per-group collapsible cell. Renders the selected
// item's always-visible orb plus a right-flying flyout holding the OTHER items.
//
// `selectedId` selects which item is the always-visible orb. When it does not
// match any item id (e.g. the tools group with 'none'), `fallbackOrb` is shown
// in the cell and the flyout lists ALL items.
// ---------------------------------------------------------------------------

interface DockGroupProps<T extends string> {
  /** Group machine name — used for aria-labels and the flyout footer slot. */
  name: string;
  /** Human-facing group label (aria). */
  ariaLabel: string;
  /** All items in the group. */
  items: DockItem<T>[];
  /** The currently-selected item id (may not match any item → fallback). */
  selectedId: T | null;
  /** Selection handler. */
  onSelect: (id: T) => void;
  /** Orb glyph shown when no item is selected. Never renders a blank cell. */
  fallbackOrb: JSX.Element;
  /** Optional footer rendered at the bottom of the flyout (shortcut hints). */
  footer?: JSX.Element;
  /** Controlled open state — driven by parent (only one group open at a time). */
  open: boolean;
  /** Called when the orb is clicked to toggle this group open/closed. */
  onToggle: () => void;
  /** Called to explicitly close this group (click-away, focusout, Esc, item select). */
  onClose: () => void;
}

function DockGroup<T extends string>({
  name,
  ariaLabel,
  items,
  selectedId,
  onSelect,
  fallbackOrb,
  footer,
  open,
  onToggle,
  onClose,
}: DockGroupProps<T>): JSX.Element {
  const flyoutId = useId();
  const cellRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);

  const selected = items.find((it) => it.id === selectedId) ?? null;
  const others = selected ? items.filter((it) => it.id !== selected.id) : items;

  // Click-away: close when a pointerdown lands outside this group cell.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (cellRef.current && !cellRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose]);

  // After selecting from the flyout, close the flyout and restore focus to the
  // group's always-visible orb so keyboard users land back on the group (the
  // flyout's children become visibility:hidden again, leaving the Tab order).
  const handleSelect = useCallback(
    (id: T) => {
      onSelect(id);
      onClose();
      orbRef.current?.focus();
    },
    [onSelect, onClose],
  );

  // Esc closes the flyout and restores focus to the orb.
  // focusout (keyboard tab leaving the group entirely) also closes.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
        orbRef.current?.focus();
      }
    },
    [open, onClose],
  );

  // focusout: close if focus moves to an element outside this group cell.
  // relatedTarget is null when focus leaves the document, which also closes.
  const handleFocusOut = useCallback(
    (e: FocusEvent) => {
      if (!open) return;
      const related = e.relatedTarget as Node | null;
      if (!cellRef.current || !cellRef.current.contains(related)) {
        onClose();
      }
    },
    [open, onClose],
  );

  return (
    <div
      ref={cellRef}
      className={`dock-group--collapsible${open ? ' dock-group--open' : ''}`}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      onBlur={handleFocusOut}
    >
      {/* Always-visible selected orb (or neutral fallback glyph).
          This is the menu-button trigger: aria-haspopup + aria-expanded.
          Enter/Space (native button) toggle it; Esc/focusout close via handlers
          above. The :focus-visible ring is preserved by the .dock-btn styles.
          `.active` is applied only when this group's flyout is open — matching
          the right-rail (ActivityBar) semantics where accent/glow fires only
          when the drawer is open. At rest the orb uses --ink-2 (idle grey). */}
      <button
        ref={orbRef}
        type="button"
        className={`dock-btn dock-group__orb${open ? ' active' : ''}`}
        title={selected ? selected.label : ariaLabel}
        aria-label={selected ? selected.label : ariaLabel}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={flyoutId}
        onClick={onToggle}
      >
        {selected ? selected.icon : fallbackOrb}
        <span className="glabel glabel--top">{selected ? selected.label : ariaLabel}</span>
      </button>

      {/* Flyout — the group's OTHER items, flying right into the chart margin
           as a HORIZONTAL ROW of orbs. The outer container (column) stacks
           the orb row above the optional footer (shortcut hints).
           Revealed ONLY by .dock-group--open — no CSS :hover or :focus-within. */}
      <div id={flyoutId} className="dock-group__flyout" role="menu" aria-label={`${ariaLabel} options`}>
        {/* Orb row — horizontal strip of sibling items extending rightward. */}
        <div className="dock-group__flyout-orbs">
          {others.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className="dock-btn dock-group__flyout-item"
              title={it.label}
              aria-label={it.label}
              onClick={() => handleSelect(it.id)}
            >
              {it.icon}
              <span className="glabel glabel--top">{it.label}</span>
            </button>
          ))}
        </div>
        {footer && (
          <div className="dock-group__flyout-footer" data-group={name}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shortcut-hints footer (tools flyout only). Mono kbd chips after a hairline.
// ---------------------------------------------------------------------------
const kbdStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2px 5px',
  borderRadius: 'var(--r-4)',
  background: 'var(--glass-strong)',
  border: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-eyebrow)',
  lineHeight: 1.4,
  color: 'var(--ink-2)',
};

function ShortcutHintsFooter(): JSX.Element {
  return (
    <div className="dock-group__hints t-mono-sm" aria-hidden>
      {SHORTCUT_HINTS.map((h) => (
        <span key={h.key} className="dock-group__hint-item">
          <kbd style={kbdStyle}>{h.key}</kbd>
          <span>{h.label}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

export function Dock(): JSX.Element {
  const chartType = useAppStore((s) => s.chartType) ?? 'candles';
  const setChartType = useAppStore((s) => s.setChartType);
  const tf = useAppStore((s) => s.tf) ?? '1h';
  const setTf = useAppStore((s) => s.setTf);
  const activeTool = useAppStore((s) => s.activeTool);
  const setActiveTool = useAppStore((s) => s.setActiveTool);

  // Lifted open state — only one group flyout open at a time.
  // null = all closed; 'chart-type' | 'timeframe' | 'tools' = that group open.
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const makeToggle = useCallback(
    (name: string) => () => setOpenGroup((prev) => (prev === name ? null : name)),
    [],
  );
  const closeAllGroups = useCallback(() => setOpenGroup(null), []);

  // Tools toggle off when re-selecting the active tool, else activate.
  const handleTool = useCallback(
    (tool: ActiveTool) => {
      setActiveTool(activeTool === tool ? 'none' : tool);
    },
    [activeTool, setActiveTool],
  );

  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Chart controls"
      className="dock--toolbar"
      style={{
        position: 'fixed',
        left: 0,
        top: RESERVE_TOP,
        bottom: RESERVE_BOTTOM,
        width: 'var(--toolbar-w)',
        zIndex: 'var(--z-dock)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 'var(--sp-6)',
        paddingTop: 'var(--sp-12)',
        paddingBottom: 'var(--sp-12)',
        // Transparent — no glass fill, no blur, no shadow. The toolbar is an
        // invisible gutter; individual orbs carry all surface treatment.
        background: 'transparent',
        // Square left edge (flush to window); rounded right (chart-facing) corners.
        borderRadius: '0 var(--r-12) var(--r-12) 0',
        animation: 'dock-in 800ms var(--ease) backwards',
        userSelect: 'none',
        // overflow MUST be visible (both axes) so each group's flyout can fly
        // RIGHT out of the gutter into the chart margin. (A scroll/clip on
        // either axis computes the other to `auto`, which would clip the
        // flyout.) The collapsed bar is only 3 orbs + 2 dividers tall, so it
        // fits inside the reserved height without needing a scroll.
        overflow: 'visible',
      }}
    >
      {/* Section 1 — Chart-type. Selected orb + flyout of the other types.
          Hairline divider is rendered as a ::after pseudo-element in CSS
          (.dock-group--collapsible:not(:last-child)::after) so it stays
          out of the flex-gap math and the first-icon y aligns with the right
          rail (both start at RESERVE_TOP + --sp-12). */}
      <DockGroup<ChartType>
        name="chart-type"
        ariaLabel="Chart type"
        items={CHART_TYPE_ITEMS}
        selectedId={chartType}
        onSelect={setChartType}
        fallbackOrb={CHART_TYPE_ITEMS[0].icon}
        open={openGroup === 'chart-type'}
        onToggle={makeToggle('chart-type')}
        onClose={closeAllGroups}
      />

      {/* Section 2 — Timeframe (4-tier: 1h / 4h / 1d / 1w — USER-LOCKED).
          Same selected-orb + flyout pattern; reads/writes useAppStore.tf. */}
      <DockGroup<Tf>
        name="timeframe"
        ariaLabel="Timeframe"
        items={TF_ITEMS}
        selectedId={tf}
        onSelect={setTf}
        fallbackOrb={<span className="dock-tf-label">{tf}</span>}
        open={openGroup === 'timeframe'}
        onToggle={makeToggle('timeframe')}
        onClose={closeAllGroups}
      />

      {/* Section 3 — Tools. activeTool drives the orb; 'none' → neutral glyph.
          Selecting re-toggles via handleTool. Shortcut hints live in the
          flyout footer. */}
      <DockGroup<ActiveTool>
        name="tools"
        ariaLabel="Drawing tools"
        items={TOOL_ITEMS}
        selectedId={activeTool === 'none' ? null : activeTool}
        onSelect={handleTool}
        fallbackOrb={<ToolsGlyphIcon />}
        footer={<ShortcutHintsFooter />}
        open={openGroup === 'tools'}
        onToggle={makeToggle('tools')}
        onClose={closeAllGroups}
      />
    </div>
  );
}

export default Dock;
