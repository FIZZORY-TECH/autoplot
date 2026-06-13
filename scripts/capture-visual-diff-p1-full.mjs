/**
 * Captures `docs/visual-diff/P1/full/rebuild.png` and `prototype.png`.
 *
 * Run with: `node scripts/capture-visual-diff-p1-full.mjs`.
 * Requires the dev server to be running (or `playwright`'s webServer kicks it
 * via the playwright.config.ts default port 1420).
 */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/visual-diff/P1/full');
mkdirSync(outDir, { recursive: true });

const REBUILD_URL = 'http://localhost:1420/';
const PROTOTYPE_HTML = resolve(repoRoot, 'app-design/project/autoplot.html');

async function waitForUrl(url, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (_) {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  let viteProc = null;
  const ready = await waitForUrl(REBUILD_URL, 1).catch(() => false);
  if (!ready) {
    console.log('[viz] starting dev server...');
    viteProc = spawn('npm', ['run', 'dev'], {
      cwd: repoRoot,
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const ok = await waitForUrl(REBUILD_URL, 60);
    if (!ok) {
      console.error('[viz] dev server did not come up');
      viteProc?.kill();
      process.exit(1);
    }
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Rebuild screenshot
  await page.goto(REBUILD_URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1000); // let bars load + initial RAF
  await page.screenshot({ path: resolve(outDir, 'rebuild.png'), fullPage: false });
  console.log('[viz] saved rebuild.png');

  // Prototype screenshot
  if (existsSync(PROTOTYPE_HTML)) {
    try {
      await page.goto('file://' + PROTOTYPE_HTML, { waitUntil: 'load', timeout: 15_000 });
      await page.waitForTimeout(2000); // give prototype its initial JS time
      await page.screenshot({ path: resolve(outDir, 'prototype.png'), fullPage: false });
      console.log('[viz] saved prototype.png');
    } catch (e) {
      console.warn('[viz] prototype capture failed:', e.message);
    }
  } else {
    console.warn('[viz] prototype HTML not found at', PROTOTYPE_HTML);
  }

  await browser.close();
  if (viteProc) viteProc.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
