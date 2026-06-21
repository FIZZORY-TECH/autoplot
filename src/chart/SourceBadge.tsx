/**
 * SourceBadge — reusable pill badge for a news/event source URL.
 *
 * Renders a globe glyph + site name label. Clicking opens the URL
 * externally via the Tauri opener plugin (falls back to window.open).
 *
 * Used by: EventPopover (S6), EventFullscreenReader (S8).
 */

import React from 'react';
import '../styles/panels.css';

export interface SourceBadgeProps {
  /** Fully-qualified source URL (e.g. "https://www.federalreserve.gov/…"). */
  sourceUrl: string;
  /** Human-readable site name (e.g. "federalreserve.gov"). */
  sourceName: string;
}

/**
 * Open an external URL via the Tauri opener plugin.
 * Matches the exact pattern used in AlpacaCredentialsModal.tsx:318-329.
 */
async function openExternal(url: string): Promise<void> {
  try {
    const mod = await import('@tauri-apps/plugin-opener');
    await mod.openUrl(url);
  } catch {
    // Fallback: best-effort window.open (works in plain vite dev).
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // swallow
    }
  }
}

/** Inline globe SVG — Lucide-style, 12×12 viewport, stroke-based. */
function GlobeIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      {/* Vertical ellipse (longitude) */}
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      {/* Horizontal line (latitude) */}
      <line x1="2" y1="12" x2="22" y2="12" />
    </svg>
  );
}

export function SourceBadge({ sourceUrl, sourceName }: SourceBadgeProps): React.ReactElement | null {
  if (!sourceUrl) return null;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>): void {
    e.stopPropagation();
    void openExternal(sourceUrl);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      void openExternal(sourceUrl);
    }
  }

  return (
    <button
      type="button"
      className="source-badge"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`Open source: ${sourceName} (opens externally)`}
    >
      <GlobeIcon />
      <span className="source-badge__label">{sourceName}</span>
    </button>
  );
}
