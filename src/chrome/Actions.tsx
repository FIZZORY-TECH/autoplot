/**
 * src/chrome/Actions.tsx — Top-right glass icon-button cluster.
 *
 * P2.1: icon-only buttons:
 *   - Command palette (sets paletteOpen=true in Zustand — P2.3 renders the palette)
 *   - Reset view      (calls onResetView prop; bound to R-key logic in AppShell)
 *
 * The `D` keyboard shortcut + the IndicatorPanel drawer are accessible via the
 * right-rail ActivityBar indicator button.
 *
 * Each button has a glass style and a tooltip with key shortcut hint.
 */

import { useRef, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';

interface ActionsProps {
  /** Callback to reset the chart view to last VISIBLE_BARS. Wired in AppShell. */
  onResetView: () => void;
}

interface TooltipState {
  text: string;
  x: number;
  y: number;
}

function ActionButton({
  icon,
  title,
  kbd,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  kbd: string;
  onClick: () => void;
}): JSX.Element {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const showTip = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTip({ text: `${title}  ${kbd}`, x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  const hideTip = () => setTip(null);

  return (
    <>
      <button
        ref={btnRef}
        onClick={onClick}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
        aria-label={`${title} (${kbd})`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 34,
          height: 34,
          borderRadius: 'var(--r-8)',
          background: 'var(--glass)',
          border: '1px solid var(--hairline)',
          color: 'var(--ink-2)',
          cursor: 'pointer',
          transition: `background var(--t-fast) var(--ease), color var(--t-fast) var(--ease)`,
          flexShrink: 0,
        }}
        onMouseDown={(e) => {
          // Ripple-style: darken on press
          (e.currentTarget as HTMLButtonElement).style.background = 'var(--glass-strong)';
        }}
        onMouseUp={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '';
        }}
      >
        {icon}
      </button>

      {/* Tooltip — portal-like fixed positioning so it can escape overflow:hidden */}
      {tip && (
        <div
          aria-hidden
          className="popover-enter"
          style={{
            position: 'fixed',
            top: tip.y,
            left: tip.x,
            transform: 'translateX(-50%)',
            zIndex: 'var(--z-popover)',
            background: 'var(--bg-2)',
            borderRadius: 'var(--r-4)',
            padding: '3px 6px',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-mono-sm)',
            color: 'var(--ink-1)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: '0 4px 16px -4px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06) inset',
          }}
        >
          {tip.text}
        </div>
      )}
    </>
  );
}

export function Actions({ onResetView }: ActionsProps): JSX.Element {
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  return (
    <div
      style={{
        position: 'absolute',
        top: 'var(--sp-16)',
        right: 'var(--sp-22)',
        zIndex: 'var(--z-chart-panel)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-6)',
        // Pointer events on (buttons are clickable).
      }}
    >
      {/* Reset view */}
      <ActionButton
        title="Reset view"
        kbd="R"
        onClick={onResetView}
        icon={
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M3 9a6 6 0 1 0 1.8-4.3"/>
            <path d="M3 3v3.5h3.5"/>
          </svg>
        }
      />

      {/* Command palette */}
      <ActionButton
        title="Search"
        kbd="⌘K"
        onClick={() => setPaletteOpen(true)}
        icon={
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="8" cy="8" r="5"/>
            <path d="M15 15l-3-3"/>
          </svg>
        }
      />
    </div>
  );
}

export default Actions;
