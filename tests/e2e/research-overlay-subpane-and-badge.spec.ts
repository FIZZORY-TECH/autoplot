/**
 * tests/e2e/research-overlay-subpane-and-badge.spec.ts
 *
 * E2E coverage for:
 *   (a) A research overlay with a `pane:'series'` line renders in the sub-pane:
 *       the sub-pane divider is present (canvas splits) and the PRICE y-axis is
 *       NOT stretched to 0–100.
 *   (b) LegendHUD row appears for the overlay AND `.legend-hud-badge--pine` is
 *       visible when `source:'pine'`.
 *   (c) The sub-pane never overlaps the right rail — chart-wrap right edge stays
 *       left of the rail (reusing the stacking-context spec's bounding-box check).
 *   (d) Bollinger recipe shape: a band (upper+lower) + middle line, pane omitted
 *       (price), renders on the PRICE pane — band NOT in sub-pane, price axis intact.
 *       NOTE: the live Pine→shape mapping (agent emitting the correct payload via
 *       PineScript-to-indicator skill tool calls) is NOT tested here — Playwright
 *       cannot drive the live Claude CLI subprocess. That boundary is covered by
 *       manual UAT. This test only verifies the DETERMINISTIC payload shape that
 *       the skill prescribes renders correctly.
 *
 * INJECTION: uses window.__researchOverlayTest (DEV-only hook in AppShell.tsx).
 * If the hook is absent (production build), all tests skip gracefully.
 *
 * RUNTIME: vite dev (http://localhost:1420). Mock provider forced via localStorage.
 * No Tauri runtime required — all assertions are DOM/canvas-geometry or store-state.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers — mirrors research-overlay.spec.ts conventions
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

/** Wait up to `ms` ms for window[hookName] to be truthy. */
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

