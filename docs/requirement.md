# autoplot — Requirements

A consolidated spec from this design session. The product is a **borderless, mostly-textless, cinematic dark-glass charting workspace** for screening any asset (crypto, stocks, etc.) with first-class AI co-research and co-strategy agents.

---

## 1. Aesthetic & Style

- **Theme:** Dark only.
- **Visual language:** Cinematic dark glass — deep neutral void background, volumetric blur halos, hairline glass panels, depth-of-field layering.
- **Density:** Minimal, borderless, mostly textless. Numerals over labels; iconography over copy. Axis labels and short metric tags are allowed; everything else is implicit.
- **Type:** Geist (sans) for UI, Geist Mono for all numerals. Tabular numerals everywhere.
- **Color hues:** Up = green oklch(0.78 0.16 150), Down = red oklch(0.70 0.20 25). Accent = cyan oklch(0.82 0.14 215). Violet oklch(0.78 0.18 320) reserved for AI strategy surfaces. Warn = amber oklch(0.85 0.16 80).
- **Motion:** Extremely smooth. Default ease `cubic-bezier(.22, 1, .36, 1)`; spring `cubic-bezier(.34, 1.56, .64, 1)`. Animated price counters, animated y-range when switching assets, shimmer + aurora effects for AI thinking states.
- **Form factor:** All breakpoints — desktop, tablet, mobile. Touch-first interaction parity.

---

## 2. Core Charting

### 2.1 Chart canvas
- Full-bleed canvas behind floating glass UI.
- Five chart types with smooth morphing between them: **candles, heikin-ashi, bars, line, area, mountain (dotted columns)**.
- Y-axis ticks live on the right edge; X-axis tick labels along the bottom (relative time: `-3h`, `-2d`, `-1mo`, `now`).
- Subtle horizontal grid; dashed last-price guideline.
- Crosshair on hover with floating price readout.

### 2.2 Interaction
- **Mouse:** drag = pan, scroll = zoom around cursor, shift+drag = range select, click = mark/comment placement when a tool is active.
- **Touch:** 1-finger drag = pan (or range when Scope tool active), 2-finger pinch = zoom around midpoint, tap = crosshair / commit mark.
- `touch-action: none` on chart stage; passive-friendly handlers.
- Reset view via `R` or Reset action.

### 2.3 Overlays
- MA20, MA50, Bollinger Bands (20, 2σ) — toggleable from a glass overlays panel.
- Custom user-pasted series accepted (parsed into a numeric array, normalized to chart scale).
- AI-generated overlays render with a glow pass.

### 2.4 Marks & Comments
- Click while Mark or Comment tool is active → opens a glass composer at the click position.
- Mark = colored led + price tag; Comment = mark plus a short note.
- Marks persist per-asset.

### 2.5 Range Scope tool
- Activate from dock then drag (or shift+drag on desktop).
- Renders a glass selection band on the chart.
- Floating stats card shows: Δ% · Δ$ · Open · Close · High · Low · Span (bars + duration). `×` clears.

---

## 3. Asset Panel (Watchlist)

### 3.1 Behavior
- **Floating, draggable, collapsible.** Position persists during the session.
- **Default position:** left edge of the viewport (so it never collides with the right-side AI panel).
- Collapse/expand button is a discrete click target — must not trigger drag.

### 3.2 Expanded state
- Search bar at top — filters by name, symbol, or provider.
- Each row: status dot · symbol · provider tag · 32-bar sparkline · price · 24h % · hover-reveal `×` to remove.
- "Add asset" button at bottom opens the Add modal.
- Drag grip at top to reposition the whole panel.

### 3.3 Collapsed state
- Vertical mini-stack of compact rows, each showing **symbol + tiny up/down triangle + short % change** (e.g. `BTC ▲ 2.4%`), color-coded green/red.
- Click any row to switch active asset; click chevron to expand.

### 3.4 Add Asset modal
- Provider chips: Coinbase, Binance, Kraken, NASDAQ, NYSE.
- Empty search → shows assets from selected provider.
- Typing → searches across all providers.
- Each candidate row shows price + 24h chg + a `+` to add (turns to `✓` when on watchlist).

### 3.5 Asset universe
- Crypto: BTC, ETH, SOL, and a handful more across Coinbase / Binance / Kraken.
- Stocks: NVDA, AAPL, TSLA, and a handful more across NASDAQ / NYSE.
- Each asset has its own deterministic 600-bar OHLC history (4h candles).

---

## 4. Floating UI Surfaces

### 4.1 Headline (top)
- Asset symbol + name + class, animated price (count-up), 24h delta pill, OHLC readout when crosshair is active.
- Right-shifted enough on desktop to clear the watchlist rail.

### 4.2 Dock (bottom-center)
- Glass capsule containing chart-type toggle, timeframe scrubber (1h / 4h / 1d / 1w), and tools: Mark, Comment, Range Scope.

### 4.3 Actions (top-right)
- Quick toggles: command palette, overlays panel, reset view.

