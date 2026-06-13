> **REMOVED 2026-05-23** — chat UI removed; this smoke doc is retained for history only.

# P7 — Manual Smoke Checklist

> Source: `docs/plan/P7-strategy-agent.md` (P7-1…P7-28) and the W5-D master plan
> at `~/.claude/plans/act-a-senior-software-declarative-reef.md`.
>
> This file is the manual smoke-test plan invoked at the end of Wave 5 (W5-D).
> It covers: P7 happy-path, plan-mode subagent path, plan-mode Apply gate,
> perf profile baseline, visual state cards, edit-flow round-trip, and
> profile isolation re-verify.

Format key:

- `[ ] PASS / [ ] FAIL` — tick whichever applies.
- `KNOWN-DEFER` — listed at the bottom; the smoke runner does **not** fail the gate on these.
- `[TODO P8 toast]` — markers left in place per CLAUDE.md convention; P8 will wire them.

---

## Pre-conditions

- [ ] PASS / [ ] FAIL — `npm run tauri:dev` boots cleanly (first Rust compile is slow;
  subsequent runs are incremental).
- [ ] PASS / [ ] FAIL — `claude` CLI installed and on PATH with a valid auth session
  (or `ANTHROPIC_API_KEY` set in `claude-home/settings.json`).
- [ ] PASS / [ ] FAIL — `npm test` passes (414 tests as of W5-D).
- [ ] PASS / [ ] FAIL — `cd src-tauri && ~/.cargo/bin/cargo test` passes (136 tests as of W5-D).
- [ ] PASS / [ ] FAIL — `npm run typecheck && npm run lint` clean.

---

## Section 1 — P7 Happy Path

Full flow: describe a thesis → strategy card with real perf → apply → signals on chart.

1. **Open strategy panel.**
   Open the app → click the Aurora FAB (bottom right) → panel opens in Research mode →
   click "Strategy" tab in the mode toggle → confirm Strategy mode active (violet accent).
   - [ ] PASS / [ ] FAIL

2. **Describe a thesis.**
   In the Composer, type:
   ```
   RSI(14) mean-revert strategy on BTC daily bars. Buy when RSI < 30, sell when RSI > 70.
   ```
   Hit Enter. A thinking trace should appear (pending → live).
   - [ ] PASS / [ ] FAIL

3. **Tool round-trip.**
   Watch the trace panel. Expect these tool steps to appear:
   - `validate_strategy` step → `done` ✓
   - `backtest_strategy` step → `done` ✓  (runs the local backtest engine)
   - `return_strategy` step → `done` ✓
   - [ ] PASS / [ ] FAIL

4. **Strategy card renders with real perf.**
   A `StrategyCard` appears in the thread with:
   - Strategy name and thesis.
   - Animated `RuleGraph` showing entry (RSI < 30) and exit (RSI > 70) nodes.
   - Perf stats: Win Rate, Sharpe, Max DD, N (trade count).
   - If N ≥ 10 → no badge. If N < 10 → "Indicative" badge (subdued tone).
   - Footnote: "Fees and slippage ignored in v1."
   - `apply` chip-toggle (NOT the plan-mode Apply CTA).
   - [ ] PASS / [ ] FAIL

5. **Apply toggle → signals on chart.**
   Click the `apply` chip-toggle on the strategy card → toggle turns active →
   Buy (upward green triangle below price) and Sell (downward red triangle above price)
   triangles appear on the chart. A dashed connector joins each pair, green if
   profitable, red if losing.
   - [ ] PASS / [ ] FAIL

6. **Signal count in AIChipStack.**
   The top-center `AIChipStack` shows a strategy chip with a signal count
   (e.g. "RSI(14) · 7 signals").
   - [ ] PASS / [ ] FAIL

7. **Chart-type morph preserves signals.**
   While signals are visible, click the chart-type toolbar to switch from
   Candlestick → Line (or any other type) → Candlestick. Signals must remain
   on the chart after the morph — they are a separate canvas pass.
   - [ ] PASS / [ ] FAIL

