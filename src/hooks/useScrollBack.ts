/**
 * src/hooks/useScrollBack.ts — Lazy scroll-back pagination (Step 4 Part A).
 *
 * When the user pans the chart back to the LEFT (past) edge of the loaded
 * window, this hook lazily fetches an OLDER page of bars via the registry's
 * `PaginatedProvider.fetchHistoryBefore`, prepends them, and shifts the
 * x-window so the on-screen viewport stays visually fixed.
 *
 * Design constraints (see the approved Step 4 plan):
 *   - `loadingOlder` is a `useRef`, NOT state — it must survive the concurrent
 *     re-render that `setBars` + the view-shift trigger, and it must not be
 *     re-armed by a stale closure mid-flight.
 *   - The trigger is debounced (~150ms) and keyed on the window's left edge so
 *     a continuous pan fires at most one fetch per debounce window.
 *   - On resolve we DISCARD the page if `sym`/`tf` changed during the fetch —
 *     no prepend, no view shift, no cache write (stale-symbol race guard).
 *   - A 0-row page sets `hasMoreHistory = false` so we stop arming forever.
 *   - `hasMoreHistory` / `earliestLoadedTs` reset whenever `sym` or `tf` flips.
 *   - `dedupByTs` is pure + exported so Step 5a can unit-test the merge/shift
 *     math without Playwright.
 *
 * Visual behavior is untouched — this hook only grows `bars` and translates
 * the x-window; ChartCanvas rendering and the clamp logic are unchanged here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bar, Provider, Tf } from '../data/MarketDataProvider';
import { getProvider } from '../data/providerRegistry';
import { ohlcCache } from '../data/ohlcCache';
import { useToastStore } from '../stores/useToastStore';

/** Bars to request per older-page fetch. */
const PAGE_OLDER = 300;

/**
 * Left-edge threshold (in bar indices). The interaction `clampWindow` is
 * relaxed (Step 4 task 2) to let `start` slip slightly below 0; once the
 * window's left edge reaches this value the older-page fetch is armed.
 */
const LEFT_TRIGGER = 8;

/** Debounce (ms) on the left-edge trigger so a continuous pan fires once. */
const DEBOUNCE_MS = 150;

/**
 * Cooldown (ms) applied after a failed fetch so we surface the error once and
 * do NOT spin in a re-arm loop while the user keeps the window pinned left.
 */
const ERROR_COOLDOWN_MS = 4000;

/**
 * Keep one bar per `ts`, ascending. Pure + exported for unit tests.
 *
 * Later entries in the input win on a `ts` collision — callers pass
 * `[...older, ...bars]` so the freshly-fetched older bars are overwritten by
 * any already-loaded bar sharing the same slot (the loaded bar may carry live
 * tick updates the historical page lacks).
 */
