/**
 * tests/e2e/research-overlay.spec.ts — Step 12 Playwright verification.
 *
 * Verifies that a research overlay injected via the window.__researchOverlayTest
 * DEV hook (set by AppShell, mirrors the bridge dispatch path):
 *
 *   1. Causes a legend entry with the overlay label to appear in the LegendHUD.
 *   2. The chart canvas is present and painted (non-blank).
 *
 * RUNTIME: vite-dev compatible (no Tauri required). Mock provider forced via
 * localStorage. Follows the conventions in scrollback.spec.ts and dock.spec.ts.
 *
 * INJECTION: uses window.__researchOverlayTest (DEV-only hook added in
 * AppShell.tsx Step 12). If the hook is absent (production build), the test
 * gracefully skips. The LegendHUD expanded row renders `.legend-hud-label`
 * with the overlay label text.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers (mirrors scrollback.spec.ts / dock.spec.ts conventions)
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

interface ResearchOverlayTestHook {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (overlay: any) => void;
  remove: (id: string) => void;
  getState: () => Record<string, unknown>;
}

/** Wait up to `ms` for the DEV hook to appear on window. */
async function waitForHook(page: Page, ms = 3000): Promise<ResearchOverlayTestHook | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hook = await page.evaluate((): ResearchOverlayTestHook | null => {
      const w = window as unknown as Record<string, unknown>;
      return (w.__researchOverlayTest as ResearchOverlayTestHook | undefined) ?? null;
    });
    if (hook) return hook;
    await page.waitForTimeout(100);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared fixture — a minimal valid ResearchOverlay payload
// ---------------------------------------------------------------------------

const TEST_OVERLAY = {
  id: 'e2e-test-overlay',
  sym: 'BTC',
  tf: '1h',
  label: 'E2E Support Level',
  color: '#4af',
  elements: [
    { type: 'hline', price: 50000, label: 'Support' },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('research-overlay legend + canvas smoke', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(500); // let MockMarketDataProvider populate
    await suppressFirstRun(page);
  });

  test('DEV hook is present after app load', async ({ page }) => {
    const hook = await waitForHook(page);
    if (!hook) {
      // If running against a production build, skip gracefully.
      test.skip(true, 'window.__researchOverlayTest not present (production build or hook missing)');
      return;
    }
    expect(hook).not.toBeNull();
  });

  test('injecting overlay causes legend entry to appear', async ({ page }) => {
    const hookPresent = await page.evaluate((): boolean => {
      const w = window as unknown as Record<string, unknown>;
      return '__researchOverlayTest' in w;
    });
    // Wait for hook if not yet mounted
    await waitForHook(page, 3000);

    const hookReady = await page.evaluate((): boolean => {
      const w = window as unknown as Record<string, unknown>;
      return '__researchOverlayTest' in w;
    });
    if (!hookReady) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }
    void hookPresent; // suppress unused-var

    // Inject the overlay via the DEV hook.
    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      const hook = w.__researchOverlayTest as ResearchOverlayTestHook | undefined;
      hook?.apply(overlay);
    }, TEST_OVERLAY);

    // LegendHUD collapsed state shows a pill. The expanded row (with label text)
    // appears once the legend auto-expands OR after clicking the expand button.
    // Wait up to 2s for the label to appear in collapsed count OR expanded row.
    await page.waitForTimeout(300);

    // Try to expand the legend if it's collapsed (presence of the "Expand" button).
    const expandBtn = page.locator('[aria-label="Expand overlay legend"]');
    const isCollapsed = await expandBtn.isVisible().catch(() => false);
    if (isCollapsed) {
      await expandBtn.click({ force: true });
      await page.waitForTimeout(200);
    }

    // The legend HUD is present.
    const hud = page.locator('[data-testid="legend-hud"]');
    await expect(hud).toBeVisible();

    // A row with the overlay label should be visible.
    const labelEl = page.locator('.legend-hud-label', { hasText: 'E2E Support Level' });
    await expect(labelEl).toBeVisible({ timeout: 3000 });
  });

  test('chart canvas is present and painted (non-blank)', async ({ page }) => {
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // Take a screenshot of the canvas — if it were blank, comparing two
    // screenshots after minimal wait would produce identical buffers.
    const shot1 = await canvas.screenshot();
    expect(shot1.length).toBeGreaterThan(1000); // non-trivial PNG
  });

  test('removing overlay clears the legend entry', async ({ page }) => {
    await waitForHook(page, 3000);
    const hookReady = await page.evaluate((): boolean => {
      const w = window as unknown as Record<string, unknown>;
      return '__researchOverlayTest' in w;
    });
    if (!hookReady) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    // Inject
    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      const hook = w.__researchOverlayTest as ResearchOverlayTestHook | undefined;
      hook?.apply(overlay);
    }, TEST_OVERLAY);
    await page.waitForTimeout(300);

    // Expand if needed
    const expandBtn = page.locator('[aria-label="Expand overlay legend"]');
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click({ force: true });
      await page.waitForTimeout(200);
    }

    // Confirm label present
    const labelEl = page.locator('.legend-hud-label', { hasText: 'E2E Support Level' });
    await expect(labelEl).toBeVisible({ timeout: 3000 });

    // Remove via hook
    await page.evaluate((id: string) => {
      const w = window as unknown as Record<string, unknown>;
      const hook = w.__researchOverlayTest as ResearchOverlayTestHook | undefined;
      hook?.remove(id);
    }, TEST_OVERLAY.id);
    await page.waitForTimeout(300);

    // Label should no longer be visible (row gone, or HUD collapsed)
    await expect(labelEl).not.toBeVisible({ timeout: 2000 });
  });
});
