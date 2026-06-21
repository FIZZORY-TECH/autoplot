/**
 * tests/e2e/event-popover-does-not-steal-rail-clicks.spec.ts — Step S10
 *
 * GUARD: The EventListPopover must never cover the 48px right rail such that a
 * click intended for a rail icon is intercepted by the popover instead.
 *
 * WHY DOM CLAMPING IS SAFE:
 *   The chart-wrap div is inset from the right by `calc(var(--rail-w) +
 *   var(--reserve-right))`, so its right edge never reaches the rail. The popover
 *   is `position:absolute` within the chart-wrap and its `left` is clamped to
 *   `Math.max(EDGE_PAD, Math.min(wrapW − POPOVER_W − EDGE_PAD, left))` where
 *   `wrapW === chartSize.w` (the wrap's own width, not the screen width). So the
 *   popover's rightmost pixel is `left + 280px ≤ wrapW − 8px`, which is
 *   guaranteed to be inside the chart-wrap — the rail is always to its right.
 *
 * RUNTIME: Vite dev server (http://localhost:1420), mock provider forced via
 *   localStorage. Does NOT require the Tauri runtime (no PTY / SQLite). The
 *   popover is opened via window.__eventHotspotTest.openEventPopover() (DEV-only
 *   hook added in AppShell.tsx S10) + the overlay data is injected via
 *   window.__researchOverlayTest (Step 12 hook).
 *
 * WHAT IT ASSERTS:
 *   1. With the event popover open, the right-rail toolbar is visible.
 *   2. The popover's bounding rect does not overlap the rail's bounding rect.
 *   3. A click on a rail icon succeeds (aria-pressed toggles), proving no
 *      overlay is stealing pointer events in the rail's screen area.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers (mirrors dock.spec.ts / research-overlay.spec.ts conventions)
// ---------------------------------------------------------------------------

async function forceMockProvider(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

async function suppressFirstRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = '__test-suppress-firstrun';
    style.textContent =
      '.firstrun-overlay { display: none !important; pointer-events: none !important; }' +
      '.toast-host { display: none !important; pointer-events: none !important; }';
    if (!document.getElementById('__test-suppress-firstrun')) {
      document.head.appendChild(style);
    }
  });
  await page.waitForTimeout(100);
}

/** Wait up to `ms` for the DEV hook to appear. */
async function waitForHook(page: Page, hookName: string, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const present = await page.evaluate((name: string) => {
      return name in (window as unknown as Record<string, unknown>);
    }, hookName);
    if (present) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

// A minimal valid research overlay with one event_mark element so the popover
// has something to render. The overlay id must survive the store lifetime.
const TEST_OVERLAY = {
  id: 'e2e-rail-guard-overlay',
  sym: 'BTC',
  tf: '1h',
  label: 'Rail Guard Test Overlay',
  color: '#4af',
  elements: [
    {
      type: 'event_mark',
      label: 'Test Event',
      ts: Date.now() - 3_600_000,
      content: 'This is a test event for rail-overlap guard.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('EventListPopover — does not steal right-rail clicks', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(500);
    await suppressFirstRun(page);
  });

  test('popover bounding rect does not overlap the right rail', async ({ page }) => {
    // Skip gracefully if running against a production build (hooks absent).
    const overlayHookPresent = await waitForHook(page, '__researchOverlayTest');
    const popoverHookPresent = await waitForHook(page, '__eventHotspotTest');
    if (!overlayHookPresent || !popoverHookPresent) {
      test.skip(
        true,
        'DEV test hooks not present — skipping (production build or hook missing)',
      );
      return;
    }

    // 1. Inject the research overlay into the store (so the popover can resolve ids).
    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, TEST_OVERLAY);
    await page.waitForTimeout(200);

    // 2. Build a valid event id using the overlay's id + element index 0.
    const eventId = `research:${TEST_OVERLAY.id}:0`;

    // 3. Open the popover at a mid-chart anchor (anchorX=100, anchorY=100) via
    //    the DEV hook — no canvas gesture simulation needed.
    await page.evaluate((id: string) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__eventHotspotTest as any).openEventPopover({
        kind: 'research',
        eventIds: [id],
        paneIndex: 0,
        anchorX: 100,
        anchorY: 100,
      });
    }, eventId);
    await page.waitForTimeout(300);

    // 4. Verify the popover is mounted and visible.
    // The popover renders as a div with class "event-popover".
    const popover = page.locator('.event-popover').first();
    await expect(popover).toBeVisible({ timeout: 2000 });

    // 5. Get the right-rail toolbar.
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    await expect(rightRail).toBeVisible();

    // 6. Assert the popover's bounding rect does NOT overlap the rail's rect.
    //    Overlap condition: popoverRight > railLeft AND popoverLeft < railRight.
    const noOverlap = await page.evaluate(() => {
      const popoverEl = document.querySelector('.event-popover');
      const railEl = document.querySelector('[aria-label="Right dock"]');
      if (!popoverEl || !railEl) return { result: false, reason: 'elements not found' };

      const popoverRect = popoverEl.getBoundingClientRect();
      const railRect = railEl.getBoundingClientRect();

      const overlapsX =
        popoverRect.right > railRect.left && popoverRect.left < railRect.right;
      const overlapsY =
        popoverRect.bottom > railRect.top && popoverRect.top < railRect.bottom;

      return {
        result: !(overlapsX && overlapsY),
        popoverRect: {
          left: popoverRect.left,
          right: popoverRect.right,
          top: popoverRect.top,
          bottom: popoverRect.bottom,
        },
        railRect: {
          left: railRect.left,
          right: railRect.right,
          top: railRect.top,
          bottom: railRect.bottom,
        },
      };
    });

    expect(noOverlap.result, `Popover overlaps the right rail: ${JSON.stringify(noOverlap)}`).toBe(
      true,
    );

    // 7. Close the popover and verify the rail is still clickable.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__eventHotspotTest as any).closeEventPopover();
    });
  });

  test('rail icon receives click when popover is open', async ({ page }) => {
    // Skip gracefully if running against a production build.
    const overlayHookPresent = await waitForHook(page, '__researchOverlayTest');
    const popoverHookPresent = await waitForHook(page, '__eventHotspotTest');
    if (!overlayHookPresent || !popoverHookPresent) {
      test.skip(
        true,
        'DEV test hooks not present — skipping (production build or hook missing)',
      );
      return;
    }

    // Inject overlay + open popover.
    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, TEST_OVERLAY);
    await page.waitForTimeout(200);

    const eventId = `research:${TEST_OVERLAY.id}:0`;
    await page.evaluate((id: string) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__eventHotspotTest as any).openEventPopover({
        kind: 'research',
        eventIds: [id],
        paneIndex: 0,
        anchorX: 100,
        anchorY: 100,
      });
    }, eventId);
    await page.waitForTimeout(300);

    // The popover should be visible.
    await expect(page.locator('.event-popover').first()).toBeVisible({ timeout: 2000 });

    // The right-rail Watchlist button — close Terminal first so we can observe
    // a toggle from closed (aria-pressed=false) to open (aria-pressed=true).
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    // Close the default-open Terminal drawer.
    await terminalBtn.click({ force: true });
    await page.waitForTimeout(200);

    const watchlistBtn = rightRail.getByRole('button', { name: 'Watchlist' });
    // Should start closed (aria-pressed=false).
    await expect(watchlistBtn).toHaveAttribute('aria-pressed', 'false');

    // Click Watchlist while the popover is still open — it must reach the rail.
    await watchlistBtn.click({ force: true });
    await page.waitForTimeout(200);

    // Rail icon should now be aria-pressed=true — proof the click landed on the
    // rail, not on a popover overlay that would have eaten the event.
    await expect(watchlistBtn).toHaveAttribute('aria-pressed', 'true');
  });
});
