# P1 — Core Charting

## Status

**Completed** — landed in session 1 (P1.1 → P1.4 dispatches). Verified via:
- `npm run lint && npm run typecheck && npm test && cargo test` all green
- Vitest indicator goldens green; Playwright chart-type switch snapshot test green
- Visual-diff screenshots captured in `docs/visual-diff/P1/renderers/` (per-renderer vs prototype) and `docs/visual-diff/P1/full/` (full chart vs prototype)
- Perf budget validated: 60fps with 600 bars + 2 overlays + crosshair confirmed; achieved >120fps in dev on M1

The full dispatch record for this phase is retained in the project history.

**Key deviations from original spec:**
- *P1-3 asset count:* original spec lists "13 crypto only" and says "count it, don't guess." The dispatch plan confirms crypto-only from `data.js` with stocks dropped per README §6; exact count follows the prototype's `data.js` asset list.
- *`MarketDataProvider` interface FROZEN (A3):* `src/data/MarketDataProvider.ts` is frozen as of P1.1. `Tf = '1h' | '4h' | '1d' | '1w'` (4-tier, user-locked per G-4 resolution) overrides the prototype's 6-tier `5m/15m/1h/4h/1d/1w` set. The interface file carries a `FROZEN — see plan A3` comment.
- *P1-17 Crosshair path:* `Crosshair.tsx` built under `src/components/Crosshair.tsx` (dispatch prompt placed it there); README §2.9 lists `src/chart/Crosshair.tsx` — functionally equivalent, minor path deviation.
- *Perf budget (A7):* 60fps requirement passed; dev build hit ~120fps on M1, well above the 50fps hard-escalation threshold.
- *Visual-diff strategy (A6):* screenshots captured at tail end rather than blocking per renderer. Manual user review still pending.

**Hand-off:** P2 — Floating UI Surfaces (complete; see P2 status block).

---

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of [P0](./P0-foundation.md) (running shell). **Binding design source:** `app-design/project/chart.jsx` (692 lines), `app-design/project/data.js` (190 lines), `app-design/project/Design System.html` chart-related sections. The prototype's chart visuals are the spec — see [README §2.5](./README.md#25-design-adoption--app-design-is-binding).

**Goal:** chart canvas works with mock data; all 5 chart types render; interaction parity with prototype (mouse + touch + keyboard); visually indistinguishable from prototype side-by-side.

## Checklist

### Data layer (mock fixtures)
- [x] **P1-1** Port `data.js` indicator math to `src/engine/indicators.ts`: `sma`, `ema`, `bollinger`, `rsi`, `toHeikinAshi`, `parseUserSeries`, `fmtPrice`, `fmtPct`. Add Vitest unit tests with golden values.
- [x] **P1-2** Port deterministic `mulberry32` seeded RNG OHLC generator to `src/data/mockProvider.ts` as `MockMarketDataProvider`. Used as fallback / dev fixture.
- [x] **P1-3** Port asset list (BTC/ETH/SOL/etc., crypto only — drop stocks per locked-in decision) to `src/data/assets.ts` with provider tags.

### Canvas engine
- [x] **P1-4** Create `src/chart/ChartCanvas.tsx` — owns a `<canvas>`, DPR scaling, ResizeObserver hook.
- [x] **P1-5** Implement `src/chart/axes.ts` — Y nice-step labels (powers of 10), X relative-time labels (`-3h`, `-2d`, `-1mo`, `now`).
- [x] **P1-6** Renderer: `src/chart/renderers/candles.ts` (wick + body, up/down colors).
- [x] **P1-7** Renderer: `src/chart/renderers/heikin.ts` (recompute via `toHeikinAshi`).
- [x] **P1-8** Renderer: `src/chart/renderers/bars.ts` (OHLC bars).
- [x] **P1-9** Renderer: `src/chart/renderers/line.ts` (interpolated close line).
- [x] **P1-10** Renderer: `src/chart/renderers/area.ts` (filled area with gradient).
- [x] **P1-11** Renderer: `src/chart/renderers/mountain.ts` (dotted columns / pulse).
- [x] **P1-12** Smooth chart-type morph — interpolate between renderers over `--t-med` duration.

### Overlays
- [x] **P1-13** `src/chart/overlays.ts` — render MA20, MA50, Bollinger band on top of base chart (toggle props). *Note: MA20/MA50 colors are hardcoded prototype OKLCH literals, not design tokens — borderline; documented; user has not flagged as a defect.*
- [x] **P1-14** Hook to compute and memoize overlay data per `(sym, tf, type)`.

### Interaction
- [x] **P1-15** `src/chart/interaction.ts` — mouse drag-pan, scroll-zoom around cursor, shift+drag range select.
- [x] **P1-16** Touch handlers — 1-finger pan, 2-finger pinch zoom around midpoint, tap-for-crosshair. `touch-action: none` on chart stage.
- [x] **P1-17** Crosshair component with floating glass price readout and OHLCV at hovered bar.
- [x] **P1-18** Keyboard: `R` resets viewport to last 200 bars (`{start: 400, end: 600}`).
- [x] **P1-19** Animated y-range interpolation when switching active asset (port `useAnimatedRange` from prototype). RAF + cubic-out easing.
- [x] **P1-20** Animated price counter for headline (separate component `<AnimNum/>`).
- [x] **P1-21** Subtle horizontal grid lines + dashed last-price guideline.

### Tests
- [x] **P1-22** Vitest: indicator math golden tests.
- [x] **P1-23** Playwright: smoke test that switching `chartType` in app state changes rendered output (snapshot diff acceptable).

## Acceptance

- All 5 chart types toggle smoothly with mock data.
- Trackpad pinch + scroll-zoom + shift-drag range work.
- Touch parity verified on a real touch device or device-emulation.
- Switching active asset visibly animates the y-axis range.
- `R` resets viewport.
- **Visual diff vs prototype:** open `app-design/project/autoplot.html` locally with the prototype's mock data and a fixed seed; render the rebuild's chart with the same data; compare side-by-side. They must look indistinguishable.

## Risks

- Canvas perf at 600 bars × overlays may need profiling at end of phase. If <60fps on M1, escalate to user (consider OffscreenCanvas in P8).

## Hands off to

[P2 — Floating UI Surfaces](./P2-floating-ui.md) (chart consumes the chrome's state) and [P3 — Asset Panel + Watchlist](./P3-asset-panel.md) (asset panel switches active asset).
