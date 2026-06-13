/**
 * tests/e2e/p9-portfolio.spec.ts — Portfolio panel UI smoke tests.
 *
 * STATUS (Tauri-gating):
 *   The portfolio DB writes (addLot, upsert, remove) go through `invoke`, which
 *   is NOT available in plain `vite dev`. We test ONLY the browser-side UI
 *   surface that works without Tauri:
 *     - Portfolio rail icon renders in the right ActivityBar and is clickable.
 *     - Panel DockDrawer opens (role="dialog" aria-label="Portfolio"), shows the
 *       Portfolio header and empty-state text.
 *     - The "Add holding" button inside the empty state opens AddHoldingModal.
 *     - AddHoldingModal renders expected fields.
 *     - Submit button is disabled when qty is empty (validation gate).
 *     - Closing the modal (Esc or close button) dismisses it.
 *
 *   One-per-side note: The Terminal drawer is open by default at launch on the
 *   right rail. Clicking Portfolio replaces Terminal as the active right drawer.
 *
 *   Persistence tests (DB round-trip after panel interaction) are deferred to
 *   the Tauri test harness — mirror the same skip pattern as p3-watchlist-persistence.
 *
 * Setup:
 *   Sets `use-mock-provider=1` in localStorage before navigation so all market
 *   data routes through MockMarketDataProvider (identical to other e2e specs).
 *   Forces empty portfolio (no Tauri → store.holdings stays []) so the empty
 *   state renders deterministically.
 *
 * Pattern mirrors: p3-watchlist-persistence.spec.ts (skip + localStorage setup).
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper — set mock provider flag before navigating
// ---------------------------------------------------------------------------
async function setupMockProvider(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

// ---------------------------------------------------------------------------
// Helper — suppress the firstrun overlay so it doesn't block pointer events.
// In browser-only mode claudeTestConnection rejects with CliNotFound, which
// mounts the .firstrun-overlay (aria-modal="true"). Inject CSS to hide it and
// remove its pointer-event capture so the underlying rail buttons are reachable.
// ---------------------------------------------------------------------------
async function suppressFirstRun(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = '__test-suppress-firstrun';
    style.textContent =
      '.firstrun-overlay { display: none !important; pointer-events: none !important; }';
    if (!document.getElementById('__test-suppress-firstrun')) {
      document.head.appendChild(style);
    }
  });
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// Helper — open the Portfolio drawer via the right-rail icon button.
// Terminal is the default-open right drawer at launch; clicking Portfolio
// replaces it (one-per-side).
// ---------------------------------------------------------------------------
async function openPortfolioDrawer(page: import('@playwright/test').Page): Promise<void> {
  const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
  const portfolioBtn = rightRail.getByRole('button', { name: 'Portfolio' });
  await portfolioBtn.click({ force: true });
  // Wait for the drawer spring animation to settle.
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Tauri-only persistence tests — skipped under vite dev (same pattern as P3)
// ---------------------------------------------------------------------------

test.describe('P9 — Portfolio watchlist persistence (Tauri-only)', () => {
  test.skip(
    true,
    'Tauri-runtime-only: SQLite persistence via invoke is not available in vite dev. ' +
      'Re-enable when the Tauri test runner is wired up.',
  );

  test('add holding, panel shows it, reload, still present', async ({ page }) => {
    await setupMockProvider(page);
    await page.goto('/');
    // This test body intentionally left as a placeholder — persistence round-trip
    // requires Tauri invoke. Fill in when the Tauri e2e runner is available.
  });
});

// ---------------------------------------------------------------------------
// Browser-side UI smoke (no Tauri required)
// ---------------------------------------------------------------------------

test.describe('P9 — Portfolio panel UI (browser-side)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(400);
    await suppressFirstRun(page);
  });

  // ── Rail icon renders ───────────────────────────────────────────────────────

  test('Portfolio rail icon is visible in the right activity bar', async ({ page }) => {
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const portfolioBtn = rightRail.getByRole('button', { name: 'Portfolio' });
    await expect(portfolioBtn).toBeVisible();
  });

  // ── Rail icon opens panel ──────────────────────────────────────────────────

  test('clicking Portfolio rail icon opens the drawer with "Portfolio" header', async ({ page }) => {
    await openPortfolioDrawer(page);

    // DockDrawer renders as role="dialog" aria-label="Portfolio"
    const drawer = page.getByRole('dialog', { name: 'Portfolio' });
    await expect(drawer).toBeVisible();

    // Header label — the panel has a "Portfolio" text in the header strip
    await expect(drawer).toContainText('Portfolio');
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  test('panel shows empty-state message when no holdings exist', async ({ page }) => {
    await openPortfolioDrawer(page);

    const panel = page.getByTestId('portfolio-panel');
    await expect(panel).toBeVisible();

    // Empty state message shown when holdings.length === 0
    await expect(panel).toContainText('No holdings');
  });

  // ── Empty-state "Add holding" button opens AddHoldingModal ─────────────────

  test('clicking "Add holding" from empty state opens AddHoldingModal', async ({ page }) => {
    await openPortfolioDrawer(page);

    const panel = page.getByTestId('portfolio-panel');
    await expect(panel).toBeVisible();

    // Click the empty-state add button
    const addBtn = panel.getByTestId('portfolio-panel-add-empty');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Modal appears
    const modal = page.getByTestId('add-holding-modal');
    await expect(modal).toBeVisible();
  });

  // ── AddHoldingModal fields render ─────────────────────────────────────────

  test('AddHoldingModal renders Quantity and Avg Cost fields', async ({ page }) => {
    await openPortfolioDrawer(page);

    const panel = page.getByTestId('portfolio-panel');
    await expect(panel).toBeVisible();

    await panel.getByTestId('portfolio-panel-add-empty').click();

    const modal = page.getByTestId('add-holding-modal');
    await expect(modal).toBeVisible();

    // Qty input
    await expect(page.getByTestId('holding-qty-input')).toBeVisible();
    // Avg Cost input
    await expect(page.getByTestId('holding-avgcost-input')).toBeVisible();
    // Submit button exists
    await expect(page.getByTestId('add-holding-modal-submit')).toBeVisible();
  });

  // ── Submit disabled when qty is empty ──────────────────────────────────────

  test('submit button is disabled when qty is empty', async ({ page }) => {
    await openPortfolioDrawer(page);

    await page.getByTestId('portfolio-panel-add-empty').click();

    const modal = page.getByTestId('add-holding-modal');
    await expect(modal).toBeVisible();

    const submit = page.getByTestId('add-holding-modal-submit');
    // qty and sym are both empty on open → submit must be disabled
    await expect(submit).toBeDisabled();
  });

  // ── Close button dismisses modal ───────────────────────────────────────────

  test('clicking close button on AddHoldingModal dismisses it', async ({ page }) => {
    await openPortfolioDrawer(page);

    await page.getByTestId('portfolio-panel-add-empty').click();

    const modal = page.getByTestId('add-holding-modal');
    await expect(modal).toBeVisible();

    await page.getByTestId('add-holding-modal-close').click();
    await expect(modal).not.toBeVisible();
  });

  // ── Close panel button ─────────────────────────────────────────────────────

  test('close button on the panel closes the Portfolio drawer', async ({ page }) => {
    await openPortfolioDrawer(page);

    // Drawer is open — rail icon should be aria-pressed=true.
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const portfolioBtn = rightRail.getByRole('button', { name: 'Portfolio' });
    await expect(portfolioBtn).toHaveAttribute('aria-pressed', 'true');

    // Close via the X button in the panel header.
    await page.getByTestId('portfolio-panel-close').click();
    await page.waitForTimeout(300);

    // Rail icon should now be aria-pressed=false (drawer toggled closed).
    await expect(portfolioBtn).toHaveAttribute('aria-pressed', 'false');

    // DockDrawer in closed state has pointer-events:none (inline style from DockDrawer).
    const drawer = page.getByRole('dialog', { name: 'Portfolio' });
    const pointerEvents = await drawer.evaluate(
      (el) => (el as HTMLElement).style.pointerEvents,
    );
    expect(pointerEvents).toBe('none');
  });
});
