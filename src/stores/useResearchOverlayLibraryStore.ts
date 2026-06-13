/**
 * src/stores/useResearchOverlayLibraryStore.ts — In-memory mirror of the
 * `research_overlays` SQLite table (Step 4). Hydrated from
 * `dbResearchOverlaysList()` on app boot, then mutated via `addOverlay` /
 * `removeOverlay` which fan out to SQLite via `dbResearchOverlays*`.
 *
 * The `ResearchOverlay` shape is owned by `src/ai/schemas.ts`. The persisted
 * JSON blob in SQLite is `JSON.stringify(overlay)`.
 *
 * This store is the library mirror only — it does NOT auto-paint anything
 * onto the chart. Chart rendering components must subscribe and apply overlays
 * themselves.
 */

import { create } from 'zustand';
import {
  dbResearchOverlaysList,
  dbResearchOverlaysUpsert,
  dbResearchOverlaysDelete,
  type ResearchOverlayRow,
} from '../lib/db';
import { ResearchOverlay } from '../ai/schemas';

type ResearchOverlayType = ReturnType<typeof ResearchOverlay.parse>;

// ---------------------------------------------------------------------------
// Persisted-row envelope — wraps a canonical ResearchOverlay with SQLite
// metadata. The `created_at` timestamp is stored separately in the
// `research_overlays.created_at` column rather than inside the JSON blob so
// we don't duplicate data that the DB tracks anyway.
// ---------------------------------------------------------------------------

/** Extended overlay as stored in memory — canonical ResearchOverlay + row metadata. */
export interface PersistedResearchOverlay extends ResearchOverlayType {
  /** Unix-ms timestamp from the SQLite `created_at` column. */
  created_at: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ResearchOverlayLibraryState {
  /** All persisted research overlays (mirror of SQLite). */
  overlays: PersistedResearchOverlay[];
  /** True once `hydrate()` has run successfully. */
  hydrated: boolean;

  /** Load all rows from SQLite into the in-memory mirror. */
  hydrate: () => Promise<void>;
  /** Replace the entire mirror — used by tests + by hydrate(). */
  setOverlays: (overlays: PersistedResearchOverlay[]) => void;
  /** Insert/replace one overlay (in-memory + SQLite). */
  addOverlay: (ro: ResearchOverlayType) => Promise<void>;
  /** Remove from in-memory + SQLite. */
  removeOverlay: (id: string) => Promise<void>;
}

export const useResearchOverlayLibraryStore = create<ResearchOverlayLibraryState>((set, get) => ({
  overlays: [],
  hydrated: false,

  hydrate: async () => {
    try {
      const rows = await dbResearchOverlaysList();
      const parsed: PersistedResearchOverlay[] = [];
      for (const r of rows) {
        const overlay = parseResearchOverlayRow(r);
        if (overlay) parsed.push(overlay);
      }
      set({ overlays: parsed, hydrated: true });
    } catch (err) {
      console.warn('[TODO P8 toast] dbResearchOverlaysList failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'warn',
          title: 'Research overlays unavailable',
          detail: 'Could not read saved overlays from disk',
        }),
      );
      set({ hydrated: true });
    }
  },

  setOverlays: (overlays) => set({ overlays }),

  addOverlay: async (ro) => {
    // Optimistic local update first.
    const created_at = Date.now();
    const persisted: PersistedResearchOverlay = { ...ro, created_at };
    const prev = get().overlays.filter((x) => x.id !== ro.id);
    set({ overlays: [...prev, persisted] });
    try {
      await dbResearchOverlaysUpsert({
        id: ro.id,
        json: JSON.stringify(ro),
        created_at,
      });
    } catch (err) {
      console.warn('[TODO P8 toast] dbResearchOverlaysUpsert failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Overlay not saved',
          detail: 'Kept locally; disk write failed',
        }),
      );
    }
  },

  removeOverlay: async (id) => {
    set({ overlays: get().overlays.filter((o) => o.id !== id) });
    try {
      await dbResearchOverlaysDelete(id);
    } catch (err) {
      console.warn('[TODO P8 toast] dbResearchOverlaysDelete failed', err);
      void import('./useToastStore').then((m) =>
        m.useToastStore.getState().push({
          kind: 'error',
          title: 'Overlay not deleted',
          detail: 'Disk row could not be removed',
        }),
      );
    }
  },
}));

// ---------------------------------------------------------------------------
// Row parsing — silently skip malformed JSON so a single bad row doesn't
// poison the whole hydrate. Uses Zod `safeParse` for strict validation.
// ---------------------------------------------------------------------------

function parseResearchOverlayRow(r: ResearchOverlayRow): PersistedResearchOverlay | null {
  try {
    const obj = JSON.parse(r.json) as unknown;
    const result = ResearchOverlay.safeParse(obj);
    if (!result.success) {
      console.warn('[TODO P8 toast] malformed ResearchOverlay in SQLite, skipping', r.id, result.error.issues);
      return null;
    }
    return { ...result.data, created_at: r.created_at };
  } catch {
    console.warn('[TODO P8 toast] malformed JSON in SQLite, skipping', r.id);
  }
  return null;
}
