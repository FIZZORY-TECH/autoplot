/**
 * src/panels/PanelHeader.tsx — the ONE canonical docked-panel header.
 *
 * Today the six dock panels (watchlist, portfolio, indicator, settings,
 * strategy-artifact, terminal) each render their own in-drawer header three
 * different ways: AssetPanel/PortfolioPanel hand-roll inline styles, Indicator
 * hardcodes its own rgba + `.x-btn`, Settings borrows `.ag-head*`, and the
 * artifact/terminal panels carry bespoke `.artifact-panel-head` /
 * `.terminal-panel-head` class trees. That's three eyebrow type ramps, three
 * close-button glyphs/hit-targets, and three focus treatments for what is
 * visually one element.
 *
 * This component replaces all of them with a single header the next phase wires
 * into each panel. It owns the eyebrow type ramp, the 22px close hit-target, the
 * canonical 10×10 close glyph, and the accent focus ring — all token-driven (see
 * the `.panel-head*` section in src/styles/panels.css). Panel-specific extras
 * (Terminal's "(Claude CLI)" subtitle, the artifact panel's strategy name + "rev
 * N" badge) go through the optional `children` slot, which right-aligns before
 * the close button and ellipsizes long content. No background of its own — it
 * reads as part of the DockDrawer's glass surface.
 */

import type { ReactNode } from 'react';

export interface PanelHeaderProps {
  /** The eyebrow label (mono, uppercase). e.g. "Watchlist", "Terminal". */
  label: string;
  /** Fired when the canonical close button is activated. */
  onClose: () => void;
  /** Accessible name for the close button. e.g. "Close watchlist". */
  closeLabel: string;
  /** Optional `data-testid` for the close button (per-panel Playwright hook). */
  closeTestId?: string;
  /**
   * Panel-supplied extras rendered in a right-aligned flex slot before the close
   * button — subtitle, strategy name, "rev N" badge, etc. The slot wrapper is
   * only rendered when children are present (no empty node).
   */
  children?: ReactNode;
}

export function PanelHeader({
  label,
  onClose,
  closeLabel,
  closeTestId,
  children,
}: PanelHeaderProps): React.ReactElement {
  return (
    <header className="panel-head">
      <span className="panel-head-label">{label}</span>
      {children != null && children !== false && (
        <div className="panel-head-slot">{children}</div>
      )}
      <button
        type="button"
        className="panel-head-close"
        aria-label={closeLabel}
        onClick={onClose}
        {...(closeTestId ? { 'data-testid': closeTestId } : {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2 2l6 6M8 2l-6 6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </header>
  );
}