---

## Section 2 — Plan-Mode Subagent Path

> **Requires a real `claude` CLI** with subagent capability. Gate: `claude --version`
> must show a version that supports `--permission-mode plan`.

1. **Send a thesis in plan mode using the `/plan` prefix.**
   In the Composer (Strategy mode), type:
   ```
   /plan decompose a multi-leg mean-revert strategy that combines RSI oversold with a 200-period SMA trend filter
   ```
   Hit Enter. The panel should enter plan-mode (permission-mode chip shows "plan").
   - [ ] PASS / [ ] FAIL — *or* SKIP if `claude` does not support plan-mode.

2. **Nested sub-trace renders.**
   Watch the ThinkingTrace. A top-level `subagent_dispatch` step should appear
   with a tinted left rail. Sub-steps render inside it via the W1-C trace
   state machine (pending → live → done).
   - [ ] PASS / [ ] FAIL — *or* SKIP (same gate as above).

3. **Sub-trace inherits permission-mode display.**
   The sub-steps should show the parent's permission-mode ("plan") in their
   display badge. No competing window listeners — routes through `src/stores/keyboard.ts`.
   - [ ] PASS / [ ] FAIL — *or* SKIP.

---

## Section 3 — Plan-Mode "Apply" Gate

> The "Apply" button on a plan-outline card is visually distinct from the
> apply chip-toggle on a normal StrategyCard. They must NOT collide (P7-24).

1. **Generate a plan outline.**
   In Strategy mode, type:
   ```
   /plan RSI mean-revert with volume confirmation
   ```
   Hit Enter. Expect a read-only outline-card with step bullets and a prominent
   **Apply** CTA button (full-width, primary style). This is NOT the chip-toggle.
   - [ ] PASS / [ ] FAIL — *or* SKIP if plan-mode unavailable.

2. **Click Apply → follow-up validated strategy card.**
   Click the primary **Apply** CTA on the outline card. The system re-runs the
   prompt in `acceptEdits` mode (no plan prefix). A validated `StrategyCard`
   with its own `apply` chip-toggle (and real perf stats) should appear in the
   thread.
   - [ ] PASS / [ ] FAIL — *or* SKIP.

3. **Both CTAs visually distinct.**
   Confirm side-by-side in the thread: the outline-card's Apply is a solid
   primary button; the StrategyCard's apply is a small chip-toggle. They occupy
   different visual roles and never overlap.
   - [ ] PASS / [ ] FAIL.

---

## Section 4 — Perf Profile Baseline

> The 5000-bar benchmark is exercised by the W5-A vitest (`src/engine/backtest.test.ts`).
> This section records the actual measured baseline so regressions are detectable.

### Reproduction script

Paste into Node.js (after building the TS, or run via `npx tsx`):

```typescript
// Paste into a scratch test file and run: npx vitest run --reporter=verbose -t "perf"
// Or use the existing golden test in src/engine/backtest.test.ts.
import { backtest } from './src/engine/backtest';

const closes: number[] = [];
let p = 100;
for (let i = 0; i < 5000; i++) {
  p += Math.sin(i * 0.05) * 0.5 + (i % 7 === 0 ? 1 : -0.1);
  closes.push(p);
}
const bars = closes.map((c, i) => ({ ts: i * 86400000, o: c, h: c, l: c, c, v: 1 }));
const strategy = {
  id: 'bench', name: 'bench', thesis: '', version: 1 as const, createdAt: 0,
  rules: {
    entry: [
      { indicator: 'rsi' as const, op: '<' as const, value: 35, params: { period: 14 } },
      { indicator: 'close' as const, op: '>' as const, value: { ref: 'sma' as const, params: { period: 50 } } },
    ],
    exit: [
      { indicator: 'rsi' as const, op: '>' as const, value: 65, params: { period: 14 } },
      { indicator: 'close' as const, op: '<' as const, value: { ref: 'ema' as const, params: { period: 20 } } },
    ],
  },
};
backtest(bars, strategy, { tf: '1d' }); // warmup
const t0 = performance.now();
for (let i = 0; i < 3; i++) backtest(bars, strategy, { tf: '1d' });
console.log('avg ms:', (performance.now() - t0) / 3);
```

