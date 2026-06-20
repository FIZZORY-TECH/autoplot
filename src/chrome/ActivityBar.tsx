/**
 * src/chrome/ActivityBar.tsx — VS Code-style activity rail.
 *
 * Rendered once per side: `<ActivityBar side="left" />` / `<ActivityBar side="right" />`.
 * Each rail is a fixed, full-height (between the top/bottom chrome strips) strip
 * pinned to its window edge, hosting one icon button per drawer assigned to that side
 * (see useDockStore.SIDE). Clicking an icon toggles its drawer via
 * `useDockStore.toggle(id)`; the active (open) drawer's icon reuses `.dock-btn.active`
 * (glow/box-shadow only — never a solid border, Design Principle 04) and reflects
 * `aria-pressed`.
 *
 * REV2.1 CONDITIONAL SURFACE: the rail is fully transparent when its side has no
 * open drawer, and takes a glass backing (--glass + blur) when a drawer IS open —
 * so rail + drawer merge into one docked surface. No hairline divider in either state.
 *
 * REV2 LEFT RAIL: left rail renders ONLY the Watchlist button. Strategy is still
 * reachable via the MCP bridge (openDrawer('strategy')); its toggle just has no
 * rail button.
 *
 * The SVGs for terminal/portfolio/settings are lifted verbatim from the now-deleted
 * floating action buttons. watchlist/strategy/indicator use new inline SVGs in the
 * same stroke language (currentColor, viewBox 0 0 24 24, strokeWidth 1.6).
 *
 * A11y: each rail is a vertical toolbar (`role="toolbar"`,
 * `aria-orientation="vertical"`) implementing the standard roving-tabindex pattern —
 * one button tabbable at a time; ArrowUp/ArrowDown move focus among the rail's
 * buttons (Home/End jump to ends).
 */

import React, { useRef, useState } from 'react';
import { useDockStore } from '../stores/useDockStore';
import type { DrawerId, DockSide } from '../stores/useDockStore';
import { RESERVE_TOP, RESERVE_BOTTOM } from '../lib/layout';

// Rail tier: at/above the drawer tier (DockDrawer DRAWER_Z=34) so the rail stays
// clickable beside an open drawer.
const RAIL_Z = 'var(--z-rail)';

// Ordered icon lists per side (mirrors useDockStore.SIDE; the order here is the
// rail's visual + roving-focus order).
// Watchlist has moved to the right rail; Strategy is MCP-bridge-only (no toggle button).
// Left rail is no longer used — return [] so any residual left-rail mount renders nothing.
const RIGHT_ORDER: DrawerId[] = ['watchlist', 'research', 'terminal', 'portfolio', 'indicator', 'settings'];

// Human label + optional keyboard hint per drawer.
const META: Record<DrawerId, { label: string; kbd?: string }> = {
  watchlist: { label: 'Watchlist' },
  research: { label: 'Research Library' },
  strategy: { label: 'Strategy' },
  terminal: { label: 'Terminal', kbd: '⌘`' },
  portfolio: { label: 'Portfolio', kbd: '⌘P' },
  indicator: { label: 'Indicators', kbd: 'D' },
  settings: { label: 'Settings', kbd: '⌘,' },
};

// ---------------------------------------------------------------------------
// Icons — terminal/portfolio/settings lifted verbatim from the deleted FABs;
// watchlist/strategy/indicator are new, in the same stroke language.
// ---------------------------------------------------------------------------