### 4.4 Command Palette
- `⌘K` or `/` opens a centered glass palette to fuzzy-search assets.
- Shows current price + 24h chg per row.

### 4.5 Overlays panel
- Slide-in from the right with toggles for MA20/MA50/Bollinger and a textarea for pasting a custom series.
- Opens above the AI panel when both are visible.

### 4.6 Hint strip (bottom)
- Tiny keyboard cheat-sheet: `⌘K` search · `D` overlays · `M` mark · `⇧ drag` range · `scroll` zoom.

---

## 5. AI Co-Research Agent

### 5.1 Purpose
Talk with an AI agent that can explore any data, plot it on the current chart, and store the result as a reusable dataset.

### 5.2 Surface
- Pulsing aurora FAB (bottom-right) opens a 440px right-edge panel.
- Header: mode toggle (Research / Strategy), Chat / Library tabs, close button.
- On mobile: panel becomes full-bleed.

### 5.3 Chat
- Aurora-avatar messages from the agent.
- **Animated thinking trace** showing what the AI is literally doing, step-by-step:
  Parsing intent → Pulling OHLCV → Computing metric → Aligning to chart axis → Plotting overlay.
  Each step has a spinner while live, a checkmark when done, a shimmer sweep across the row, and a small detail tag (e.g. `600 bars · 4h`).
- Suggested prompt chips above the composer.
- Composer has paperclip (attach reference data) and send button.

### 5.4 Reference data input
- User can attach reference datasets to the conversation as chips.
- These are usable as context for follow-up requests.

### 5.5 Output: Dataset card
- Returned inline in the thread with a colored swatch, label, source asset, and a `plot` / `on chart` toggle.
- Toggling plots the series on the chart with a glow pass and adds an active chip at top-center.
- Datasets are **permanent reusable assets** stored in the Library tab.

### 5.6 Built-in research presets (keyword-routed)
- 30d realized volatility · Correlation w/ ETH · Momentum z-score · Liquidity pressure · Funding rate proxy.

---

## 6. AI Co-Strategy Agent

### 6.1 Purpose
Talk with an AI agent that researches, develops, and edits custom trading strategies. Strategies are permanent reusable assets.

### 6.2 Surface
- Same panel as Research, switched via mode toggle (violet aurora identity).

### 6.3 Chat
- Animated thinking trace specific to strategy work:
  Decomposing thesis → Selecting indicators → Building rule graph → Backtesting on 600 bars → Rendering signals on chart.
- During thinking, a **strategy workflow visualization** animates in: horizontal flow of nodes (Trigger → Filter → Entry → Exit), each color-coded, edges fade in between them.

### 6.4 Output: Strategy card
- Inline card with name, animated rule graph, and perf stats (WR / SR / DD / N).
- `apply` toggle pushes signals onto the chart.
- AI-only development: user describes thesis or asks for an edit ("tighten stop to 2%"); no manual rule editor.

### 6.5 Chart signal rendering
- **Buy** = upward green triangle below the price; **Sell** = downward red triangle above.
- Dashed connector line between paired buy/sell — green if profitable, red if losing.

### 6.6 Library
- Stores every strategy as a reusable asset. Card shows the rule graph + compact perf and an apply/remove control.

### 6.7 Built-in strategy presets (keyword-routed)
- RSI(14) mean revert · Donchian 20/10 breakout.

---

## 7. Active AI Chip Stack

When an AI overlay or strategy is on the chart, a chip appears top-center:
- Aurora dot · label (with signal count for strategies) · `×` to clear.
- Stacks vertically when both research overlay and strategy are active.

---

## 8. Keyboard Shortcuts

| Key | Action |
|---|---|
| `⌘K` / `/` | Open command palette |
| `D` | Toggle overlays panel |
| `M` | Toggle mark tool |
| `C` | Toggle comment tool |
| `R` | Reset chart view |
| `⇧ + drag` | Range scope on chart |
| `Esc` | Dismiss palette / composer / active tool |

---

## 9. Technical Notes

- React 18.3.1 (UMD) + Babel standalone, modular Babel JSX files imported via `<script type="text/babel">`.
- Each component file exports to `window.*` for cross-script access.
- Styles in a single `app.css`, OKLCH throughout, glass via `backdrop-filter` + hairline borders.
- Procedural OHLC generated with deterministic per-asset RNG so prices stay stable across reloads.
- Heikin Ashi computed from raw candles; SMA/Bollinger computed on close prices; AI series computed from active candles to keep visuals correct.
- Smooth y-range animation via interpolated ref + RAF; animated number component for the headline price.

---

## 10. File Structure

```
autoplot.html       — entry, font + script loads
app.css                   — all styles (cinematic dark glass + AI surfaces)
data.js                   — OHLC generator, asset list, providers, helpers
chart.jsx                 — canvas rendering + interaction (mouse + touch)
chrome.jsx                — Dock, Actions, Palette, OverlaysPanel, MarkComposer
panel.jsx                 — floating Asset Panel + Add modal
agents.jsx                — AI Research + Strategy panel, thinking traces, library
app.jsx                   — App shell, state, wiring
```
