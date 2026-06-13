/**
 * src/stores/useDatasetStore.ts — In-memory mirror of the `datasets` SQLite
 * table (P6 W4-B). Hydrated from `dbDatasetsList()` on app boot, then mutated
 * via `addDataset` / `removeDataset` which fan out to SQLite via `dbDatasets*`.
 *
 * The `Dataset` shape is owned by W4-A (`src/ai/schemas.ts`); this file uses
 * a structural stub so the UI layer (DatasetCard / LibraryDatasets) can
 * compile against a stable interface until W4-A merges. When W4-A's
 * `Dataset` Zod schema lands, replace `Dataset` here with an import:
 *
 *   // W4-A integration: replace with import from '../ai/schemas'
 *   import type { Dataset } from '../ai/schemas';
 *
 * The persisted JSON blob in SQLite is `JSON.stringify(dataset)`.
 */

import { create } from 'zustand';
import {
  dbDatasetsList,
  dbDatasetsUpsert,
  dbDatasetsDelete,
  type DatasetRow,
} from '../lib/db';

// ---------------------------------------------------------------------------
// Dataset type — imported from W4-A's canonical Zod schema export.
// The schemas.ts Dataset shape (id/label/kind/align/sym/tf/values) differs
// from the W4-B stub (id/name/kind/sourceSym/sourceTf/values/align). We
// bridge the gap with a store-level type alias that accommodates both shapes
// during the transition, re-exporting the legacy fields as optional so
// existing UI code continues to compile.
// ---------------------------------------------------------------------------

// Re-export the canonical Zod-backed type as the primary Dataset.
export type { Dataset } from '../ai/schemas';
import type { Dataset } from '../ai/schemas';

// Legacy alias types kept for UI code that still references them.
// These will be removed when DatasetCard/LibraryDatasets migrate to the
// canonical `label` / `sym` / `tf` field names (P8 cleanup).
export type DatasetKind =
  | 'realized_vol'
  | 'correlation'
  | 'momentum_z'
  | 'liquidity_pressure'
  | 'funding_proxy'
  | 'custom';
export type DatasetAlign = 'right' | 'index';

// ---------------------------------------------------------------------------
// Persisted-row envelope — wraps a canonical Dataset with SQLite metadata.
// The `createdAt` timestamp is stored separately in the `datasets.created_at`
// column (set when first upserted) rather than inside the JSON blob so we
// don't duplicate data that the DB tracks anyway.
// ---------------------------------------------------------------------------

/** Extended dataset as stored in memory — canonical Dataset + row metadata. */
export interface PersistedDataset extends Dataset {
  /** Unix-ms timestamp from the SQLite `created_at` column. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DatasetState {
  /** All persisted datasets (mirror of SQLite). */
  datasets: PersistedDataset[];
  /** True once `hydrate()` has run successfully. */
  hydrated: boolean;

  /** Load all rows from SQLite into the in-memory mirror. */
  hydrate: () => Promise<void>;
  /** Replace the entire mirror — used by tests + by hydrate(). */
  setDatasets: (ds: PersistedDataset[]) => void;
  /** Insert/replace one dataset (in-memory + SQLite). */
  addDataset: (d: PersistedDataset) => Promise<void>;
  /** Remove from in-memory + SQLite. */
  removeDataset: (id: string) => Promise<void>;
}

