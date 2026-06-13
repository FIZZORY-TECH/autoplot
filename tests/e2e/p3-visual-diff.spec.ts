/**
 * tests/e2e/p3-visual-diff.spec.ts — Capture P3.2 visual-diff screenshots.
 *
 * Captures `docs/visual-diff/P3/asset-panel.rebuild.png` for the visual diff
 * suite (per A6). Runs against the Vite dev server at localhost:1420 — no
 * Tauri runtime needed because nothing on this page requires SQLite (the
 * watchlist will be empty in dev; the empty-state is the canonical first-run
 * UX so capturing it satisfies the spec).
 */

import { test } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const VISUAL_DIR = path.resolve(__dirname, '../../docs/visual-diff/P3');

if (!fs.existsSync(VISUAL_DIR)) {
  fs.mkdirSync(VISUAL_DIR, { recursive: true });
}

test('capture asset-panel screenshot', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="asset-panel"]');
  // Allow async bar fetches to settle.
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(VISUAL_DIR, 'asset-panel.rebuild.png'),
    fullPage: false,
  });
});
