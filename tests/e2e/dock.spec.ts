/**
 * tests/e2e/dock.spec.ts — Dock layout (ActivityBar + DockDrawer) integration.
 *
 * Runs against http://localhost:1420 (Vite dev server, mock data provider).
 *
 * Scope: pure-frontend dock layout behaviors that work WITHOUT the Tauri runtime.
 *   - Only the right rail renders (left rail is unused; all drawers are on the right).
 *   - At launch the Terminal rail icon is aria-pressed=true (default-open).
 *   - --reserve-right is non-zero at launch (terminal drawer insets the chart).
 *   - Clicking the Watchlist icon (right rail) opens the right drawer; clicking again closes it.
 *   - --reserve-right increases when watchlist is open, returns to previous value when closed.
 *   - One-per-side: opening Portfolio on the right replaces Terminal as active.
 *
 * Skip conventions:
 *   - Anything requiring the Tauri runtime (PTY output, SQLite, Alpaca) is
 *     wrapped in `test.skip` with a clear reason.
 *
 * Note on window.getComputedStyle vs inline style:
 *   useDockStore writes `--reserve-*` directly to
 *   `document.documentElement.style.setProperty`, so they appear in the
 *   element's *inline* style, not in the computed cascade. We read them via
 *   `document.documentElement.style.getPropertyValue` via page.evaluate.
 *
 * Note on the FirstRun overlay:
 *   In browser-only (vite dev) mode, `claudeTestConnection` rejects with
 *   `CliNotFound`, which mounts the `.firstrun-overlay` (`aria-modal="true"`).
 *   The `cli-not-found` branch has NO dismiss button, so we inject a CSS rule
 *   to remove it from the pointer-event layer and then hide it entirely.
 *   This is intentional — the dock is a layout layer that must work regardless
 *   of the CLI gate. The `force: true` option on button clicks is a belt-and-
 *   suspenders guard in case the overlay is slow to render.
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper — hide the firstrun overlay so it doesn't block pointer events.
// In browser-only mode claudeTestConnection rejects with CliNotFound, which
// mounts the .firstrun-overlay (aria-modal="true"). The cli-not-found branch
// has NO dismiss button; we suppress it via CSS + attribute injection.
// ---------------------------------------------------------------------------

async function suppressFirstRun(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    // Inject a style rule that forcibly hides the overlay and removes its
    // pointer-event capture so the underlying dock buttons are reachable.
    const style = document.createElement('style');
    style.id = '__test-suppress-firstrun';
    // Also neutralize the transient toast layer: in browser-only/mock mode a
    // warn toast renders top-right (top:16/right:16) and is tall enough to
    // overlap the now-topmost right-rail icon (Watchlist), intercepting clicks.
    // The toast is incidental to dock-layout testing (same rationale as the
    // firstrun overlay), and `.toast-host` is already pointer-events:none when
    // empty — we hide it outright so a visible toast can't sit over the rail.
    style.textContent =
      '.firstrun-overlay { display: none !important; pointer-events: none !important; }' +
      '.toast-host { display: none !important; pointer-events: none !important; }';
    if (!document.getElementById('__test-suppress-firstrun')) {
      document.head.appendChild(style);
    }
  });
  // Give React a tick to re-render in case the overlay is still resolving.
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// Helper — read a --reserve-* CSS var from document.documentElement inline style.
// ---------------------------------------------------------------------------

async function getReserve(
  page: import('@playwright/test').Page,
  side: 'left' | 'right',
): Promise<string> {
  return page.evaluate((s: string) => {
    return document.documentElement.style.getPropertyValue(`--reserve-${s}`);
  }, side);
}

// ---------------------------------------------------------------------------
// Common setup
// ---------------------------------------------------------------------------

async function setup(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('canvas');
  await page.waitForTimeout(400);
  await suppressFirstRun(page);
}

// ---------------------------------------------------------------------------
// 1. Activity rail renders (right rail only)
// ---------------------------------------------------------------------------

test.describe('Dock — ActivityBar rails', () => {
  test('right rail is present with correct aria-label', async ({ page }) => {
    await setup(page);

    // Right rail — aria-label="Right dock", role="toolbar".
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    await expect(rightRail).toBeVisible();
  });

  test('right rail contains Watchlist, Terminal, Portfolio, Indicators, Settings buttons', async ({
    page,
  }) => {
    await setup(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    // Watchlist has moved to the right rail; Strategy is MCP-bridge-only (no toggle button).
    await expect(rightRail.getByRole('button', { name: 'Watchlist' })).toBeVisible();
    await expect(rightRail.getByRole('button', { name: 'Terminal' })).toBeVisible();
    await expect(rightRail.getByRole('button', { name: 'Portfolio' })).toBeVisible();
    await expect(rightRail.getByRole('button', { name: 'Indicators' })).toBeVisible();
    await expect(rightRail.getByRole('button', { name: 'Settings' })).toBeVisible();
    // Strategy has no rail toggle button (MCP-bridge-only).
    await expect(rightRail.getByRole('button', { name: 'Strategy' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Terminal is default-open at launch
// ---------------------------------------------------------------------------

test.describe('Dock — Terminal default-open', () => {
  test('Terminal icon is aria-pressed=true at launch', async ({ page }) => {
    await setup(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('--reserve-right is non-zero at launch (terminal drawer insets chart)', async ({
    page,
  }) => {
    await setup(page);

    const reserveRight = await getReserve(page, 'right');
    // Should be a pixel value like "560px" or a clamped value — NOT "0px" or "".
    expect(reserveRight).not.toBe('0px');
    expect(reserveRight).not.toBe('');
    // Should be a px value greater than zero.
    const px = parseFloat(reserveRight);
    expect(px).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Right drawer toggle (Watchlist — now on the right rail)
// ---------------------------------------------------------------------------

test.describe('Dock — Watchlist right drawer toggle', () => {
  test('clicking Watchlist opens the right drawer (--reserve-right becomes non-zero)', async ({
    page,
  }) => {
    await setup(page);

    // Terminal is default-open, so --reserve-right is already non-zero at launch.
    // First close Terminal so we can test Watchlist's effect in isolation.
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    await terminalBtn.click({ force: true });
    await page.waitForTimeout(200);
    // Now verify reserve is 0 (terminal closed, watchlist not yet open).
    const afterTerminal = await getReserve(page, 'right');
    expect(parseFloat(afterTerminal || '0')).toBe(0);

    const watchlistBtn = rightRail.getByRole('button', { name: 'Watchlist' });

    // Click Watchlist to open. force:true in case overlay hasn't fully hidden.
    await watchlistBtn.click({ force: true });
    await page.waitForTimeout(200);

    // Button should now be aria-pressed=true.
    await expect(watchlistBtn).toHaveAttribute('aria-pressed', 'true');

    // --reserve-right should be > 0.
    const openReserve = await getReserve(page, 'right');
    const openPx = parseFloat(openReserve || '0');
    expect(openPx).toBeGreaterThan(0);

    // --reserve-left is always 0 (no left drawers).
    const leftReserve = await getReserve(page, 'left');
    expect(parseFloat(leftReserve || '0')).toBe(0);
  });

  test('clicking Watchlist again closes it (--reserve-right returns to 0px)', async ({
    page,
  }) => {
    await setup(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    // Close Terminal first so Watchlist toggle is isolated.
    await rightRail.getByRole('button', { name: 'Terminal' }).click({ force: true });
    await page.waitForTimeout(200);

    const watchlistBtn = rightRail.getByRole('button', { name: 'Watchlist' });

    // Open then close.
    await watchlistBtn.click({ force: true });
    await page.waitForTimeout(200);
    await watchlistBtn.click({ force: true });
    await page.waitForTimeout(200);

    // Button should now be aria-pressed=false.
    await expect(watchlistBtn).toHaveAttribute('aria-pressed', 'false');

    // --reserve-right should be back to 0px (terminal also closed).
    const closedReserve = await getReserve(page, 'right');
    expect(closedReserve).toBe('0px');
  });
});

// ---------------------------------------------------------------------------
// 4. One-per-side: opening Portfolio on the right replaces Terminal
// ---------------------------------------------------------------------------

test.describe('Dock — one-per-side (right)', () => {
  test('opening Portfolio replaces Terminal as the active right drawer', async ({ page }) => {
    await setup(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    const portfolioBtn = rightRail.getByRole('button', { name: 'Portfolio' });

    // Terminal should be active at launch.
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(portfolioBtn).toHaveAttribute('aria-pressed', 'false');

    // Click Portfolio — replaces Terminal.
    await portfolioBtn.click({ force: true });
    await page.waitForTimeout(200);

    await expect(portfolioBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------
// 5. Tauri-only: PTY output / terminal text content
// ---------------------------------------------------------------------------

test.skip('Terminal PTY output requires Tauri runtime — not testable in vite-dev mode', async () => {
  // Skipped: XtermPanel mounts inside DockDrawer(mountOnOpen) but the actual PTY
  // spawn (terminal_spawn Tauri command) is unavailable without the Rust backend.
  // XtermPanel does NOT render any visible text in pure browser mode; it only
  // attaches a real xterm.js instance once invoke('terminal_spawn') resolves.
  // Re-enable with the Tauri test runner: `npm run tauri:dev` + Playwright config
  // that targets the webview directly (not the Vite dev server).
});
