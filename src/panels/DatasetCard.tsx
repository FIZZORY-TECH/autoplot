/**
 * src/panels/DatasetCard.tsx — inline AI Research dataset card (P6 W4-B).
 *
 * Rendered inside the AgentsPanel chat thread by `Message` (in `AgentsPanel.tsx`)
 * for `kind === 'research-result'` messages. Bound token-for-token to the
 * prototype `app-design/project/agents.jsx` (.ds-card / .ds-swatch / .ds-label /
 * .ds-meta / .ds-toggle) — see `app-design/project/app.css:1593–1624` for the
 * canonical glass treatment.
 *
 * Plot toggle is mutually exclusive across ALL dataset chips/cards — toggling a
 * new id auto-clears the prior, enforced in `useAppStore.setAiOverlayDataset`.
 *
 * The `×` clears the active overlay only — it does NOT delete from library.
 * The library-level delete lives in `LibraryDatasets.tsx::lib-rm`.
 */

import { useAppStore } from '../stores/useAppStore';
import type { PersistedDataset } from '../stores/useDatasetStore';

// W4-A integration: Dataset is now imported from the canonical W4-A schemas.ts
// via useDatasetStore's re-export. PersistedDataset extends Dataset with createdAt.

export interface DatasetCardProps {
  dataset: PersistedDataset;
  /** Color token (cyan / violet / amber / emerald / rose) — assigned silently
   *  by the caller via `colorForIndex(idx)` from `useDatasetStore`. */
  color: string;
  /** Optional click handler for the `×` clear-overlay button. Defaults to
   *  clearing the active dataset id (does NOT delete from library). */
  onClearOverlay?: () => void;
}

export function DatasetCard({
  dataset,
  color,
  onClearOverlay,
}: DatasetCardProps): JSX.Element {
  const activeId = useAppStore((s) => s.aiOverlayDatasetId);
  const setActive = useAppStore((s) => s.setAiOverlayDataset);

  const isActive = activeId === dataset.id;

  const handleTogglePlot = () => {
    // Mutual exclusion is enforced inside `setAiOverlayDataset` — passing a
    // new id auto-replaces the prior. Passing null clears.
    setActive(isActive ? null : dataset.id);
  };

  const handleClear = () => {
    if (onClearOverlay) {
      onClearOverlay();
    } else {
      // Default: clear the overlay only. Does NOT delete from library.
      setActive(null);
    }
  };

  return (
    <div
      className="ds-card"
      style={{ ['--ds-color' as string]: color } as React.CSSProperties}
    >
      <span className="ds-swatch" aria-hidden />
      <span className="ds-label">{dataset.label}</span>
      <span className="ds-meta">
        {dataset.sym} · {dataset.tf}
      </span>
      <button
        type="button"
        className={`ds-toggle ${isActive ? 'on' : ''}`}
        onClick={handleTogglePlot}
        aria-pressed={isActive}
      >
        {isActive ? 'on chart' : 'plot'}
      </button>
      {/*
        `×` clears overlay only — never deletes from library (per master plan
        P6-12). Visible only when this card's dataset is currently plotted, so
        users always have an obvious "untoggle" path even when the card has
        scrolled past the chip stack.
      */}
      {isActive && (
        <button
          type="button"
          className="lib-rm"
          onClick={handleClear}
          aria-label="Clear overlay"
          title="Clear overlay (does not delete)"
        >
          ×
        </button>
      )}
    </div>
  );
}

export default DatasetCard;
