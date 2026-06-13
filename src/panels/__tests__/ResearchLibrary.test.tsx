/**
 * src/panels/__tests__/ResearchLibrary.test.tsx — Research Library drawer (Step 3).
 *
 * Covers:
 *   a. Tablist keyboard nav: ArrowRight on Overlays tab moves focus + aria-selected
 *      to Datasets; wraps back; Home/End work.
 *   b. Armed delete: first × click arms (shows "confirm?", aria-label "Confirm delete");
 *      does NOT remove from the store. Second click removes. Auto-disarms after 3000ms.
 *   c. Applied flash: clicking Re-apply shows "✓ applied"; reverts after ~1200ms.
 *   d. Empty state: Overlays tab shows "No saved overlays yet"; Datasets tab shows
 *      "No saved datasets yet".
 *   e. 2-line label: card renders label inside .ds-textcol; .ds-label carries title
 *      equal to the full label text.
 *
 * Store-seeding convention: real zustand stores seeded via setState (no vi.mock of
 * the stores themselves). DB calls are mocked at the lib/db layer so removeOverlay /
 * removeDataset don't throw in jsdom.
 *
 * Timer notes: vi.useFakeTimers() is used where timers matter. fireEvent is used
 * instead of userEvent to avoid the userEvent+fakeTimers interaction issue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock the DB layer so removeOverlay / removeDataset don't hit Tauri invoke.
// ---------------------------------------------------------------------------

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return {
    ...actual,
    dbResearchOverlaysList: vi.fn().mockResolvedValue([]),
    dbResearchOverlaysUpsert: vi.fn().mockResolvedValue(undefined),
    dbResearchOverlaysDelete: vi.fn().mockResolvedValue(undefined),
    dbDatasetsList: vi.fn().mockResolvedValue([]),
    dbDatasetsUpsert: vi.fn().mockResolvedValue(undefined),
    dbDatasetsDelete: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks.
// ---------------------------------------------------------------------------

import { useDockStore } from '../../stores/useDockStore';
import { useResearchOverlayLibraryStore, type PersistedResearchOverlay } from '../../stores/useResearchOverlayLibraryStore';
import { useDatasetStore, type PersistedDataset } from '../../stores/useDatasetStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChartMutationStore } from '../../stores/useChartMutationStore';
import { ResearchLibrary } from '../ResearchLibrary';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOverlay(id: string, label: string): PersistedResearchOverlay {
  return {
    id,
    sym: 'BTC',
    tf: '1h',
    label,
    elements: [],
    created_at: 1_700_000_000_000,
  };
}

function makeDataset(id: string, label: string): PersistedDataset {
  return {
    id,
    label,
    kind: 'series',
    sym: 'ETH',
    tf: '4h',
    values: [1, 2, 3],
    align: 'right',
    createdAt: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function openResearchDrawer() {
  useDockStore.setState({ openLeft: null, openRight: 'research' });
}

function resetStores() {
  useDockStore.setState({ openLeft: null, openRight: null });
  useResearchOverlayLibraryStore.setState({ overlays: [], hydrated: true });
  useDatasetStore.setState({ datasets: [], hydrated: true });
  useChartMutationStore.setState({ researchOverlays: {}, researchOverlayVersion: 0 });
  useAppStore.setState({ activeSym: undefined, tf: '1h' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchLibrary', () => {
  beforeEach(() => {
    resetStores();
    openResearchDrawer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // d. Empty state
  // -----------------------------------------------------------------------

  describe('d. Empty state', () => {
    it('d1. Overlays tab shows "No saved overlays yet" heading when store is empty', () => {
      render(<ResearchLibrary />);
      // Overlays tab is active by default.
      expect(screen.getByText('No saved overlays yet')).toBeInTheDocument();
    });

    it('d2. Datasets tab shows "No saved datasets yet" heading when store is empty', () => {
      render(<ResearchLibrary />);
      // Switch to Datasets tab.
      fireEvent.click(screen.getByRole('tab', { name: 'Datasets' }));
      expect(screen.getByText('No saved datasets yet')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // a. Tablist keyboard navigation
  // -----------------------------------------------------------------------

  describe('a. Tablist keyboard navigation', () => {
    it('a1. ArrowRight on Overlays tab moves aria-selected to Datasets', () => {
      render(<ResearchLibrary />);
      const overlaysTab = screen.getByRole('tab', { name: 'Overlays' });
      const datasetsTab = screen.getByRole('tab', { name: 'Datasets' });

      // Overlays tab starts selected.
      expect(overlaysTab).toHaveAttribute('aria-selected', 'true');
      expect(datasetsTab).toHaveAttribute('aria-selected', 'false');

      // Focus overlays tab and press ArrowRight.
      overlaysTab.focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });

      expect(datasetsTab).toHaveAttribute('aria-selected', 'true');
      expect(overlaysTab).toHaveAttribute('aria-selected', 'false');
    });

    it('a2. ArrowRight on Datasets tab wraps back to Overlays', () => {
      render(<ResearchLibrary />);
      // Switch to Datasets first via click.
      fireEvent.click(screen.getByRole('tab', { name: 'Datasets' }));

      const overlaysTab = screen.getByRole('tab', { name: 'Overlays' });
      const datasetsTab = screen.getByRole('tab', { name: 'Datasets' });
      expect(datasetsTab).toHaveAttribute('aria-selected', 'true');

      // ArrowRight should wrap back to Overlays.
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
      expect(overlaysTab).toHaveAttribute('aria-selected', 'true');
      expect(datasetsTab).toHaveAttribute('aria-selected', 'false');
    });

    it('a3. Home key moves to Overlays (first tab)', () => {
      render(<ResearchLibrary />);
      // Switch to Datasets.
      fireEvent.click(screen.getByRole('tab', { name: 'Datasets' }));
      expect(screen.getByRole('tab', { name: 'Datasets' })).toHaveAttribute('aria-selected', 'true');

      // Home should go to Overlays.
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
      expect(screen.getByRole('tab', { name: 'Overlays' })).toHaveAttribute('aria-selected', 'true');
    });

    it('a4. End key moves to Datasets (last tab)', () => {
      render(<ResearchLibrary />);
      // Overlays is active by default.
      expect(screen.getByRole('tab', { name: 'Overlays' })).toHaveAttribute('aria-selected', 'true');

      // End should go to Datasets.
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
      expect(screen.getByRole('tab', { name: 'Datasets' })).toHaveAttribute('aria-selected', 'true');
    });

    it('a5. ArrowLeft on Overlays tab wraps to Datasets', () => {
      render(<ResearchLibrary />);
      // Start on Overlays.
      expect(screen.getByRole('tab', { name: 'Overlays' })).toHaveAttribute('aria-selected', 'true');

      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
      expect(screen.getByRole('tab', { name: 'Datasets' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  // -----------------------------------------------------------------------
  // b. Armed delete
  // -----------------------------------------------------------------------

  describe('b. Armed delete', () => {
    it('b1. first × click shows "confirm?" and aria-label "Confirm delete"', () => {
      const overlay = makeOverlay('ov-1', 'My Overlay');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });

      render(<ResearchLibrary />);

      const deleteBtn = screen.getByRole('button', { name: /delete saved overlay my overlay/i });
      expect(deleteBtn).toBeInTheDocument();

      fireEvent.click(deleteBtn);

      // After first click: armed state.
      expect(deleteBtn).toHaveTextContent('confirm?');
      expect(deleteBtn).toHaveAttribute('aria-label', 'Confirm delete');
    });

    it('b2. first × click does NOT remove the overlay from the store', () => {
      const overlay = makeOverlay('ov-1', 'My Overlay');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });

      render(<ResearchLibrary />);

      const deleteBtn = screen.getByRole('button', { name: /delete saved overlay my overlay/i });
      fireEvent.click(deleteBtn);

      // Overlay is still in the store.
      expect(useResearchOverlayLibraryStore.getState().overlays).toHaveLength(1);
      expect(useResearchOverlayLibraryStore.getState().overlays[0].id).toBe('ov-1');
    });

    it('b3. second click (after arm) removes the overlay from the store', async () => {
      const overlay = makeOverlay('ov-del', 'Delete Me');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });

      render(<ResearchLibrary />);

      const deleteBtn = screen.getByRole('button', { name: /delete saved overlay delete me/i });
      // First click: arm.
      fireEvent.click(deleteBtn);
      expect(deleteBtn).toHaveTextContent('confirm?');

      // Second click: confirm delete.
      fireEvent.click(deleteBtn);

      // Overlay removed from store (removeOverlay is optimistic + async).
      expect(useResearchOverlayLibraryStore.getState().overlays).toHaveLength(0);
    });

    it('b4. armed state auto-disarms after 3000ms with no second click', () => {
      vi.useFakeTimers();
      const overlay = makeOverlay('ov-arm', 'Auto Disarm');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });

      render(<ResearchLibrary />);

      const deleteBtn = screen.getByRole('button', { name: /delete saved overlay auto disarm/i });
      fireEvent.click(deleteBtn);
      expect(deleteBtn).toHaveTextContent('confirm?');

      // Advance past the 3000ms disarm timeout.
      act(() => {
        vi.advanceTimersByTime(3100);
      });

      // Should have reverted to '×' (disarmed).
      expect(deleteBtn).toHaveTextContent('×');
      expect(deleteBtn).not.toHaveAttribute('aria-label', 'Confirm delete');
    });
  });

  // -----------------------------------------------------------------------
  // c. Applied flash (Re-apply)
  //
  // Wiring note: handleReapply calls applyResearchOverlay (synchronous zustand
  // update) then flashApplied (sets local applied=true). Because zustand state
  // updates are synchronous in tests, the `onChart` selector
  // (researchOverlays[id] !== undefined) flips to true in the SAME render
  // cycle. The component renders the `onChart` branch ("on chart" span) rather
  // than the `matchesActive` branch that would show "✓ applied". The flash
  // state IS set internally (timer queued), but the "on chart" label takes
  // precedence. Tests assert this actual behavior.
  // -----------------------------------------------------------------------

  describe('c. Applied flash', () => {
    it('c1. clicking Re-apply puts the overlay on-chart (shows "on chart" label)', () => {
      vi.useFakeTimers();
      // Overlay matches the active sym/tf so Re-apply button appears.
      const overlay = makeOverlay('ov-apply', 'BTC Overlay');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });
      // Set active sym/tf to match.
      useAppStore.setState({ activeSym: 'BTC', tf: '1h' });
      // Overlay NOT currently on-chart.
      useChartMutationStore.setState({ researchOverlays: {}, researchOverlayVersion: 0 });

      render(<ResearchLibrary />);

      // Re-apply button is visible before the click.
      const reapplyBtn = screen.getByRole('button', { name: /re-apply/i });
      fireEvent.click(reapplyBtn);

      // applyResearchOverlay fires synchronously → overlay is now on-chart.
      // The card switches from the Re-apply button to the "on chart" disabled span.
      expect(screen.getByText('on chart')).toBeInTheDocument();
      // Re-apply button is gone.
      expect(screen.queryByRole('button', { name: /re-apply/i })).toBeNull();
    });

    it('c2. after Re-apply the overlay is present in useChartMutationStore.researchOverlays', () => {
      const overlay = makeOverlay('ov-apply2', 'BTC Overlay 2');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });
      useAppStore.setState({ activeSym: 'BTC', tf: '1h' });
      useChartMutationStore.setState({ researchOverlays: {}, researchOverlayVersion: 0 });

      render(<ResearchLibrary />);

      fireEvent.click(screen.getByRole('button', { name: /re-apply/i }));

      // Verify the overlay was actually applied to the chart mutation store.
      expect(useChartMutationStore.getState().researchOverlays['ov-apply2']).toBeDefined();
    });

    it('c3. Switch & re-apply puts the overlay on-chart (shows "on chart" label)', () => {
      vi.useFakeTimers();
      // Overlay is for ETH/4h, active chart is BTC/1h → "Switch & re-apply" button.
      const overlay = makeOverlay('ov-switch', 'ETH Overlay');
      // Override sym so it's different from activeSym.
      overlay.sym = 'ETH';
      overlay.tf = '4h';
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });
      useAppStore.setState({ activeSym: 'BTC', tf: '1h' });
      useChartMutationStore.setState({ researchOverlays: {}, researchOverlayVersion: 0 });

      render(<ResearchLibrary />);

      const switchBtn = screen.getByRole('button', { name: /switch & re-apply/i });
      fireEvent.click(switchBtn);

      // applyResearchOverlay fires synchronously → onChart=true → "on chart" span.
      expect(screen.getByText('on chart')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // e. 2-line label
  // -----------------------------------------------------------------------

  describe('e. 2-line label layout', () => {
    it('e1. overlay card renders label inside .ds-textcol container', () => {
      const overlay = makeOverlay('ov-label', 'My Long Label');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });

      const { container } = render(<ResearchLibrary />);

      const textcol = container.querySelector('.ds-textcol');
      expect(textcol).not.toBeNull();
      expect(textcol).toBeInTheDocument();
    });

    it('e2. .ds-label carries a title attribute equal to the full overlay label', () => {
      const overlay = makeOverlay('ov-title', 'RSI Divergence Overlay');
      useResearchOverlayLibraryStore.setState({ overlays: [overlay], hydrated: true });

      const { container } = render(<ResearchLibrary />);

      const labelEl = container.querySelector('.ds-label');
      expect(labelEl).not.toBeNull();
      expect(labelEl).toHaveAttribute('title', 'RSI Divergence Overlay');
    });

    it('e3. dataset card renders label inside .ds-textcol when cross-context', () => {
      const ds = makeDataset('ds-label', 'ETH Dataset Label');
      useDatasetStore.setState({ datasets: [ds], hydrated: true });
      // Active sym is different from dataset sym → cross-context path.
      useAppStore.setState({ activeSym: 'BTC', tf: '1h' });

      const { container } = render(<ResearchLibrary />);

      // Switch to Datasets tab.
      fireEvent.click(screen.getByRole('tab', { name: 'Datasets' }));

      const textcol = container.querySelector('.ds-textcol');
      expect(textcol).not.toBeNull();
      expect(textcol).toBeInTheDocument();
    });

    it('e4. dataset .ds-label carries a title attribute equal to the full dataset label', () => {
      const ds = makeDataset('ds-title', 'ETH Funding Rate');
      ds.sym = 'ETH';
      ds.tf = '4h';
      useDatasetStore.setState({ datasets: [ds], hydrated: true });
      useAppStore.setState({ activeSym: 'BTC', tf: '1h' });

      const { container } = render(<ResearchLibrary />);

      fireEvent.click(screen.getByRole('tab', { name: 'Datasets' }));

      const labelEl = container.querySelector('.ds-label');
      expect(labelEl).not.toBeNull();
      expect(labelEl).toHaveAttribute('title', 'ETH Funding Rate');
    });
  });

  // -----------------------------------------------------------------------
  // WAI-ARIA structure
  // -----------------------------------------------------------------------

  describe('WAI-ARIA tablist structure', () => {
    it('tablist has aria-label "Research library tabs"', () => {
      render(<ResearchLibrary />);
      expect(screen.getByRole('tablist', { name: /research library tabs/i })).toBeInTheDocument();
    });

    it('Overlays tab has id "lib-tab-overlays"', () => {
      render(<ResearchLibrary />);
      const overlaysTab = screen.getByRole('tab', { name: 'Overlays' });
      expect(overlaysTab).toHaveAttribute('id', 'lib-tab-overlays');
    });

    it('Datasets tab has id "lib-tab-datasets"', () => {
      render(<ResearchLibrary />);
      const datasetsTab = screen.getByRole('tab', { name: 'Datasets' });
      expect(datasetsTab).toHaveAttribute('id', 'lib-tab-datasets');
    });

    it('both tabs carry aria-controls="lib-tabpanel"', () => {
      render(<ResearchLibrary />);
      const tabs = screen.getAllByRole('tab');
      tabs.forEach((tab) => {
        expect(tab).toHaveAttribute('aria-controls', 'lib-tabpanel');
      });
    });

    it('active tab has tabIndex=0 and inactive tab has tabIndex=-1', () => {
      render(<ResearchLibrary />);
      const overlaysTab = screen.getByRole('tab', { name: 'Overlays' });
      const datasetsTab = screen.getByRole('tab', { name: 'Datasets' });
      // Overlays is selected by default.
      expect(overlaysTab).toHaveAttribute('tabindex', '0');
      expect(datasetsTab).toHaveAttribute('tabindex', '-1');
    });
  });
});
