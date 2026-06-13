/**
 * scripts/capture-visual-diff-p5.mjs — P5 visual-diff capture (Wave 1 + Wave 2).
 *
 * Captures the AgentsPanel + AuroraAvatar shipped in W1-C against their
 * `app-design/project/agents.jsx` prototype counterparts (Wave 1), plus the
 * Wave 2 surfaces shipped across W2-A/B/C/D1/D2/D3/E/G — Settings tabs, slash
 * palette, Library history, FirstRun states, permission-mode popover, bypass
 * confirm dialog, and the plan_outline Apply card.
 *
 * Modeled on `capture-visual-diff-p1-full.mjs` (spawn-vite + Playwright +
 * side-by-side prototype HTML) so the artifact directory layout stays
 * diff-clean across phases.
 *
 * Run with: `node scripts/capture-visual-diff-p5.mjs` (no args).
 *
 * Outputs (under `docs/visual-diff/P5/`):
 *   Wave 1 (paired prototype + rebuild):
 *   - panel-closed.{rebuild,prototype}.png
 *   - panel-research.{rebuild,prototype}.png
 *   - panel-strategy.{rebuild,prototype}.png
 *   Wave 1 (rebuild-only — prototype has no equivalent state):
 *   - trace-pending.rebuild.png
 *   - trace-mid-stream.rebuild.png
 *   - trace-with-subagent.rebuild.png
 *   - aurora-avatar-research.rebuild.png
 *   - aurora-avatar-strategy.rebuild.png
 *   Wave 2 (rebuild-only):
 *   - settings-{general,models,tools,mcp,skills,hooks,privacy}.rebuild.png
 *   - slash-palette.rebuild.png
 *   - library-history.rebuild.png
 *   - firstrun-not-found.rebuild.png
 *   - firstrun-auth.rebuild.png
 *   - firstrun-version.rebuild.png
 *   - permission-popover.rebuild.png
 *   - bypass-confirm.rebuild.png
 *   - plan-outline-card.rebuild.png
 *   - NOTES.md                                — flags prototype states the
 *                                               prototype cannot drive.
 *
 * Trace + avatar prototype counterparts are intentionally skipped because the
 * prototype's ThinkingTrace state isn't externally drivable from a headless
 * page (its steps array is internal React state behind a Babel-transpiled
 * `<App>`). Documented inline + in NOTES.md.
 *
 * The capture flow:
 *   1. Spawn `npm run dev` on port 1420 (Vite, strictPort) if it isn't already.
 *   2. Force the mock provider via `localStorage` so chart bars resolve in
 *      browser-only mode (no Tauri runtime needed).
 *   3. Drive panel/trace state through `window.__aiCapture` — installed at
 *      DEV-time by `src/ai/__capture_helpers.ts`.
 *   4. Capture rebuild PNGs.
 *   5. Open `app-design/project/autoplot.html` from disk; capture the
 *      panel-closed/research/strategy prototype counterparts by clicking the
 *      `.agents-fab` and the in-panel mode toggle.
 *   6. Close browser; kill the spawned Vite if we started it.
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
const outDir = resolve(repoRoot, 'docs/visual-diff/P5');
mkdirSync(outDir, { recursive: true });

const REBUILD_URL = 'http://localhost:1420/';
const PROTOTYPE_DIR = resolve(repoRoot, 'app-design/project');
const PROTOTYPE_HTML = resolve(PROTOTYPE_DIR, 'autoplot.html');
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

/** Spin up a tiny static file server for the prototype dir — fixes the
 *  `file://` CORS problem when Babel-standalone fetches sibling .jsx files. */
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
    } catch (_) {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureMockProvider(ctx) {
  // Inject `localStorage.use-mock-provider = '1'` BEFORE the page loads so the
  // provider registry picks the mock path on first call. Mirrors the pattern
  // used in `capture-visual-diff-p1-full.mjs` callers (Playwright e2e).
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('use-mock-provider', '1');
    } catch (_) {
      /* private mode etc. — best-effort */
    }
  });
}

