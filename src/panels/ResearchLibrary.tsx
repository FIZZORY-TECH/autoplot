/**
 * src/panels/ResearchLibrary.tsx — user-facing Research Library drawer (Step 7).
 *
 * Wrapped in DockDrawer (right side, id='research', width=352). Open-state is
 * owned by useDockStore — the library is open when openRight === 'research'.
 * DockDrawer owns mount-stable motion + framing; no self-animation here.
 *
 * Two tabs (segmented control, reusing the `.settings-tabstrip` / `.settings-tab`
 * pattern):
 *   - Overlays  — saved ResearchOverlays from useResearchOverlayLibraryStore.
 *   - Datasets  — saved Datasets from useDatasetStore (DatasetCard, plot-guarded).
 *
 * Cards reuse the `.ds-card` family (panels.css:503). Library delete (`.lib-rm`)
 * deletes the SAVED copy only — it never removes an on-chart instance.
 *
 * Apply-and-navigate ordering vs pruneResearchOverlays (AppShell effect on
 * sym/tf change): we set the active sym/tf FIRST, then applyResearchOverlay.
 * Because the re-applied overlay's (sym, tf) matches the freshly-set active
 * context, pruneResearchOverlays — which keeps overlays whose (sym, tf) match
 * the active context, case-insensitive on sym — is a no-op for it whenever the
 * effect fires (before, between, or after our apply). The overlay therefore
 * always survives.
 */

import { useState, useRef, useEffect } from 'react';
import { useDockStore } from '../stores/useDockStore';
import { useAppStore } from '../stores/useAppStore';
import {
  useResearchOverlayLibraryStore,
  type PersistedResearchOverlay,
} from '../stores/useResearchOverlayLibraryStore';
import {
  useDatasetStore,
  colorForIndex,
} from '../stores/useDatasetStore';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import type { ResearchOverlay } from '../ai/schemas';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { ASSETS } from '../data/assets';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';
import { DatasetCard } from './DatasetCard';

type Tab = 'overlays' | 'datasets';

const TAB_DEFS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'overlays', label: 'Overlays' },
  { id: 'datasets', label: 'Datasets' },
];

