# P3 — Asset Panel + Watchlist

## Status

**Completed** — landed in session 1 (P3.1 DB layer + P3.2 UI, 2 sequential dispatches). Verified via:
- `npm run lint && npm run typecheck && npm test && cargo test` all green
- Playwright: add asset → restart → assert persisted with active selection preserved — green
- Visual-diff screenshots captured in `docs/visual-diff/P3/`
- `--reserve-left` updates dynamically when panel expands/collapses

The full dispatch record for this phase is retained in the project history.

**Key deviations from original spec:**
- *Split into P3.1 + P3.2:* dispatch plan split the phase into a DB layer step (P3.1) and a UI step (P3.2) to reduce coordination risk. Original spec was a single phase.
- *P3-2 panel position:* position state lives in `useAppStore.panelPos` and is **session-only** (not persisted to SQLite). Original P3-2 phrasing was ambiguous ("persist within session only (no SQLite needed)") — this matches.
- *First-run watchlist:* **empty watchlist on first run** — no seed assets. The AddAssetModal guides the user to add their first asset. Original spec did not specify a seed; empty state is the implemented behavior.
- *P3-12/P3-13 provider chips:* Coinbase, Binance, Kraken active; NASDAQ/NYSE chips DISABLED with "Coming soon" tooltip — as specified.
- *`--reserve-left` dynamic updates:* panel writes its width to `:root --reserve-left` when expanded and `0px` when collapsed, per A4. Headline auto-shifts without pixel coupling.
- *`0003_watchlist.sql` migration:* `watchlist(sym, provider, added_at, PRIMARY KEY(sym, provider))` + `app_state(key, value)` added per A1.

**Hand-off:** P4 — Real Crypto Data Layer (complete; see P4 status block).

---

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of [P2](./P2-floating-ui.md). **Binding design source:** `app-design/project/panel.jsx` (289 lines), prototype expanded + collapsed states, AddAssetModal layout.

**Goal:** floating draggable watchlist with Add modal; persists active asset and watchlist across sessions. Pixel-fidelity to prototype — see [README §2.5](./README.md#25-design-adoption--app-design-is-binding).

## Checklist

### Floating panel mechanics
- [x] **P3-1** `src/panels/AssetPanel.tsx` — floating, draggable via top grip, collapsible.
- [x] **P3-2** Position state in Zustand `useAppStore.panelPos`; **session-only** (not persisted to SQLite).
- [x] **P3-3** Default position: left edge of viewport (clears right-side AI panel).
- [x] **P3-4** Collapse/expand button must NOT trigger drag (separate hit target).
- [x] **P3-5** `prefers-reduced-motion` respected for drag animations.

### Expanded state
- [x] **P3-6** Search bar at top — filter watchlist by name/symbol/provider.
- [x] **P3-7** Each row: status dot · symbol · provider tag · 32-bar SVG sparkline · price · 24h % · hover-reveal `×`.
- [x] **P3-8** "Add asset" button → opens AddAssetModal.
- [x] **P3-9** Drag grip at top.

### Collapsed state
- [x] **P3-10** Vertical mini-stack: symbol + tiny up/down triangle + short % (e.g. `BTC ▲ 2.4%`) color-coded.
- [x] **P3-11** Click a row to switch active asset; chevron to expand.

### Add Asset modal
- [x] **P3-12** `src/panels/AddAssetModal.tsx`.
- [x] **P3-13** Provider chips: Coinbase, Binance, Kraken (active). NASDAQ/NYSE chips DISABLED with tooltip "Coming soon" per locked-in decision.
- [x] **P3-14** Empty search → list assets from selected provider.
- [x] **P3-15** Typing → cross-provider search.
- [x] **P3-16** Each candidate: price + 24h chg + `+`/`✓` toggle.

### Persistence
- [x] **P3-17** SQLite schema `watchlist(sym, provider, added_at, PRIMARY KEY(sym, provider))` + Tauri command `db_watchlist_*`. *Migration: `0003_watchlist.sql` per A1.*
- [x] **P3-18** SQLite schema `app_state(key, value)` for `activeSym`, `chartType`, `tf`, `viewport`. *In same `0003_watchlist.sql` migration.*
- [x] **P3-19** Hydrate Zustand from SQLite on app start; debounce writes (200ms) on change.

### Sparkline
- [x] **P3-20** `src/components/MiniSpark.tsx` — SVG polyline, normalized to row height; stroke from change direction.

### Tests
- [x] **P3-21** Playwright: add an asset, restart app, verify it's still there with active selection preserved — green.

## Acceptance

Drag panel anywhere, collapse/expand, add/remove assets, switch active asset by row click; survives reload.

## Hands off to

[P4 — Real Crypto Data Layer](./P4-crypto-data.md) — but P4 can start in parallel once P1's `MockMarketDataProvider` interface is stable.

## PFIX P3-extended — Floating sidebar refinements

Added in PFIX wave (post P0–P4 completion):

- [x] **P3-extended-1** AssetPanel is **collapsed by default** on first load (`useState(true)` for `collapsed`).
- [x] **P3-extended-2** Body always mounted; collapse/expand co-animates `opacity var(--t-fast)` + `max-height var(--t-med)` alongside the existing width transition. Body never unmounts during transition (no popping in/out).
- [x] **P3-extended-3** Decoupled from Headline layout — AssetPanel pins `--reserve-left: 0px` while mounted; `Headline.tsx` no longer reads `--reserve-left`. The panel floats above the chart without reserving any layout space.
- [x] **P3-extended-4** Drag mechanics + persisted position (`useAppStore.panelPos`) preserved unchanged.