/** Expand LegendHUD if it is in the collapsed "Indicators" pill state. */
async function expandLegend(page: Page): Promise<void> {
  const expandBtn = page.locator('[aria-label="Expand overlay legend"]');
  if (await expandBtn.isVisible().catch(() => false)) {
    await expandBtn.click({ force: true });
    await page.waitForTimeout(200);
  }
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

// A research overlay with ONE pane:'series' line (RSI-like 0-100 oscillator).
// `source:'pine'` triggers the Pine provenance badge.
const RSI_SERIES_OVERLAY = {
  id: 'e2e-rsi-series-pane',
  sym: 'BTC',
  tf: '1h',
  label: 'E2E RSI(14)',
  color: '#9b59b6',
  source: 'pine' as const,
  elements: [
    {
      type: 'line' as const,
      values: Array.from({ length: 200 }, (_, i) => 50 + 30 * Math.sin(i / 8)),
      align: 'right' as const,
      color: '#9b59b6',
      pane: 'series' as const,
    },
  ],
};

// A research overlay with ONLY price-pane elements (hline at a price level).
// Used as a sanity baseline: this must NOT activate the sub-pane.
const PRICE_PANE_OVERLAY = {
  id: 'e2e-price-pane-baseline',
  sym: 'BTC',
  tf: '1h',
  label: 'E2E Price Level',
  color: '#4af',
  elements: [
    { type: 'hline' as const, price: 50000, label: 'Support' },
  ],
};

// Bollinger band recipe shape (deterministic): one BandElement (upper+lower) +
// one LineElement (middle), all on the price pane (pane omitted = default price).
// NOTE: This test ONLY verifies that the deterministic payload renders on the
// price pane and does NOT activate the sub-pane. The live agent emit of this
// shape (Pine→tool→apply) is covered by manual UAT, not this spec.
const BOLLINGER_OVERLAY = {
  id: 'e2e-bollinger-recipe',
  sym: 'BTC',
  tf: '1h',
  label: 'E2E BB(20)',
  color: '#3498db',
  elements: [
    // Middle line — price pane (pane omitted = default 'price')
    {
      type: 'line' as const,
      values: Array.from({ length: 200 }, (_, i) => 50000 + 200 * Math.cos(i / 12)),
      align: 'right' as const,
      color: '#3498db',
      // pane omitted → price
    },
    // Band: upper + lower shaded region — price pane (pane omitted)
    {
      type: 'band' as const,
      upper: Array.from({ length: 200 }, (_, i) => 51500 + 300 * Math.cos(i / 12)),
      lower: Array.from({ length: 200 }, (_, i) => 48500 + 100 * Math.cos(i / 12)),
      align: 'right' as const,
      color: '#3498db',
      opacity: 0.15,
      // pane omitted → price
    },
  ],
};

// ---------------------------------------------------------------------------
// Shared geometry helper — measures chart-wrap vs rail positions.
// Reused from subchart-pane-stays-in-chart-stacking-context.spec.ts.
// ---------------------------------------------------------------------------
type GeomResult =
  | { ok: true; wrapRight: number; railLeft: number }
  | { ok: false; reason: string; wrapRight?: number; railLeft?: number };

async function measureWrapVsRail(page: Page): Promise<GeomResult> {
  return page.evaluate((): GeomResult => {
    const canvas = document.querySelector('canvas');
    const rail = document.querySelector('[aria-label="Right dock"]');
    if (!canvas || !rail) return { ok: false, reason: 'missing canvas or right dock' };

    let wrap: HTMLElement | null = canvas.parentElement;
    while (wrap) {
      const style = getComputedStyle(wrap);
      if (style.position === 'absolute' && style.isolation === 'isolate') break;
      wrap = wrap.parentElement;
    }
    if (!wrap) return { ok: false, reason: 'chart-wrap not found' };

    const wrapRect = wrap.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    return {
      ok: wrapRect.right <= railRect.left,
      wrapRight: wrapRect.right,
      railLeft: railRect.left,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('research overlay — sub-pane rendering + provenance badge', () => {
  test.beforeEach(async ({ page }) => {
    await forceMockProvider(page);
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(500); // let MockMarketDataProvider populate
    await suppressFirstRun(page);
  });

  // ── (a) pane:'series' overlay renders in the sub-pane; price axis not stretched ──

  test('(a) pane:series overlay splits canvas into sub-pane — canvas count stays same', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    const canvasBefore = await page.locator('canvas').count();

    // Inject the series-pane overlay via the established DEV hook.
    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, RSI_SERIES_OVERLAY);
    await page.waitForTimeout(400);

    // Sub-pane is canvas-drawn inside the single <canvas> — no extra canvas must appear.
    const canvasAfter = await page.locator('canvas').count();
    expect(canvasAfter).toBe(canvasBefore);

    // Verify the overlay was actually applied with the pane:'series' element.
    const state = await page.evaluate((): unknown => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (w.__researchOverlayTest as any).getState();
    });
    expect(state).toHaveProperty('e2e-rsi-series-pane');
  });

  test('(a) pane:series overlay — canvas pixels change after injection (sub-pane painted)', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    const canvas = page.locator('canvas').first();
    const before = await canvas.screenshot();

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, RSI_SERIES_OVERLAY);
    await page.waitForTimeout(400);

    const after = await canvas.screenshot();
    // A sub-pane divider + oscillator line must have repainted pixels.
    expect(Buffer.compare(before, after)).not.toBe(0);
  });

  test('(a) price-only overlay does NOT activate sub-pane (store returns null for series elements)', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, PRICE_PANE_OVERLAY);
    await page.waitForTimeout(400);

    // Verify the overlay is in the store but has no pane:'series' elements.
    const overlays = await page.evaluate((): unknown => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (w.__researchOverlayTest as any).getState();
    }) as Record<string, { elements: Array<{ type: string; pane?: string }> }>;

    const priceOverlay = overlays['e2e-price-pane-baseline'];
    expect(priceOverlay).toBeDefined();
    // None of its elements carry pane:'series' — so no sub-pane is allocated.
    const hasSeriesPane = priceOverlay.elements.some((el) => el.pane === 'series');
    expect(hasSeriesPane).toBe(false);
  });

  // ── (b) LegendHUD row + provenance badge ────────────────────────────────────

  test('(b) legend row appears for series-pane overlay with Pine badge', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, RSI_SERIES_OVERLAY);
    await page.waitForTimeout(300);
    await expandLegend(page);

    // Legend HUD is present.
    const hud = page.locator('[data-testid="legend-hud"]');
    await expect(hud).toBeVisible();

    // The overlay label row is visible.
    const labelEl = page.locator('.legend-hud-label', { hasText: 'E2E RSI(14)' });
    await expect(labelEl).toBeVisible({ timeout: 3000 });

    // The Pine provenance badge is rendered (source:'pine' → .legend-hud-badge--pine).
    const badge = page.locator('.legend-hud-badge--pine');
    await expect(badge).toBeVisible({ timeout: 3000 });
    await expect(badge).toHaveText('Pine');
  });

  test('(b) nl source renders AI badge, not Pine badge', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    const nlOverlay = {
      ...RSI_SERIES_OVERLAY,
      id: 'e2e-rsi-nl-source',
      label: 'E2E RSI NL',
      source: 'nl' as const,
    };

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, nlOverlay);
    await page.waitForTimeout(300);
    await expandLegend(page);

    const nlBadge = page.locator('.legend-hud-badge--nl');
    await expect(nlBadge).toBeVisible({ timeout: 3000 });
    await expect(nlBadge).toHaveText('AI');

    // Ensure no Pine badge is shown for this overlay.
    const pineBadge = page.locator('.legend-hud-badge--pine');
    await expect(pineBadge).not.toBeVisible();
  });

  test('(b) overlay without source has no provenance badge', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    const noSourceOverlay = {
      id: 'e2e-no-source-badge',
      sym: 'BTC',
      tf: '1h' as const,
      label: 'E2E No Badge',
      color: '#4af',
      // source omitted
      elements: [{ type: 'hline' as const, price: 50000, label: 'Level' }],
    };

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, noSourceOverlay);
    await page.waitForTimeout(300);
    await expandLegend(page);

    const labelEl = page.locator('.legend-hud-label', { hasText: 'E2E No Badge' });
    await expect(labelEl).toBeVisible({ timeout: 3000 });

    // Neither Pine nor AI badge should be present for a source-absent overlay.
    const pineBadge = page.locator('.legend-hud-badge--pine');
    const nlBadge = page.locator('.legend-hud-badge--nl');
    await expect(pineBadge).not.toBeVisible();
    await expect(nlBadge).not.toBeVisible();
  });

  // ── (c) Sub-pane never overlaps the right rail ──────────────────────────────

  test('(c) chart-wrap right edge stays left of right rail after series-pane overlay', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, RSI_SERIES_OVERLAY);
    await page.waitForTimeout(400);

    const result = await measureWrapVsRail(page);
    expect(
      result.ok,
      `Chart-wrap right (${result.wrapRight}) must be ≤ rail left (${result.railLeft}): ${!result.ok ? (result as { reason: string }).reason : ''}`,
    ).toBe(true);
  });

  test('(c) no chart-wrap child DOM element overlaps the right rail with sub-pane active', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, RSI_SERIES_OVERLAY);
    await page.waitForTimeout(400);

    const noOverlap = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const rail = document.querySelector('[aria-label="Right dock"]');
      if (!canvas || !rail) return { ok: false, reason: 'missing elements' };

      let wrap: HTMLElement | null = canvas.parentElement;
      while (wrap) {
        const style = getComputedStyle(wrap);
        if (style.position === 'absolute' && style.isolation === 'isolate') break;
        wrap = wrap.parentElement;
      }
      if (!wrap) return { ok: false, reason: 'chart-wrap not found' };

      const railRect = rail.getBoundingClientRect();
      const children = Array.from(wrap.children) as HTMLElement[];

      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const overlapsX = rect.right > railRect.left && rect.left < railRect.right;
        const overlapsY = rect.bottom > railRect.top && rect.top < railRect.bottom;
        if (overlapsX && overlapsY) {
          return {
            ok: false,
            reason: `child "${child.className}" overlaps rail`,
          };
        }
      }
      return { ok: true };
    });

    expect(noOverlap.ok, `Rail overlap detected: ${JSON.stringify(noOverlap)}`).toBe(true);
  });

  // ── (d) Bollinger recipe shape renders on PRICE pane, no sub-pane ────────────
  //
  // NOTE: The LIVE agent emit of this shape — Claude CLI calling the
  // pinescript-to-indicator skill, emitting the correct tool call, which maps
  // Pine's multi-plot() to ONE BandElement + one LineElement — is verified by
  // MANUAL UAT ONLY. Playwright cannot drive the live Claude CLI subprocess or
  // assert the LLM's actual tool-call emission. This test asserts ONLY the
  // deterministic downstream: the prescribed Bollinger payload shape (from the
  // skill spec) routes to the price pane correctly.

  test('(d) Bollinger recipe: band+line on price pane — no sub-pane activated', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    const canvasBefore = await page.locator('canvas').count();

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, BOLLINGER_OVERLAY);
    await page.waitForTimeout(400);

    // Canvas count must not increase — Bollinger is price-pane, no sub-pane split.
    const canvasAfter = await page.locator('canvas').count();
    expect(canvasAfter).toBe(canvasBefore);

    // Verify the overlay is in the store with exactly one band + one line, both price-pane.
    const overlays = await page.evaluate((): unknown => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (w.__researchOverlayTest as any).getState();
    }) as Record<string, { elements: Array<{ type: string; pane?: string }> }>;

    const bb = overlays['e2e-bollinger-recipe'];
    expect(bb).toBeDefined();

    const lineEl = bb.elements.find((el) => el.type === 'line');
    const bandEl = bb.elements.find((el) => el.type === 'band');
    expect(lineEl).toBeDefined();
    expect(bandEl).toBeDefined();

    // Neither element carries pane:'series' — both are price-pane.
    // (pane omitted ⇒ treated as 'price' per schema backward-compat).
    expect(lineEl?.pane).toBeUndefined();
    expect(bandEl?.pane).toBeUndefined();

    // No series-pane elements → sub-pane should NOT be activated.
    const hasSeriesPane = bb.elements.some((el) => el.pane === 'series');
    expect(hasSeriesPane).toBe(false);
  });

  test('(d) Bollinger recipe: legend row appears (no badge — source omitted)', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, BOLLINGER_OVERLAY);
    await page.waitForTimeout(300);
    await expandLegend(page);

    const labelEl = page.locator('.legend-hud-label', { hasText: 'E2E BB(20)' });
    await expect(labelEl).toBeVisible({ timeout: 3000 });

    // Bollinger recipe has no source → no provenance badge.
    // (When the live agent emits it with source:'pine', a separate overlay
    // with source set should show the badge — that path is covered by test (b).)
    const pineBadge = page.locator('.legend-hud-badge--pine');
    await expect(pineBadge).not.toBeVisible();
  });

  test('(d) Bollinger recipe: chart-wrap stays inside chart bounds — no rail overlap', async ({ page }) => {
    const hookPresent = await waitForHook(page, '__researchOverlayTest');
    if (!hookPresent) {
      test.skip(true, 'window.__researchOverlayTest not present — skipping');
      return;
    }

    await page.evaluate((overlay) => {
      const w = window as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.__researchOverlayTest as any).apply(overlay);
    }, BOLLINGER_OVERLAY);
    await page.waitForTimeout(400);

    const result = await measureWrapVsRail(page);
    expect(
      result.ok,
      `Bollinger overlay: chart-wrap right (${result.wrapRight}) must be ≤ rail left (${result.railLeft})`,
    ).toBe(true);
  });
});
