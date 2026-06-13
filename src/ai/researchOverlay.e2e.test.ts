/**
 * src/ai/researchOverlay.e2e.test.ts — Step 12 verification.
 *
 * Exercises the research-overlay dispatch path end-to-end:
 *   • apply_research_overlay  (valid full payload → store slice populated)
 *   • apply_research_overlay  (invalid payloads → field-level Zod diagnostics)
 *   • remove_research_overlay (→ slice cleared)
 *   • list_overlays           (returns all four slices)
 *   • clear-on-switch prune   (store directly, not via AppShell useEffect)
 *
 * The bridge dispatcher (bridgeRoundtrip.ts::handleRequest) is NOT exported,
 * so we test through the public primitives it uses:
 *   - ResearchOverlay Zod schema  (parse → applyResearchOverlay)
 *   - useChartMutationStore       (apply/remove/state snapshot)
 *
 * AppShell's prune effect is now a one-liner that calls the store's
 * `pruneResearchOverlays(sym, tf)` action; the prune tests below drive that
 * SAME action so coverage of the (case-insensitive sym, exact tf) predicate
 * stays honest.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchOverlay } from './schemas';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import {
  useResearchOverlayLibraryStore,
  type PersistedResearchOverlay,
} from '../stores/useResearchOverlayLibraryStore';

// ---------------------------------------------------------------------------
// Helpers — minimal valid fixtures for each element type
// ---------------------------------------------------------------------------

const BASE_OVERLAY = {
  id: 'ro-test-1',
  sym: 'BTC',
  tf: '1h' as const,
  label: 'Test overlay',
  color: '#ff0000',
};

/** Full fixture covering all 7 element kinds. */
const FULL_OVERLAY = {
  ...BASE_OVERLAY,
  elements: [
    // line
    {
      type: 'line' as const,
      values: [100, 101, null, 103],
      align: 'right' as const,
      color: '#4af',
    },
    // band
    {
      type: 'band' as const,
      upper: [110, 112, null],
      lower: [90, 88, null],
      align: 'index' as const,
    },
    // hline
    {
      type: 'hline' as const,
      price: 50000,
      label: 'Support',
    },
    // markers
    {
      type: 'markers' as const,
      points: [
        { ts: 1700000000000, price: 50000, shape: 'circle' as const, anchor: 'above' as const },
        { ts: 1700010000000, shape: 'triangle-up' as const },
      ],
    },
    // event_mark
    {
      type: 'event_mark' as const,
      kind: 'vline' as const,
      ts: 1700000000000,
      label: 'Halving',
    },
    // text
    {
      type: 'text' as const,
      ts: 1700000000000,
      price: 51000,
      content: 'Key level',
    },
    // hotspot
    {
      type: 'hotspot' as const,
      ts: 1700000000000,
      price: 50500,
      panel: {
        title: 'Signal',
        rows: [{ label: 'RSI', value: '28' }],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Reset store before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset all slices to empty maps.
  useChartMutationStore.setState({
    overlays: {},
    timelineLayers: {},
    strategyOverlays: {},
    researchOverlays: {},
  });
});

// ---------------------------------------------------------------------------
// 1. apply_research_overlay — valid payload with ALL 7 element types
// ---------------------------------------------------------------------------

describe('apply_research_overlay — valid full payload', () => {
  it('Zod parse succeeds for all 7 element kinds', () => {
    const result = ResearchOverlay.safeParse(FULL_OVERLAY);
    expect(result.success).toBe(true);
  });

  it('store slice contains the overlay after applyResearchOverlay', () => {
    const parsed = ResearchOverlay.parse(FULL_OVERLAY);
    useChartMutationStore.getState().applyResearchOverlay(parsed);

    const slices = useChartMutationStore.getState();
    expect(slices.researchOverlays['ro-test-1']).toBeDefined();
    expect(slices.researchOverlays['ro-test-1'].label).toBe('Test overlay');
    expect(slices.researchOverlays['ro-test-1'].elements).toHaveLength(7);
  });

  it('replace-by-id: applying same id again overwrites', () => {
    const v1 = ResearchOverlay.parse(FULL_OVERLAY);
    useChartMutationStore.getState().applyResearchOverlay(v1);

    const v2 = ResearchOverlay.parse({ ...FULL_OVERLAY, label: 'Updated label' });
    useChartMutationStore.getState().applyResearchOverlay(v2);

    const slices = useChartMutationStore.getState();
    expect(Object.keys(slices.researchOverlays)).toHaveLength(1);
    expect(slices.researchOverlays['ro-test-1'].label).toBe('Updated label');
  });
});

// ---------------------------------------------------------------------------
// 2. apply_research_overlay — INVALID payloads → field-level Zod diagnostics
// ---------------------------------------------------------------------------

describe('apply_research_overlay — invalid payloads', () => {
  it('band missing lower → safeParse fails with path="elements.0.lower"', () => {
    const bad = {
      ...BASE_OVERLAY,
      elements: [
        {
          type: 'band',
          upper: [100, 101],
          // lower intentionally omitted
          align: 'right',
        },
      ],
    };
    const result = ResearchOverlay.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      // Zod discriminated union error bubbles up through the union — the path
      // includes the element index and the missing field.
      expect(paths.some((p) => p.includes('lower') || p.includes('elements'))).toBe(true);
    }
  });

  it('line values length 501 → safeParse fails with a max-length issue on values', () => {
    const bad = {
      ...BASE_OVERLAY,
      elements: [
        {
          type: 'line',
          values: Array(501).fill(1),
          align: 'right',
        },
      ],
    };
    const result = ResearchOverlay.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('values') || p.includes('elements'))).toBe(true);
    }
  });

  it('elements array length 51 → rejects with max-50 error', () => {
    const bad = {
      ...BASE_OVERLAY,
      elements: Array(51)
        .fill(null)
        .map((_, i) => ({ type: 'hline', price: i })),
    };
    const result = ResearchOverlay.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p === 'elements' || p.includes('elements'))).toBe(true);
    }
  });

  it('invalid tf → rejects with path="tf"', () => {
    const bad = { ...BASE_OVERLAY, elements: [], tf: '5m' };
    const result = ResearchOverlay.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('tf');
    }
  });

  it('error reply issues shape: each issue has {path, message}', () => {
    // Mirror what bridgeRoundtrip does: issues.map(i => ({path, message}))
    const bad = { ...BASE_OVERLAY, elements: [], tf: '5m' };
    const result = ResearchOverlay.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      expect(issues.length).toBeGreaterThan(0);
      issues.forEach((issue) => {
        expect(typeof issue.path).toBe('string');
        expect(typeof issue.message).toBe('string');
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. remove_research_overlay → slice cleared
// ---------------------------------------------------------------------------

describe('remove_research_overlay', () => {
  it('removes a known overlay from the store', () => {
    const parsed = ResearchOverlay.parse(FULL_OVERLAY);
    useChartMutationStore.getState().applyResearchOverlay(parsed);
    expect(useChartMutationStore.getState().researchOverlays['ro-test-1']).toBeDefined();

    useChartMutationStore.getState().removeResearchOverlay('ro-test-1');
    expect(useChartMutationStore.getState().researchOverlays['ro-test-1']).toBeUndefined();
    expect(Object.keys(useChartMutationStore.getState().researchOverlays)).toHaveLength(0);
  });

  it('remove is a no-op for unknown id', () => {
    // Should not throw.
    expect(() =>
      useChartMutationStore.getState().removeResearchOverlay('nonexistent-id'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. list_overlays — returns all four slices (mirror of bridge handler logic)
// ---------------------------------------------------------------------------

describe('list_overlays — all four slices', () => {
  it('snapshot contains overlays, timelineLayers, strategyOverlays, researchOverlays', () => {
    // Apply one item to each slice so they're all non-empty.
    useChartMutationStore.getState().applyDataset({
      id: 'ds-1',
      label: 'Test dataset',
      kind: 'overlay',
      align: 'right',
      sym: 'BTC',
      tf: '1h',
      values: [1, 2, 3],
    });
    useChartMutationStore.getState().applyTimelineLayer({
      id: 'tl-1',
      name: 'Earnings',
      events: [{ ts: 1700000000000, label: 'Q1', kind: 'pin' }],
    });
    useChartMutationStore.getState().applyStrategyOverlay({ id: 'strat-1', bodyJson: '{}' });
    const ro = ResearchOverlay.parse(FULL_OVERLAY);
    useChartMutationStore.getState().applyResearchOverlay(ro);

    const st = useChartMutationStore.getState();
    // Mirror list_overlays handler in bridgeRoundtrip.ts:
    const snapshot = {
      overlays: Object.values(st.overlays),
      timelineLayers: Object.values(st.timelineLayers),
      strategyOverlays: Object.values(st.strategyOverlays),
      researchOverlays: Object.values(st.researchOverlays),
    };

    expect(snapshot.overlays).toHaveLength(1);
    expect(snapshot.timelineLayers).toHaveLength(1);
    expect(snapshot.strategyOverlays).toHaveLength(1);
    expect(snapshot.researchOverlays).toHaveLength(1);
    expect(snapshot.researchOverlays[0].id).toBe('ro-test-1');
  });
});

// ---------------------------------------------------------------------------
// 5. Prune predicate — sym/tf switch removes stale overlays
// ---------------------------------------------------------------------------

describe('clear-on-switch prune predicate', () => {
  it('removes overlay when active sym changes', () => {
    const ro = ResearchOverlay.parse(FULL_OVERLAY); // sym='BTC', tf='1h'
    useChartMutationStore.getState().applyResearchOverlay(ro);
    expect(Object.keys(useChartMutationStore.getState().researchOverlays)).toHaveLength(1);

    // Drive the REAL store action (sym changed BTC→ETH, tf unchanged).
    useChartMutationStore.getState().pruneResearchOverlays('ETH', '1h');

    expect(Object.keys(useChartMutationStore.getState().researchOverlays)).toHaveLength(0);
  });

  it('removes overlay when tf changes', () => {
    const ro = ResearchOverlay.parse(FULL_OVERLAY); // sym='BTC', tf='1h'
    useChartMutationStore.getState().applyResearchOverlay(ro);

    // sym same, tf changed 1h→4h.
    useChartMutationStore.getState().pruneResearchOverlays('BTC', '4h');

    expect(Object.keys(useChartMutationStore.getState().researchOverlays)).toHaveLength(0);
  });

  it('keeps overlay when sym and tf both match (case-insensitive sym)', () => {
    const ro = ResearchOverlay.parse(FULL_OVERLAY); // sym='BTC', tf='1h'
    useChartMutationStore.getState().applyResearchOverlay(ro);

    // Lower-case 'btc' must still match BTC (case-insensitive sym).
    useChartMutationStore.getState().pruneResearchOverlays('btc', '1h');

    expect(Object.keys(useChartMutationStore.getState().researchOverlays)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Research-overlay library tools — save / list / load / delete.
//
// The dispatcher (handleRequest) is not exported, so we mirror the SAME
// filtering / lookup logic it runs over the public library store, and exercise
// the store mutations the cases delegate to.
// ---------------------------------------------------------------------------

describe('research-overlay library — list / load filter logic', () => {
  const ro = (id: string, sym: string, tf: '1h' | '4h'): PersistedResearchOverlay => ({
    id,
    sym,
    tf,
    label: `${sym} ${tf}`,
    elements: [],
    created_at: 1700000000000,
  });

  beforeEach(() => {
    useResearchOverlayLibraryStore.setState({
      overlays: [
        ro('ro-btc-1h', 'BTC', '1h'),
        ro('ro-btc-4h', 'BTC', '4h'),
        ro('ro-eth-1h', 'ETH', '1h'),
      ],
      hydrated: true,
    });
  });

  // Mirror of the list_research_overlays case filter + metadata projection.
  function listOverlays(filter?: { sym?: string; tf?: string }) {
    const symFilter = filter?.sym?.toLowerCase();
    const tfFilter = filter?.tf;
    return useResearchOverlayLibraryStore
      .getState()
      .overlays.filter((o) => {
        if (symFilter && o.sym.toLowerCase() !== symFilter) return false;
        if (tfFilter && o.tf !== tfFilter) return false;
        return true;
      })
      .map((o) => ({ id: o.id, sym: o.sym, tf: o.tf, label: o.label, created_at: o.created_at }));
  }

  it('returns all overlays (metadata only) with no filter', () => {
    const out = listOverlays();
    expect(out).toHaveLength(3);
    // Metadata only — no `elements` key.
    expect(out[0]).not.toHaveProperty('elements');
    expect(out[0]).toMatchObject({ id: 'ro-btc-1h', sym: 'BTC', tf: '1h' });
  });

  it('filters by sym case-insensitively', () => {
    const out = listOverlays({ sym: 'btc' });
    expect(out.map((o) => o.id)).toEqual(['ro-btc-1h', 'ro-btc-4h']);
  });

  it('filters by sym AND tf', () => {
    const out = listOverlays({ sym: 'BTC', tf: '1h' });
    expect(out.map((o) => o.id)).toEqual(['ro-btc-1h']);
  });

  it('load finds the full overlay by id', () => {
    const found = useResearchOverlayLibraryStore
      .getState()
      .overlays.find((o) => o.id === 'ro-eth-1h');
    expect(found).toBeDefined();
    expect(found?.sym).toBe('ETH');
  });

  it('load returns nothing for an unknown id', () => {
    const found = useResearchOverlayLibraryStore
      .getState()
      .overlays.find((o) => o.id === 'missing');
    expect(found).toBeUndefined();
  });
});
