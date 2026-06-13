# P2 — Floating UI Surfaces

## Status

**Completed** — landed in session 1 (P2.1 → P2.7 dispatches, 5 parallel + 1 sequential). Verified via:
- `npm run lint && npm run typecheck && npm test && cargo test` all green
- Vitest: keyboard-handler dispatcher tests green
- Playwright: palette flow + overlay toggle + mark place + reload cycle green
- Marks survive app restart (SQLite persist confirmed)
- Visual-diff screenshots captured in `docs/visual-diff/P2/`

The full dispatch record for this phase is retained in the project history.

**Key deviations from original spec:**
- *P2-5 Timeframe scrubber:* spec listed "flag G-4" and referenced prototype's 6-tier `5m/15m/1h/4h/1d/1w`. Implemented as **4-tier `1h/4h/1d/1w`** per G-4 user resolution (USER-LOCKED). The prototype's 6-tier is not used.
- *P2-22 Keyboard dispatcher:* built as a single unified `src/stores/keyboard.ts` global dispatcher per dispatch plan (P2.7). Original spec listed it as P2-22 in the checklist but the dispatch plan made it the sole sequential step. `⌘K` confirmed not firing in Tauri's macOS webview; `Ctrl+K` is the working fallback and is already wired. Both are documented.
- *P2-16 marks DB schema:* migration file is `0002_marks.sql` per A1 (append-only). Original P2-16 listed `marks(id, sym, price, color, note, created_at)`; that is exactly what landed.
- *P2-24 Playwright:* some Playwright tests require Tauri runtime — those are currently skipped with reasons documented in the test files; non-runtime-dependent flows (palette, overlays, mark round-trip) pass.

**Hand-off:** P3 — Asset Panel + Watchlist (complete; see P3 status block).

---

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of [P1](./P1-core-charting.md) (working chart). **Binding design source:** `app-design/project/chrome.jsx` (421 lines), `app-design/project/app.css` glass section, `app-design/project/Design System.html` §04 Components (Headline + delta pill, dock, tf-scrubber, mark composer).

**Goal:** all chrome around the chart matches the spec — headline, dock, actions, palette, overlays panel, marks/comments, range scope, hint strip, keyboard shortcuts. Pixel-fidelity to prototype — see [README §2.5](./README.md#25-design-adoption--app-design-is-binding).

## Checklist

### Headline (top)
- [x] **P2-1** `src/chrome/Headline.tsx` — symbol + name + class, `<AnimNum/>` price, 24h delta pill, OHLCV readout when crosshair active.
- [x] **P2-2** Right-shift on desktop to clear the watchlist rail. *Reads `var(--reserve-left)` per A4; no hardcoded pixel offset.*

### Dock (bottom-center)
- [x] **P2-3** `src/chrome/Dock.tsx` — glass capsule.
- [x] **P2-4** Chart-type toggle (5 buttons + "mountain" → 6 visual states).
- [x] **P2-5** ~~Timeframe scrubber with prototype's 6-tier `5m/15m/1h/4h/1d/1w`~~ — *implemented as 4-tier `1h/4h/1d/1w` per G-4 user resolution (USER-LOCKED). Animated active pill present.*
- [x] **P2-6** Tools: Mark, Comment, Range Scope. Active state visible.

### Actions (top-right)
- [x] **P2-7** `src/chrome/Actions.tsx` — command palette toggle, overlays panel toggle, reset view.

### Command palette
- [x] **P2-8** `src/chrome/Palette.tsx` — `⌘K` / `Ctrl+K` / `/` opens; centered glass; arrow keys; Enter picks. *`⌘K` does not fire in Tauri macOS webview; `Ctrl+K` is the wired fallback.*
- [x] **P2-9** Fuzzy search assets via `fuse.js`.
- [x] **P2-10** Each row: symbol + name + price + 24h chg + 24-bar mini chart.

### Overlays panel
- [x] **P2-11** `src/panels/OverlaysPanel.tsx` — slide-in from right; toggles for MA20/MA50/Bollinger.
- [x] **P2-12** Custom series textarea (paste CSV); parse via `parseUserSeries` from `engine/indicators.ts`; show row-count + parse errors inline.
- [x] **P2-13** "Plot" button wires to chart's `customSeries` prop.

### Marks & Comments
- [x] **P2-14** `src/chrome/MarkComposer.tsx` — opens at click position when Mark/Comment tool active. Color swatches (5), textarea (Comment only), Cmd+Enter to save, Esc to cancel.
- [x] **P2-15** Render marks on chart (colored LED + price tag; hover reveals note for Comment).
- [x] **P2-16** SQLite schema `marks(id, sym, price, color, note, created_at)` + Tauri command `db_marks_*`. *Migration file: `0002_marks.sql` per A1.*
- [x] **P2-17** Marks persist per-asset across app restart (per G-6). Confirmed via Playwright reload test.

### Range Scope tool
- [x] **P2-18** Activate from dock → drag (or Shift+drag).
- [x] **P2-19** Render glass selection band on chart via `src/chart/rangeScope.ts`.
- [x] **P2-20** Floating stats card `src/chrome/RangeStats.tsx`: Δ% · Δ$ · O · C · H · L · Span (bars + duration). `×` clears.

### Hint strip
- [x] **P2-21** `src/chrome/Hint.tsx` — bottom strip with `⌘K` search · `D` overlays · `M` mark · `⇧ drag` range · `scroll` zoom.

### Keyboard shortcuts
- [x] **P2-22** Global handler: `⌘K`/`Ctrl+K` / `/`, `D`, `M`, `C`, `R`, `Esc`, `⇧+drag`. Implemented as single unified `src/stores/keyboard.ts` dispatcher per A approach in P2.7.

### Tests
- [x] **P2-23** Vitest: keyboard-handler dispatcher mapping table tests green.
- [x] **P2-24** Playwright: open palette, search, select; toggle overlays; place a mark; survive reload. *Some tests require Tauri runtime — skipped with documented reasons; non-runtime flows pass.*

## Acceptance

- Every shortcut, every dock control, every panel works.
- Marks survive app restart.
- **Visual diff vs prototype:** dock, headline, palette, overlays panel, mark composer compared side-by-side with prototype — indistinguishable.

## Risks

- Tauri's webview keyboard handling can differ from a regular browser — verify `⌘K` works on macOS specifically.

## Hands off to

[P3 — Asset Panel + Watchlist](./P3-asset-panel.md).

## PFIX P2-extended — Trend Line tool

Added in PFIX wave (post P0–P4 completion):

- [x] **P2-extended-1** Trend Line tool added as fourth Dock button (45° glyph). `T` key toggles. Chart cursor changes to crosshair when active. Chart rail glow indicator shown via `Hint` strip ("Click + drag to draw a trend line · Esc to cancel").
- [x] **P2-extended-2** Range Scope (`S` key) wired to keyboard dispatcher; chart cursor changes to `col-resize` when active; hint strip shows "Drag horizontally to define range · Esc to clear".
- [x] **P2-extended-3** Mark + Comment tools gain chart-side affordance (cursor + rail glow + hint) — previously only the Dock button glow indicated active state.
- [x] **P2-extended-4** Trend Line persistence: migration `0006_trends.sql`, Rust `db_trends_list/insert/delete` commands, TS `dbTrendsList/Insert/Delete` bindings. Trends survive app restart.
- [x] **P2-extended-5** Trend Line interaction: mousedown anchors first point; drag updates draft; mouseup commits + persists. Esc cancels mid-draw (drops draft, stays in tool); a second Esc exits the tool. Click on existing trend within hit-test threshold selects it; Backspace deletes selected trend.
