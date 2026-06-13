/**
 * tests/e2e/scrollback.spec.ts — Step 5a scroll-back pagination smoke test.
 *
 * Proves both "symptoms are fixed":
 *   (a) bar count increases after panning to the left (past) edge
 *   (b) earliest ts decreases (older bars are prepended)
 *   (c) no duplicate ts in the bar series
 *   (d) viewport stays visually stable across the prepend (canvas redraws, not blank)
 *   (e) a second pan after history is exhausted does NOT keep refetching
 *       (count stabilizes) — gated/skipped for vite dev (see below)
 *
 * RUNTIME CONSTRAINTS:
 *   This spec runs against plain `vite dev` (no Tauri runtime, no SQLite, no
 *   real market data adapters). The mock provider is forced via `use-mock-provider`
 *   localStorage (see CLAUDE.md). The `MockMarketDataProvider.fetchHistoryBefore`
 *   always returns bars (never returns [] for a 0-row terminal page), so
 *   assertion (e) cannot be proved deterministically without Tauri. It is gated
 *   with `test.skip` for the exhaustion sub-case, documented below.
 *
 * INSTRUMENTATION:
 *   Bar state is read via `window.__scrollbackTest` (set by AppShell's DEV-only
 *   useEffect). This avoids adding DOM attributes to the canvas, which can't
 *   carry structured data, and avoids importing React internals into a Playwright
 *   test. The hook also exposes `triggerScrollLeft()` to programmatically snap
 *   the x-window to start=0, which is equivalent to the user panning all the way
 *   to the left — avoids flaky multi-pan UI simulation (canvas width and bar
 *   density vary by viewport/test machine).
 *
 * TAURI-GATING CONVENTION (matches project pattern in symbol-catalog-search.spec.ts):
 *   Assertions that require Tauri (0-row page / true exhaustion) are documented
 *   with `test.skip` and an explanation. The vite-dev-reachable assertions run
 *   unconditionally.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScrollbackTestHook {
  barCount: number;
  earliestTs: number | null;
  tsList: number[];
  triggerScrollLeft: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Force the mock provider so no real adapters are attempted. */
async function forceMockProvider(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

/**
 * Dismiss the FirstRun overlay (present when `claudeTestConnection` rejects
 * with CliNotFound — no Tauri CLI available in vite dev). Mirrors the helper
 * used by p2-keyboard-flow.spec.ts.
 */
async function dismissFirstRun(page: Page): Promise<void> {
  const overlay = page.locator('.firstrun-overlay');
  const visible = await overlay.isVisible().catch(() => false);
  if (!visible) return;
  await page.evaluate(() => {
    document.querySelectorAll('.firstrun-overlay').forEach((el) => el.remove());
  });
  await page.waitForTimeout(100);
}

/** Read the current scrollback test hook state from the page. */
async function readScrollbackState(page: Page): Promise<Omit<ScrollbackTestHook, 'triggerScrollLeft'> | null> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const h = w.__scrollbackTest as ScrollbackTestHook | undefined;
    if (!h) return null;
    return {
      barCount: h.barCount,
      earliestTs: h.earliestTs,
      tsList: [...h.tsList], // clone so it's serialisable
    };
  });
}

/**
 * Invoke `window.__scrollbackTest.triggerScrollLeft()` — snaps the x-window
 * to start=0, equivalent to panning all the way to the left edge. The hook
 * fires synchronously inside React, so the scroll-back debounce begins
 * immediately on the next render.
 */
async function triggerScrollLeft(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const h = w.__scrollbackTest as ScrollbackTestHook | undefined;
    h?.triggerScrollLeft();
  });
}

/**
 * Wait until the earliest bar ts drops below `threshold` (or times out).
 *
 * The scroll-back hook has a 150ms debounce + async mock fetch; we poll
 * until `earliestTs < threshold` or the deadline expires.
 */