### Recorded baseline (W5-D)

| Machine | Date | Avg / run | Threshold | Result |
|---------|------|-----------|-----------|--------|
| Apple Silicon M-series (dev machine) | 2026-05-10 | **~1–2 ms** | < 250 ms | PASS |

> **How this was measured:** `npx vitest run src/engine/backtest.test.ts -t "runs <250ms"`
> reports `5ms` for the entire test (1 warmup + 3 measured runs). Average per
> measured run ≈ **1–2 ms** — three orders of magnitude under the 250 ms gate.
>
> The vitest timing of "5ms" for the test case reflects Vitest's own overhead
> (timer resolution, promise scheduling). The `performance.now()` delta measured
> inside the test confirms individual runs are under 5ms total across all 3 runs.
>
> **Assertion threshold:** `expect(avg).toBeLessThan(250)` in
> `src/engine/backtest.test.ts:379`. This hard-gates CI.

### Re-run after release build (optional)

If the dev-build benchmark is suspiciously slow, re-measure with:

```bash
cd src-tauri && ~/.cargo/bin/cargo build --release
# Then re-run the vitest benchmark — note Vite/Vitest stays in dev mode;
# only Rust gets the release optimization. The backtest engine is pure TS
# so Vite's ESM transform path applies, not Rust.
npm run typecheck && npx vitest run src/engine/backtest.test.ts -t "perf"
```

---

## Section 5 — N<10 Indicative Badge + N=null Empty State

These states are exercised via DEV capture helpers (`window.__aiCapture`).
Use `npm run dev` (no Tauri needed).

**Browser console commands (open DevTools → Console):**

```javascript
// N < 10 — Indicative badge:
__aiCapture.reset();
__aiCapture.hideFirstRun();
__aiCapture.setPanelOpen(true);
__aiCapture.setMode('strategy');
__aiCapture.seedStrategyCard({ id: 'smoke-ind', perfState: 'indicative' });
// → StrategyCard appears with N=7, Indicative badge, subdued tone.

// N = null — empty state:
__aiCapture.reset();
__aiCapture.hideFirstRun();
__aiCapture.setPanelOpen(true);
__aiCapture.setMode('strategy');
__aiCapture.seedStrategyCard({ id: 'smoke-empty', perfState: 'empty' });
// → StrategyCard appears with "No trades found in window" message.

// Loading state (perf = undefined, shimmer):
__aiCapture.reset();
__aiCapture.hideFirstRun();
__aiCapture.setPanelOpen(true);
__aiCapture.setMode('strategy');
__aiCapture.seedStrategyCard({ id: 'smoke-load', perfState: 'loading' });
// → StrategyCard appears with a shimmer placeholder in the perf row.
```

- [ ] PASS / [ ] FAIL — Indicative badge renders with subdued color + "Indicative" text.
- [ ] PASS / [ ] FAIL — Empty state renders "No trades found in window".
- [ ] PASS / [ ] FAIL — Loading shimmer renders (perf row shows pulse animation).

---

## Section 6 — Edit-Flow Round-Trip

> Confirms that editing a strategy preserves `id` + `createdAt` and emits the
> diff toast marker. This is fully covered by vitest (W5-C3 + W5-D tests), but
> the manual path here lets you verify the UI surface.

**Automated test (paste into console with a running Tauri app):**

```javascript
// 1. Seed a strategy to the library.
__aiCapture.reset();
__aiCapture.hideFirstRun();
__aiCapture.setPanelOpen(true);
__aiCapture.setMode('strategy');
__aiCapture.seedStrategyCard({ id: 'edit-round-trip', name: 'RSI Original', perfState: 'valid' });

// 2. Check the store state before edit.
const before = __aiStore.getState();
// (useStrategyStore is accessed via window.__stores if available)

// 3. In the UI: find the strategy in Library → Strategies, click "Edit",
//    change the exit RSI threshold from 70 → 65, and observe:
//    a) The card updates with the new rule.
//    b) The strategy id stays the same.
//    c) The createdAt timestamp stays the same.
//    d) A [TODO P8 toast] console.warn appears with the diff summary.
```

