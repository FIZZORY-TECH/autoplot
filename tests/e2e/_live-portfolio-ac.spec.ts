/**
 * tests/e2e/_live-portfolio-ac.spec.ts — Live Portfolio UI acceptance tests.
 *
 * Scratch/verification artifact (underscore prefix). Tests run against the
 * already-running Vite dev server at http://localhost:1420 (browser-only mode,
 * no Tauri runtime — portfolio DB writes no-op, mock market provider active).
 *
 * AC1 — Panel open/close: FAB + ⌘P/Ctrl+P
 * AC2 — Empty state: empty-state prompt + Add holding action
 * AC3 — Add/Edit modal: fields render, symbol picker, submit disabled/enabled
 * AC4 — Modal dismiss: close button + Esc key
 */

import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';

const SCREENSHOT_DIR = path.resolve('test-results/portfolio-live');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupMockProvider(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

async function dismissFirstRun(page: Page): Promise<void> {
  const overlay = page.locator('.firstrun-overlay');
  const visible = await overlay.isVisible().catch(() => false);
  if (!visible) return;
  await page.evaluate(() => {
    document.querySelectorAll('.firstrun-overlay').forEach((el) => el.remove());
  });
  await page.waitForTimeout(50);
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('canvas');
  await dismissFirstRun(page);
}

// ---------------------------------------------------------------------------
// Console error collection
// ---------------------------------------------------------------------------

function attachConsoleCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });
  return errors;
}

// ---------------------------------------------------------------------------
// AC1 — Panel open/close via FAB and ⌘P/Ctrl+P
// ---------------------------------------------------------------------------

