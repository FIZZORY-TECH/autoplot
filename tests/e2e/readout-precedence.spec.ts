/**
 * tests/e2e/readout-precedence.spec.ts
 *
 * UX-CLUTTER GUARD for the floating-readout precedence ladder.
 *
 * The chart floats several info readouts (crosshair price chip, OverlayInfoPanel
 * hover card, EventListPopover). They must be MUTUALLY EXCLUSIVE — at most ONE
 * competes for attention at a time. This spec exercises the two collisions the
 * user reported:
 *
 *   (a) popover OPEN → the hover OverlayInfoPanel and the crosshair PRICE chip
 *       are NOT visible (the popover owns the screen).
 *   (b) hovering an event column → the crosshair price VALUE chip is NOT visible
 *       while the event affordance (the concise hover hint) IS.
 *
 * Reuses the real-click harness from event-hotspot-real-click-opens-popover:
 * the dev event fixture auto-seeds on DEV, ChartHotspotFocusOverlay renders one
 * `.chart-hotspot-btn` per cluster, and we read its rect to find the column x.
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

async function waitForHotspotButton(page: Page, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const count = await page.locator('.chart-hotspot-btn').count();
    if (count > 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

interface Geom {
  columnCenterX: number;
  notchY: number;
  canvasTop: number;
  canvasBottom: number;
}

async function readGeom(page: Page): Promise<Geom | null> {
  return page.evaluate(() => {
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
    };
  });
}

test.describe('Floating-readout precedence — at most one readout at a time', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(600);
    await suppressFirstRun(page);
  });

  test('(c) hovering a normal bar shows the crosshair readout with Change block labels', async ({
    page,
  }) => {
    // Move to the center of the canvas — away from any event notch.
    const canvasRect = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    if (!canvasRect) {
      test.skip(true, 'Canvas not found');
      return;
    }
    const cx = canvasRect.left + canvasRect.width * 0.5;
    const cy = canvasRect.top + canvasRect.height * 0.45;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(300);

    // The crosshair readout should appear (we're not over an event or popover).
    const readout = page.getByTestId('crosshair-readout');
    await expect(readout, 'crosshair readout visible on normal bar hover').toBeVisible({
      timeout: 2000,
    });

    // The Change block label "vs O" must be present — confirms new structure rendered.
    await expect(readout, 'readout contains "vs O" change label').toContainText('vs O');

    // A +/- value pattern or the Δ prev label should also appear for bars after idx 0.
    // We check for the Rng label as a stable proxy for the Range/Vol block.
    await expect(readout, 'readout contains "Rng" range label').toContainText('Rng');

    // C label in the demoted OHLC block confirms the full block is rendered.
    await expect(readout, 'readout contains demoted OHLC "C" label').toContainText('C');
  });

  test('(b) hovering an event column hides the price chip and shows the event hint', async ({
    page,
  }) => {
    const hasButton = await waitForHotspotButton(page);
    if (!hasButton) {
      test.skip(true, 'No event-notch hotspot present — production build or fixture absent');
      return;
    }
    const geom = await readGeom(page);
    expect(geom, 'hotspot + canvas geometry').not.toBeNull();
    const g = geom!;

    // Hover (move only, no click) at the column, mid-pane.
    const hoverY = g.canvasTop + (g.canvasBottom - g.canvasTop) * 0.4;
    await page.mouse.move(g.columnCenterX, hoverY);
    await page.waitForTimeout(200);

    // The crosshair PRICE value chip must NOT be visible (event is primary).
    await expect(
      page.getByTestId('crosshair-readout'),
      'crosshair price chip suppressed while hovering an event',
    ).toHaveCount(0);

    // The concise event affordance IS visible.
    await expect(
      page.getByTestId('event-hover-hint'),
      'concise event hover hint visible',
    ).toBeVisible({ timeout: 1500 });

    // The full hover OverlayInfoPanel (role=dialog glass-card) must NOT show on
    // event hover — scope to the panel class so unrelated dialogs (drawers,
    // modals) on the page don't false-positive.
    await expect(
      page.locator('div.glass-card.overlay-enter[role="dialog"]'),
      'full overlay info card not shown on event hover',
    ).toHaveCount(0);
  });

  test('(a) with the popover OPEN, the hover panel and the price chip are hidden', async ({
    page,
  }) => {
    const hasButton = await waitForHotspotButton(page);
    if (!hasButton) {
      test.skip(true, 'No event-notch hotspot present — production build or fixture absent');
      return;
    }
    const geom = await readGeom(page);
    expect(geom, 'hotspot + canvas geometry').not.toBeNull();
    const g = geom!;

    const clickY = g.canvasTop + (g.canvasBottom - g.canvasTop) * 0.4;
    await page.mouse.move(g.columnCenterX, clickY);
    await page.waitForTimeout(60);
    await page.mouse.click(g.columnCenterX, clickY);
    await page.waitForTimeout(300);

    // Popover open.
    await expect(page.locator('.event-popover').first()).toBeVisible({ timeout: 2000 });

    // Crosshair price chip suppressed.
    await expect(
      page.getByTestId('crosshair-readout'),
      'crosshair price chip suppressed while popover open',
    ).toHaveCount(0);

    // Hover event-hint suppressed (popover owns the screen).
    await expect(
      page.getByTestId('event-hover-hint'),
      'event hover hint suppressed while popover open',
    ).toHaveCount(0);

    // Full OverlayInfoPanel hover/pinned card suppressed (scoped to its class).
    await expect(
      page.locator('div.glass-card.overlay-enter[role="dialog"]'),
      'overlay info card suppressed while popover open',
    ).toHaveCount(0);
  });
});
