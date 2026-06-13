/**
 * tests/e2e/p3-watchlist-persistence.spec.ts — P3.2 / P3-21
 *
 * STATUS: SKIPPED — this test exercises SQLite persistence which only exists
 * inside the Tauri runtime (not the plain Vite dev server Playwright targets
 * via http://localhost:1420). When the Tauri test harness is available, drop
 * the `test.skip(...)` lines and the body should run as-is.
 *
 * What this test WOULD do once enabled:
 *   1. Open the app at `/`.
 *   2. Wait for the floating AssetPanel ([data-testid="asset-panel"]) to mount.
 *   3. Click the panel's "Add asset" button → AddAssetModal opens.
 *   4. Click the Binance provider chip
 *      ([data-testid="add-asset-provider-binance"]).
 *   5. Click `+` on the BTC row ([data-testid="add-asset-row-add-BTC"])
 *      and close the modal.
 *   6. Assert a row [data-testid="asset-row-BTC"] is now visible inside the
 *      panel and shows price + delta.
 *   7. Click the row → assert [data-active="true"] flips to that row, and
 *      the Headline text contains "BTC".
 *   8. Reload the page (`page.reload()`).
 *   9. After hydration, assert:
 *        - [data-testid="asset-row-BTC"] is still rendered.
 *        - The active row is still BTC.
 *        - The Headline still reads BTC.
 *  10. Assert NASDAQ + NYSE provider chips render with
 *      [data-disabled="true"] and a "Coming soon" tooltip.
 */

import { test, expect } from '@playwright/test';

test.describe('P3.2 — Watchlist add + persistence', () => {
  test.skip(
    true,
    'Tauri-runtime-only: SQLite persistence is not exercised against vite dev. ' +
      'Re-enable when the Tauri test runner is wired up.',
  );

  test('add BTC, click row, reload, BTC still active in panel', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('[data-testid="asset-panel"]');
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="asset-panel-add-btn"]').click();
    const modal = page.locator('[data-testid="add-asset-modal"]');
    await expect(modal).toBeVisible();

    await modal.locator('[data-testid="add-asset-provider-binance"]').click();
    // ADR-0009: testid scheme is triple-keyed by (provider, sym, quote).
    await modal.locator('[data-testid="add-asset-row-binance-BTC-USDT"]').click();
    await page.locator('[data-testid="add-asset-modal-close"]').click();

    const btcRow = panel.locator('[data-testid="watchlist-row-binance-BTC-USDT"]');
    await expect(btcRow).toBeVisible();
    await btcRow.click();
    await expect(btcRow).toHaveAttribute('data-active', 'true');

    // NASDAQ + NYSE chips visible-but-disabled.
    await panel.locator('[data-testid="asset-panel-add-btn"]').click();
    await expect(modal.locator('[data-testid="add-asset-provider-nasdaq"]'))
      .toHaveAttribute('data-disabled', 'true');
    await expect(modal.locator('[data-testid="add-asset-provider-nyse"]'))
      .toHaveAttribute('data-disabled', 'true');
    await page.locator('[data-testid="add-asset-modal-close"]').click();

    await page.reload();
    await expect(panel.locator('[data-testid="watchlist-row-binance-BTC-USDT"]')).toBeVisible();
    await expect(panel.locator('[data-testid="watchlist-row-binance-BTC-USDT"]'))
      .toHaveAttribute('data-active', 'true');
  });
});