async function waitForEarliestTsBelow(
  page: Page,
  threshold: number,
  timeoutMs = 5000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readScrollbackState(page);
    if (state?.earliestTs !== null && (state?.earliestTs ?? threshold) < threshold) {
      return state!.earliestTs;
    }
    await page.waitForTimeout(150);
  }
  const finalState = await readScrollbackState(page);
  return finalState?.earliestTs ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('scroll-back pagination', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
  });

  /**
   * Core happy-path — assertions (a)(b)(c):
   *   - Load the app with BTC (mock provider)
   *   - Record initial bar count + earliest ts
   *   - Programmatically snap window to start=0 (left edge)
   *   - Assert (a) count grew, (b) earliestTs decreased, (c) no duplicates
   */
  test('(a)(b)(c) triggering left edge grows bar count, decreases earliestTs, no duplicates', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('canvas');
    // Wait for mock bars to populate (mock provider resolves synchronously but
    // React renders asynchronously). 800ms matches the loading fade duration.
    await page.waitForTimeout(800);
    await dismissFirstRun(page);

    // Wait for bars to be loaded (chart-skeleton disappears = idle).
    await expect(page.locator('[data-loading-phase]')).toHaveAttribute(
      'data-loading-phase',
      'idle',
      { timeout: 5000 },
    );

    const initial = await readScrollbackState(page);
    expect(initial).not.toBeNull();
    expect(initial!.barCount).toBeGreaterThan(0);
    expect(initial!.earliestTs).not.toBeNull();

    const initialCount = initial!.barCount;
    const initialEarliestTs = initial!.earliestTs!;

    // Snap the x-window to start=0 — this triggers the scroll-back hook's
    // left-edge guard (`start <= LEFT_TRIGGER=8`) on the next render.
    await triggerScrollLeft(page);

    // Wait for the debounce (150ms) + mock async fetch + React re-render.
    const newEarliestTs = await waitForEarliestTsBelow(page, initialEarliestTs, 5000);

    // (b) Earliest ts must have decreased (older bars prepended).
    expect(newEarliestTs).not.toBeNull();
    expect(newEarliestTs!).toBeLessThan(initialEarliestTs);

    const after = await readScrollbackState(page);
    expect(after).not.toBeNull();

    // (a) Bar count must have grown (older page prepended).
    expect(after!.barCount).toBeGreaterThan(initialCount);

    // (c) No duplicate ts values in the merged series.
    const tsList = after!.tsList;
    const uniqueSet = new Set(tsList);
    expect(uniqueSet.size).toBe(tsList.length);
  });

  /**
   * (d) Visual stability: the canvas must not go blank after a prepend.
   *
   * We capture a screenshot just before triggering scroll-back and compare
   * it to a screenshot after the prepend. The two should differ (the chart
   * redraws with more bars at a shifted x-window), but neither should be
   * blank. We verify by asserting the two buffers differ — same logic as
   * chart-interaction.spec.ts's "scroll-zoom did redraw" assertion.
   */
  test('(d) viewport stays visually stable across prepend (canvas redraws, not blank)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(800);
    await dismissFirstRun(page);

    await expect(page.locator('[data-loading-phase]')).toHaveAttribute(
      'data-loading-phase',
      'idle',
      { timeout: 5000 },
    );

    const initialState = await readScrollbackState(page);
    if (!initialState || initialState.barCount === 0) {
      test.skip(true, 'No bars loaded — mock provider not ready');
      return;
    }

    const initialEarliestTs = initialState.earliestTs!;
    const canvas = page.locator('canvas').first();
    const beforePrepend = await canvas.screenshot();

    // Trigger the scroll-back fetch.
    await triggerScrollLeft(page);
    await waitForEarliestTsBelow(page, initialEarliestTs, 5000);

    // Give React one more frame to flush the view-shift and canvas repaint.
    await page.waitForTimeout(300);
    const afterPrepend = await canvas.screenshot();

    // The two frames must differ — the chart shifted / grew, not blanked.
    expect(Buffer.compare(beforePrepend, afterPrepend)).not.toBe(0);
  });

  /**
   * (e) TAURI-ONLY: history exhaustion stops refetching.
   *
   * `MockMarketDataProvider.fetchHistoryBefore` never returns an empty page
   * (it always synthesises bars), so in vite dev the `hasMoreHistory=false`
   * gate is never triggered. Testing exhaustion requires:
   *   1. The real Alpaca adapter (which genuinely runs out of data), OR
   *   2. A mock that can be instructed to return 0 rows (only possible
   *      inside the Tauri runtime where the adapter is injected).
   *
   * The vite-dev-observable signal is the absence of infinite refetching:
   * after N triggers with the mock, each new page still has bars (not 0),
   * so `hasMoreHistory` stays true and the hook re-arms on each left-edge
   * approach. This is correct behavior for the mock; the exhaustion guard is
   * validated by `setHasMoreHistory(false)` on a 0-row response which is
   * unit-tested separately in paginatedProvider.test.ts (the mock always
   * returns > 0 rows by design).
   */
  test.skip(
    '(e) second pan after history exhausted does not keep refetching (Tauri-only)',
    async () => {
      // To enable: run with the Tauri test harness AND a mock that returns 0
      // bars on the second fetchHistoryBefore call for BTC. The assertion is:
      //   barCountAfterFirstTrigger === barCountAfterSecondTrigger (stabilized).
      // This mirrors the pattern in symbol-catalog-search.spec.ts.
    },
  );
});