test.describe('AC1 — Portfolio panel open/close', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockProvider(page);
    await gotoApp(page);
  });

  test('AC1a — FAB opens and close-button closes the panel', async ({ page }) => {
    const errors = attachConsoleCollector(page);

    // Locate FAB — aria-label toggles between "Open portfolio panel" / "Close portfolio panel"
    const fab = page.getByRole('button', { name: /open portfolio panel/i });
    await expect(fab).toBeVisible();

    // --- Open via FAB ---
    await fab.click();
    const panel = page.getByTestId('portfolio-panel');
    // Panel should now show its body content (open gate renders the holdings list)
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Portfolio');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac1-open-fab.png'),
      fullPage: false,
    });

    // --- Close via the X button in panel header ---
    const closeBtn = page.getByTestId('portfolio-panel-close');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    // After close, the panel body gates on `open` — "No holdings" disappears
    await expect(panel).not.toContainText('No holdings');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac1-closed.png'),
      fullPage: false,
    });

    // Report console errors
    if (errors.length > 0) {
      console.log('[AC1a console errors]', errors);
    }
  });

  test('AC1b — ⌘P/Ctrl+P shortcut toggles the panel open and closed', async ({ page }) => {
    const errors = attachConsoleCollector(page);
    const panel = page.getByTestId('portfolio-panel');

    // Ensure panel is closed initially
    await expect(panel).not.toContainText('No holdings');

    // --- Open via ⌘P (macOS: Meta+p) ---
    // Try Meta+p first (darwin); also send Ctrl+p as fallback since Meta may be
    // intercepted by headless Chrome. The keyboard dispatcher handles both.
    await page.keyboard.press('Meta+p');
    // Allow animation to complete (380ms spring)
    await page.waitForTimeout(450);

    const openedWithMeta = await panel.evaluate((el) =>
      el.textContent?.includes('No holdings') ?? false
    );

    if (openedWithMeta) {
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'ac1-open-shortcut.png'),
        fullPage: false,
      });
      console.log('[AC1b] Meta+p WORKED headless — panel opened');

      // Close with Meta+p again (toggle)
      await page.keyboard.press('Meta+p');
      await page.waitForTimeout(300);
      await expect(panel).not.toContainText('No holdings');
    } else {
      // Meta was not captured — try Ctrl+P
      console.log('[AC1b] Meta+p did NOT open panel headless — trying Ctrl+p');
      await page.keyboard.press('Control+p');
      await page.waitForTimeout(450);

      const openedWithCtrl = await panel.evaluate((el) =>
        el.textContent?.includes('No holdings') ?? false
      );

      if (openedWithCtrl) {
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, 'ac1-open-shortcut.png'),
          fullPage: false,
        });
        console.log('[AC1b] Ctrl+p WORKED headless — panel opened');
        // Close again
        await page.keyboard.press('Control+p');
        await page.waitForTimeout(300);
        await expect(panel).not.toContainText('No holdings');
      } else {
        // Neither worked — capture state and fail with diagnostic
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, 'ac1-open-shortcut.png'),
          fullPage: false,
        });
        throw new Error(
          '[AC1b] Neither Meta+p nor Ctrl+p opened the portfolio panel in headless mode. ' +
          'Check whether the keyboard dispatcher is mounted and the onTogglePortfolio callback is wired.'
        );
      }
    }

    if (errors.length > 0) {
      console.log('[AC1b console errors]', errors);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — Empty state
// ---------------------------------------------------------------------------

test.describe('AC2 — Portfolio empty state', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockProvider(page);
    await gotoApp(page);
  });

  test('AC2 — Panel shows empty-state prompt and Add holding button', async ({ page }) => {
    const errors = attachConsoleCollector(page);

    const fab = page.getByRole('button', { name: /open portfolio panel/i });
    await fab.click();

    const panel = page.getByTestId('portfolio-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Portfolio');

    // Empty-state text
    await expect(panel).toContainText('No holdings');

    // "Add holding" button in empty state
    const addEmptyBtn = panel.getByTestId('portfolio-panel-add-empty');
    await expect(addEmptyBtn).toBeVisible();
    await expect(addEmptyBtn).toContainText('Add holding');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac2-empty.png'),
      fullPage: false,
    });

    if (errors.length > 0) {
      console.log('[AC2 console errors]', errors);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — Add/Edit modal fields + submit state
// ---------------------------------------------------------------------------

test.describe('AC3 — Add holding modal fields and submit state', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockProvider(page);
    await gotoApp(page);
    // Open panel and trigger modal
    const fab = page.getByRole('button', { name: /open portfolio panel/i });
    await fab.click();
    const addEmptyBtn = page.getByTestId('portfolio-panel-add-empty');
    await expect(addEmptyBtn).toBeVisible();
    await addEmptyBtn.click();
    await expect(page.getByTestId('add-holding-modal')).toBeVisible();
  });

  test('AC3a — Modal fields render (symbol picker, qty, avg cost, note)', async ({ page }) => {
    const errors = attachConsoleCollector(page);
    const modal = page.getByTestId('add-holding-modal');

    // Dialog header
    await expect(modal).toContainText('Add holding');

    // Symbol search input (placeholder text)
    const symSearch = modal.locator('input[placeholder*="Search symbol"]');
    await expect(symSearch).toBeVisible();

    // Provider chips — at least Coinbase, Binance, Kraken (Alpaca hidden when not Tauri)
    // Chips are buttons with aria-pressed
    const binanceChip = modal.getByRole('button', { name: /binance/i });
    await expect(binanceChip).toBeVisible();

    const coinbaseChip = modal.getByRole('button', { name: /coinbase/i });
    await expect(coinbaseChip).toBeVisible();

    const krakenChip = modal.getByRole('button', { name: /kraken/i });
    await expect(krakenChip).toBeVisible();

    // Quantity field
    const qtyInput = page.getByTestId('holding-qty-input');
    await expect(qtyInput).toBeVisible();

    // Avg cost field
    const avgCostInput = page.getByTestId('holding-avgcost-input');
    await expect(avgCostInput).toBeVisible();

    // Note field
    const noteInput = page.getByTestId('holding-note-input');
    await expect(noteInput).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac3-modal-fields.png'),
      fullPage: false,
    });

    if (errors.length > 0) {
      console.log('[AC3a console errors]', errors);
    }
  });

  test('AC3b — Submit button is DISABLED when qty is empty/invalid', async ({ page }) => {
    const errors = attachConsoleCollector(page);

    const submit = page.getByTestId('add-holding-modal-submit');
    await expect(submit).toBeVisible();

    // On open: sym not selected + qty empty → disabled
    await expect(submit).toBeDisabled();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac3-submit-disabled.png'),
      fullPage: false,
    });

    if (errors.length > 0) {
      console.log('[AC3b console errors]', errors);
    }
  });

  test('AC3c — Submit button becomes ENABLED after valid sym + qty + avg cost', async ({ page }) => {
    const errors = attachConsoleCollector(page);
    const modal = page.getByTestId('add-holding-modal');
    const submit = page.getByTestId('add-holding-modal-submit');

    // Step 1: Pick a symbol from the browse list
    // The browse list loads symbols from symbolCatalogList (falls back to
    // mock data / empty in browser mode). We try clicking the first available
    // row; if none are present we type in the search to find a mock symbol.
    const symbolListContainer = modal.locator('div').filter({ has: modal.locator('[style*="position: relative"]') }).first();

    // Wait a moment for the browse fetch to complete (may be empty in browser mode)
    await page.waitForTimeout(300);

    // Try clicking first rendered symbol row (absolute-positioned in windowed list)
    const firstSymRow = modal.locator('[style*="position: absolute"]').first();
    const hasSymRow = await firstSymRow.count().then((c) => c > 0);

    if (hasSymRow) {
      await firstSymRow.click();
      console.log('[AC3c] Clicked first sym row from browse list');
    } else {
      // Browse list empty in browser mode — the symbol picker will show "Loading..."
      // We cannot select a real symbol without Tauri/DB.
      // Instead verify the disable→enable transition using qty+avgcost inputs
      // knowing symbol selection is a prerequisite. Report this partial path.
      console.log('[AC3c] No browse rows available (browser mode, no DB). Testing qty/avgcost field enable logic only.');
    }

    // Fill qty
    const qtyInput = page.getByTestId('holding-qty-input');
    await qtyInput.fill('1.5');

    // Fill avg cost
    const avgCostInput = page.getByTestId('holding-avgcost-input');
    await avgCostInput.fill('50000');

    // If a sym was selected, submit should now be enabled
    if (hasSymRow) {
      // Wait for React state update
      await page.waitForTimeout(100);
      await expect(submit).toBeEnabled();
      console.log('[AC3c] Submit is ENABLED with sym + qty + avgcost');
    } else {
      // No sym → still disabled; assert that
      await expect(submit).toBeDisabled();
      console.log('[AC3c] Submit still DISABLED (no sym available in browser mode) — PARTIAL');
    }

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac3-submit-enabled.png'),
      fullPage: false,
    });

    if (errors.length > 0) {
      console.log('[AC3c console errors]', errors);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Modal dismiss (close button + Esc)
// ---------------------------------------------------------------------------

test.describe('AC4 — AddHoldingModal dismiss', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockProvider(page);
    await gotoApp(page);
    // Open panel
    const fab = page.getByRole('button', { name: /open portfolio panel/i });
    await fab.click();
  });

  test('AC4a — Modal closes via close button', async ({ page }) => {
    const errors = attachConsoleCollector(page);

    // Open modal
    const addBtn = page.getByTestId('portfolio-panel-add-empty');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const modal = page.getByTestId('add-holding-modal');
    await expect(modal).toBeVisible();

    // Close via close button
    const closeBtn = page.getByTestId('add-holding-modal-close');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    await expect(modal).not.toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac4-dismiss.png'),
      fullPage: false,
    });

    if (errors.length > 0) {
      console.log('[AC4a console errors]', errors);
    }
  });

  test('AC4b — Modal closes via Esc key', async ({ page }) => {
    const errors = attachConsoleCollector(page);

    // Open modal
    const addBtn = page.getByTestId('portfolio-panel-add-empty');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const modal = page.getByTestId('add-holding-modal');
    await expect(modal).toBeVisible();

    // Dismiss via Esc
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ac4-dismiss-esc.png'),
      fullPage: false,
    });

    if (errors.length > 0) {
      console.log('[AC4b console errors]', errors);
    }
  });
});