// ---------------------------------------------------------------------------
// Resolve a full (sym, provider, quote) tuple for a saved overlay/dataset that
// only carries `sym`. Prefer a watchlist row the user already has, then the
// curated catalog, both matched case-insensitively. Returns null when the
// symbol can't be resolved (no provider known) so the caller can keep the
// active asset untouched.
// ---------------------------------------------------------------------------
function resolveAsset(
  sym: string,
  watchlist: ReadonlyArray<{ sym: string; provider: string; quote: string }>,
): { sym: string; provider: string; quote: string } | null {
  const symLc = sym.toLowerCase();
  const fromWatchlist = watchlist.find((a) => a.sym.toLowerCase() === symLc);
  if (fromWatchlist) {
    return { sym: fromWatchlist.sym, provider: fromWatchlist.provider, quote: fromWatchlist.quote };
  }
  const fromCatalog = ASSETS.find((a) => a.sym.toLowerCase() === symLc);
  if (fromCatalog) {
    return { sym: fromCatalog.sym, provider: fromCatalog.provider, quote: fromCatalog.quote };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overlay card — mirrors DatasetCard's .ds-card layout. Action varies by
// whether the overlay is on-chart, matches the active context, or needs a
// switch-and-reapply.
// ---------------------------------------------------------------------------
interface OverlayCardProps {
  overlay: PersistedResearchOverlay;
  color: string;
  idx: number;
}

function OverlayCard({ overlay, color, idx }: OverlayCardProps): JSX.Element {
  // Subscribe to the on-chart set + version so the pill flips live as overlays
  // are applied/removed/pruned.
  const onChart = useChartMutationStore(
    (s) => s.researchOverlays[overlay.id] !== undefined,
  );
  const activeSym = useAppStore((s) => s.activeSym);
  const activeTf = useAppStore((s) => s.tf);
  const watchlist = useWatchlistStore((s) => s.assets);
  const removeOverlay = useResearchOverlayLibraryStore((s) => s.removeOverlay);

  const [applied, setApplied] = useState(false);
  const appliedTimer = useRef<number | undefined>(undefined);

  const [arming, setArming] = useState(false);
  const armingTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(appliedTimer.current);
      window.clearTimeout(armingTimer.current);
    };
  }, []);

  const matchesActive =
    activeSym !== undefined &&
    activeSym.toLowerCase() === overlay.sym.toLowerCase() &&
    activeTf === overlay.tf;

  // Strip the persisted `created_at` field — applyResearchOverlay takes a clean
  // canonical ResearchOverlay.
  const cleanOverlay = (): ResearchOverlay => {
    const { created_at: _created_at, ...ro } = overlay;
    void _created_at;
    return ro;
  };

  const flashApplied = () => {
    setApplied(true);
    window.clearTimeout(appliedTimer.current);
    appliedTimer.current = window.setTimeout(() => setApplied(false), 1200);
  };

  const handleReapply = () => {
    useChartMutationStore.getState().applyResearchOverlay(cleanOverlay());
    flashApplied();
  };

  const handleSwitchAndReapply = () => {
    // Set the active sym/tf FIRST so the AppShell prune effect (which keeps
    // overlays whose (sym, tf) match the active context) treats our re-applied
    // overlay as a keeper regardless of effect ordering. THEN apply.
    const resolved = resolveAsset(overlay.sym, watchlist);
    if (resolved) {
      useAppStore.getState().setActiveAsset(resolved);
    }
    useAppStore.getState().setTf(overlay.tf);
    useChartMutationStore.getState().applyResearchOverlay(cleanOverlay());
    flashApplied();
  };

  const handleDelete = () => {
    if (!arming) {
      setArming(true);
      window.clearTimeout(armingTimer.current);
      armingTimer.current = window.setTimeout(() => setArming(false), 3000);
      return;
    }
    window.clearTimeout(armingTimer.current);
    setArming(false);
    void removeOverlay(overlay.id);
  };

  const meta = `${overlay.sym} · ${overlay.tf} · ${overlay.elements.length} elements`;

  return (
    <div
      className="ds-card"
      style={{ ['--ds-color' as string]: color, ['--i' as string]: idx } as React.CSSProperties}
    >
      <span className="ds-swatch" aria-hidden />
      <span className="ds-textcol">
        <span className="ds-label" title={overlay.label}>
          {overlay.label}
        </span>
        <span className="ds-meta">{meta}</span>
      </span>
      {onChart ? (
        <span className="ds-toggle on" aria-disabled="true">
          on chart
        </span>
      ) : matchesActive ? (
        <button
          type="button"
          className={`ds-toggle${applied ? ' applied' : ''}`}
          onClick={handleReapply}
        >
          {applied ? '✓ applied' : 'Re-apply'}
        </button>
      ) : (
        <button
          type="button"
          className={`ds-toggle${applied ? ' applied' : ''}`}
          onClick={handleSwitchAndReapply}
          title={`Switch to ${overlay.sym} ${overlay.tf} and re-apply`}
        >
          {applied ? '✓ applied' : 'Switch & re-apply'}
        </button>
      )}
      <button
        type="button"
        className={`lib-rm${arming ? ' arming' : ''}`}
        onClick={handleDelete}
        aria-label={arming ? 'Confirm delete' : `Delete saved overlay ${overlay.label}`}
        title={arming ? 'Click again to confirm delete' : 'Delete saved overlay (keeps any on-chart copy)'}
      >
        {arming ? 'confirm?' : '×'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dataset card wrapper — reuses DatasetCard, but intercepts its plot action
// when the dataset's (sym, tf) differs from the active chart: switch the
// active sym/tf first, then let DatasetCard set the active overlay id.
//
// DatasetCard's plot toggle is self-contained (it calls setAiOverlayDataset
// directly), so the cleanest interception is to compose the same .ds-card UI
// here for the cross-context case and reuse DatasetCard verbatim when the
// dataset already matches the active chart.
// ---------------------------------------------------------------------------
interface LibraryDatasetCardProps {
  dataset: ReturnType<typeof useDatasetStore.getState>['datasets'][number];
  color: string;
  idx: number;
}

function LibraryDatasetCard({ dataset, color, idx }: LibraryDatasetCardProps): JSX.Element {
  const activeSym = useAppStore((s) => s.activeSym);
  const activeTf = useAppStore((s) => s.tf);
  const activeId = useAppStore((s) => s.aiOverlayDatasetId);
  const watchlist = useWatchlistStore((s) => s.assets);
  const removeDataset = useDatasetStore((s) => s.removeDataset);

  const [applied, setApplied] = useState(false);
  const appliedTimer = useRef<number | undefined>(undefined);

  const [arming, setArming] = useState(false);
  const armingTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(appliedTimer.current);
      window.clearTimeout(armingTimer.current);
    };
  }, []);

  const matchesActive =
    activeSym !== undefined &&
    activeSym.toLowerCase() === dataset.sym.toLowerCase() &&
    activeTf === dataset.tf;

  const flashApplied = () => {
    setApplied(true);
    window.clearTimeout(appliedTimer.current);
    appliedTimer.current = window.setTimeout(() => setApplied(false), 1200);
  };

  const handleDelete = () => {
    if (!arming) {
      setArming(true);
      window.clearTimeout(armingTimer.current);
      armingTimer.current = window.setTimeout(() => setArming(false), 3000);
      return;
    }
    window.clearTimeout(armingTimer.current);
    setArming(false);
    void removeDataset(dataset.id);
  };

  // When the dataset matches the active chart, reuse DatasetCard verbatim —
  // its plot toggle already does the right thing.
  if (matchesActive) {
    return (
      <div className="lib-row">
        <DatasetCard dataset={dataset} color={color} />
        <button
          type="button"
          className={`lib-rm${arming ? ' arming' : ''}`}
          onClick={handleDelete}
          aria-label={arming ? 'Confirm delete' : `Delete saved dataset ${dataset.label}`}
          title={arming ? 'Click again to confirm delete' : 'Delete saved dataset'}
        >
          {arming ? 'confirm?' : '×'}
        </button>
      </div>
    );
  }

  // Cross-context: compose the same .ds-card UI but switch sym/tf first, then
  // set the active overlay id (mutually-exclusive, enforced in the store).
  const isActive = activeId === dataset.id;
  const handlePlot = () => {
    if (isActive) {
      useAppStore.getState().setAiOverlayDataset(null);
      return;
    }
    const resolved = resolveAsset(dataset.sym, watchlist);
    if (resolved) {
      useAppStore.getState().setActiveAsset(resolved);
    }
    useAppStore.getState().setTf(dataset.tf);
    useAppStore.getState().setAiOverlayDataset(dataset.id);
    flashApplied();
  };

  return (
    <div
      className="ds-card"
      style={{ ['--ds-color' as string]: color, ['--i' as string]: idx } as React.CSSProperties}
    >
      <span className="ds-swatch" aria-hidden />
      <span className="ds-textcol">
        <span className="ds-label" title={dataset.label}>
          {dataset.label}
        </span>
        <span className="ds-meta">
          {dataset.sym} · {dataset.tf}
        </span>
      </span>
      <button
        type="button"
        className={`ds-toggle${isActive ? ' on' : ''}${!isActive && applied ? ' applied' : ''}`}
        onClick={handlePlot}
        aria-pressed={isActive}
        title={`Switch to ${dataset.sym} ${dataset.tf} and plot`}
      >
        {isActive ? 'on chart' : applied ? '✓ applied' : 'plot here'}
      </button>
      <button
        type="button"
        className={`lib-rm${arming ? ' arming' : ''}`}
        onClick={handleDelete}
        aria-label={arming ? 'Confirm delete' : `Delete saved dataset ${dataset.label}`}
        title={arming ? 'Click again to confirm delete' : 'Delete saved dataset'}
      >
        {arming ? 'confirm?' : '×'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty-state note — structured empty state using .lib-empty CSS classes.
// ---------------------------------------------------------------------------
function EmptyNote({ heading, helper }: { heading: string; helper: string }): JSX.Element {
  return (
    <div className="lib-empty" role="status">
      <div className="lib-empty-icon" aria-hidden="true">◈</div>
      <p className="lib-empty-heading">{heading}</p>
      <p className="lib-empty-helper">{helper}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export function ResearchLibrary(): JSX.Element {
  const open = useDockStore((s) => s.openRight === 'research');
  const [tab, setTab] = useState<Tab>('overlays');

  const overlays = useResearchOverlayLibraryStore((s) => s.overlays);
  const datasets = useDatasetStore((s) => s.datasets);

  // Refs for roving-tabindex keyboard navigation.
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    overlays: null,
    datasets: null,
  });

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const order: Tab[] = ['overlays', 'datasets'];
    const currentIdx = order.indexOf(tab);
    let nextIdx: number | null = null;

    if (e.key === 'ArrowRight') {
      nextIdx = (currentIdx + 1) % order.length;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = (currentIdx - 1 + order.length) % order.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = order.length - 1;
    }

    if (nextIdx !== null) {
      e.preventDefault();
      const nextTab = order[nextIdx];
      setTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  };

  const activeTabId = `lib-tab-${tab}`;

  return (
    <DockDrawer side="right" id="research" ariaLabel="Research Library" open={open}>
      <PanelHeader
        label="Research Library"
        closeLabel="Close research library"
        closeTestId="research-library-close"
        onClose={() => useDockStore.getState().close('right')}
      />

      <div
        className="settings-tabstrip"
        role="tablist"
        aria-label="Research library tabs"
        onKeyDown={handleTabKeyDown}
      >
        {TAB_DEFS.map((t) => {
          const tabId = `lib-tab-${t.id}`;
          return (
            <button
              key={t.id}
              id={tabId}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls="lib-tabpanel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`settings-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        id="lib-tabpanel"
        className="settings-body"
        data-testid="research-library-body"
        role="tabpanel"
        aria-labelledby={activeTabId}
      >
        {tab === 'overlays' &&
          (overlays.length === 0 ? (
            <EmptyNote
              heading="No saved overlays yet"
              helper="Items you save from AI Research appear here"
            />
          ) : (
            overlays.map((ro, idx) => (
              <OverlayCard
                key={ro.id}
                overlay={ro}
                color={ro.color ?? colorForIndex(idx)}
                idx={idx}
              />
            ))
          ))}

        {tab === 'datasets' &&
          (datasets.length === 0 ? (
            <EmptyNote
              heading="No saved datasets yet"
              helper="Items you save from AI Research appear here"
            />
          ) : (
            datasets.map((ds, idx) => (
              <LibraryDatasetCard key={ds.id} dataset={ds} color={colorForIndex(idx)} idx={idx} />
            ))
          ))}
      </div>
    </DockDrawer>
  );
}

export default ResearchLibrary;
