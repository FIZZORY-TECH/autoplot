/**
 * tests/e2e/terminal-mode.spec.ts — Step 14: Terminal mode E2E smoke tests.
 *
 * GATING CONVENTION (mirrors p7-strategy-flow.spec.ts):
 *   - Tests that only need the browser/React layer run always (mock provider).
 *   - Tests that need a live PTY (xterm canvas with real output) gate on
 *     `isTauriRuntime()` and call `test.skip()` when absent.
 *
 * Run in mock/dev mode:    `npx playwright test tests/e2e/terminal-mode.spec.ts`
 * Run with Tauri runtime:  start `npm run tauri:dev`, then run above.
 *
 * Dock UI notes:
 *   - The Terminal drawer is OPEN BY DEFAULT at launch (right rail, one-per-side).
 *   - The right rail is role="toolbar" aria-label="Right dock".
 *   - The Terminal rail icon button has aria-label="Terminal".
 *   - Clicking the icon when Terminal is already open closes the drawer (toggle).
 *   - The Terminal DockDrawer has aria-label="Claude CLI terminal" (TerminalPanel.tsx).
 *
 * Dock open/close tests (1 & 2) do NOT use a Tauri stub — the terminal drawer
 * is a pure CSS/React layout concern testable in plain vite-dev. The stub
 * interfered with chart canvas initialization, so it was removed.
 *
 * Test 3 (xterm canvas) and test 4 (PTY data) gate on a live Tauri runtime
 * and skip cleanly in all other environments.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set use-mock-provider so no real market data calls are attempted. */
async function forceMockProvider(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

/**
 * Detect whether the page is running inside a real Tauri process.
 * Real Tauri runtime does NOT set any `isStub` marker.
 */
async function isTauriRuntime(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as Record<string, unknown>;
    const tauri = w.__TAURI__ as Record<string, unknown> | undefined;
    return tauri !== undefined && !tauri['isStub'];
  });
}

// ---------------------------------------------------------------------------
// Helper — suppress the firstrun overlay so it doesn't block pointer events.
// In browser-only mode claudeTestConnection rejects with CliNotFound which
// mounts the .firstrun-overlay. Inject CSS to hide it.
// ---------------------------------------------------------------------------
async function suppressFirstRun(page: Page): Promise<void> {
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
// Tests
// ---------------------------------------------------------------------------

test.describe('Terminal mode', () => {
  // ---- Test 1: Terminal drawer is open by default; toggle via rail icon -----
  //
  // This is a pure browser/dock layout test — no Tauri stub required.
  // The Terminal DockDrawer is default-open (useDockStore initializes
  // openRight='terminal'). We verify the rail icon state and drawer presence.
  // The DockDrawer aria-label is "Claude CLI terminal" (TerminalPanel.tsx).

  test('Terminal drawer is open by default at launch', async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');

    // Wait for the app shell to settle (canvas / chart mounts).
    await page.waitForSelector('canvas', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await suppressFirstRun(page);

    // Right rail — Terminal icon should be aria-pressed=true (default-open).
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    await expect(terminalBtn).toBeVisible({ timeout: 5_000 });
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');

    // DockDrawer for Terminal — aria-label="Claude CLI terminal".
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    await expect(drawer).toBeVisible({ timeout: 3_000 });
  });

  // ---- Test 2: clicking Terminal rail icon closes then re-opens the drawer ---
  //
  // Pure dock layout test — no Tauri stub required.

  test('clicking Terminal rail icon closes the drawer; clicking again opens it', async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');

    await page.waitForSelector('canvas', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await suppressFirstRun(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });

    // Terminal is open at launch.
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');

    // Click to close. Dispatch via JS to bypass any overlay interception.
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(500);
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'false');

    // Click to re-open.
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(500);
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');
  });

  // ---- Test 3: xterm canvas content (Tauri runtime only) -------------------
  //
  // PTY output / xterm canvas assertions require the Tauri runtime.
  // Skip immediately in browser-only / vite-dev mode. The Tauri stub is NOT
  // used here because the stub cannot render actual xterm output and causes the
  // chart canvas to fail to mount.

  test('xterm canvas renders inside the Terminal drawer (Tauri only)', async ({ page }) => {
    await forceMockProvider(page);
    // Do NOT install the stub — check for a real Tauri runtime directly.
    await page.goto('/');

    await page.waitForSelector('canvas', { timeout: 10_000 });

    const tauri = await isTauriRuntime(page);
    if (!tauri) {
      test.skip(
        true,
        'xterm canvas content requires a live Tauri runtime — start with `npm run tauri:dev`',
      );
      return;
    }

    await page.waitForTimeout(400);
    await suppressFirstRun(page);

    // Terminal drawer is default-open at launch.
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    await expect(drawer).toBeVisible({ timeout: 3_000 });

    // Real runtime: wait for the xterm canvas to appear in the drawer body.
    const xtermCanvas = drawer.locator('.xterm-screen, .xterm canvas').first();
    await expect(xtermCanvas).toBeVisible({ timeout: 8_000 });
  });

  // ---- Test 4: terminal:data event arrives (Tauri runtime only) -------------

  test('terminal data renders in xterm within 8 s (Tauri only)', async ({ page }) => {
    // This test requires a LIVE Tauri runtime — the stub does not forward PTY
    // output, so `.xterm-rows` will remain empty. Skip when not in Tauri.
    await forceMockProvider(page);
    // Do NOT install the stub for this test — we need the real Tauri invoke.
    await page.goto('/');
    await page.waitForSelector('canvas', { timeout: 10_000 });

    const tauri = await isTauriRuntime(page);
    if (!tauri) {
      test.skip(
        true,
        'terminal data test requires a live Tauri runtime — start with `npm run tauri:dev`',
      );
      return;
    }

    // Terminal drawer is already open at launch.
    const drawer = page.getByRole('dialog', { name: 'Terminal' });
    await expect(drawer).toBeVisible({ timeout: 3_000 });

    // Wait for at least one xterm row to contain non-whitespace text, which
    // indicates the Claude TUI welcome has been received and rendered.
    // `.xterm-rows` holds `<div>` rows; each row contains `<span>` characters.
    const xtermRows = drawer.locator('.xterm-rows');
    await expect(xtermRows).toBeVisible({ timeout: 8_000 });

    // Poll until any row span contains visible text (timeout: 8 s).
    await expect(async () => {
      const text = await xtermRows.innerText();
      expect(text.trim().length).toBeGreaterThan(0);
    }).toPass({ timeout: 8_000 });
  });
});