async function freezeAnimations(page) {
  // Aurora has a perpetual `aurora-spin` animation. For visual diff we want
  // a stable frame, so we disable animations + transitions globally for the
  // capture. (CSS injection — does not bake into the rebuild build.)
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

async function waitForAICapture(page) {
  // The DEV escape hatch is installed via a dynamic import; give it a beat.
  await page.waitForFunction(() => Boolean(window.__aiCapture), null, {
    timeout: 10_000,
  });
}

async function shot(page, name) {
  const file = resolve(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[viz] saved ${name}`);
}

async function clip(page, locator, name) {
  const box = await locator.boundingBox();
  if (!box) {
    console.warn(`[viz] could not locate element for ${name}`);
    return;
  }
  // Pad the box a touch so glow/shadow doesn't get cropped.
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
  console.log(`[viz] saved ${name}`);
}

// ---------------------------------------------------------------------------
// Rebuild captures
// ---------------------------------------------------------------------------

async function captureRebuild(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ensureMockProvider(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('[viz] pageerror:', e.message));

  await page.goto(REBUILD_URL, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1200); // bars + RAF settle
  await waitForAICapture(page);
  await freezeAnimations(page);

  // 1. panel-closed
  await page.evaluate(() => window.__aiCapture.reset());
  await page.waitForTimeout(150);
  await shot(page, 'panel-closed.rebuild.png');

  // 2. panel-research
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
  });
  await page.waitForSelector('.agents-panel');
  await page.waitForTimeout(200);
  await shot(page, 'panel-research.rebuild.png');

  // 3. panel-strategy
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.setMode('strategy');
    window.__aiCapture.setPanelOpen(true);
  });
  await page.waitForTimeout(200);
  await shot(page, 'panel-strategy.rebuild.png');

  // 4. trace-pending
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedTrace('pending', 'research');
  });
  await page.waitForSelector('.ai-trace');
  await page.waitForTimeout(200);
  await shot(page, 'trace-pending.rebuild.png');

  // 5. trace-mid-stream
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedTrace('midstream', 'research');
  });
  await page.waitForTimeout(200);
  await shot(page, 'trace-mid-stream.rebuild.png');

  // 6. trace-with-subagent
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedTrace('subagent', 'strategy');
  });
  await page.waitForTimeout(200);
  await shot(page, 'trace-with-subagent.rebuild.png');

  // 7+8. aurora avatars — close-up of the panel header avatar in each mode.
  // The panel header doesn't render a `large` aurora directly; use the FAB
  // (which contains an `.aurora-shell`) and the Composer placeholder agent
  // icon as the canonical avatar surfaces. We zoom in on the FAB for both
  // research and strategy.
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(false);
  });
  await page.waitForTimeout(150);
  {
    const fab = page.locator('.agents-fab');
    await clip(page, fab, 'aurora-avatar-research.rebuild.png');
  }

  await page.evaluate(() => {
    window.__aiCapture.setMode('strategy');
  });
  await page.waitForTimeout(150);
  {
    const fab = page.locator('.agents-fab');
    await clip(page, fab, 'aurora-avatar-strategy.rebuild.png');
  }

  // -------------------------------------------------------------------------
  // Wave 2 captures — Settings tabs, slash palette, library history, FirstRun
  // states, permission popover, bypass dialog, plan_outline card.
  // No prototype counterparts (the prototype only covers Wave 1 surfaces);
  // see NOTES.md "Wave 2 captures" section.
  // -------------------------------------------------------------------------

  const SETTINGS_TABS = /** @type {const} */ ([
    'general',
    'models',
    'tools',
    'mcp',
    'skills',
    'hooks',
    'privacy',
  ]);

  for (const tab of SETTINGS_TABS) {
    await page.evaluate((t) => {
      window.__aiCapture.reset();
      window.__aiCapture.hideFirstRun();
      window.__aiCapture.openSettingsTab(t);
    }, tab);
    await page.waitForSelector('.settings-panel', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(200);
    await shot(page, `settings-${tab}.rebuild.png`);
  }

  // slash-palette — open AI panel, type `/` into the composer textarea.
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
  });
  await page.waitForSelector('.agents-panel', { timeout: 5_000 });
  await page.waitForTimeout(200);
  {
    const ta = page.locator('.ag-composer-row textarea').first();
    if (await ta.count()) {
      await ta.click();
      await ta.fill('/');
      await page.waitForTimeout(400);
    }
    await shot(page, 'slash-palette.rebuild.png');
  }

  // library-history — Library tab → History sub-tab.
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
    const s = window.__aiStore.getState();
    s.setActiveTab('library');
    s.setLibrarySubTab('history');
  });
  await page.waitForTimeout(300);
  await shot(page, 'library-history.rebuild.png');

  // firstrun-not-found
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedFirstRun({ kind: 'cli-not-found' });
  });
  await page.waitForSelector('.firstrun-overlay', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'firstrun-not-found.rebuild.png');

  // firstrun-auth
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedFirstRun({ kind: 'cli-auth' });
  });
  await page.waitForSelector('.firstrun-overlay', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'firstrun-auth.rebuild.png');

  // firstrun-version-unsupported
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedFirstRun({ kind: 'cli-version-unsupported', version: '0.9.7' });
  });
  await page.waitForSelector('.firstrun-overlay', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'firstrun-version.rebuild.png');

  // firstrun-profile-setup (Wave 0)
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedFirstRun({ kind: 'profile-setup' });
  });
  await page.waitForSelector('.firstrun-overlay', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'firstrun-profile-setup.rebuild.png');

  // firstrun-profile-auth (Wave 0)
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.seedFirstRun({ kind: 'profile-auth' });
  });
  await page.waitForSelector('.firstrun-overlay', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'firstrun-profile-auth.rebuild.png');

  // permission-popover — open panel, click chip.
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.setMode('research');
    window.__aiCapture.setPanelOpen(true);
  });
  await page.waitForSelector('.agents-panel', { timeout: 5_000 });
  await page.waitForTimeout(200);
  {
    const chip = page.locator('.ag-perm-chip').first();
    if (await chip.count()) {
      await chip.click();
      await page.waitForSelector('.perm-popover', { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
    await shot(page, 'permission-popover.rebuild.png');
  }

  // bypass-confirm — popover open + bypass dialog forced.
  await page.evaluate(() => {
    window.__aiCapture.seedBypassDialog(true);
  });
  await page.waitForSelector('.bypass-dialog', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'bypass-confirm.rebuild.png');

  // plan-outline-card — seed a finished plan-mode trace.
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedPlanOutline('research');
  });
  await page.waitForSelector('.plan-outline', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'plan-outline-card.rebuild.png');

  // inspect-payload — open the AgentsPanel + Inspect modal with a small
  // synthetic payload (image + >2 KB text attachment) so the elision pass
  // and expand-toggle button are visible in the screenshot.
  await page.evaluate(() => {
    window.__aiCapture.reset();
    window.__aiCapture.hideFirstRun();
    window.__aiCapture.seedInspectModal('research');
  });
  await page.waitForSelector('.inspect-modal', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, 'inspect-payload.rebuild.png');

  // Reset panel state before closing context so subsequent runs start fresh.
  await page.evaluate(() => window.__aiCapture.reset());

  await ctx.close();
}

// ---------------------------------------------------------------------------
// Prototype captures
// ---------------------------------------------------------------------------

async function capturePrototype(browser) {
  if (!existsSync(PROTOTYPE_HTML)) {
    console.warn('[viz] prototype HTML not found at', PROTOTYPE_HTML);
    return;
  }

  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('[viz][proto] pageerror:', e.message));

  try {
    await page.goto(PROTOTYPE_URL, { waitUntil: 'networkidle', timeout: 45_000 });
    // Babel-standalone needs a moment to transpile + render. The prototype
    // pulls react/babel from unpkg under SRI; under unreliable network it
    // can take >15s on cold cache. We give it 30s and treat absence as a
    // skipped prototype state (already documented in NOTES.md).
    await page.waitForSelector('.agents-fab', { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await freezeAnimations(page);

    // panel-closed.prototype.png
    await shot(page, 'panel-closed.prototype.png');

    // Click the FAB to open the panel — defaults to research mode.
    await page.click('.agents-fab');
    await page.waitForSelector('.agents-panel', { timeout: 5_000 });
    await page.waitForTimeout(400);
    await shot(page, 'panel-research.prototype.png');

    // Switch to strategy by clicking the second mode button.
    const strategyBtn = page.locator('.ag-mode-btn').nth(1);
    if (await strategyBtn.count()) {
      await strategyBtn.click();
      await page.waitForTimeout(400);
      await shot(page, 'panel-strategy.prototype.png');
    } else {
      console.warn('[viz][proto] could not find strategy mode toggle');
    }
  } catch (e) {
    console.warn('[viz][proto] capture failed:', e.message);
  }

  await ctx.close();
}

// ---------------------------------------------------------------------------
// Sibling NOTES.md — documents prototype-state captures we deliberately skip.
// ---------------------------------------------------------------------------

const NOTES = `# P5 Visual Diff — capture notes

## Wave 1 (W1-D) — AI panel chrome

Side-by-side rebuild + prototype screenshots for the W1-C panel UI (FAB,
AgentsPanel chrome, ThinkingTrace, AuroraAvatar).

| Artifact | Rebuild | Prototype |
|---|---|---|
| panel-closed | yes | yes |
| panel-research | yes | yes |
| panel-strategy | yes | yes |
| trace-pending | yes | **skipped** |
| trace-mid-stream | yes | **skipped** |
| trace-with-subagent | yes | **skipped** |
| aurora-avatar-research | yes | **skipped** |
| aurora-avatar-strategy | yes | **skipped** |

## Why some Wave-1 prototype states are skipped

**captured live UI only — prototype has no equivalent state**

- *trace-pending / trace-mid-stream / trace-with-subagent.* The prototype's
  \`ThinkingTrace\` is driven by \`pendingDataset.steps\` / \`pendingStrategy.steps\`
  internal React state inside \`agents.jsx\`. Those arrays are only populated
  during the prototype's mock animation timer (a few seconds in-flight); they
  are not externally drivable from a headless page. The rebuild captures use
  the dev-only \`window.__aiCapture.seedTrace(...)\` escape hatch which does
  not exist on the prototype side.

- *aurora-avatar-research / aurora-avatar-strategy.* The prototype renders
  \`.aurora\` as a header / FAB ornament; capturing a close-up requires
  driving the same \`.agents-fab\` we already screenshot in panel-closed. We
  defer to the rebuild close-ups for size-comparison; visual fidelity of the
  aurora itself can be cross-checked against the panel-closed prototype shot.

## Wave 2 captures

Wave 2 introduces surfaces that have **no prototype counterpart** —
Settings, MCP, Skills, Hooks, slash palette, FirstRun, permission-mode
popover, plan_outline Apply card, Library history. The prototype at
\`app-design/project/agents.jsx\` only models the Wave-1 AI panel chrome;
these captures are rebuild-only by design (per the W2-F brief).

| Artifact | Rebuild | Prototype |
|---|---|---|
| settings-general | yes | n/a |
| settings-models | yes | n/a |
| settings-tools | yes | n/a |
| settings-mcp | yes | n/a |
| settings-skills | yes | n/a |
| settings-hooks | yes | n/a |
| settings-privacy | yes | n/a |
| slash-palette | yes | n/a |
| library-history | yes | n/a |
| firstrun-not-found | yes | n/a |
| firstrun-auth | yes | n/a |
| firstrun-version | yes | n/a |
| firstrun-profile-setup (Wave 0) | yes | n/a |
| firstrun-profile-auth (Wave 0) | yes | n/a |
| permission-popover | yes | n/a |
| bypass-confirm | yes | n/a |
| plan-outline-card | yes | n/a |
| inspect-payload | yes | n/a |

State-driven captures (FirstRun states, plan_outline, bypass dialog) use
DEV-only seeders gated by \`import.meta.env.DEV\`:

- \`window.__aiCapture.openSettingsTab(tab)\` — opens Settings on a
  specific tab body.
- \`window.__aiCapture.seedFirstRun(state)\` — forces FirstRun into a
  specific gate state via \`src/ai/__capture_state.ts:setFirstRunOverride\`.
- \`window.__aiCapture.seedBypassDialog(true)\` — forces the
  PermissionModePopover's bypass-confirm dialog visible.
- \`window.__aiCapture.seedPlanOutline(mode)\` — seeds a finished
  plan-mode trace whose only step is a \`plan_outline\` card.
- \`window.__aiCapture.seedInspectModal(mode)\` — opens the AgentsPanel
  + Inspect-payload modal with a synthetic prompt + attachments (one
  image with base64 \`data\`, one >2 KB text body) so the elision and
  collapse-expand affordances are visible in the captured PNG.

These seeders mirror the existing \`seedTrace()\` pattern from W1-D and
short-circuit to no-ops in production builds (the override module reads
\`import.meta.env.DEV\` and Vite tree-shakes the subscriber wiring).

## How to refresh

\`\`\`bash
node scripts/capture-visual-diff-p5.mjs
\`\`\`

The script auto-spawns Vite on port 1420 (\`strictPort\`), seeds traces +
panel state via \`window.__aiCapture\`, then re-loads the prototype HTML
from \`app-design/project/autoplot.html\` for the side-by-side
counterparts (Wave 1 only).
`;

function writeNotes() {
  writeFileSync(resolve(outDir, 'NOTES.md'), NOTES, 'utf8');
  console.log('[viz] saved NOTES.md');
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

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
    viteProc.stdout?.on('data', () => {});
    viteProc.stderr?.on('data', () => {});
    const ok = await waitForUrl(REBUILD_URL, 60);
    if (!ok) {
      console.error('[viz] dev server did not come up');
      viteProc?.kill();
      process.exit(1);
    }
  }

  const browser = await chromium.launch();
  const protoServer = await startPrototypeServer();
  try {
    await captureRebuild(browser);
    await capturePrototype(browser);
    writeNotes();
  } finally {
    await browser.close();
    protoServer.close();
    if (viteProc) viteProc.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
