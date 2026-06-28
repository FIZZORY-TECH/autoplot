/**
 * tests/e2e/saved-indicators.spec.ts — Step 8 Playwright verification for the
 * IndicatorPanel "Saved indicators" section (Pine→indicator reuse feature).
 *
 * Mirrors the established research-overlay spec conventions:
 *   - Mock provider forced via localStorage (vite-dev compatible).
 *   - first-run / toast hosts suppressed so they never intercept clicks.
 *   - DEV-only window hooks drive store state directly (no Tauri / SQLite).
 *
 * DEV hooks used (set in AppShell.tsx, guarded on import.meta.env.DEV):
 *   window.__savedIndicatorsTest
 *     .seed(overlays)   — write rows into useResearchOverlayLibraryStore (mirror only)
 *     .clear()          — empty the library mirror
 *     .getOverlays()    — read the library mirror back
 *     .getApplied()     — read useChartMutationStore.researchOverlays (post-Apply)
 *     .setActive(sym,tf)— set the store active asset+tf (satisfies the Apply gate
 *                         + simulates switching symbols)
 * If the hook is absent (production build), every test skips gracefully.
 *
 * Coverage:
 *   1. Empty state: "No saved indicators yet" when the library is empty.
 *   2. Seeded overlay renders a card (label, meta, PINE provenance badge).
 *   3. Switch symbol → Apply RECOMPUTES the recipe for the live (sym, tf):
 *      the applied overlay is keyed `<id>:recompute`, carries the active sym,
 *      and (rsi recipe) contains a pane:'series' element (sub-pane routing).
 *      The button flashes "✓ applied".
 *   4. Two-click delete: first click arms ("confirm?"), second removes the row.
 *
 * RUNTIME: vite dev (http://localhost:1420). No Tauri runtime required.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers (mirror research-overlay.spec.ts conventions)
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

/** Wait up to `ms` for window[hookName] to be truthy. */
async function waitForHook(page: Page, hookName: string, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const present = await page.evaluate((name: string) => {
      return name in (window as unknown as Record<string, unknown>);
    }, hookName);
    if (present) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** Seed the library mirror via the DEV hook. */
async function seedLibrary(page: Page, overlays: unknown[]): Promise<void> {
  await page.evaluate((rows) => {
    const w = window as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w.__savedIndicatorsTest as any).seed(rows);
  }, overlays);
}

/** Set the store active asset + tf via the DEV hook. */
async function setActive(page: Page, sym: string, tf: string): Promise<void> {
  await page.evaluate(
    ({ sym: s, tf: t }) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__savedIndicatorsTest as any).setActive(s, t);
    },
    { sym, tf },
  );
}

/** Open the Indicators drawer (D-key toggle) and wait for the panel body. */
async function openIndicatorPanel(page: Page): Promise<void> {
  // Click the chart first so the keydown isn't swallowed by a focused input.
  await page.locator('canvas').first().click({ position: { x: 40, y: 40 }, force: true });
  // D toggles the indicators drawer (src/stores/keyboard.ts).
  await page.keyboard.press('d');
  await page.waitForTimeout(250);
}

/**
 * Scope a locator to the IndicatorPanel drawer (DockDrawer id='indicator' →
 * data-testid='indicator'). The same seeded library mirror also feeds the
 * Research Library's Overlays list, so an unscoped `.ds-card` would match cards
 * in BOTH drawers — every assertion below must be scoped to this panel.
 */
function panel(page: Page) {
  return page.locator('[data-testid="indicator"]');
}

// ---------------------------------------------------------------------------
// Fixtures — a PersistedResearchOverlay (canonical overlay + created_at).
// The recipe drives the recompute-on-Apply path; rsi → pane:'series' sub-pane.
// `source:'pine'` triggers the PINE provenance badge on the card.
// ---------------------------------------------------------------------------

