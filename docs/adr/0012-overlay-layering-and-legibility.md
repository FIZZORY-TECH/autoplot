# ADR-0012: Overlay Layering and Legibility (Z-Index Token Scale + Over-Content Surface System)

**Status:** Accepted
**Date:** 2026-06-16

**Amends [ADR-0011](./0011-activity-bar-drawer-dock.md)** — ADR-0011 identified
"z-index soup" as a known issue deferred from the dock refactor; this ADR
resolves it by introducing a named token scale and a legibility contract for
over-content surfaces.

## Context

After the dock refactor, 14+ raw z-index literals remained scattered across CSS
and TSX with no shared scale. The chart wrapper (`src/AppShell.tsx`) was not a
stacking context, so chart-local floats (Crosshair, OverlayInfoPanel, RangeStats)
participated in the global z-stack. Three concrete problems followed:

- **Tier collisions.** `RangeStats` and the Dock shared the same z-index, causing
  a stacking tie under certain window sizes.
- **Panel occlusion.** `OverlayInfoPanel` was occluded by `LegendHUD` when both
  were visible.
- **Modal bleed.** The Actions tooltip painted over modal scrim layers because
  the chart wrapper had no isolation boundary.

Separately, over-content surfaces (Palette menu, OverlayInfoPanel, modal cards,
Dock flyout) were too translucent to read over a busy candlestick chart. The
`MarkComposer` already carried a hand-rolled `bg-1 88%` opacity workaround
proving the design gap was real and recurring. ADR-0011 had flagged "z-index
soup" explicitly; this ADR is the resolution.

## Decision

Two invariants govern every z-index and over-content opacity choice in the
codebase going forward.

### Invariant 1 — Named z-index scale

All z-index values come from `--z-*` tokens defined in `src/styles/tokens.css`.
Raw numeric z-index literals are forbidden in shared (non-isolated) contexts.

The scale, spaced by 100 to leave room for future insertion:

| Token | Value | Used by |
|---|---|---|
| `--z-base` | 0 | default document flow |
| `--z-chart-crosshair` | 10 | Crosshair overlay |
| `--z-chart-hud` | 20 | LegendHUD, RangeStats |
| `--z-chart-panel` | 30 | OverlayInfoPanel, MarkComposer, other chart panels |
| `--z-chrome` | 100 | top/bottom chrome strips |
| `--z-dock` | 200 | Dock cells, activity rails |
| `--z-drawer` | 300 | DockDrawer |
| `--z-rail` | 400 | activity rail (above open drawer) |
| `--z-banner` | 500 | notification banners |
| `--z-popover` | 600 | Palette menu, tooltips, flyouts |
| `--z-modal-scrim` | 700 | AddAsset/AddHolding scrim backdrop |
| `--z-modal` | 800 | modal card content |
| `--z-toast` | 1000 | toast layer (always on top) |

**Chart wrapper isolation.** `src/AppShell.tsx`'s chart wrapper div carries
`isolation: isolate`. This makes `--z-chart-crosshair` / `--z-chart-hud` /
`--z-chart-panel` (values 10/20/30) **local** to the chart stacking context —
they can never compete with or bleed into shell chrome.

**Sanctioned local raw values.** Genuinely-local sibling ordering inside an
isolated component (e.g. flyout orbs inside the Dock cell, the
terminal-start-overlay inside XtermPanel) may keep small raw integers, but they
MUST be accompanied by a `/* local z — inside isolated <ComponentName> */`
comment so reviewers know they are intentionally scoped.

### Invariant 2 — Over-content surface opacity

Surfaces that float **over content** (over the chart, over another panel) MUST
use the designated fill and backdrop tokens rather than raw `rgba` or `bg-*`
classes:

- **Fill:** `--surface-overlay` (`bg-1` at 90% opacity) for single-layer floats;
  `--surface-overlay-strong` (`bg-1` at 94% opacity) for nested or secondary
  over-content surfaces.
- **Backdrop/scrim:** `--scrim` (black at 45% opacity) for modal backdrops;
  `--scrim-strong` (black at 55% opacity) for stacked modal scenarios.
- Surfaces retain `backdrop-filter: blur(…)` — they stay frosted-glass, just
  legible at WCAG-AA contrast over a busy chart background.

**Ambient surfaces are unchanged.** Docked, always-visible surfaces (ActivityBar
rails, Dock cells, DockDrawer background) keep the existing translucent
`--glass*` tint tokens — they sit beside content, not over it.

**`.glass-card` deprecation for over-content use.** `.glass-card` uses a
`--glass*` tint tuned for ambient contexts and is too translucent when floating
over a chart. It is **deprecated for any new over-content surface**. Existing
ambient consumers (XtermPanel, DesignPreview) are grandfathered; `.glass-card`
is kept in the stylesheet, not deleted.

### Sanctioned exceptions

- **(a) Chart-local tiers.** `--z-chart-crosshair` / `--z-chart-hud` /
  `--z-chart-panel` resolve to 10/20/30 — small values that would be
  meaningless in the global stack. They are safe because the chart wrapper uses
  `isolation: isolate`. This is the intended design; do not remove `isolation`.
- **(b) Intentionally-local raw values.** Small raw integers inside isolated
  components are permitted when commented `/* local z — inside isolated … */`.
  They MUST NOT appear in shared global stylesheet rules.
- **(c) `--scrim-strong` for truly stacked modals.** A modal opened from inside
  another modal (e.g. AlpacaCredentialsModal from Settings) uses `--scrim-strong`
  (55%) instead of `--scrim` (45%) so the two backdrops read as distinct layers.

## Consequences

**Forbidden:**
- Raw z-index integers in shared or global stylesheets — use a `--z-*` token.
- Over-content floats using `--glass*` tints or raw `rgba` for fill — use
  `--surface-overlay` or `--surface-overlay-strong`.
- Removing `isolation: isolate` from the chart wrapper — doing so collapses the
  chart's local tier into the global stack and reintroduces collisions.
- Adding new `.glass-card` over-content uses — it is deprecated for that role.

**Required:**
- New over-content surfaces (Palette entries, tooltip menus, flyouts, modal
  cards): choose the appropriate `--z-*` tier from the table; choose
  `--surface-overlay` or `--surface-overlay-strong` for fill.
- New isolated components with internal sibling ordering: keep raw values, add
  the `/* local z — inside isolated <Name> */` comment.
- `src/styles/tokens.css` is the single source of truth for the `--z-*` and
  `--surface-overlay*` / `--scrim*` tokens; changes to the scale require a new
  ADR or an amendment.

**Observable behavior:**
- Chart floats (Crosshair, LegendHUD, OverlayInfoPanel, RangeStats) stack
  correctly relative to each other and never paint over shell chrome or modals.
- Palette menu, OverlayInfoPanel, modal cards, and Dock flyout are legible over
  a busy chart at WCAG-AA contrast.
- Toast layer always wins (`--z-toast: 1000`); modal scrim always sits below the
  modal card (`--z-modal-scrim: 700` < `--z-modal: 800`).

**Source:**
- Token scale + overlay/scrim tokens: `src/styles/tokens.css`
- Chart wrapper isolation: `src/AppShell.tsx`
- Amends: [ADR-0011](./0011-activity-bar-drawer-dock.md)
