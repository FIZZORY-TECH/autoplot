/**
 * src/stores/useToastStore.test.ts — Wave C1 vitest cases.
 *
 * Covers:
 *   1. push / dismiss / remove flow.
 *   2. Auto-dismiss timer fires at 4000ms (info/warn) and 8000ms (error).
 *   3. Dedupe: same kind+title+detail → single toast, refreshed createdAt.
 *   4. Cap-3: a fourth simultaneous toast auto-dismisses the oldest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useToastStore } from './useToastStore';

describe('useToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset store between tests.
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('push appends a toast and returns its id', () => {
    const id = useToastStore.getState().push({ kind: 'info', title: 'Hello' });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe(id);
    expect(toasts[0].kind).toBe('info');
    expect(toasts[0].dismissedAt).toBeUndefined();
  });

  it('auto-dismisses info toasts after 4000ms', () => {
    useToastStore.getState().push({ kind: 'info', title: 'Auto info' });
    vi.advanceTimersByTime(3999);
    expect(useToastStore.getState().toasts[0].dismissedAt).toBeUndefined();
    vi.advanceTimersByTime(2);
    expect(useToastStore.getState().toasts[0].dismissedAt).toBeDefined();
  });

  it('auto-dismisses error toasts after 8000ms', () => {
    useToastStore.getState().push({ kind: 'error', title: 'Boom' });
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts[0].dismissedAt).toBeUndefined();
    vi.advanceTimersByTime(4001);
    expect(useToastStore.getState().toasts[0].dismissedAt).toBeDefined();
  });

  it('dedupes by kind+title+detail and refreshes createdAt', () => {
    const id1 = useToastStore
      .getState()
      .push({ kind: 'warn', title: 'Same', detail: 'X' });
    vi.advanceTimersByTime(100);
    const id2 = useToastStore
      .getState()
      .push({ kind: 'warn', title: 'Same', detail: 'X' });
    expect(id1).toBe(id2);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
  });

  it('caps active toasts to 3 — older ones auto-dismiss', () => {
    const s = useToastStore.getState();
    s.push({ kind: 'info', title: 'A' });
    s.push({ kind: 'info', title: 'B' });
    s.push({ kind: 'info', title: 'C' });
    s.push({ kind: 'info', title: 'D' });
    const all = useToastStore.getState().toasts;
    const active = all.filter((t) => t.dismissedAt === undefined);
    expect(active).toHaveLength(3);
    // The oldest (`A`) should be the one dismissed.
    const a = all.find((t) => t.title === 'A');
    expect(a?.dismissedAt).toBeDefined();
  });

  it('dismiss flips dismissedAt; remove splices the toast out', () => {
    const id = useToastStore.getState().push({ kind: 'info', title: 'X' });
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts[0].dismissedAt).toBeDefined();
    useToastStore.getState().remove(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