const SVG_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function WatchlistIcon(): JSX.Element {
  // List/rows glyph — a watchlist of symbols.
  return (
    <svg {...SVG_PROPS}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function ResearchIcon(): JSX.Element {
  // Layered-stack glyph — saved research (overlays + datasets) library.
  return (
    <svg {...SVG_PROPS}>
      <rect x="3" y="3" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="17" width="18" height="4" rx="1" />
    </svg>
  );
}

function StrategyIcon(): JSX.Element {
  // Code-brackets glyph — a strategy script.
  return (
    <svg {...SVG_PROPS}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function TerminalIcon(): JSX.Element {
  // Lifted verbatim from the deleted terminal FAB — chevron + underscore prompt glyph.
  return (
    <svg {...SVG_PROPS}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function PortfolioIcon(): JSX.Element {
  // Lifted verbatim from the deleted portfolio FAB — briefcase / portfolio glyph.
  return (
    <svg {...SVG_PROPS}>
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <line x1="12" y1="12" x2="12" y2="12.01" />
    </svg>
  );
}

function IndicatorIcon(): JSX.Element {
  // Line-chart glyph — overlays/indicators on the chart.
  return (
    <svg {...SVG_PROPS}>
      <path d="M3 3v18h18" />
      <polyline points="7 14 11 9 14 12 19 6" />
    </svg>
  );
}

function SettingsIcon(): JSX.Element {
  // Lifted verbatim from the deleted settings FAB — gear glyph.
  return (
    <svg {...SVG_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const ICONS: Record<DrawerId, () => JSX.Element> = {
  watchlist: WatchlistIcon,
  research: ResearchIcon,
  strategy: StrategyIcon,
  terminal: TerminalIcon,
  portfolio: PortfolioIcon,
  indicator: IndicatorIcon,
  settings: SettingsIcon,
};

export interface ActivityBarProps {
  side: DockSide;
}

export function ActivityBar({ side }: ActivityBarProps): JSX.Element {
  // Left rail is no longer used (Step 2 removes the mount); return [] defensively.
  const ids = side === 'left' ? [] : RIGHT_ORDER;
  // Open drawer for THIS side — drives `aria-pressed` / `.active`.
  const openId = useDockStore((s) => (side === 'left' ? s.openLeft : s.openRight));

  // Roving tabindex — index of the currently-tabbable button. Defaults to the
  // first; moves with the focus so Tab always lands on the last-focused button.
  const [rovingIdx, setRovingIdx] = useState(0);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusAt = (idx: number) => {
    const clamped = ((idx % ids.length) + ids.length) % ids.length;
    setRovingIdx(clamped);
    btnRefs.current[clamped]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusAt(idx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusAt(idx - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(ids.length - 1);
        break;
      default:
        break;
    }
  };

  const edge = side === 'left' ? { left: 0 } : { right: 0 };

  // REV2.1: rail is transparent when idle; takes a glass surface (the
  // `activity-bar--docked` modifier) when its side's drawer is open so rail +
  // drawer merge into one docked surface. No dividers.
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Left dock' : 'Right dock'}
      className={openId !== null ? 'activity-bar activity-bar--docked' : 'activity-bar'}
      style={{
        position: 'fixed',
        top: RESERVE_TOP,
        bottom: RESERVE_BOTTOM,
        ...edge,
        width: 'var(--rail-w)',
        zIndex: RAIL_Z,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--sp-6)',
        // --sp-12 = 12px (tokens.css); the old --sp-10 didn't exist and resolved to 0.
        paddingTop: 'var(--sp-12)',
        // Icons never clip at the 600px min height.
        overflowY: 'auto',
      }}
    >
      {ids.map((id, idx) => {
        const open = openId === id;
        const { label, kbd } = META[id];
        const Icon = ICONS[id];
        return (
          <button
            key={id}
            type="button"
            ref={(el) => {
              btnRefs.current[idx] = el;
            }}
            className={`dock-btn${open ? ' active' : ''}`}
            aria-label={label}
            aria-pressed={open}
            title={kbd ? `${label} (${kbd})` : label}
            tabIndex={idx === rovingIdx ? 0 : -1}
            onFocus={() => setRovingIdx(idx)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            onClick={() => useDockStore.getState().toggle(id)}
          >
            <Icon />
            <span className="glabel glabel--rail">
              {label}
              {kbd ? `  ${kbd}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default ActivityBar;
