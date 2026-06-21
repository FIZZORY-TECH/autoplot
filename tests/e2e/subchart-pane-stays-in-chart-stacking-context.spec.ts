/**
 * tests/e2e/subchart-pane-stays-in-chart-stacking-context.spec.ts — Step S10
 *
 * GUARD: When a `kind:'series'` dataset is active (triggering the sub-pane),
 * the sub-pane must stay inside the chart-wrap's isolated stacking context and
 * must NOT have any DOM element that overlaps the 48px right rail.
 *
 * WHY IT IS TRIVIALLY CORRECT (verified by code inspection):
 *   The sub-pane is CANVAS-DRAWN — it is part of the single `<canvas>` element
 *   that fills the chart-wrap. There are no stray DOM nodes for the sub-pane.
 *   The chart-wrap itself is inset by `calc(var(--rail-w) + var(--reserve-right))`
 *   on the right, so the canvas (and every DOM child inside it) can never reach
 *   the rail's screen area.
 *
 * RUNTIME: Vite dev server (http://localhost:1420), mock provider forced via
 *   localStorage. Does NOT require the Tauri runtime.
 *   The series dataset is injected via window.__eventHotspotTest.injectSeriesDataset()
 *   (DEV-only hook added in AppShell.tsx S10).
 *
 * WHAT IT ASSERTS:
 *   1. With a series dataset injected, a single <canvas> is still present (no
 *      extra canvas or DOM sub-pane element is created outside the chart-wrap).
 *   2. The chart-wrap's right edge is to the LEFT of the right rail's left edge,
 *      confirming the canvas can never paint into the rail's screen area.
 *   3. No direct child of the chart-wrap has a bounding rect that overlaps the
 *      right rail.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
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

// A minimal `kind:'series'` dataset (e.g. an RSI-like 0-100 series).
const TEST_SERIES_DATASET = {
  id: 'e2e-series-pane-test',
  label: 'E2E RSI Series',
  kind: 'series' as const,
  align: 'right' as const,
  sym: 'BTC',
  tf: '1h',
  // 200 values in [0,100] simulating an oscillator.
  values: Array.from({ length: 200 }, (_, i) => 50 + 30 * Math.sin(i / 10)),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Sub-chart pane — stays inside chart stacking context', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(500);
    await suppressFirstRun(page);
  });

  test('series dataset activates sub-pane via canvas only — no extra DOM elements', async ({
    page,
  }) => {
    const hookPresent = await waitForHook(page, '__eventHotspotTest');
    if (!hookPresent) {
      test.skip(true, 'DEV test hook not present — skipping');
      return;
    }

    // Count canvas elements before injection.
    const canvasBefore = await page.locator('canvas').count();

    // Inject the series dataset.
    await page.evaluate((ds) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__eventHotspotTest as any).injectSeriesDataset(ds);
    }, TEST_SERIES_DATASET);
    await page.waitForTimeout(400);

    // Canvas count must not increase — sub-pane is drawn inside the same canvas.
    const canvasAfter = await page.locator('canvas').count();
    expect(canvasAfter).toBe(canvasBefore);

    // The single canvas is still present and visible.
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('chart-wrap right edge is left of the right rail — canvas cannot paint into rail', async ({
    page,
  }) => {
    const hookPresent = await waitForHook(page, '__eventHotspotTest');
    if (!hookPresent) {
      test.skip(true, 'DEV test hook not present — skipping');
      return;
    }

    // Inject the series dataset to ensure the sub-pane is active.
    await page.evaluate((ds) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__eventHotspotTest as any).injectSeriesDataset(ds);
    }, TEST_SERIES_DATASET);
    await page.waitForTimeout(400);

    // Measure chart-wrap right edge vs rail left edge.
    const result = await page.evaluate(() => {
      // The chart-wrap is the div that wraps the canvas (has isolation:isolate).
      // We identify it as the closest ancestor of the canvas that has
      // position:absolute (per AppShell). The rail is role=toolbar aria-label="Right dock".
      const canvas = document.querySelector('canvas');
      const rail = document.querySelector('[aria-label="Right dock"]');
      if (!canvas || !rail) return { ok: false, reason: 'missing elements' };

      // Walk up from canvas to find the chart-wrap (position:absolute + isolation).
      let wrap: HTMLElement | null = canvas.parentElement;
      while (wrap) {
        const style = getComputedStyle(wrap);
        if (style.position === 'absolute' && style.isolation === 'isolate') break;
        wrap = wrap.parentElement;
      }
      if (!wrap) return { ok: false, reason: 'chart-wrap not found' };

      const wrapRect = wrap.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();

      return {
        ok: wrapRect.right <= railRect.left,
        wrapRight: wrapRect.right,
        railLeft: railRect.left,
      };
    });

    expect(result.ok, `Chart-wrap right (${result.wrapRight}) must be ≤ rail left (${result.railLeft})`).toBe(
      true,
    );
  });

  test('no chart-wrap child DOM element overlaps the right rail', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__eventHotspotTest');
    if (!hookPresent) {
      test.skip(true, 'DEV test hook not present — skipping');
      return;
    }

    // Inject series dataset.
    await page.evaluate((ds) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__eventHotspotTest as any).injectSeriesDataset(ds);
    }, TEST_SERIES_DATASET);
    await page.waitForTimeout(400);

    const noOverlap = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const rail = document.querySelector('[aria-label="Right dock"]');
      if (!canvas || !rail) return { ok: false, reason: 'missing elements' };

      let wrap: HTMLElement | null = canvas.parentElement;
      while (wrap) {
        const style = getComputedStyle(wrap);
        if (style.position === 'absolute' && style.isolation === 'isolate') break;
        wrap = wrap.parentElement;
      }
      if (!wrap) return { ok: false, reason: 'chart-wrap not found' };

      const railRect = rail.getBoundingClientRect();
      const children = Array.from(wrap.children) as HTMLElement[];

      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const overlapsX = rect.right > railRect.left && rect.left < railRect.right;
        const overlapsY = rect.bottom > railRect.top && rect.top < railRect.bottom;
        if (overlapsX && overlapsY) {
          return {
            ok: false,
            reason: `child "${child.className}" overlaps rail`,
            childRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            railRect: { left: railRect.left, right: railRect.right },
          };
        }
      }
      return { ok: true };
    });

    expect(noOverlap.ok, `Rail overlap detected: ${JSON.stringify(noOverlap)}`).toBe(true);
  });
});
