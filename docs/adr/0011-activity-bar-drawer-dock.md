# ADR-0011: Activity-Bar + Drawer Dock (Floating Panels → VS Code-style Dock)

**Status:** Accepted
**Date:** 2026-06-07

**Amends [ADR-0004](./0004-design-binding-prototype.md)** — the binding prototype
`app-design/project/` now depicts a docked layout, not free-floating panels.
**Supersedes the floating-panel layout** of P2/P3 while KEEPING ADR-0004's
binding-fidelity principle: the dock is an *evolution of the same visual
language* (token-for-token, motion-for-motion), not a reskin.

## Context

The rebuild reproduced the prototype's six panels as free-floating glass cards
(AssetPanel, IndicatorPanel — née OverlaysPanel — Portfolio, Strategy, Terminal,
Settings). Each owned its own position and its own per-panel `open` flag. In
practice this produced:

- **Overlap / z-index soup.** Multiple panels could occupy the same screen
  region; tuning their z-index against modals (MarkComposer, AddAsset scrim) and
  the chart was fragile and ad-hoc.
- **Unused layout machinery.** `tokens.css` defined `--reserve-left` /
  `--reserve-right` (the A4 "layout reservation" vars) but only AssetPanel ever
  wrote one; floating panels covered the chart instead of insetting it. The
  `prototype-fidelity` skill explicitly discouraged coupling floating panels to
  the reserve vars.
- **Five independent open-state owners.** Each panel store carried its own
  `open` boolean and a removed `useTerminalStore`; nothing enforced "at most one
  panel per region."

The binding prototype itself depicted floating cards (ADR-0004), so any
production dock had to be sanctioned by an amending ADR and reflected back into
the prototype.

## Decision

Replace the floating panels with a **VS Code-style activity-bar + drawer dock**:

- **Two always-visible ~48px activity rails** (left + right), each
  `role="toolbar"` reusing the existing `.dock-btn` visual (glow/box-shadow on
  active — never a solid border, Design Principle 04). Left rail: Watchlist,
  Strategy. Right rail: Claude CLI (Terminal), Portfolio, Indicator, Settings
  (`src/chrome/ActivityBar.tsx:39-40`).
- **Clicking a rail icon toggles a drawer** that slides out from that side. The
  chart **insets** by consuming the previously-unused `--reserve-left` /
  `--reserve-right` vars plus a new `--rail-w: 48px`
  (`src/styles/tokens.css:140-142`); the chart container reads
  `left: calc(var(--rail-w) + var(--reserve-left))` /
  `right: calc(var(--rail-w) + var(--reserve-right))`
  (`src/AppShell.tsx:884-885`).
- **At most one drawer open per side** — structural, not policed: the store
  holds one nullable `DrawerId` per side
  (`useDockStore.openLeft` / `openRight`, `src/stores/useDockStore.ts:38-39`).
- **The Claude CLI (Terminal) drawer is OPEN BY DEFAULT** at launch
  (`src/stores/useDockStore.ts:89,95`).
- **`useDockStore` is the single source of truth** for drawer open-state. The
  five legacy per-panel open flags were deleted and `useTerminalStore` removed
  (`src/stores/useDockStore.ts:1-15`).
- **`DockDrawer`** is the one reusable drawer shell, flush against its rail,
  filling the reserved inset between the top/bottom chrome strips
  (`src/panels/DockDrawer.tsx:54-71`).
- **Motion reuses existing tokens.** Chart inset:
  `left/right var(--t-med) var(--ease-spring)` (`src/AppShell.tsx:794-796`).
  Drawer slide: new side-aware keyframes `drawer-{in,out}-{left,right}` with the
  same magnitudes/durations as the removed `overlays-panel-*` (enter 380ms
  `ease-spring`, exit 220ms `ease`; `src/styles/motion.css:69-84`,
  `src/panels/DockDrawer.tsx:151-156`). All neutralized under
  `prefers-reduced-motion`.
- **Narrow-window clamp.** Each side's reserve is clamped so the chart column
  never drops below 240px at the 800×600 Tauri minimum:
  `min(width, innerWidth - 2*RAIL_W - 240)`
  (`src/stores/useDockStore.ts:33,68-73`; mirrored as a `max-width` on the
  drawer in `src/panels/DockDrawer.tsx:39,193`).
