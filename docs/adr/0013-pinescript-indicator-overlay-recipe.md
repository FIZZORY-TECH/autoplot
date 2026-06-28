# ADR-0013: Pine Script → Indicator via Overlay Recipe (Option A)

**Status:** Accepted
**Date:** 2026-06-27

## Context

Users want to paste a TradingView Pine Script (or describe an indicator in plain
language) and see it rendered on the autoplot chart. Two implementation paths
were considered:

**Option A — Overlay recipe (chosen):** Reuse the existing
`compute_indicator` + `apply_research_overlay` MCP tool pair, taught to the
Claude CLI agent via a new skill file
(`src-tauri/resources/profile-assets/skills/pinescript-to-indicator/SKILL.md`).
The agent calls `compute_indicator` for each series, assembles a
`ResearchOverlay` object, and calls `apply_research_overlay`. No new MCP tool,
no sidecar rebuild. The skill also sets `ResearchOverlay.source` to `'pine'` or
`'nl'` to drive a provenance badge in LegendHUD.

**Option B — First-class `apply_indicator` MCP tool (deferred):** A new MCP
tool that accepts an indicator spec and drives a persistent, tick-updating
overlay. This would require: a new tool handler in the sidecar crate, an entry
in `ipc_bridge.rs`, a new bridge roundtrip handler in `bridgeRoundtrip.ts`, a
new Zustand store slice, and a sidecar rebuild (`npm run build:sidecar`).

Option A was chosen for the MVP because it delivers the feature with no new MCP
tool surface and no sidecar rebuild. The key trade-off is that Option A produces
a **static snapshot**: the overlay is computed once at apply-time, value arrays
are capped at 500 points, and the overlay does NOT tick-update as new bars
arrive.

To support oscillators (RSI, ATR) that have an independent 0–100 or unbounded
scale, three overlay element types (`LineElement`, `BandElement`, `HLineElement`)
gained an optional `pane?: 'price' | 'series'` field in `src/ai/schemas.ts`. A
`pane: 'series'` element renders in the chart's oscillator sub-pane on an
independent y-scale. The `ResearchOverlay` type gained an optional
`source?: 'pine' | 'nl'` field. Both additions are backward-compatible: absent
fields default to existing behavior (`pane` defaults to price; `source` absent
means no badge).

## Decision

- The Pine Script → indicator feature MUST be implemented as a CLI skill (Option
  A) using `compute_indicator` + `apply_research_overlay`. No new `apply_indicator`
  MCP tool exists in this release.
- The skill file at
  `src-tauri/resources/profile-assets/skills/pinescript-to-indicator/SKILL.md`
  is the single agent-facing playbook for indicator conversion. It MUST be kept
  in sync with the 15-kind `compute_indicator` enum; adding a new indicator kind
  requires updating the skill's mapping table.
- `Element.pane` absent MUST continue to behave identically to `pane: 'price'`
  — backward compatibility is non-negotiable. All renderers that read `pane`
  MUST treat `undefined` as `'price'`.
- The oscillator sub-pane is a single shared pane. Rendering two concurrent
  `pane: 'series'` overlays is NOT supported and MUST NOT be attempted; the skill
  explicitly tells the agent to ask the user to choose one.
- `ResearchOverlay.source` absent MUST be accepted without error (optional
  field). LegendHUD renders no badge when `source` is absent.

## Consequences

**Forbidden:**
- Implementing `apply_indicator` or any live-tick overlay tool without a new
  superseding ADR.
- Treating absent `Element.pane` as anything other than `'price'`.
- Rendering more than one oscillator sub-pane for a single chart.
- Adding indicator kinds to `compute_indicator` without updating the skill's
  mapping table.

**Required:**
- Agents converting Pine Script MUST follow the skill playbook — in particular
  the static-snapshot and 500-point-cap caveats MUST be disclosed to the user.
- `source: 'pine'` triggers a "Pine" provenance badge; `source: 'nl'` triggers
  an "AI" badge in LegendHUD. New source values require a schema + badge update.

**Observable behavior:**
- An RSI overlay applied with `pane: 'series'` renders below the price chart on
  its own 0–100 y-scale; it does NOT distort the price axis.
- LegendHUD shows a "Pine" badge for Pine-derived overlays and an "AI" badge
  for NL-derived overlays; no badge for overlays with absent `source`.
- The overlay is a static snapshot — it does not extend past the 500-bar window
  or update on new ticks.

**Source:**
- Schema additions: `src/ai/schemas.ts` (`LineElement`, `BandElement`,
  `HLineElement` `pane` field; `ResearchOverlay` `source` field)
- Skill: `src-tauri/resources/profile-assets/skills/pinescript-to-indicator/SKILL.md`
