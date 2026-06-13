/**
 * src/stores/useChartMutationStore.test.ts — Vitest unit tests for
 * useChartMutationStore, focused on the researchOverlayVersion counter
 * added in Step 3.
 *
 * Strategy:
 *   - Reset store to initial state before each test so state doesn't leak.
 *   - Call store actions directly via `getState()` (no React, no mocks needed
 *     — the store is pure Zustand).
 *   - Assert that researchOverlayVersion increments on apply, remove, and
 *     pruning prunes, and does NOT increment on a no-op prune.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ResearchOverlay } from '../ai/schemas';
import { useChartMutationStore } from './useChartMutationStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOverlay(overrides: Partial<ResearchOverlay> = {}): ResearchOverlay {
  return {
    id: 'ro-1',
    sym: 'BTC',
    tf: '1d',
    label: 'Test overlay',
    elements: [],
    ...overrides,
  };
}

function resetStore() {
  useChartMutationStore.setState({
    researchOverlays: {},
    researchOverlayVersion: 0,
  });
}

beforeEach(() => {
  resetStore();
});

// ---------------------------------------------------------------------------
// researchOverlayVersion — apply
// ---------------------------------------------------------------------------

describe('useChartMutationStore — researchOverlayVersion on applyResearchOverlay', () => {
  it('starts at 0', () => {
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(0);
  });

  it('increments by 1 on first apply', () => {
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay());
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(1);
  });

  it('increments again on a second apply (replace)', () => {
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay());
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ label: 'Updated' }));
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(2);
  });

  it('stores the overlay in researchOverlays alongside the version bump', () => {
    const ro = makeOverlay({ id: 'ro-test' });
    useChartMutationStore.getState().applyResearchOverlay(ro);
    expect(useChartMutationStore.getState().researchOverlays['ro-test']).toEqual(ro);
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// researchOverlayVersion — remove
// ---------------------------------------------------------------------------

describe('useChartMutationStore — researchOverlayVersion on removeResearchOverlay', () => {
  it('increments when an existing overlay is removed', () => {
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ id: 'ro-a' }));
    const versionAfterApply = useChartMutationStore.getState().researchOverlayVersion;

    useChartMutationStore.getState().removeResearchOverlay('ro-a');
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(versionAfterApply + 1);
    expect(useChartMutationStore.getState().researchOverlays['ro-a']).toBeUndefined();
  });

  it('still increments when removing a non-existent id (remove is unconditional)', () => {
    // The remove action always bumps the version — it does a delete on a copy
    // regardless of whether the key existed. This is intentional: callers
    // issuing a remove expect a repaint.
    useChartMutationStore.getState().removeResearchOverlay('does-not-exist');
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// researchOverlayVersion — pruneResearchOverlays
// ---------------------------------------------------------------------------

describe('useChartMutationStore — researchOverlayVersion on pruneResearchOverlays', () => {
  it('increments when at least one overlay is pruned', () => {
    // Apply two overlays on different (sym, tf) pairs.
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ id: 'keep', sym: 'BTC', tf: '1d' }));
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ id: 'drop', sym: 'ETH', tf: '1d' }));
    const vBefore = useChartMutationStore.getState().researchOverlayVersion;

    // Prune to BTC/1d — 'drop' should be removed.
    useChartMutationStore.getState().pruneResearchOverlays('BTC', '1d');
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(vBefore + 1);
    expect(useChartMutationStore.getState().researchOverlays['keep']).toBeDefined();
    expect(useChartMutationStore.getState().researchOverlays['drop']).toBeUndefined();
  });

  it('does NOT increment on a no-op prune (all overlays already match)', () => {
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ id: 'ro-1', sym: 'BTC', tf: '1d' }));
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ id: 'ro-2', sym: 'BTC', tf: '1d' }));
    const vBefore = useChartMutationStore.getState().researchOverlayVersion;

    // Prune to the same (sym, tf) — nothing should be removed.
    useChartMutationStore.getState().pruneResearchOverlays('BTC', '1d');
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(vBefore);
  });

  it('does NOT increment on a no-op prune when the store is empty', () => {
    useChartMutationStore.getState().pruneResearchOverlays('BTC', '1d');
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(0);
  });

  it('sym match is case-insensitive for pruning', () => {
    useChartMutationStore.getState().applyResearchOverlay(makeOverlay({ id: 'ro-btc', sym: 'BTC', tf: '1d' }));
    const vBefore = useChartMutationStore.getState().researchOverlayVersion;

    // Lower-case sym in the prune call must still match the upper-case stored sym.
    useChartMutationStore.getState().pruneResearchOverlays('btc', '1d');
    expect(useChartMutationStore.getState().researchOverlayVersion).toBe(vBefore);
    expect(useChartMutationStore.getState().researchOverlays['ro-btc']).toBeDefined();
  });
});
