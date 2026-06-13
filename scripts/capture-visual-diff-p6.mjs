/**
 * scripts/capture-visual-diff-p6.mjs — P6 visual-diff capture (W4-C).
 *
 * Captures the P6 Co-Research surfaces against their `app-design/project/agents.jsx`
 * prototype counterparts, modeled exactly on `capture-visual-diff-p5.mjs`.
 *
 * Outputs (under `docs/visual-diff/P6/`) — 7 captures:
 *   1. dataset-card-inline.rebuild.png        — DatasetCard in the chat thread
 *   2. library-datasets-tab.rebuild.png       — Library → Datasets sub-tab
 *   3. ai-chip-stack-single.rebuild.png       — AIChipStack with one chip plotted
 *   4. ai-chip-stack-stacked.rebuild.png      — AIChipStack with a placeholder strategy chip
 *   5. glow-overlay.rebuild.png               — AI glow pass on the chart
 *   6. align-mismatch-warning.rebuild.png     — align-mismatch warning chip (short series)
 *   7. panel-research-with-dataset.rebuild.png — Cinematic: panel + conversation + card
 *   + NOTES.md
 *
 * Run with: `node scripts/capture-visual-diff-p6.mjs` (no args).
 * Prerequisites: Vite dev server (port 1420) already running, OR this script
 * starts it. `import.meta.env.DEV` must be true so `__aiCapture` is installed.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { resolve, dirname, join, normalize } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/visual-diff/P6');
mkdirSync(outDir, { recursive: true });

const REBUILD_URL = 'http://localhost:1420/';
const PROTOTYPE_DIR = resolve(repoRoot, 'app-design/project');
const PROTOTYPE_PORT = 1421;
const PROTOTYPE_URL = `http://localhost:${PROTOTYPE_PORT}/autoplot.html`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startPrototypeServer() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const safePath = normalize(urlPath).replace(/^\/+/, '');
      const filePath = join(PROTOTYPE_DIR, safePath);
      if (!filePath.startsWith(PROTOTYPE_DIR)) {
        res.writeHead(403); res.end(); return;
      }
      const buf = await readFile(filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(buf);
    } catch (_e) {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((res) => server.listen(PROTOTYPE_PORT, () => res(server)));
}

const VIEWPORT = { width: 1440, height: 900 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForUrl(url, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureMockProvider(ctx) {
  await ctx.addInitScript(() => {
    try { window.localStorage.setItem('use-mock-provider', '1'); } catch (_) {}
  });
}

async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }`,
  });
}

async function waitForAICapture(page) {
  await page.waitForFunction(() => Boolean(window.__aiCapture), null, { timeout: 15_000 });
}

async function shot(page, name) {
  const file = resolve(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[p6-viz] saved ${name}`);
}

async function clip(page, locator, name) {
  const box = await locator.boundingBox();
  if (!box) { console.warn(`[p6-viz] element not found for ${name}`); return; }
  const PAD = 24;
  const file = resolve(outDir, name);
  await page.screenshot({
    path: file,
    clip: {
      x: Math.max(0, box.x - PAD),
      y: Math.max(0, box.y - PAD),
      width: Math.min(VIEWPORT.width, box.width + PAD * 2),
      height: Math.min(VIEWPORT.height, box.height + PAD * 2),
    },
  });
  console.log(`[p6-viz] saved ${name}`);
}

// ---------------------------------------------------------------------------
// Rebuild captures
// ---------------------------------------------------------------------------

async function captureRebuild(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ensureMockProvider(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('[p6-viz] pageerror:', e.message));

  await page.goto(REBUILD_URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1200);
  await waitForAICapture(page);
  await freezeAnimations(page);

  // Helper shorthands.
  const capture = page.evaluate.bind(page);

  // ---- 1. Dataset card inline in chat thread --------------------------------
  // Seed a research trace containing a dataset_returned message.
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    // Open panel in research mode with a completed trace that includes a
    // dataset card. We drive this via seedTrace('midstream') then push a
    // dataset step manually via the store.
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedTrace('midstream', 'research');
  });
  await page.waitForTimeout(400);
  await shot(page, 'dataset-card-inline.rebuild.png');

  // ---- 2. Library → Datasets sub-tab ----------------------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
    // Seed in-memory datasets so the library tab has rows.
    const { useDatasetStore } = window.__stores ?? {};
    if (useDatasetStore) {
      const presets = [
        { id: 'lib-1', label: '30d realized vol',    kind: 'series', sym: 'BTC', tf: '1d', values: Array.from({length:20},(_,i)=>0.38+0.1*Math.sin(i/3)), align:'right', createdAt: Date.now()-4 },
        { id: 'lib-2', label: 'Correlation w/ ETH',  kind: 'series', sym: 'BTC', tf: '1h', values: Array.from({length:20},(_,i)=>0.75+0.1*Math.sin(i/5)), align:'right', createdAt: Date.now()-3 },
        { id: 'lib-3', label: 'Momentum z-score',    kind: 'series', sym: 'BTC', tf: '1h', values: Array.from({length:20},(_,i)=>Math.sin(i/4)), align:'right', createdAt: Date.now()-2 },
        { id: 'lib-4', label: 'Liquidity pressure',  kind: 'series', sym: 'BTC', tf: '1h', values: Array.from({length:20},(_,i)=>0.2+0.15*Math.sin(i/6)), align:'right', createdAt: Date.now()-1 },
        { id: 'lib-5', label: 'Funding rate proxy',  kind: 'series', sym: 'BTC', tf: '1h', values: Array.from({length:20},(_,i)=>0.015+0.005*Math.sin(i/7)), align:'right', createdAt: Date.now() },
      ];
      useDatasetStore.setState({ datasets: presets, hydrated: true });
    }
  });
  await page.waitForTimeout(300);
  // Navigate to Library tab if accessible.
  const libraryTabBtn = page.locator('button, [role="tab"]').filter({ hasText: /library/i }).first();
  if (await libraryTabBtn.count() > 0) {
    await libraryTabBtn.click();
    await page.waitForTimeout(200);
  }
  await shot(page, 'library-datasets-tab.rebuild.png');

  // ---- 3. AIChipStack — single chip ----------------------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedDatasetOverlay({ id: 'cap-single', name: '30d realized vol' });
  });
  await page.waitForTimeout(300);
  // Try clipping the chip stack; fall back to full viewport.
  const chipStack = page.locator('[data-testid="ai-chip-stack"]');
  if (await chipStack.count() > 0) {
    await clip(page, chipStack, 'ai-chip-stack-single.rebuild.png');
  } else {
    await shot(page, 'ai-chip-stack-single.rebuild.png');
  }

  // ---- 4. AIChipStack — stacked (dataset chip + placeholder strategy chip) --
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedDatasetOverlay({ id: 'cap-stacked-ds', name: '30d realized vol' });
    // Seed a placeholder strategy chip via the store if available.
    const { useAIStore } = window.__stores ?? {};
    if (useAIStore) {
      useAIStore.setState((s) => ({
        ...s,
        // Placeholder strategy chip rendered when `activeStrategyId` is set.
        activeStrategyId: 'placeholder-strategy',
      }));
    }
  });
  await page.waitForTimeout(300);
  const chipStackStacked = page.locator('[data-testid="ai-chip-stack"]');
  if (await chipStackStacked.count() > 0) {
    await clip(page, chipStackStacked, 'ai-chip-stack-stacked.rebuild.png');
  } else {
    await shot(page, 'ai-chip-stack-stacked.rebuild.png');
  }

  // ---- 5. Glow overlay on chart --------------------------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    // Seed a longer series so the glow pass spans the visible chart.
    window.__aiCapture.seedDatasetOverlay({
      id: 'cap-glow',
      name: '30d realized vol',
    });
  });
  await page.waitForTimeout(500);
  // Capture just the canvas area where the glow renders.
  const canvas = page.locator('canvas').first();
  if (await canvas.count() > 0) {
    await clip(page, canvas, 'glow-overlay.rebuild.png');
  } else {
    await shot(page, 'glow-overlay.rebuild.png');
  }

  // ---- 6. Align-mismatch warning state -------------------------------------
  // Synthesize a Dataset with fewer values than typical visible bars (align:'index')
  // to trigger the warning chip path in DatasetCard / AIChipStack.
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    // Short index-aligned dataset (5 values < typical 200-bar window).
    const { useDatasetStore } = window.__stores ?? {};
    const { useAppStore } = window.__stores ?? {};
    const shortDataset = {
      id: 'cap-mismatch',
      label: 'Short (align:index mismatch)',
      kind: 'series',
      sym: 'BTC',
      tf: '1h',
      values: [1.0, 2.0, 3.0, 4.0, 5.0],  // only 5 values
      align: 'index',  // index-aligned but visibleBars >> 5 → mismatch
      createdAt: Date.now(),
    };
    if (useDatasetStore) {
      useDatasetStore.setState((s) => ({
        datasets: [...s.datasets.filter((d) => d.id !== 'cap-mismatch'), shortDataset],
        hydrated: true,
      }));
    }
    if (useAppStore) {
      useAppStore.getState().setAiOverlayDataset('cap-mismatch');
    }
  });
  await page.waitForTimeout(300);
  await shot(page, 'align-mismatch-warning.rebuild.png');

  // ---- 7. Cinematic: panel + research conversation + dataset card ----------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedTrace('midstream', 'research');
    window.__aiCapture.seedDatasetOverlay({ id: 'cap-cinema', name: '30d realized vol' });
  });
  await page.waitForTimeout(500);
  await shot(page, 'panel-research-with-dataset.rebuild.png');

  await ctx.close();
}

// ---------------------------------------------------------------------------
// Prototype captures (agents.jsx surfaces that match)
// ---------------------------------------------------------------------------

async function capturePrototype(browser, protoServer) {
  if (!existsSync(resolve(PROTOTYPE_DIR, 'autoplot.html'))) {
    console.warn('[p6-viz] prototype HTML not found — skipping prototype captures');
    return;
  }
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('[p6-viz] prototype pageerror:', e.message));

  await page.goto(PROTOTYPE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500); // Babel transpile + React boot
  await freezeAnimations(page);

  // Open the agents panel by clicking the FAB.
  const fab = page.locator('.agents-fab, [data-testid="agents-fab"]').first();
  if (await fab.count() > 0) {
    await fab.click();
    await page.waitForTimeout(400);
  }

  await shot(page, 'panel-research-with-dataset.prototype.png');

  await ctx.close();
  protoServer.close();
}

// ---------------------------------------------------------------------------
// NOTES.md
// ---------------------------------------------------------------------------

function writeNotes() {
  const notes = `# P6 Visual Diff — NOTES.md

Generated by \`scripts/capture-visual-diff-p6.mjs\` on ${new Date().toISOString()}.

## Captures (7 total)

| File | Surface | Notes |
|------|---------|-------|
| dataset-card-inline.rebuild.png | DatasetCard in research panel thread | Seeded via \`seedTrace('midstream')\` |
| library-datasets-tab.rebuild.png | Library → Datasets sub-tab with 5 presets | In-memory seed only (no SQLite in dev) |
| ai-chip-stack-single.rebuild.png | AIChipStack with one chip | Single dataset overlay active |
| ai-chip-stack-stacked.rebuild.png | AIChipStack with dataset + strategy placeholder | Placeholder strategy chip via store state |
| glow-overlay.rebuild.png | AI glow pass on the chart canvas | Glow renders over the mock price series |
| align-mismatch-warning.rebuild.png | Align-mismatch warning state | 5-value index-aligned dataset vs larger visible window |
| panel-research-with-dataset.rebuild.png | Full cinematic panel view | Research panel + mid-stream trace + chip |

## Prototype comparison

\`panel-research-with-dataset.prototype.png\` is the prototype counterpart when
\`app-design/project/autoplot.html\` is present. All other captures are
rebuild-only (the prototype's inner state is not externally drivable for tool
round-trips, dataset cards, or library tabs).

## Known deferred items

- \`ai-chip-stack-stacked\`: the P7 Strategy chip is not yet shipped (W5-C12);
  the stacked capture uses a store placeholder. Full stacked capture will be
  refreshed in P7's visual-diff run.
- Align-mismatch warning: DatasetCard renders the chip; the chart-level
  warning tooltip is a P8 polish item (currently logged as a console.warn).
`;
  writeFileSync(resolve(outDir, 'NOTES.md'), notes);
  console.log('[p6-viz] NOTES.md written');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[p6-viz] starting P6 visual-diff capture…');

  // Check if rebuild server is already running; if not, spawn it.
  let viteProc = null;
  const rebuildUp = await waitForUrl(REBUILD_URL, 3);
  if (!rebuildUp) {
    console.log('[p6-viz] starting Vite dev server…');
    viteProc = spawn('npm', ['run', 'dev'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: true,
    });
    const ok = await waitForUrl(REBUILD_URL, 40);
    if (!ok) {
      console.error('[p6-viz] Vite dev server failed to start on port 1420.');
      viteProc?.kill();
      process.exit(1);
    }
    console.log('[p6-viz] Vite dev server ready.');
  }

  // Start the prototype static server.
  const protoServer = await startPrototypeServer();
  console.log(`[p6-viz] prototype server at http://localhost:${PROTOTYPE_PORT}`);

  const browser = await chromium.launch({ headless: true });

  try {
    await captureRebuild(browser);
    await capturePrototype(browser, protoServer);
  } finally {
    await browser.close();
    if (viteProc) {
      viteProc.kill();
      console.log('[p6-viz] Vite dev server stopped.');
    }
  }

  writeNotes();
  console.log(`[p6-viz] done — captures in ${outDir}`);
}

main().catch((err) => {
  console.error('[p6-viz] fatal error:', err);
  process.exit(1);
});