export function dedupByTs(bars: Bar[]): Bar[] {
  const byTs = new Map<number, Bar>();
  for (const b of bars) {
    byTs.set(b.ts, b);
  }
  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

export interface UseScrollBackArgs {
  bars: Bar[];
  setBars: (bars: Bar[]) => void;
  xWindow: { start: number; end: number };
  setXWindow: (next: { start: number; end: number }) => void;
  sym: string;
  tf: Tf;
  provider: Provider;
  quote: string;
}

export interface UseScrollBackState {
  /** False once a 0-row page proves there is no older history. */
  hasMoreHistory: boolean;
  /** True while an older-page fetch is in flight (read of the live ref). */
  loadingOlder: boolean;
}

/**
 * Hook: arms an older-page fetch when the chart is panned to the left edge.
 *
 * Returns lightweight diagnostic state (mostly for tests / future UI). The
 * primary effects are side effects on `setBars` / `setXWindow`.
 */
export function useScrollBack({
  bars,
  setBars,
  xWindow,
  setXWindow,
  sym,
  tf,
  provider,
  quote,
}: UseScrollBackArgs): UseScrollBackState {
  // loadingOlder is a REF, not state — it must survive the concurrent
  // re-render that setBars + the x-window shift trigger, and must not be
  // re-armed by a stale closure while a fetch is in flight.
  const loadingOlder = useRef(false);

  // hasMoreHistory is state so consumers can observe it.
  const [hasMoreHistory, setHasMoreHistory] = useState(true);

  // Short cooldown after a failed fetch — gates re-arming so we don't loop.
  const cooldownUntil = useRef(0);

  // Reset pagination bookkeeping whenever the instrument or timeframe changes.
  // A fresh symbol/tf starts from "there might be more history" again, and any
  // in-flight fetch is logically abandoned (the resolve handler also discards
  // by comparing the captured cap against the live sym/tf).
  useEffect(() => {
    setHasMoreHistory(true);
    loadingOlder.current = false;
    cooldownUntil.current = 0;
  }, [sym, tf]);

  // Surface a fetch failure exactly once (matches the AppShell toast pattern).
  const reportError = useCallback((s: string, t: Tf) => {
    useToastStore.getState().push({
      kind: 'warn',
      title: 'Older history unavailable',
      detail: `${s} ${t} could not load earlier bars`,
    });
  }, []);

  // Debounced left-edge trigger. Keyed on xWindow.start so a continuous pan
  // collapses into a single fetch per debounce window.
  const start = xWindow.start;
  useEffect(() => {
    // Empty / short history must skip the trigger entirely (no bars[0]).
    const firstTs = bars[0]?.ts;
    if (firstTs === undefined) return;
    if (!hasMoreHistory) return;
    if (loadingOlder.current) return;
    if (start > LEFT_TRIGGER) return;
    if (Date.now() < cooldownUntil.current) return;

    const handle = window.setTimeout(() => {
      // Re-check guards inside the debounce — state may have moved on.
      if (loadingOlder.current) return;
      if (!hasMoreHistory) return;
      if (Date.now() < cooldownUntil.current) return;
      const before = bars[0]?.ts;
      if (before === undefined) return;

      // Arm + capture the instrument identity at fetch time. The resolve
      // handler discards the page if this no longer matches the live sym/tf.
      loadingOlder.current = true;
      const cap = { sym, tf };

      getProvider(provider, quote)
        .fetchHistoryBefore(cap.sym, cap.tf, before, PAGE_OLDER)
        .then((older) => {
          // Stale-symbol race guard — a sym/tf switch happened mid-flight.
          if (cap.sym !== sym || cap.tf !== tf) return; // DISCARD

          if (older.length === 0) {
            // Proven end of history — stop arming forever (for this sym/tf).
            setHasMoreHistory(false);
            return;
          }

          // Merge older + current, dedup by ts, ascending. Current bars win on
          // a ts collision (they may carry live-tick close updates).
          const merge = dedupByTs([...older, ...bars]);
          const inserted = merge.length - bars.length;
          setBars(merge);

          // Shift the x-window by the count of newly-prepended bars so the
          // on-screen viewport stays put (every visible bar keeps its x).
          if (inserted > 0) {
            setXWindow({ start: start + inserted, end: xWindow.end + inserted });
          }

          // Keep the in-memory cache consistent with the grown range so a
          // later same-instrument fetch sees the extended history.
          ohlcCache.set(provider, cap.sym, quote, cap.tf, merge);
        })
        .catch((err) => {
          // Cooldown so we surface the failure once and don't loop.
          cooldownUntil.current = Date.now() + ERROR_COOLDOWN_MS;
          // eslint-disable-next-line no-console
          console.warn(`[scrollback] fetchHistoryBefore failed for ${cap.sym}@${cap.tf}:`, err);
          // Only toast for the live instrument (a stale failure is irrelevant).
          if (cap.sym === sym && cap.tf === tf) reportError(cap.sym, cap.tf);
        })
        .finally(() => {
          loadingOlder.current = false;
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
    // `start` and `bars` drive the trigger; the setters are stable. We
    // intentionally key on the latest closure each render so the captured
    // `bars`/`xWindow` are fresh when the debounce fires.
  }, [start, bars, xWindow.end, hasMoreHistory, sym, tf, provider, quote, setBars, setXWindow, reportError]);

  return {
    hasMoreHistory,
    loadingOlder: loadingOlder.current,
  };
}
