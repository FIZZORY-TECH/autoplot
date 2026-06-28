/**
 * src/panels/IndicatorPanel.savedIndicators.test.tsx — Step 7 panel-render tests
 * for the "Saved indicators" section added in Step 6.
 *
 * Asserts:
 *   1. Empty-state — no saved overlays ⇒ the empty note renders.
 *   2. Card render — a saved overlay renders a .ds-card with its label + an
 *      Apply button; the provenance badge (PINE / AI) is derived from source.
 *   3. Apply — clicking Apply RECOMPUTES via recomputeRecipe and writes the
 *      result into useChartMutationStore (keyed by `${id}:recompute`).
 *   4. Not-enough-history — Apply with insufficient bars surfaces the inline note.
 *
 * The panel is gated on useDockStore.openRight === 'indicator'; the DockDrawer
 * still mounts its children when closed, so we set it open for clarity. Apply is
 * disabled until useBarsStore has bars.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// Mock the Tauri DB so removeOverlay (delete path) doesn't try to invoke.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return {
    ...actual,
    dbResearchOverlaysList: vi.fn().mockResolvedValue([]),
    dbResearchOverlaysUpsert: vi.fn().mockResolvedValue(undefined),
    dbResearchOverlaysDelete: vi.fn().mockResolvedValue(undefined),
  };
});

import { IndicatorPanel } from './IndicatorPanel';
import { useDockStore } from '../stores/useDockStore';
import { useAppStore } from '../stores/useAppStore';
import { useBarsStore } from '../stores/useBarsStore';
import {
  useResearchOverlayLibraryStore,
  type PersistedResearchOverlay,
} from '../stores/useResearchOverlayLibraryStore';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import type { Bar } from '../data/MarketDataProvider';

function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.5 + Math.sin(i / 5) * 4;
    const c = base + Math.cos(i / 7) * 2;
    bars.push({ ts: 1_700_000_000_000 + i * 3_600_000, o: base, h: Math.max(base, c) + 1, l: Math.min(base, c) - 1, c, v: 1000 + i });
  }
  return bars;
}

function makeSaved(overrides: Partial<PersistedResearchOverlay> = {}): PersistedResearchOverlay {
  return {
    id: 'rsi-14',
    sym: 'BTC',
    tf: '1h',
    label: 'RSI(14)',
    source: 'pine',
    recipe: {
      source: 'pine',
      series: [{ kind: 'rsi', params: { period: 14 }, pane: 'series' }],
    },
    elements: [{ type: 'line', values: [50, 51], align: 'right', pane: 'series' }],
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe('IndicatorPanel — Saved indicators', () => {
  beforeEach(() => {
    cleanup();
    useDockStore.setState({ openRight: 'indicator' });
    useAppStore.setState({ activeSym: 'ETH', tf: '4h' });
    useBarsStore.setState({ bars: makeBars(300) });
    useResearchOverlayLibraryStore.setState({ overlays: [], hydrated: true });
    useChartMutationStore.setState({ researchOverlays: {}, researchOverlayVersion: 0 });
  });

  it('renders the empty-state when there are no saved overlays', () => {
    render(<IndicatorPanel />);
    expect(screen.getByText('No saved indicators yet')).toBeInTheDocument();
  });

  it('renders a card with the overlay label, an Apply button, and a PINE badge', () => {
    useResearchOverlayLibraryStore.setState({ overlays: [makeSaved()], hydrated: true });
    render(<IndicatorPanel />);

    expect(screen.getByText('RSI(14)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(screen.getByText('PINE')).toBeInTheDocument();
    expect(screen.queryByText('No saved indicators yet')).not.toBeInTheDocument();
  });

  it('shows an AI badge for source:"nl" overlays', () => {
    useResearchOverlayLibraryStore.setState({
      overlays: [makeSaved({ id: 'sma', label: 'SMA(20)', source: 'nl', recipe: { source: 'nl', series: [{ kind: 'sma', params: { period: 20 } }] } })],
      hydrated: true,
    });
    render(<IndicatorPanel />);
    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('Apply recomputes for the live (sym, tf) and writes to the chart store', () => {
    useResearchOverlayLibraryStore.setState({ overlays: [makeSaved()], hydrated: true });
    render(<IndicatorPanel />);

    expect(useChartMutationStore.getState().researchOverlays).toEqual({});

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    const applied = useChartMutationStore.getState().researchOverlays;
    // Recomputed overlay is keyed by the stable `${id}:recompute` id.
    expect(applied['rsi-14:recompute']).toBeDefined();
    const ro = applied['rsi-14:recompute'];
    // Retargeted to the active context.
    expect(ro.sym).toBe('ETH');
    expect(ro.tf).toBe('4h');
    // Recomputed RSI line + two guide hlines.
    expect(ro.elements.filter((e) => e.type === 'hline')).toHaveLength(2);
  });

  it('surfaces the not-enough-history note when bars are insufficient', () => {
    // SMA(200) on 120 bars cannot compute.
    useBarsStore.setState({ bars: makeBars(120) });
    useResearchOverlayLibraryStore.setState({
      overlays: [makeSaved({ id: 'sma-200', label: 'SMA(200)', source: 'nl', recipe: { source: 'nl', series: [{ kind: 'sma', params: { period: 200 } }] } })],
      hydrated: true,
    });
    const { container } = render(<IndicatorPanel />);

    fireEvent.click(within(container).getByRole('button', { name: 'Apply' }));

    expect(screen.getByText('not enough history for SMA(200)')).toBeInTheDocument();
  });

  it('disables Apply until bars are loaded', () => {
    useBarsStore.setState({ bars: [] });
    useResearchOverlayLibraryStore.setState({ overlays: [makeSaved()], hydrated: true });
    render(<IndicatorPanel />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});
