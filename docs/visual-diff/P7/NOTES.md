> **REMOVED 2026-05-23** — chat UI removed; these visual diffs are retained for history only.

# P7 Visual Diff — NOTES.md

This directory contains visual-diff captures for the P7 Co-Strategy surfaces.

## Status

PNGs are generated lazily — they require a running Vite dev server. The capture
script (`scripts/capture-visual-diff-p7.mjs`) generates all 10 captures
automatically. W4-C set this precedent; see `docs/visual-diff/P6/NOTES.md`.

## How to generate

```bash
# Terminal 1 — start the Vite dev server:
npm run dev

# Terminal 2 — run the capture script:
node scripts/capture-visual-diff-p7.mjs

# Outputs appear in docs/visual-diff/P7/
```

The script auto-starts the Vite dev server if port 1420 is not already open.
No real `claude` CLI or Tauri runtime is required — all captures are driven via
`window.__aiCapture` DEV seeders installed in `src/ai/__capture_helpers.ts`.

## Expected captures (10 rebuild + 1 prototype)

| File | Surface | W5-D Seeder | Notes |
|------|---------|-------------|-------|
| `strategy-card-valid.rebuild.png` | StrategyCard with real perf (N ≥ 10) | `seedStrategyCard({ perfState: 'valid' })` | WR 62%, Sharpe 1.42, DD -12%, N=24 |
| `strategy-card-indicative.rebuild.png` | StrategyCard with Indicative badge (N < 10) | `seedStrategyCard({ perfState: 'indicative' })` | N=7, subdued tone |
| `strategy-card-empty.rebuild.png` | StrategyCard "No trades found in window" | `seedStrategyCard({ perfState: 'empty' })` | perf=null |
| `rule-graph-4nodes.rebuild.png` | RuleGraph Trigger → Filter → Entry → Exit | Store seed with `filters[]` | All 4 node types |
| `rule-graph-mid-anim.rebuild.png` | RuleGraph mid-fade-in animation frame | Same + brief animation re-enable | Partial opacity on edges |
| `signals-profitable.rebuild.png` | Chart canvas — green triangles + green dashed connector | `seedActiveStrategyTrades(true)` | signals.ts canvas pass |
| `signals-losing.rebuild.png` | Chart canvas — red triangles + red dashed connector | `seedActiveStrategyTrades(false)` | signals.ts canvas pass |
| `chip-stack-both.rebuild.png` | AIChipStack — dataset chip + strategy chip | `seedDatasetOverlay` + `seedStrategyCard` | Both P6+P7 chip types |
| `plan-outline-card.rebuild.png` | Plan-mode outline card with primary Apply CTA | `seedStrategyPlanOutline()` | Distinct from apply-toggle |
| `library-strategies.rebuild.png` | Library → Strategies with 2 presets | `seedLibraryStrategies()` | RSI(14) + Donchian 20/10 |
| `strategy-panel.prototype.png` | Prototype's strategy panel | n/a — prototype render | Comparison reference |

## Prototype comparison

`strategy-panel.prototype.png` is generated from `app-design/project/autoplot.html`
(served by the capture script's built-in static server on port 1422). All other
captures are rebuild-only because the prototype's inner state is not externally
drivable for AI tool round-trips or library persistence.

## Known deferred items

- **`rule-graph-mid-anim`**: the mid-animation frame requires the RuleGraph's CSS
  edge-fade animation to be keyed in `agents.css` under a `.anim-in` class.
  If not yet implemented (W5-C12 deferred), the capture shows the static graph —
  identical to `rule-graph-4nodes.rebuild.png`. Will be refreshed in P8 polish.
- **`signals-*.rebuild.png`**: signals render onto the Canvas2D element only when
  an active strategy with trades is wired. If `useAppStore.setActiveStrategyTrades`
  is not yet exposed, the chart shows bare price data. The seeder falls back
  gracefully via the `data-test-active-strategy` DOM attribute.
- **`chip-stack-both.rebuild.png`**: the strategy chip in AIChipStack is driven by
  `activeStrategyId` in `useAIStore`. If W5-C12 hasn't wired this store field to
  a visible chip, the stacked capture shows only the dataset chip.
