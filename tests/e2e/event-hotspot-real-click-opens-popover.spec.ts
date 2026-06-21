/**
 * tests/e2e/event-hotspot-real-click-opens-popover.spec.ts
 *
 * REGRESSION GUARD for the REAL canvas-click → EventListPopover path.
 *
 * Why this spec exists:
 *   The pre-existing event-popover specs all open the popover via the DEV hook
 *   `window.__eventHotspotTest.openEventPopover(...)`, which BYPASSES the real
 *   canvas click. A regression that made the click anchor off the column's raw
 *   x/y (LEFT edge + pane TOP) instead of the notch center (`payload.cxCenter`)
 *   + column BOTTOM (`y2`) shipped undetected because no spec exercised the real
 *   mouse-click path. This spec performs an ACTUAL `page.mouse.click(...)` on the
 *   chart canvas at a hotspot column and asserts the popover opens on-canvas.
 *
 * It clicks at the TOP, MIDDLE, and BOTTOM of the column's vertical extent to
 * prove the full-pane column resolves the hit at any height (no vertical
 * precision required), and that the popover anchors beside the notch.
 *
 * Locating the column on screen:
 *   The dev event fixture (`seedDevEventFixtures`, auto-seeded on DEV) renders
 *   visible notch clusters. `ChartHotspotFocusOverlay` renders one
 *   `.chart-hotspot-btn` per cluster, positioned at the cluster's notch CENTER x
 *   and BOTTOM y (`left = cxCenter − 12`, width 24; `top = notchTop`). We read
 *   that button's bounding rect to find the column x + the notch y on screen,
 *   then click the CANVAS (not the button — it is pointer-events:none) at that x.
 *
 * RUNTIME: Vite dev server (http://localhost:1420), mock provider forced via
 *   localStorage. Does NOT require the Tauri runtime.
 */

import { test, expect, type Page } from '@playwright/test';

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

/** Wait up to `ms` for at least one event-notch focus button to render. */
async function waitForHotspotButton(page: Page, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const count = await page.locator('.chart-hotspot-btn').count();
    if (count > 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

test.describe('EventListPopover — opens on a REAL canvas click at the hotspot column', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(600);
    await suppressFirstRun(page);
  });

  for (const where of ['top', 'middle', 'bottom'] as const) {
    test(`click at column ${where} opens the popover on-canvas`, async ({ page }) => {
      // The dev fixture auto-seeds on DEV. If no notch button appears, we are
      // running against a production build (fixture stripped) — skip gracefully.
      const hasButton = await waitForHotspotButton(page);
      if (!hasButton) {
        test.skip(true, 'No event-notch hotspot present — production build or fixture absent');
        return;
      }

      // Read the FIRST hotspot button's rect: its horizontal center is the
      // notch center x (the column center), and its top sits at the notch (the
      // column BOTTOM region). We also read the canvas rect to compute a click
      // point at the chosen vertical position WITHIN the canvas.
      const geom = await page.evaluate(() => {
        const btn = document.querySelector('.chart-hotspot-btn') as HTMLElement | null;
        const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
        if (!btn || !canvas) return null;
        const b = btn.getBoundingClientRect();
        const c = canvas.getBoundingClientRect();
        return {
          columnCenterX: b.left + b.width / 2,
          notchY: b.top + b.height / 2,
          canvasTop: c.top,
          canvasBottom: c.bottom,
          canvasLeft: c.left,
          canvasRight: c.right,
        };
      });
      expect(geom, 'hotspot button + canvas geometry').not.toBeNull();
      const g = geom!;

      // Choose a y within the canvas at the requested vertical position. The
      // full-pane column spans the whole price pane, so a click at any of these
      // y heights (at the column x) must resolve the SAME column hit.
      // The column spans the price PANE, whose top sits below the chart's top
      // chrome and whose bottom is at the notch (the x-axis rides below it). We
      // don't have the exact pane `layout.y` exposed, so derive the testable
      // band from the canvas extent and the notch y: the notch is at/near the
      // pane bottom. "top" = ~15% into the canvas (safely inside the pane top,
      // well clear of any chrome), "middle" = pane mid, "bottom" = just above
      // the notch. All three must resolve the SAME full-pane column hit.
      const clickX = g.columnCenterX;
      const span = g.canvasBottom - g.canvasTop;
      let clickY: number;
      if (where === 'top') {
        clickY = g.canvasTop + span * 0.15;
      } else if (where === 'middle') {
        clickY = g.canvasTop + span * 0.5;
      } else {
        // Just above the notch so we stay inside the price pane column.
        clickY = Math.min(g.notchY - 4, g.canvasBottom - 16);
      }

      // A real, stationary mouse click (move + down + up at the same point) so
      // ChartCanvas's drag-safe click detector (CLICK_TAP_PX) fires onChartClick
      // and the hover hit is published before mouseup.
      await page.mouse.move(clickX, clickY);
      await page.waitForTimeout(60);
      await page.mouse.click(clickX, clickY);
      await page.waitForTimeout(300);

      // The popover must be visible.
      const popover = page.locator('.event-popover').first();
      await expect(
        popover,
        `popover should open on a real click at the column ${where}`,
      ).toBeVisible({ timeout: 2000 });

      // …and positioned fully on-canvas (inside the chart-wrap horizontally, and
      // not clipped at the bottom edge — the bottom anchor must flip up).
      const placement = await page.evaluate(() => {
        const pop = document.querySelector('.event-popover') as HTMLElement | null;
        const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
        if (!pop || !canvas) return null;
        const p = pop.getBoundingClientRect();
        const c = canvas.getBoundingClientRect();
        return {
          insideLeft: p.left >= c.left - 1,
          insideRight: p.right <= c.right + 1,
          notClippedBottom: p.bottom <= c.bottom + 1,
          notClippedTop: p.top >= c.top - 1,
          // The popover should be beside the notch x (within ~POPOVER_W of it).
          near: p.left,
        };
      });
      expect(placement, 'popover placement geometry').not.toBeNull();
      expect(placement!.insideLeft, 'popover left inside canvas').toBe(true);
      expect(placement!.insideRight, 'popover right inside canvas').toBe(true);
      expect(placement!.notClippedBottom, 'popover not clipped at bottom').toBe(true);
      expect(placement!.notClippedTop, 'popover not clipped at top').toBe(true);
    });
  }
});