const RSI_SAVED = {
  id: 'e2e-saved-rsi',
  sym: 'BTC',
  tf: '1h' as const,
  label: 'RSI(14)',
  source: 'pine' as const,
  recipe: {
    source: 'pine' as const,
    series: [{ kind: 'rsi' as const, params: { period: 14 }, pane: 'series' as const }],
  },
  // Frozen snapshot elements (what was applied at save time). Recompute replaces
  // these; included so the row is a valid ResearchOverlay even before Apply.
  elements: [
    {
      type: 'line' as const,
      values: Array.from({ length: 60 }, (_, i) => 50 + 20 * Math.sin(i / 6)),
      align: 'right' as const,
      pane: 'series' as const,
    },
  ],
  created_at: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('IndicatorPanel — Saved indicators section', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(500); // let MockMarketDataProvider populate bars
    await suppressFirstRun(page);
  });

  test('empty state shows "No saved indicators yet" when library is empty', async ({ page }) => {
    if (!(await waitForHook(page, '__savedIndicatorsTest'))) {
      test.skip(true, 'window.__savedIndicatorsTest not present — skipping');
      return;
    }

    // Ensure the mirror is empty, then open the panel.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__savedIndicatorsTest as any).clear();
    });
    await openIndicatorPanel(page);

    const empty = panel(page).locator('.lib-empty-heading', { hasText: 'No saved indicators yet' });
    await expect(empty).toBeVisible({ timeout: 3000 });
  });

  test('seeded overlay renders a card with label, meta, and PINE badge', async ({ page }) => {
    if (!(await waitForHook(page, '__savedIndicatorsTest'))) {
      test.skip(true, 'window.__savedIndicatorsTest not present — skipping');
      return;
    }

    await seedLibrary(page, [RSI_SAVED]);
    await openIndicatorPanel(page);

    // The card label (.ds-label) reads the overlay label.
    const label = panel(page).locator('.ds-label', { hasText: 'RSI(14)' });
    await expect(label).toBeVisible({ timeout: 3000 });

    // Meta derives "kind · pane" from recipe.series[0] → "rsi · sub-pane".
    const meta = panel(page).locator('.ds-meta', { hasText: 'rsi · sub-pane' });
    await expect(meta).toBeVisible();

    // Provenance badge: source 'pine' → PINE pill, reusing .legend-hud-badge--pine.
    const badge = panel(page).locator('.legend-hud-badge--pine', { hasText: 'PINE' });
    await expect(badge).toBeVisible();
  });

  test('switch symbol then Apply recomputes the recipe for the live (sym, tf)', async ({ page }) => {
    if (!(await waitForHook(page, '__savedIndicatorsTest'))) {
      test.skip(true, 'window.__savedIndicatorsTest not present — skipping');
      return;
    }

    // Saved against BTC 1h; switch the active context to ETH 4h so Apply must
    // RECOMPUTE rather than re-stretch the frozen snapshot.
    await seedLibrary(page, [RSI_SAVED]);
    await setActive(page, 'ETH', '4h');
    // Give the history-fetch effect time to repopulate bars for the new symbol so
    // the Apply gate (disabled while bars.length === 0) is satisfied.
    await page.waitForTimeout(700);

    await openIndicatorPanel(page);

    const applyBtn = panel(page)
      .locator('.ds-card', { hasText: 'RSI(14)' })
      .locator('button.ds-toggle');
    await expect(applyBtn).toBeEnabled({ timeout: 3000 });
    await applyBtn.click();

    // The button flashes "✓ applied" for ~1.2s.
    await expect(applyBtn).toHaveText('✓ applied', { timeout: 1500 });

    // The applied overlay is keyed `<id>:recompute`, retargeted to ETH/4h, and
    // (rsi recipe) carries a pane:'series' element → sub-pane routing.
    const applied = (await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (w.__savedIndicatorsTest as any).getApplied();
    })) as Record<
      string,
      { sym: string; tf: string; elements: Array<{ type: string; pane?: string }> }
    >;

    const recomputed = applied['e2e-saved-rsi:recompute'];
    expect(recomputed).toBeDefined();
    expect(recomputed.sym.toLowerCase()).toBe('eth');
    expect(recomputed.tf).toBe('4h');
    const hasSeriesPane = recomputed.elements.some((el) => el.pane === 'series');
    expect(hasSeriesPane).toBe(true);
  });

  test('two-click delete arms then removes the card', async ({ page }) => {
    if (!(await waitForHook(page, '__savedIndicatorsTest'))) {
      test.skip(true, 'window.__savedIndicatorsTest not present — skipping');
      return;
    }

    await seedLibrary(page, [RSI_SAVED]);
    await openIndicatorPanel(page);

    const card = panel(page).locator('.ds-card', { hasText: 'RSI(14)' });
    await expect(card).toBeVisible({ timeout: 3000 });

    const rm = card.locator('button.lib-rm');
    // First click arms — label flips to "confirm?".
    await rm.click();
    await expect(rm).toHaveText('confirm?', { timeout: 1500 });

    // Second click confirms — the card disappears and the empty state returns.
    await rm.click();
    await expect(card).toHaveCount(0, { timeout: 2000 });

    // Mirror is now empty.
    const remaining = (await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (w.__savedIndicatorsTest as any).getOverlays();
    })) as unknown[];
    expect(remaining.length).toBe(0);
  });
});
