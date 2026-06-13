> **REMOVED 2026-05-23** — chat UI removed; these visual diffs are retained for history only.

# P5 Visual Diff — capture notes

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
  `ThinkingTrace` is driven by `pendingDataset.steps` / `pendingStrategy.steps`
  internal React state inside `agents.jsx`. Those arrays are only populated
  during the prototype's mock animation timer (a few seconds in-flight); they
  are not externally drivable from a headless page. The rebuild captures use
  the dev-only `window.__aiCapture.seedTrace(...)` escape hatch which does
  not exist on the prototype side.

- *aurora-avatar-research / aurora-avatar-strategy.* The prototype renders
  `.aurora` as a header / FAB ornament; capturing a close-up requires
  driving the same `.agents-fab` we already screenshot in panel-closed. We
  defer to the rebuild close-ups for size-comparison; visual fidelity of the
  aurora itself can be cross-checked against the panel-closed prototype shot.

## Wave 2 captures

Wave 2 introduces surfaces that have **no prototype counterpart** —
Settings, MCP, Skills, Hooks, slash palette, FirstRun, permission-mode
popover, plan_outline Apply card, Library history. The prototype at
`app-design/project/agents.jsx` only models the Wave-1 AI panel chrome;
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
DEV-only seeders gated by `import.meta.env.DEV`:

- `window.__aiCapture.openSettingsTab(tab)` — opens Settings on a
  specific tab body.
- `window.__aiCapture.seedFirstRun(state)` — forces FirstRun into a
  specific gate state via `src/ai/__capture_state.ts:setFirstRunOverride`.
- `window.__aiCapture.seedBypassDialog(true)` — forces the
  PermissionModePopover's bypass-confirm dialog visible.
- `window.__aiCapture.seedPlanOutline(mode)` — seeds a finished
  plan-mode trace whose only step is a `plan_outline` card.
- `window.__aiCapture.seedInspectModal(mode)` — opens the AgentsPanel
  + Inspect-payload modal with a synthetic prompt + attachments (one
  image with base64 `data`, one >2 KB text body) so the elision and
  collapse-expand affordances are visible in the captured PNG.

These seeders mirror the existing `seedTrace()` pattern from W1-D and
short-circuit to no-ops in production builds (the override module reads
`import.meta.env.DEV` and Vite tree-shakes the subscriber wiring).

## How to refresh

```bash
node scripts/capture-visual-diff-p5.mjs
```

The script auto-spawns Vite on port 1420 (`strictPort`), seeds traces +
panel state via `window.__aiCapture`, then re-loads the prototype HTML
from `app-design/project/autoplot.html` for the side-by-side
counterparts (Wave 1 only).