**Vitest coverage:** `src/engine/p7.integration.test.ts` covers this case with
seeded preset round-trips. Run:

```bash
npx vitest run src/engine/p7.integration.test.ts --reporter=verbose
```

Expected output: 8/8 tests pass, including:
- "updateStrategy with same id as a seeded preset preserves id + createdAt"
- "updateStrategy fires [TODO P8 toast] diff warning when exit condition changes"

- [ ] PASS / [ ] FAIL — `id` and `createdAt` preserved after edit.
- [ ] PASS / [ ] FAIL — `[TODO P8 toast]` diff warning visible in console.
- [ ] PASS / [ ] FAIL — Vitest P7 integration tests: 8/8 pass.

---

## Section 7 — Profile Isolation Re-Verify

> Cross-wave gate: `~/.claude` must be byte-identical before and after a full
> P6 + P7 session (datasets plotted, strategies backtested, MCP added, slash
> invoked, subagent dispatched).

```bash
# Pre-session baseline:
shasum -a 256 -r ~/.claude 2>/dev/null | sort > /tmp/claude-pre.txt
echo "Pre-session shasum saved to /tmp/claude-pre.txt"

# Run a full session:
# 1. npm run tauri:dev
# 2. Research: run "30d realized vol" preset → plot dataset chip.
# 3. Strategy: describe RSI thesis → wait for strategy card → apply.
# 4. Settings → MCP: add a test server (name: test-p7, command: echo).
# 5. Composer: type /research → run the slash command.
# 6. Strategy: send "/plan decompose a trend strategy" → wait for subagent.
# 7. Close the app.

# Post-session check:
shasum -a 256 -r ~/.claude 2>/dev/null | sort > /tmp/claude-post.txt
diff /tmp/claude-pre.txt /tmp/claude-post.txt
```

Expected: **zero diff**. If any lines differ, the app is writing to the user's
main profile — investigate `src-tauri/src/commands/ai.rs` argv builder and
`CLAUDE_CONFIG_DIR` propagation.

> One allowed exception: `~/.claude.json` may be touched by the CLI if the
> OAuth flow re-issues a token. This is the CLI's own book-keeping and is
> acceptable; we do NOT write to it ourselves. Verify by isolating:
> `diff /tmp/claude-pre.txt /tmp/claude-post.txt | grep '\.claude\.json'`.

- [ ] PASS / [ ] FAIL — Zero diff in `shasum` output.
- [ ] PASS / [ ] FAIL (conditional) — If `.claude.json` changed, it was ONLY
  touched by the CLI OAuth flow (acceptable); all other files under `~/.claude*`
  are byte-identical.

---

## KNOWN-DEFER

These items are acknowledged gaps that do NOT fail the P7 smoke gate.
They are tracked for P8 polish.

| Item | Reason deferred |
|------|-----------------|
| Visual toast notifications for strategy errors | Marked `[TODO P8 toast]` throughout. P8 will wire these to the Sonner toast system. |
| `rule-graph-mid-anim` capture uses static graph | CSS edge-fade animation requires a `currentTime` API call during capture. Deferred to P8 polish pass. |
| Strategy chip in AIChipStack wiring | `activeStrategyId` in `useAIStore` may not yet drive an explicit chip if W5-C12 didn't finalize the store integration. Chip renders as a store placeholder. |
| `/plan` prefix plan-mode for strategy (Section 2) | Requires `claude` CLI with subagent support and valid auth. CI skips these. |
| Session-dir pruning for old AI sessions | Deferred to P8 (noted in HAND-OFF.md). |
| Model auto-discovery via `claude --print --model help` | Deferred to P8; model list is hardcoded. |
