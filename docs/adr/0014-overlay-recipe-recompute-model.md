# ADR-0014: Overlay Recipe + Frontend Recompute Model

**Status:** Accepted
**Date:** 2026-06-27

## Context

ADR-0013 (Option A) established indicators as static `ResearchOverlay` snapshots
via `compute_indicator` + `apply_research_overlay`. That left two problems:

1. **Two consent prompts** — the agent had to call `save_research_overlay`
   explicitly after apply, triggering a second MCP consent dialog.
2. **Value-coupled storage** — a saved overlay's `elements[].values` are bound
   to the `(sym, tf)` at compute time; re-loading on a different symbol shows
   stale data.

This ADR adds a lightweight reuse layer on top of Option A (no new MCP tool,
no sidecar rebuild): a `recipe` field on `ResearchOverlay` captures the
machine-readable indicator spec; `apply_research_overlay` auto-saves when
`recipe` is present; and a pure frontend helper reruns the recipe against new
bars on reapply.

## Decision

- `ResearchOverlay` MUST accept `recipe?: RecipeSpec` (`src/ai/schemas.ts`).
  Overlays without `recipe` are fully backward-compatible.
- `RecipeSpec` is `{ source: 'pine'|'nl', series: SeriesSpec[] }`. `SeriesSpec`
  is `{ kind, params?, pane?, color?, width? }` where `kind` is the `Indicator`
  enum plus recipe-only aliases `'bollinger'` and `'donchian'` — NOT added to
  the main enum.
- **One-consent model:** `bridgeRoundtrip.ts`'s `apply_research_overlay` handler
  MUST auto-save to `useResearchOverlayLibraryStore` when `parsed.data.recipe`
  is truthy. The skill calls only `apply_research_overlay`; no explicit
  `save_research_overlay` call is needed. Auto-save MUST upsert by `id`; a
  persistence failure MUST NOT undo the apply — log `[TODO P8 toast]` instead.
- `recomputeRecipe.ts` MUST be a pure function (no React, no store reads, no
  I/O). It mirrors `computeIndicator.ts`'s per-kind dispatch exactly. Oscillator
  guide lines (RSI 70/30 hlines) are NOT in `recipe.series`; they are
  re-emitted deterministically from a per-kind default map.
- The indicator skill MUST always emit `recipe` and MUST NOT call
  `save_research_overlay` explicitly.

## Consequences

**Forbidden:**
- Adding `recipe` to the Rust sidecar or SQLite schema — it is stored opaquely
  in the `blob` column of `research_overlays` (migration `0019`); no new migration.
- Calling `save_research_overlay` from the Pine→indicator skill.
- Making `recomputeRecipe.ts` stateful or effectful.
- Adding `'bollinger'`/`'donchian'` to the main `Indicator` enum.

**Required:**
- A recipe-bearing overlay applied via `apply_research_overlay` MUST appear in
  the Research Library immediately after apply.
- `recomputeRecipe` MUST produce values equivalent to what the skill's
  `compute_indicator` calls would have produced for the same `(kind, params)`.

**Observable behavior:**
- RSI(14) applied via the skill → one consent prompt → renders AND persists.
- "Apply to chart" on a saved RSI(14) for a different symbol →
  `recomputeRecipe` reruns → fresh values, not the old snapshot.

**Source:**
- Schema: `src/ai/schemas.ts` (`RecipeSpec`, `SeriesSpec`, `ResearchOverlay.recipe`)
- Auto-save on apply: `src/ai/bridgeRoundtrip.ts` (the `apply_research_overlay` case)
- Recompute helper: `src/panels/recomputeRecipe.ts`
- Skill: `src-tauri/resources/profile-assets/skills/pinescript-to-indicator/SKILL.md`
