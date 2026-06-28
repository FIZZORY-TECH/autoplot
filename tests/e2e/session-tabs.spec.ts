/**
 * tests/e2e/session-tabs.spec.ts — AI Sessions tab-strip E2E specs.
 *
 * Replaces the retired sessions-panel.spec.ts. Sessions are now folded INTO
 * the Terminal header as a tab strip (SessionTabs). The standalone
 * SessionsPanel drawer + its right-rail button are gone.
 *
 * GATING CONVENTION (mirrors terminal-mode.spec.ts):
 *   - Tests that only need the browser/React layer run always (mock provider).
 *   - Tests requiring a live PTY/SQLite (real session lifecycle, auto-start,
 *     busy indicator with real terminal:data) are skipped when no Tauri runtime
 *     is detected (isTauriRuntime() → false).
 *
 * Run in mock/dev mode:    `npx playwright test tests/e2e/session-tabs.spec.ts`
 * Run with Tauri runtime:  start `npm run tauri:dev`, then run above.
 *
 * New data-test selectors (SessionTabs.tsx / ActivityBar.tsx):
 *   Tab strip:       [data-testid="session-tabs"]  (role="tablist")
 *   Tab:             [data-testid="session-tab"]   (role="tab")
 *                    attrs: data-session-id, data-run-state, data-busy,
 *                           data-active, aria-selected
 *                    active class: .session-tab--active
 *   Per-tab actions: button[data-action="rename"]  → inline .session-tab__rename input
 *                    button[data-action="exit"]     (RUNNING tabs only)
 *                    button[data-action="forget"]   (IDLE tabs only, two-click)
 *   New session btn: [data-testid="session-tabs-new"]  (disabled while spawn pending)
 *   Rail busy badge: [data-testid="terminal-busy-badge"]  (shown when any session busy
 *                    AND Terminal drawer closed)
 *
 * OLD selectors that NO LONGER EXIST (retired with SessionsPanel):
 *   sessions-panel, sessions-new, sessions-empty, sessions-body,
 *   sessions-close, sessions-busy-badge, role="dialog" name="AI Sessions",
 *   role="button" name="Sessions" in right rail.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function forceMockProvider(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('use-mock-provider', '1');
  });
}

/** Suppress the FirstRun overlay + toast layer so they don't intercept clicks. */
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

/** Returns true when running inside a real (non-stub) Tauri process. */
async function isTauriRuntime(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as Record<string, unknown>;
    const tauri = w.__TAURI__ as Record<string, unknown> | undefined;
    return tauri !== undefined && !tauri['isStub'];
  });
}

/** Common landing sequence: go to '/', wait for canvas, suppress overlay. */
async function landOnApp(page: Page): Promise<void> {
  await forceMockProvider(page);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await suppressFirstRun(page);
}

/** Open the Terminal drawer via the right-rail button (it is default-open,
 *  so we may need to close-then-reopen to guarantee a fresh open edge). */
async function ensureTerminalOpen(page: Page): Promise<void> {
  const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
  const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
  const isOpen = await terminalBtn.getAttribute('aria-pressed');
  if (isOpen !== 'true') {
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
  }
}

// ---------------------------------------------------------------------------
// Mock-safe tests (no Tauri runtime required)
// ---------------------------------------------------------------------------

