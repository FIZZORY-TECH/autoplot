# src/chart — CLAUDE.md

Canvas2D chart pipeline (P1) — the single rendering surface for bars, overlays, marks, trends, and signals.

## Pipeline contract

- Driven by `bars: Bar[]` + `view: ViewWindow` (start/end bar indices + yMin/yMax). `AppShell` recomputes y-bounds from the visible slice on every view change.
- A `ChartRenderer` (one of six in `renderers/`) handles the chart-type morph.
- Overlay renderers are built by `buildOverlays()` from active overlay flags + optional user custom series.
- The `rangeScope` overlay must use a **stable ref** (not re-creation) to avoid morph re-trigger. See `rangeScope.ts`.
- `interaction.ts` handles pan/zoom/range-select; `marks.ts` draws persisted annotations; `trends.ts` draws trend lines.

## Keyboard

Route ALL chart shortcuts through the global dispatcher at `src/stores/keyboard.ts` (`useKeyboardDispatcher`). Owns ⌘K, `/`, `D`, `M`, `C`, `S`, `T`, `R`, `Esc` with a documented precedence chain. **Do not attach competing window keydown listeners.** Local React `onKeyDown` on focused inputs is fine.

## Frozen

`Bar` is imported from the FROZEN `MarketDataProvider` interface — see [ADR-0001](../../docs/adr/0001-market-data-provider-frozen.md). Never mutate `Bar` shape or add timeframes — see [ADR-0002](../../docs/adr/0002-timeframe-set-locked.md).
