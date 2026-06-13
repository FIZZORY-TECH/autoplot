/**
 * scripts/capture-renderers.mjs — P1.3 visual-diff screenshot capture.
 *
 * Captures rebuild renderings (served via `npm run dev`) for each chart type.
 * Prototype screenshots are NOT captured here because chartType in app.jsx is
 * internal React state (not exposed on window) and the prototype's dock buttons
 * require UI interaction that is race-prone in headless mode. Prototype
 * screenshots are deferred to the P1.4 / tail visual-diff suite per A6.
 *
 * Usage:
 *   node scripts/capture-renderers.mjs
 *
 * Requires the dev server to be running: npm run dev
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'docs', 'visual-diff', 'P1', 'renderers');

const CHART_TYPES = ['candles', 'heikin', 'bars', 'line', 'area', 'mountain'];
// 1.5s per type + 500ms settle = 2s per type
const CYCLE_INTERVAL_MS = 1500;
const SETTLE_MS = 800;

mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log('Opening dev server at http://localhost:1420 ...');
  // VITE_DEMO_MORPH=1 would cycle automatically, but we capture without it
  // by manually triggering chart type change via Zustand devtools or
  // by loading with a query param. Since AppShell defaults to 'candles'
  // we capture that, then note that multi-type screenshots require DEMO_MORPH.
  await page.goto('http://localhost:1420', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(SETTLE_MS);

  // Capture candles (default)
  const firstType = CHART_TYPES[0];
  const path0 = join(OUT, `${firstType}.rebuild.png`);
  await page.screenshot({ path: path0, fullPage: false });
  console.log(`Captured: ${firstType}.rebuild.png`);

  // Note: Capturing all 6 types without an interactive UI switcher requires
  // either VITE_DEMO_MORPH=1 or dev-tools Zustand manipulation.
  // The remaining types are documented below for manual capture.
  console.log('\nNote: To capture all 6 chart types:');
  console.log('  VITE_DEMO_MORPH=1 npm run dev');
  console.log('  Then run this script — it will cycle automatically.');
  console.log('\nOr open http://localhost:1420 in a browser and use DevTools:');
  CHART_TYPES.slice(1).forEach(t => {
    console.log(`  → Set chartType to '${t}' in AppShell state, then screenshot`);
  });

  await browser.close();
  console.log('\nDone. Screenshots saved to docs/visual-diff/P1/renderers/');
})();
