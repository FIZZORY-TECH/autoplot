/**
 * src/stores/useResearchOverlayLibraryStore.test.ts — Vitest unit tests for
 * useResearchOverlayLibraryStore.
 *
 * Covers:
 *   1. hydrate: one valid row is parsed and stored; one malformed row is
 *      skipped with a [TODO P8 toast] console.warn.
 *   2. addOverlay: optimistic in-memory insert + dbResearchOverlaysUpsert call.
 *   3. removeOverlay: optimistic in-memory remove + dbResearchOverlaysDelete call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResearchOverlayRow } from '../lib/db';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them.
// ---------------------------------------------------------------------------

const dbResearchOverlaysListMock = vi.fn<() => Promise<ResearchOverlayRow[]>>();
const dbResearchOverlaysUpsertMock = vi.fn<(row: ResearchOverlayRow) => Promise<void>>();
const dbResearchOverlaysDeleteMock = vi.fn<(id: string) => Promise<void>>();

vi.mock('../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/db')>();
  return {
    ...orig,
    dbResearchOverlaysList: () => dbResearchOverlaysListMock(),
    dbResearchOverlaysUpsert: (row: ResearchOverlayRow) => dbResearchOverlaysUpsertMock(row),
    dbResearchOverlaysDelete: (id: string) => dbResearchOverlaysDeleteMock(id),
  };
});

// Import after mocks are registered.
const { useResearchOverlayLibraryStore } = await import('./useResearchOverlayLibraryStore');
import type { ResearchOverlay } from '../ai/schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOverlay(id: string, label: string): ResearchOverlay {
  return {
    id,
    sym: 'BTC',
    tf: '1h',
    label,
    elements: [],
  };
}

function resetStore() {
  useResearchOverlayLibraryStore.setState({ overlays: [], hydrated: false });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
  dbResearchOverlaysListMock.mockReset();
  dbResearchOverlaysUpsertMock.mockReset();
  dbResearchOverlaysDeleteMock.mockReset();
  dbResearchOverlaysUpsertMock.mockResolvedValue(undefined);
  dbResearchOverlaysDeleteMock.mockResolvedValue(undefined);
});

describe('useResearchOverlayLibraryStore — hydrate', () => {
  it('parses one valid row and skips one malformed row', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const validOverlay = makeOverlay('valid-id', 'RSI Bands');
    const validRow: ResearchOverlayRow = {
      id: 'valid-id',
      json: JSON.stringify(validOverlay),
      created_at: 1_700_000_000_000,
    };
    const malformedRow: ResearchOverlayRow = {
      id: 'bad-id',
      json: '{ "not": "an overlay" }',
      created_at: 1_700_000_001_000,
    };

    dbResearchOverlaysListMock.mockResolvedValue([validRow, malformedRow]);

    await useResearchOverlayLibraryStore.getState().hydrate();

    const { overlays, hydrated } = useResearchOverlayLibraryStore.getState();

    // Valid row is present.
    expect(hydrated).toBe(true);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].id).toBe('valid-id');
    expect(overlays[0].label).toBe('RSI Bands');
    expect(overlays[0].created_at).toBe(1_700_000_000_000);

    // Malformed row was skipped with the [TODO P8 toast] marker.
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('[TODO P8 toast]'),
    );
    expect(warnCalls.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it('sets hydrated=true and overlays=[] when db returns empty list', async () => {
    dbResearchOverlaysListMock.mockResolvedValue([]);
    await useResearchOverlayLibraryStore.getState().hydrate();
    expect(useResearchOverlayLibraryStore.getState().hydrated).toBe(true);
    expect(useResearchOverlayLibraryStore.getState().overlays).toHaveLength(0);
  });
});

describe('useResearchOverlayLibraryStore — addOverlay', () => {
  it('optimistically inserts overlay into state and calls dbResearchOverlaysUpsert', async () => {
    const overlay = makeOverlay('add-id', 'Volume Profile');

    await useResearchOverlayLibraryStore.getState().addOverlay(overlay);

    const { overlays } = useResearchOverlayLibraryStore.getState();
    expect(overlays).toHaveLength(1);
    expect(overlays[0].id).toBe('add-id');
    expect(overlays[0].label).toBe('Volume Profile');

    expect(dbResearchOverlaysUpsertMock).toHaveBeenCalledOnce();
    const upsertArg = dbResearchOverlaysUpsertMock.mock.calls[0][0] as ResearchOverlayRow;
    expect(upsertArg.id).toBe('add-id');
    expect(JSON.parse(upsertArg.json)).toMatchObject({ id: 'add-id', label: 'Volume Profile' });
  });

  it('replaces existing overlay with same id', async () => {
    const first = makeOverlay('dup-id', 'First');
    const second = makeOverlay('dup-id', 'Second');

    await useResearchOverlayLibraryStore.getState().addOverlay(first);
    await useResearchOverlayLibraryStore.getState().addOverlay(second);

    const { overlays } = useResearchOverlayLibraryStore.getState();
    expect(overlays.filter((o) => o.id === 'dup-id')).toHaveLength(1);
    expect(overlays.find((o) => o.id === 'dup-id')!.label).toBe('Second');
  });
});

describe('useResearchOverlayLibraryStore — removeOverlay', () => {
  it('optimistically removes overlay from state and calls dbResearchOverlaysDelete', async () => {
    const overlay = makeOverlay('rm-id', 'To Remove');
    await useResearchOverlayLibraryStore.getState().addOverlay(overlay);
    expect(useResearchOverlayLibraryStore.getState().overlays).toHaveLength(1);

    await useResearchOverlayLibraryStore.getState().removeOverlay('rm-id');

    expect(useResearchOverlayLibraryStore.getState().overlays).toHaveLength(0);
    expect(dbResearchOverlaysDeleteMock).toHaveBeenCalledWith('rm-id');
  });

  it('is a no-op (no crash) when id does not exist', async () => {
    await useResearchOverlayLibraryStore.getState().removeOverlay('nonexistent');
    expect(useResearchOverlayLibraryStore.getState().overlays).toHaveLength(0);
    expect(dbResearchOverlaysDeleteMock).toHaveBeenCalledWith('nonexistent');
  });
});