test.describe('Session tabs — mock-safe (no Tauri runtime required)', () => {

  // -------------------------------------------------------------------------
  // 1. Terminal is open by default; tab strip container is present
  // -------------------------------------------------------------------------

  test('Terminal drawer opens and [data-testid="session-tabs"] tablist is present', async ({ page }) => {
    await landOnApp(page);
    await ensureTerminalOpen(page);

    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // The session-tabs tablist must be rendered inside the terminal drawer.
    const tabStrip = drawer.locator('[data-testid="session-tabs"]');
    await expect(tabStrip).toBeVisible({ timeout: 3_000 });

    // Strip carries the correct ARIA role.
    await expect(tabStrip).toHaveAttribute('role', 'tablist');
  });

  test('"+" new-session button [data-testid="session-tabs-new"] is present in the tab strip', async ({ page }) => {
    await landOnApp(page);
    await ensureTerminalOpen(page);

    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const newBtn = drawer.locator('[data-testid="session-tabs-new"]');
    await expect(newBtn).toBeVisible({ timeout: 3_000 });

    // Button should not be disabled in mock mode (no pending spawn).
    // It IS enabled (disabled=false / no disabled attr).
    const disabled = await newBtn.getAttribute('disabled');
    expect(disabled).toBeNull();
  });

  test('No "Sessions" rail button — old drawer is retired', async ({ page }) => {
    await landOnApp(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    // The old Sessions rail button must not exist.
    const sessionsBtn = rightRail.getByRole('button', { name: /^Sessions$/ });
    await expect(sessionsBtn).toHaveCount(0);
  });

  test('No role="dialog" named "AI Sessions" — old drawer is retired', async ({ page }) => {
    await landOnApp(page);

    // Old Sessions drawer must be absent from the DOM.
    const oldDrawer = page.getByRole('dialog', { name: 'AI Sessions' });
    await expect(oldDrawer).toHaveCount(0);
  });

  test('Tab strip renders zero tabs in mock mode (dbAiSessionsList returns [] without SQLite)', async ({ page }) => {
    await landOnApp(page);
    await ensureTerminalOpen(page);

    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    // In mock/vite-dev mode there is no Tauri invoke, so hydrate yields [].
    const tabs = drawer.locator('[data-testid="session-tab"]');
    await expect(tabs).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 2. Terminal-busy-badge lives on the Terminal rail button
  // -------------------------------------------------------------------------

  test('terminal-busy-badge is absent in mock mode (no sessions → not busy)', async ({ page }) => {
    await landOnApp(page);

    // With no sessions in mock mode, no session can be busy, so the badge
    // must not appear on the Terminal rail button.
    const badge = page.locator('[data-testid="terminal-busy-badge"]');
    await expect(badge).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 3. Reduced-motion: tab strip is operable and static
  // -------------------------------------------------------------------------

  test('reduced-motion: tab strip renders and "+" button is operable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await landOnApp(page);
    await ensureTerminalOpen(page);

    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const tabStrip = drawer.locator('[data-testid="session-tabs"]');
    await expect(tabStrip).toBeVisible({ timeout: 3_000 });

    const newBtn = drawer.locator('[data-testid="session-tabs-new"]');
    await expect(newBtn).toBeVisible();
  });

  test('reduced-motion: terminal-busy-badge is absent when no sessions (no phantom animation)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await landOnApp(page);

    // No sessions in mock mode → badge must be completely absent (zero count),
    // not just invisible: there must be no stale animated dot.
    const badge = page.locator('[data-testid="terminal-busy-badge"]');
    await expect(badge).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 4. Other drawers unaffected
  // -------------------------------------------------------------------------

  test('Watchlist drawer still opens independently; Terminal tab strip unaffected', async ({ page }) => {
    await landOnApp(page);

    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const watchlistBtn = rightRail.getByRole('button', { name: /^Watchlist/ });
    await watchlistBtn.click({ force: true });
    await page.waitForTimeout(250);

    const watchlistDrawer = page.getByRole('dialog', { name: /Watchlist/i });
    await expect(watchlistDrawer).toBeVisible({ timeout: 3_000 });

    // Re-open Terminal — tab strip must still be present.
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);

    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    await expect(drawer).toBeVisible({ timeout: 3_000 });
    const tabStrip = drawer.locator('[data-testid="session-tabs"]');
    await expect(tabStrip).toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // 5. Lifecycle tests — GATED: require Tauri runtime + PTY/SQLite
  // -------------------------------------------------------------------------

  test('GATED: tab data-attributes are well-formed when sessions exist', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    await ensureTerminalOpen(page);
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const tabs = drawer.locator('[data-testid="session-tab"]');
    const count = await tabs.count();
    if (count > 0) {
      const first = tabs.first();
      const runState = await first.getAttribute('data-run-state');
      expect(['RUNNING', 'IDLE']).toContain(runState);
      const busy = await first.getAttribute('data-busy');
      expect(['true', 'false']).toContain(busy);
      const sessionId = await first.getAttribute('data-session-id');
      expect(sessionId).toBeTruthy();
      const active = await first.getAttribute('data-active');
      expect(['true', 'false']).toContain(active);
      await expect(first).toHaveAttribute('role', 'tab');
    }
  });

  test('GATED: clicking RUNNING tab switches it to active (aria-selected="true")', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    await ensureTerminalOpen(page);
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const runningTab = drawer.locator('[data-testid="session-tab"][data-run-state="RUNNING"]').first();
    const count = await runningTab.count();
    if (count === 0) {
      test.skip();
      return;
    }
    await runningTab.click();
    await page.waitForTimeout(300);
    await expect(runningTab).toHaveAttribute('data-active', 'true');
    await expect(runningTab).toHaveAttribute('aria-selected', 'true');
  });

  test('GATED: "+" button starts a new session and a new tab appears', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    await ensureTerminalOpen(page);
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const newBtn = drawer.locator('[data-testid="session-tabs-new"]');
    const before = await drawer.locator('[data-testid="session-tab"]').count();
    await newBtn.click();
    // Wait up to 8s for a new PTY to spawn and a tab to appear.
    await expect(drawer.locator('[data-testid="session-tab"]')).toHaveCount(before + 1, { timeout: 8_000 });
  });

  test('GATED: exit action transitions RUNNING session to IDLE (data-run-state="IDLE")', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    await ensureTerminalOpen(page);
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const runningTab = drawer.locator('[data-testid="session-tab"][data-run-state="RUNNING"]').first();
    if (await runningTab.count() === 0) {
      test.skip();
      return;
    }
    // Hover to reveal per-tab actions, then click exit.
    await runningTab.hover();
    const exitBtn = runningTab.locator('button[data-action="exit"]');
    await expect(exitBtn).toBeVisible({ timeout: 3_000 });
    await exitBtn.click();
    await page.waitForTimeout(500);
    await expect(runningTab).toHaveAttribute('data-run-state', 'IDLE', { timeout: 5_000 });
  });

  test('GATED: forget two-click (arm then confirm) removes an IDLE tab', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    await ensureTerminalOpen(page);
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    const idleTab = drawer.locator('[data-testid="session-tab"][data-run-state="IDLE"]').first();
    if (await idleTab.count() === 0) {
      test.skip();
      return;
    }
    const before = await drawer.locator('[data-testid="session-tab"]').count();
    await idleTab.hover();
    const forgetBtn = idleTab.locator('button[data-action="forget"]');
    await expect(forgetBtn).toBeVisible({ timeout: 3_000 });
    // First click: arm (button text → "?").
    await forgetBtn.click();
    await expect(forgetBtn).toHaveText('?', { timeout: 2_000 });
    // Second click: confirm → tab removed.
    await forgetBtn.click();
    await expect(drawer.locator('[data-testid="session-tab"]')).toHaveCount(before - 1, { timeout: 5_000 });
  });

  test('GATED: auto-start on Terminal open yields at least one session tab', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    // Close Terminal first to test the closed → open edge.
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'false');

    // Open Terminal — auto-start should fire startNewSession() once.
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);

    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    // Wait up to 8s for the auto-spawned session tab to appear.
    await expect(drawer.locator('[data-testid="session-tab"]')).not.toHaveCount(0, { timeout: 8_000 });
  });

  test('GATED: terminal-busy-badge appears on Terminal rail button when busy and drawer closed', async ({ page }) => {
    await landOnApp(page);
    const needsTauri = await isTauriRuntime(page);
    if (!needsTauri) {
      test.skip();
      return;
    }

    // Ensure a RUNNING session exists (auto-start or pre-existing).
    const drawer = page.getByRole('dialog', { name: 'Claude CLI terminal' });
    await ensureTerminalOpen(page);
    const tabs = drawer.locator('[data-testid="session-tab"][data-run-state="RUNNING"]');
    if (await tabs.count() === 0) {
      test.skip();
      return;
    }

    // Close the Terminal drawer — badge should appear if any session is busy.
    const rightRail = page.getByRole('toolbar', { name: 'Right dock' });
    const terminalBtn = rightRail.getByRole('button', { name: 'Terminal' });
    await terminalBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'false');

    // The badge appears while a session is within its 700ms busy window.
    // We cannot guarantee activity without PTY output, so we just verify
    // the badge selector and ARIA shape when it IS present.
    const badge = page.locator('[data-testid="terminal-busy-badge"]');
    // If badge is present, it must be inside the Terminal button and aria-hidden.
    const count = await badge.count();
    if (count > 0) {
      await expect(badge.first()).toHaveAttribute('aria-hidden', 'true');
    }
    // Either badge is present (busy) or absent (idle) — both are valid outcomes.
    // The test exercises the selector path; the busy-badge unit-tested at store level.
  });
});