- **Keyboard.** `D` → Indicator, `⌘P` → Portfolio, `⌘,` → Settings, `⌘\`` →
  Terminal (newly wired), `Esc` → close the focused side's drawer
  (`src/AppShell.tsx:667-702`). Watchlist/Strategy are rail-icon-only (no
  shortcut).

### Sanctioned exceptions / boundaries

- **(a) Reserve-var layout reservation now drives chart inset.** The
  `prototype-fidelity` skill previously discouraged coupling floating panels to
  the reserve vars; this is the **approved exception** — the reserve vars are now
  the dock's load-bearing inset mechanism, not a floating-panel anti-pattern.
- **(b) Single-source `useDockStore`.** Drawer open-state lives in exactly one
  store; per-panel open flags and `useTerminalStore` are gone.
- **(c) `mountOnOpen` mount policy.** `DockDrawer` defaults to **mount-stable**
  (children always rendered; closed = off-screen resting transform; stable DOM
  for a11y / Playwright) for Watchlist / Portfolio / Indicator. **`mountOnOpen`**
  (mount only while open; unmount on the closing animation's end so
  unmount-keyed cleanup runs) is used for **Terminal** (PTY dispose),
  **Strategy** (CodeMirror teardown), and **Settings** (heavy / lazy)
  (`src/panels/DockDrawer.tsx:62-69,109-124,166-167`).
- **(d) Overlays → Indicator rename is panel-UI-only.** The toggle panel
  `OverlaysPanel` → `IndicatorPanel`, `overlayFlags` → `indicatorFlags`,
  `OVERLAY_ITEMS` → `INDICATOR_ITEMS`. The CHART-ENGINE overlay vocabulary
  (`buildOverlays`, `useOverlayData`, `strategyOverlays`, ChartCanvas `overlays`
  prop, `signalsOverlay`, `timelineEventsOverlay`) is a DIFFERENT concept and is
  deliberately LEFT untouched.
- **(e) Terminal default-open** at launch (the primary AI surface; CLI/Terminal
  is the only AI surface per the chat-UI removal).
- **(f) Session-only drawer state.** `useDockStore` is pure runtime UI state —
  nothing is persisted; the dock resets to Terminal-open every launch
  (`src/stores/useDockStore.ts:1-15`).
- **(g) ≥240px narrow-window clamp** as above.

**Out of scope (still floating modals):** FirstRun, Palette, AddAssetModal,
AddHoldingModal, AlpacaCredentialsModal, Inspect. These are transient centered
overlays, not dockable panels.

## Consequences

**Forbidden:**
- Reintroducing per-panel `open` booleans or a second drawer-state owner —
  open-state MUST flow through `useDockStore`.
- Opening two drawers on the same side simultaneously (structurally impossible:
  one nullable `DrawerId` per side).
- Letting the chart column fall below 240px — the reserve clamp MUST hold at the
  800×600 minimum.
- Renaming the chart-engine overlay vocabulary to "indicator" — the rename
  boundary stops at the panel UI.

**Required:**
- New dockable panels wrap in `DockDrawer`, declare a `side` + `width` in
  `useDockStore.SIDE` / `WIDTH`, and choose `mountOnOpen` only when they own
  unmount-keyed teardown (PTY, editor).
- Drawer + chart-inset motion reuses the existing tokens (`--t-med`,
  `--ease-spring`) and the `drawer-{in,out}-{left,right}` keyframes; new easings
  or durations require user approval per ADR-0004 / §2.5.
- The prototype (`app-design/project/`) depicts the dock; the
  `prototype-fidelity` skill audits against the docked layout.

**Observable behavior:**
- App launches with the Terminal drawer open on the right; the chart is inset on
  the right by the Terminal reserve.
- Clicking a rail icon slides its drawer in (spring), insets the chart, and
  toggles `aria-pressed`/`.active` on the icon; clicking again (or `Esc` on that
  side) slides it out and re-expands the chart.
- At the 800×600 minimum, opening a wide drawer shrinks both the drawer and its
  inset so ≥240px of chart remains.

**Source:**
- Store (single source + reserve + clamp + Terminal default-open):
  `src/stores/useDockStore.ts`
- Reusable drawer + `mountOnOpen`: `src/panels/DockDrawer.tsx`
- Rails: `src/chrome/ActivityBar.tsx`
- Chart inset + keyboard wiring: `src/AppShell.tsx:667-702,884-896`
- Token + keyframes: `src/styles/tokens.css:140-142`,
  `src/styles/motion.css:69-84`
- Amends / supersedes: [ADR-0004](./0004-design-binding-prototype.md)