export const useDatasetStore = create<DatasetState>((set, get) => ({
  datasets: [],
  hydrated: false,

  hydrate: async () => {
    try {
      const rows = await dbDatasetsList();
      const parsed: PersistedDataset[] = [];
      for (const r of rows) {
        const ds = parseDatasetRow(r);
        if (ds) parsed.push(ds);
      }
      set({ datasets: parsed, hydrated: true });
    } catch (err) {
      console.warn('[dataset] dbDatasetsList failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'warn',
          title: 'Datasets unavailable',
          detail: 'Could not read saved datasets from disk',
        }),
      );
      set({ hydrated: true });
    }
  },

  setDatasets: (ds) => set({ datasets: ds }),

  addDataset: async (d) => {
    // Optimistic local update first.
    const prev = get().datasets.filter((x) => x.id !== d.id);
    set({ datasets: [...prev, d] });
    try {
      await dbDatasetsUpsert({
        id: d.id,
        json: JSON.stringify(d),
        created_at: d.createdAt,
      });
    } catch (err) {
      console.warn('[dataset] dbDatasetsUpsert failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Dataset not saved',
          detail: 'Kept locally; disk write failed',
        }),
      );
    }
  },

  removeDataset: async (id) => {
    set({ datasets: get().datasets.filter((d) => d.id !== id) });
    try {
      await dbDatasetsDelete(id);
    } catch (err) {
      console.warn('[dataset] dbDatasetsDelete failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Dataset not deleted',
          detail: 'Disk row could not be removed',
        }),
      );
    }
  },
}));

// ---------------------------------------------------------------------------
// Row parsing — silently skip malformed JSON so a single bad row doesn't
// poison the whole hydrate.
//
// Handles two persisted shapes:
//   1. Canonical W4-A shape: { id, label, kind, align, sym, tf, values, ... }
//   2. Legacy W4-B preset shape: { id, name, kind, sourceSym, sourceTf, values, align, ... }
//      — bridged by mapping `name→label`, `sourceSym→sym`, `sourceTf→tf`.
// ---------------------------------------------------------------------------

function parseDatasetRow(r: DatasetRow): PersistedDataset | null {
  try {
    const obj = JSON.parse(r.json) as Record<string, unknown>;
    if (typeof obj.id !== 'string' || !Array.isArray(obj.values)) return null;

    // Resolve label: canonical 'label' wins; fall back to legacy 'name'.
    const label =
      typeof obj.label === 'string' ? obj.label
      : typeof obj.name === 'string' ? obj.name
      : null;
    if (!label) return null;

    // Resolve sym: canonical 'sym' wins; fall back to legacy 'sourceSym'.
    const sym =
      typeof obj.sym === 'string' ? obj.sym
      : typeof obj.sourceSym === 'string' ? obj.sourceSym
      : null;
    if (!sym) return null;

    // Resolve tf: canonical 'tf' wins; fall back to legacy 'sourceTf'.
    const tf =
      typeof obj.tf === 'string' ? obj.tf
      : typeof obj.sourceTf === 'string' ? obj.sourceTf
      : '1h';

    const createdAt: number =
      typeof obj.createdAt === 'number' ? obj.createdAt : r.created_at;

    // Build a canonical Dataset-compatible object.
    const dataset: PersistedDataset = {
      id: obj.id,
      label,
      sym,
      tf: tf as Dataset['tf'],
      kind: (typeof obj.kind === 'string' ? obj.kind : 'series') as Dataset['kind'],
      align: (typeof obj.align === 'string' ? obj.align : 'right') as Dataset['align'],
      values: obj.values as Array<number | null>,
      notes: typeof obj.notes === 'string' ? obj.notes
             : typeof obj.prompt === 'string' ? obj.prompt
             : undefined,
      createdAt,
    };
    return dataset;
  } catch {
    console.warn('[dataset] malformed JSON in SQLite, skipping', r.id);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Color palette — silently mapped from index. Mirrors design tokens used in
// the prototype's chip stack: cyan / violet / amber / emerald / rose.
// ---------------------------------------------------------------------------

export const DATASET_PALETTE: readonly string[] = Object.freeze([
  'oklch(0.82 0.14 215)', // cyan (accent)
  'oklch(0.78 0.18 320)', // violet
  'oklch(0.85 0.16 80)',  // amber
  'oklch(0.78 0.16 150)', // emerald
  'oklch(0.78 0.20 25)',  // rose
]);

/** Pick a color for a dataset by its index in the persisted list. Cycles
 *  silently when there are more datasets than palette entries. */
export function colorForIndex(idx: number): string {
  return DATASET_PALETTE[((idx % DATASET_PALETTE.length) + DATASET_PALETTE.length) % DATASET_PALETTE.length];
}
