/**
 * src/panels/DatasetCard.test.tsx — DatasetCard plot toggle (P6 W4-B).
 *
 * Asserts:
 *   1. Plot toggle is mutually exclusive across multiple cards. Toggling
 *      card A then card B must auto-clear A — only B's `aiOverlayDatasetId`
 *      remains active in `useAppStore`.
 *   2. The `×` clears the active overlay but does NOT delete the dataset
 *      from the in-memory `useDatasetStore` (and would NOT call
 *      `dbDatasetsDelete`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// Mock the Tauri DB so the DatasetCard's chip toggle doesn't try to invoke.
// dbDatasetsDelete must NOT be called by the `×` clear-overlay button.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return {
    ...actual,
    dbDatasetsList: vi.fn().mockResolvedValue([]),
    dbDatasetsUpsert: vi.fn().mockResolvedValue(undefined),
    dbDatasetsDelete: vi.fn().mockResolvedValue(undefined),
  };
});

import { DatasetCard } from './DatasetCard';
import { useAppStore } from '../stores/useAppStore';
import { useDatasetStore, type PersistedDataset } from '../stores/useDatasetStore';
import { dbDatasetsDelete } from '../lib/db';

function makeDataset(id: string, name: string): PersistedDataset {
  return {
    id,
    label: name,
    kind: 'series',
    sym: 'BTC',
    tf: '1h',
    values: [1, 2, 3, 4, 5],
    align: 'right',
    notes: `prompt for ${name}`,
    createdAt: 1_700_000_000_000,
  };
}

describe('DatasetCard', () => {
  beforeEach(() => {
    cleanup();
    // Reset the relevant stores to a known baseline before every test.
    useAppStore.setState({ aiOverlayDatasetId: null });
    useDatasetStore.setState({ datasets: [], hydrated: true });
    vi.mocked(dbDatasetsDelete).mockClear();
  });

  it('plot toggle is mutually exclusive across multiple cards', () => {
    const a = makeDataset('a', 'Alpha');
    const b = makeDataset('b', 'Beta');
    useDatasetStore.setState({ datasets: [a, b], hydrated: true });

    render(
      <>
        <DatasetCard dataset={a} color="oklch(0.82 0.14 215)" />
        <DatasetCard dataset={b} color="oklch(0.78 0.18 320)" />
      </>,
    );

    // Initially neither card is active.
    expect(useAppStore.getState().aiOverlayDatasetId).toBeNull();

    // Toggle card A — `aiOverlayDatasetId` must be 'a'.
    const cards = screen.getAllByRole('button', { name: 'plot' });
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[0]);
    expect(useAppStore.getState().aiOverlayDatasetId).toBe('a');

    // Re-query buttons — the first card now shows 'on chart', second is still 'plot'.
    fireEvent.click(screen.getByRole('button', { name: 'plot' }));
    // Mutual exclusion: clicking B must replace, not stack.
    expect(useAppStore.getState().aiOverlayDatasetId).toBe('b');

    // No "two active" state should be possible: only one card has aria-pressed=true.
    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed).toHaveLength(1);
  });

  it('× clears the overlay only — does NOT delete from library', () => {
    const a = makeDataset('a', 'Alpha');
    useDatasetStore.setState({ datasets: [a], hydrated: true });
    useAppStore.setState({ aiOverlayDatasetId: 'a' });

    const { container } = render(
      <DatasetCard dataset={a} color="oklch(0.82 0.14 215)" />,
    );

    // The × button should be visible because the card is currently plotted.
    const clearBtn = within(container).getByRole('button', { name: 'Clear overlay' });
    fireEvent.click(clearBtn);

    // Overlay cleared.
    expect(useAppStore.getState().aiOverlayDatasetId).toBeNull();

    // Library unchanged: dataset still in the store.
    expect(useDatasetStore.getState().datasets).toHaveLength(1);
    expect(useDatasetStore.getState().datasets[0].id).toBe('a');

    // dbDatasetsDelete must NOT have been called.
    expect(dbDatasetsDelete).not.toHaveBeenCalled();
  });
});
