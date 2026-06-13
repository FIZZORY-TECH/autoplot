/**
 * tests/e2e/symbol-catalog-search.spec.ts — ADR-0009 / Step 11
 *
 * STATUS: SKIPPED — the MOCK_CATALOG in-process fixture was removed during the
 * live-catalog pivot (2026-06-07). `searchSymbols()` now returns `[]` (with a
 * `[TODO P8 toast]` warn) when there is no Tauri runtime — the real FTS5 catalog
 * requires SQLite / Tauri `invoke`. The symbol search and AddAssetModal browse
 * assertions in this file therefore require the Tauri runtime to be available.
 *
 * When the Tauri e2e test harness is wired up, drop the `test.skip(true, ...)` call
 * from the describe block and the body should run against the live SQLite catalog
 * (use real crypto symbols like BTC/USDT rather than the former MOCK_CATALOG rows).
 *
 * What this test WOULD do once enabled:
 *   1. Modal opens; default browse list renders rows from the live FTS5 catalog.
 *   2. Searching "BTC" returns grouped results with ADR-0009 group/row testids:
 *        - data-testid="add-asset-group-binance"
 *        - data-testid="add-asset-row-binance-BTC-USDC" (or BTC-USDT)
 *   3. Clicking the `+` on a BTC row adds it; the AssetPanel renders the row.
 *   4. The Refresh button (`add-asset-modal-refresh`) is visible + clickable.
 *   5. SQLite persistence after reload is covered by p3-watchlist-persistence.spec.ts.
 *
 * Original assertions (pre-live-catalog-pivot):
 *   Relied on MOCK_CATALOG rows: BTC/USDC + ETH/USDC on binance, SOL/USDC on coinbase.
 */

import { test, expect, type Page } from '@playwright/test';

/** Set use-mock-provider so no real market data calls are attempted. */
async function forceMockProvider(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

/**
 * Dismiss the FirstRun overlay in browser-only mode. Mirrors the
 * `dismissFirstRun` helper used by p2-keyboard-flow.spec.ts — the overlay
 * appears when `claudeTestConnection` rejects with CliNotFound (no Tauri
 * runtime) and would otherwise intercept pointer events.
 */
async function dismissFirstRun(page: Page): Promise<void> {
  const overlay = page.locator('.firstrun-overlay');
  const visible = await overlay.isVisible().catch(() => false);
  if (!visible) return;
  // FirstRun has no test-mode escape hatch — for the catalog smoke we just
  // strip the overlay node from the DOM so pointer events reach the panel.
  // This is safe: the overlay only gates Claude-CLI features (not the
  // watchlist or chart), which are out of scope for this spec.
  await page.evaluate(() => {
    document.querySelectorAll('.firstrun-overlay').forEach((el) => el.remove());
  });
  await page.waitForTimeout(50);
}

test.describe('AddAssetModal — catalog search (ADR-0009)', () => {
  // TAURI-ONLY: the real FTS5 catalog requires SQLite / invoke; searchSymbols()
  // returns [] in plain vite dev. Re-enable when the Tauri test runner is wired up.
  test.skip(
    true,
    'Tauri-runtime-only: symbol catalog search requires SQLite/invoke. ' +
      'MOCK_CATALOG was removed in the live-catalog pivot (2026-06-07). ' +
      'Re-enable when the Tauri test runner is wired up.',
  );

  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
  });

  test('opens modal, searches usdc, adds BTC/USDC, asserts panel + refresh', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForSelector('canvas').catch(() => {});
    await page.waitForTimeout(400);
    await dismissFirstRun(page);

    const panel = page.locator('[data-testid="asset-panel"]');
    await expect(panel).toBeVisible();

    // ----- Expand the panel if it boots collapsed (P3-10/11 default state) -----
    // The panel toggles via `data-collapsed`; when collapsed the expanded body
    // has `pointer-events: none` so the Add button is unreachable. Click the
    // chevron exactly once to expand.
    const isCollapsed = await panel.getAttribute('data-collapsed');
    if (isCollapsed === 'true') {
      await panel.locator('[data-testid="asset-panel-collapse"]').click();
    }
    // Wait for the max-height animation to settle so pointer-events flips.
    await page.waitForTimeout(350);

    // ----- Open the modal -----
    const addBtn = panel.locator('[data-testid="asset-panel-add-btn"]');
    await addBtn.click();
    const modal = page.locator('[data-testid="add-asset-modal"]');
    await expect(modal).toBeVisible();

    // ----- Default browse list has at least one row -----
    const list = modal.locator('[data-testid="add-asset-modal-list"]');
    await expect(list).toBeVisible();

    // ----- Refresh button is visible + clickable -----
    const refresh = modal.locator('[data-testid="add-asset-modal-refresh"]');
    await expect(refresh).toBeVisible();
    await expect(refresh).toBeEnabled();

    // ----- Type `usdc` → grouped cross-provider results -----
    const search = modal.locator('[data-testid="add-asset-modal-search"]');
    await search.fill('usdc');
    // 150ms debounce — wait it out.
    await page.waitForTimeout(250);

    // MOCK_CATALOG has BTC/USDC + ETH/USDC on binance and SOL/USDC on
    // coinbase. The mock search matches `sym` OR `name`, not `quote` — so we
    // search for a sym that exists across quotes instead, then assert the
    // group headers + row testids appear for the multi-quote demo rows.
    // The 'usdc' substring is in the sym/name of nothing, so first switch to
    // a query that resolves to the USDC demo rows.
    await search.fill('BTC');
    await page.waitForTimeout(250);

    // Group headers — `add-asset-group-${provider}` per Step 6 testid scheme.
    await expect(
      modal.locator('[data-testid="add-asset-group-binance"]'),
    ).toBeVisible();

    // BTC/USDC — the triple-keyed testid is shared by the row container and
    // the `+` button; the button is the click target.
    const usdcAddBtn = modal.locator(
      'button[data-testid="add-asset-row-binance-BTC-USDC"]',
    );
    await expect(usdcAddBtn).toBeVisible();

    // ----- Click `+` on BTC/USDC, close the modal -----
    await usdcAddBtn.click();
    await page.locator('[data-testid="add-asset-modal-close"]').click();

    // ----- AssetPanel renders the new BTC/USDC watchlist row -----
    const newRow = panel.locator('[data-testid="watchlist-row-binance-BTC-USDC"]');
    await expect(newRow).toBeVisible();

    // ----- Reload — see header comment for the persistence caveat -----
    // SQLite persistence requires the Tauri runtime. In plain vite dev the
    // Zustand store resets to defaults so we DO NOT assert the row survives a
    // reload here — that lane is covered by p3-watchlist-persistence.spec.ts.
    // We still issue the reload to confirm no console errors crash the app.
    await page.reload();
    await expect(panel).toBeVisible();
  });
});
