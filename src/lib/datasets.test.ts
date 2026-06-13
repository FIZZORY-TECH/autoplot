/**
 * src/lib/datasets.test.ts — round-trip + seed idempotency (P6 W4-B).
 *
 * Coverage:
 *   1. `dbDatasetsUpsert / dbDatasetsList / dbDatasetsDelete` round-trip via
 *      a mocked `invoke` (asserts the wire shape Rust expects).
 *   2. `seedDefaultDatasetsIfNeeded()` is idempotent: running it twice
 *      results in five upserts the first time and zero the second time, and
 *      the `library.datasets_seeded` gate flips on the first call only.
 *   3. `useDatasetStore.hydrate()` parses persisted Dataset JSON and silently
 *      skips a malformed row without poisoning the rest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core — backed by an in-memory map so we can exercise
// the round-trip in isolation. Each command shape mirrors what Rust expects:
//   db_datasets_upsert  → { row: DatasetRow }
//   db_datasets_list    → ()    → DatasetRow[]
//   db_datasets_delete  → { id }
//   db_app_state_get    → { key } → string | null
//   db_app_state_set    → { key, value }
// ---------------------------------------------------------------------------

interface RowShape { id: string; json: string; created_at: number }

const datasetsTable = new Map<string, RowShape>();
const appState = new Map<string, string>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'db_datasets_upsert': {
        const row = args!.row as RowShape;
        datasetsTable.set(row.id, { ...row });
        return Promise.resolve(undefined);
      }
      case 'db_datasets_list': {
        const rows = Array.from(datasetsTable.values()).sort(
          (a, b) => a.created_at - b.created_at,
        );
        return Promise.resolve(rows);
      }
      case 'db_datasets_delete': {
        datasetsTable.delete(args!.id as string);
        return Promise.resolve(undefined);
      }
      case 'db_app_state_get': {
        const v = appState.get(args!.key as string);
        return Promise.resolve(v ?? null);
      }
      case 'db_app_state_set': {
        appState.set(args!.key as string, args!.value as string);
        return Promise.resolve(undefined);
      }
      default:
        return Promise.resolve(null);
    }
  }),
}));

// Imports AFTER vi.mock so the mocked invoke is in place.
import {
  dbDatasetsList,
  dbDatasetsUpsert,
  dbDatasetsDelete,
} from './db';
import {
  seedDefaultDatasetsIfNeeded,
  DEFAULT_DATASET_PRESETS,
} from '../ai/seedDatasets';
import { useDatasetStore } from '../stores/useDatasetStore';

beforeEach(() => {
  datasetsTable.clear();
  appState.clear();
  useDatasetStore.setState({ datasets: [], hydrated: false });
});

describe('db_datasets_* round-trip', () => {
  it('upsert + list + delete via Tauri wrappers', async () => {
    const row = {
      id: 't1',
      json: JSON.stringify({ id: 't1', name: 'Test', values: [1, 2, 3] }),
      created_at: 1_700_000_000_000,
    };
    await dbDatasetsUpsert(row);
    const listed = await dbDatasetsList();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('t1');
    expect(listed[0].json).toContain('Test');

    // Upsert again to verify ON CONFLICT semantics in the mock.
    await dbDatasetsUpsert({ ...row, json: JSON.stringify({ id: 't1', name: 'Renamed', values: [9] }) });
    const listed2 = await dbDatasetsList();
    expect(listed2).toHaveLength(1);
    expect(listed2[0].json).toContain('Renamed');

    await dbDatasetsDelete('t1');
    expect(await dbDatasetsList()).toHaveLength(0);
  });
});

describe('seedDefaultDatasetsIfNeeded — idempotent first-run gate', () => {
  it('seeds 5 presets the first time, 0 the second time', async () => {
    // First run: empty gate → all 5 presets land + flag flips.
    await seedDefaultDatasetsIfNeeded();
    const afterFirst = await dbDatasetsList();
    expect(afterFirst).toHaveLength(DEFAULT_DATASET_PRESETS.length);
    expect(appState.get('library.datasets_seeded')).toBe('1');

    // Capture row count, then run again — count must NOT grow.
    const tableSizeAfterFirst = datasetsTable.size;
    await seedDefaultDatasetsIfNeeded();
    expect(datasetsTable.size).toBe(tableSizeAfterFirst);
    const afterSecond = await dbDatasetsList();
    expect(afterSecond).toHaveLength(DEFAULT_DATASET_PRESETS.length);
  });

  it('preset shapes parse cleanly via useDatasetStore.hydrate()', async () => {
    await seedDefaultDatasetsIfNeeded();
    await useDatasetStore.getState().hydrate();
    const ds = useDatasetStore.getState().datasets;
    expect(ds).toHaveLength(DEFAULT_DATASET_PRESETS.length);
    // Round-trip preserved core fields.
    const realizedVol = ds.find((d) => d.id === 'preset-realized-vol-30d');
    // Canonical W4-A kind is 'series' (preset seeds use this value).
    expect(realizedVol?.kind).toBe('series');
    expect(realizedVol?.values.length).toBeGreaterThan(0);
  });

  it('hydrate silently skips a malformed JSON row', async () => {
    // Inject a bad row alongside a good one.
    datasetsTable.set('good', {
      id: 'good',
      json: JSON.stringify({
        id: 'good',
        name: 'Good',
        sourceSym: 'BTC',
        values: [1, 2, 3],
      }),
      created_at: 1,
    });
    datasetsTable.set('bad', {
      id: 'bad',
      json: '{not valid json',
      created_at: 2,
    });

    await useDatasetStore.getState().hydrate();
    const ds = useDatasetStore.getState().datasets;
    expect(ds.map((d) => d.id)).toEqual(['good']);
  });
});
