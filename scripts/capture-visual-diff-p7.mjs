/**
 * scripts/capture-visual-diff-p7.mjs — P7 visual-diff capture (W5-D).
 *
 * Captures the P7 Co-Strategy surfaces against their `app-design/project/agents.jsx`
 * prototype counterparts. Modeled exactly on `capture-visual-diff-p6.mjs`.
 *
 * Outputs (under `docs/visual-diff/P7/`) — 10 captures + NOTES.md:
 *   1. strategy-card-valid.rebuild.png         — card with real perf stats (N ≥ 10)
 *   2. strategy-card-indicative.rebuild.png    — card with N < 10 Indicative badge
 *   3. strategy-card-empty.rebuild.png         — card with N=null "No trades found"
 *   4. rule-graph-4nodes.rebuild.png           — Trigger → Filter → Entry → Exit flow
 *   5. rule-graph-mid-anim.rebuild.png         — rule-graph mid-fade animation frame
 *   6. signals-profitable.rebuild.png          — chart with green triangle pair + connector
 *   7. signals-losing.rebuild.png              — chart with red triangle pair + connector
 *   8. chip-stack-both.rebuild.png             — AIChipStack with dataset + strategy chip
 *   9. plan-outline-card.rebuild.png           — plan-mode outline card with Apply CTA
 *  10. library-strategies.rebuild.png          — Library Strategies tab with 2 presets
 *   + NOTES.md
 *
 * Run with: `node scripts/capture-visual-diff-p7.mjs`
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
const outDir = resolve(repoRoot, 'docs/visual-diff/P7');
mkdirSync(outDir, { recursive: true });

const REBUILD_URL = 'http://localhost:1420/';
const PROTOTYPE_DIR = resolve(repoRoot, 'app-design/project');
const PROTOTYPE_PORT = 1422;
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
  console.log(`[p7-viz] saved ${name}`);
}

async function clip(page, locator, name) {
  const box = await locator.boundingBox();
  if (!box) {
    console.warn(`[p7-viz] element not found for ${name} — falling back to full viewport`);
    await shot(page, name);
    return;
  }
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
  console.log(`[p7-viz] saved ${name}`);
}

// ---------------------------------------------------------------------------
// Rebuild captures
// ---------------------------------------------------------------------------

async function captureRebuild(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ensureMockProvider(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('[p7-viz] pageerror:', e.message));

  await page.goto(REBUILD_URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1200);
  await waitForAICapture(page);
  await freezeAnimations(page);

  const capture = page.evaluate.bind(page);

  // ---- 1. Strategy card — valid perf (N ≥ 10) --------------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedStrategyCard({ id: 'cap-valid', name: 'RSI(14) Mean Reversion', perfState: 'valid' });
  });
  await page.waitForTimeout(400);
  // Try to show the strategy card in the panel.
  const panelEl = page.locator('[data-testid="agents-panel"], .ag-panel').first();
  if (!await panelEl.isVisible().catch(() => false)) {
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(300);
  }
  const stratCard = page.locator('.strat-card, [data-testid="strategy-card"]').first();
  if (await stratCard.count() > 0) {
    await clip(page, stratCard, 'strategy-card-valid.rebuild.png');
  } else {
    await shot(page, 'strategy-card-valid.rebuild.png');
  }

  // ---- 2. Strategy card — Indicative badge (N < 10) -------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedStrategyCard({ id: 'cap-ind', name: 'RSI(14) — small window', perfState: 'indicative' });
  });
  await page.waitForTimeout(400);
  const stratCardInd = page.locator('.strat-card, [data-testid="strategy-card"]').first();
  if (await stratCardInd.count() > 0) {
    await clip(page, stratCardInd, 'strategy-card-indicative.rebuild.png');
  } else {
    await shot(page, 'strategy-card-indicative.rebuild.png');
  }

  // ---- 3. Strategy card — empty state (N = null) -----------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedStrategyCard({ id: 'cap-empty', name: 'EMA Crossover (no trades)', perfState: 'empty' });
  });
  await page.waitForTimeout(400);
  const stratCardEmpty = page.locator('.strat-card, [data-testid="strategy-card"]').first();
  if (await stratCardEmpty.count() > 0) {
    await clip(page, stratCardEmpty, 'strategy-card-empty.rebuild.png');
  } else {
    await shot(page, 'strategy-card-empty.rebuild.png');
  }

  // ---- 4. Rule graph — 4 nodes (frozen, no animation) -----------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
    // Seed a strategy with entry + exit + filter conditions so the rule graph
    // has all 4 node types: Trigger → Filter → Entry → Exit.
    const { useStrategyStore } = window.__stores ?? {};
    if (useStrategyStore) {
      useStrategyStore.setState({
        strategies: {
          'cap-4node': {
            id: 'cap-4node',
            name: 'RSI + MA Filter Strategy',
            thesis: 'Multi-condition strategy for 4-node rule graph capture.',
            rules: {
              filters: [
                { indicator: 'close', op: '>', value: { ref: 'sma', params: { period: 200 } } },
              ],
              entry: [
                { indicator: 'rsi', op: '<', value: 30, params: { period: 14 } },
              ],
              exit: [
                { indicator: 'rsi', op: '>', value: 70, params: { period: 14 } },
              ],
            },
            perf: { winRate: 0.65, sharpe: 1.55, maxDrawdown: -0.10, trades: 18 },
            version: 1,
            createdAt: Date.now(),
          },
        },
        hydrated: true,
      });
    }
  });
  await page.waitForTimeout(400);
  const ruleGraph = page.locator('.rule-graph, [data-testid="rule-graph"]').first();
  if (await ruleGraph.count() > 0) {
    await clip(page, ruleGraph, 'rule-graph-4nodes.rebuild.png');
  } else {
    await shot(page, 'rule-graph-4nodes.rebuild.png');
  }

  // ---- 5. Rule graph — mid-animation frame ----------------------------------
  // Approach: seed the strategy card again (animations frozen), then briefly
  // re-enable transitions for one frame to capture a partial fade state.
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedStrategyCard({ id: 'cap-anim', perfState: 'valid' });
  });
  // Temporarily re-enable animations to capture a partial state.
  await page.evaluate(() => {
    const el = document.querySelector('.rule-graph, [data-testid="rule-graph"]');
    if (el) {
      // Force a CSS animation to start.
      el.classList.remove('no-anim');
      el.classList.add('anim-in');
    }
  });
  await page.waitForTimeout(100); // mid-animation window
  const ruleGraphAnim = page.locator('.rule-graph, [data-testid="rule-graph"]').first();
  if (await ruleGraphAnim.count() > 0) {
    await clip(page, ruleGraphAnim, 'rule-graph-mid-anim.rebuild.png');
  } else {
    await shot(page, 'rule-graph-mid-anim.rebuild.png');
  }

  // ---- 6. Signals — profitable (green triangles + green connector) -----------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedStrategyCard({ id: 'cap-sig-profit', perfState: 'valid' });
    window.__aiCapture.seedActiveStrategyTrades(true); // profitable
  });
  await page.waitForTimeout(500);
  const canvas = page.locator('canvas').first();
  if (await canvas.count() > 0) {
    await clip(page, canvas, 'signals-profitable.rebuild.png');
  } else {
    await shot(page, 'signals-profitable.rebuild.png');
  }

  // ---- 7. Signals — losing (red triangles + red connector) ------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedStrategyCard({ id: 'cap-sig-lose', perfState: 'valid' });
    window.__aiCapture.seedActiveStrategyTrades(false); // losing
  });
  await page.waitForTimeout(500);
  const canvasLosing = page.locator('canvas').first();
  if (await canvasLosing.count() > 0) {
    await clip(page, canvasLosing, 'signals-losing.rebuild.png');
  } else {
    await shot(page, 'signals-losing.rebuild.png');
  }

  // ---- 8. AIChipStack — both dataset chip + strategy chip active ------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedDatasetOverlay({ id: 'cap-ds-both', name: '30d realized vol' });
    window.__aiCapture.seedStrategyCard({ id: 'cap-strat-both', perfState: 'valid' });
    // Set active strategy id so the strategy chip renders in the chip stack.
    const { useAIStore } = window.__stores ?? {};
    if (useAIStore) {
      useAIStore.setState((s) => ({ ...s, activeStrategyId: 'cap-strat-both' }));
    }
  });
  await page.waitForTimeout(300);
  const chipStack = page.locator('[data-testid="ai-chip-stack"]').first();
  if (await chipStack.count() > 0) {
    await clip(page, chipStack, 'chip-stack-both.rebuild.png');
  } else {
    await shot(page, 'chip-stack-both.rebuild.png');
  }

  // ---- 9. Plan-mode outline card with Apply CTA ----------------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedStrategyPlanOutline();
  });
  await page.waitForTimeout(400);
  // Look for the plan outline card or the strategy panel with a plan step.
  const planCard = page.locator('[data-testid="plan-outline-card"], .plan-outline-card, .ag-panel').first();
  if (await planCard.count() > 0) {
    await shot(page, 'plan-outline-card.rebuild.png');
  } else {
    await shot(page, 'plan-outline-card.rebuild.png');
  }

  // ---- 10. Library Strategies tab with 2 seeded presets --------------------
  await capture(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
    window.__aiCapture.seedLibraryStrategies();
  });
  await page.waitForTimeout(300);

  // Navigate to Library → Strategies.
  const libTabBtn = page.locator('button, [role="tab"]').filter({ hasText: /library/i }).first();
  if (await libTabBtn.count() > 0) {
    await libTabBtn.click();
    await page.waitForTimeout(200);
    const stratTabBtn = page.locator('button').filter({ hasText: /strateg/i }).first();
    if (await stratTabBtn.count() > 0) {
      await stratTabBtn.click();
      await page.waitForTimeout(200);
    }
  }
  await shot(page, 'library-strategies.rebuild.png');

  await ctx.close();
}

// ---------------------------------------------------------------------------
// Prototype captures
// ---------------------------------------------------------------------------

async function capturePrototype(browser, protoServer) {
  if (!existsSync(resolve(PROTOTYPE_DIR, 'autoplot.html'))) {
    console.warn('[p7-viz] prototype HTML not found — skipping prototype captures');
    protoServer.close();
    return;
  }
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('[p7-viz] prototype pageerror:', e.message));

  await page.goto(PROTOTYPE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500); // Babel transpile + React boot
  await freezeAnimations(page);

  // Open agents panel by clicking FAB.
  const fab = page.locator('.agents-fab, [data-testid="agents-fab"]').first();
  if (await fab.count() > 0) {
    await fab.click();
    await page.waitForTimeout(400);
  }

  // Switch to strategy mode in prototype.
  const stratBtn = page.locator('button').filter({ hasText: /strategy/i }).first();
  if (await stratBtn.count() > 0) {
    await stratBtn.click();
    await page.waitForTimeout(400);
  }

  await page.screenshot({
    path: resolve(outDir, 'strategy-panel.prototype.png'),
    fullPage: false,
  });
  console.log('[p7-viz] saved strategy-panel.prototype.png');

  await ctx.close();
  protoServer.close();
}

// ---------------------------------------------------------------------------
// NOTES.md
// ---------------------------------------------------------------------------

function writeNotes() {
  const notes = `# P7 Visual Diff — NOTES.md

Generated by \`scripts/capture-visual-diff-p7.mjs\` on ${new Date().toISOString()}.

## Regenerating

\`\`\`bash
# 1. Start the Vite dev server (if not already running):
npm run dev

# 2. In a separate terminal, run the capture script:
node scripts/capture-visual-diff-p7.mjs

# 3. Review outputs in docs/visual-diff/P7/
\`\`\`

The script auto-starts the Vite dev server if port 1420 is not already open.
All captures are driven via \`window.__aiCapture\` (W5-D seeders installed in
\`src/ai/__capture_helpers.ts\`). No real \`claude\` CLI is required.

## Captures (10 rebuild + 1 prototype)

| File | Surface | Seeder Used | Notes |
|------|---------|-------------|-------|
| strategy-card-valid.rebuild.png | StrategyCard with real perf (N ≥ 10) | \`seedStrategyCard({ perfState: 'valid' })\` | Win rate 62%, Sharpe 1.42, DD -12%, N=24 |
| strategy-card-indicative.rebuild.png | StrategyCard with Indicative badge (N < 10) | \`seedStrategyCard({ perfState: 'indicative' })\` | N=7, subdued tone, badge visible |
| strategy-card-empty.rebuild.png | StrategyCard with "No trades found" (N=null) | \`seedStrategyCard({ perfState: 'empty' })\` | perf=null empty state |
| rule-graph-4nodes.rebuild.png | RuleGraph with Trigger + Filter + Entry + Exit | Store seed with filters[] | All 4 node types color-coded |
| rule-graph-mid-anim.rebuild.png | RuleGraph mid-fade animation frame | Same + animation briefly re-enabled | Partial opacity on edges |
| signals-profitable.rebuild.png | Chart canvas with green triangle pair + green dashed connector | \`seedActiveStrategyTrades(true)\` | signals.ts canvas pass |
| signals-losing.rebuild.png | Chart canvas with red triangle pair + red dashed connector | \`seedActiveStrategyTrades(false)\` | signals.ts canvas pass |
| chip-stack-both.rebuild.png | AIChipStack with dataset chip + strategy chip | \`seedDatasetOverlay\` + \`seedStrategyCard\` | Both P6+P7 chip types active |
| plan-outline-card.rebuild.png | Plan-mode outline card with primary Apply CTA | \`seedStrategyPlanOutline()\` | Distinct from apply-toggle |
| library-strategies.rebuild.png | Library → Strategies sub-tab with 2 seed presets | \`seedLibraryStrategies()\` | RSI(14) + Donchian 20/10 |
| strategy-panel.prototype.png | Prototype's strategy panel (if agents.jsx present) | n/a — prototype render | Comparison reference |

## Known deferred items

- \`rule-graph-mid-anim\`: animation capture requires a running Playwright context
  that can briefly un-freeze transitions; in pure headless the capture may look
  identical to the frozen state if the animation hasn't started. A real mid-frame
  capture would require \`page.evaluate(() => el.getAnimations()[0].currentTime = 200)\`
  which requires the CSS animation to be keyed in \`agents.css\`. If the graph
  has no animations yet (W5-C12 edge-fade deferred), this capture shows the
  static graph — acceptable until the fade is implemented.
- \`signals-*.rebuild.png\`: signals render onto the Canvas2D element. The capture
  clips the canvas element. If no active strategy is set in the app store, the
  signals layer renders nothing — the capture will show the bare chart.
- \`chip-stack-both\`: the \`activeStrategyId\` store field may not drive an explicit
  chip in the AIChipStack if the W5-C12 chip is not yet wired to that key.
  The capture will show a dataset chip only; the strategy chip is deferred
  pending store integration.
`;
  writeFileSync(resolve(outDir, 'NOTES.md'), notes);
  console.log('[p7-viz] NOTES.md written');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[p7-viz] starting P7 visual-diff capture…');

  // Check if rebuild server is already running; if not, spawn it.
  let viteProc = null;
  const rebuildUp = await waitForUrl(REBUILD_URL, 3);
  if (!rebuildUp) {
    console.log('[p7-viz] starting Vite dev server…');
    viteProc = spawn('npm', ['run', 'dev'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: true,
    });
    const ok = await waitForUrl(REBUILD_URL, 40);
    if (!ok) {
      console.error('[p7-viz] Vite dev server failed to start on port 1420.');
      viteProc?.kill();
      process.exit(1);
    }
    console.log('[p7-viz] Vite dev server ready.');
  }

  const protoServer = await startPrototypeServer();
  console.log(`[p7-viz] prototype server at http://localhost:${PROTOTYPE_PORT}`);

  const browser = await chromium.launch({ headless: true });

  try {
    await captureRebuild(browser);
    await capturePrototype(browser, protoServer);
  } finally {
    await browser.close();
    if (viteProc) {
      viteProc.kill();
      console.log('[p7-viz] Vite dev server stopped.');
    }
  }

  writeNotes();
  console.log(`[p7-viz] done — captures in ${outDir}`);
}

main().catch((err) => {
  console.error('[p7-viz] fatal error:', err);
  process.exit(1);
});
