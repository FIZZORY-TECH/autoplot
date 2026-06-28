# Pine Script & NL → Chart Indicator

description: Convert a user's Pine Script (TradingView) OR a plain-language indicator request into an autoplot research overlay by orchestrating the live MCP tools — detect the input, map the convertible subset, choose the right pane, emit a recipe field, and apply the overlay (persist-on-apply is automatic). Invoke whenever the user pastes Pine Script or asks for a moving average / RSI / Bollinger / band / oscillator on the chart.

---

This skill teaches you to turn what a user describes — either a TradingView **Pine Script** they paste, or a **natural-language** ("plain English") request — into a chart indicator that renders on the autoplot chart. You do this by orchestrating the existing `mcp__autoplot__*` tools. You never compute indicator math yourself: the engine lives in the frontend TS and is the single source of truth. Read the `autoplot-onboarding` skill first if you have not — it defines the full tool surface, consent semantics, and the paper-trading guardrail. This skill is the focused playbook for the convert-an-indicator task.

---

## Step 0 — Detect: Pine branch or NL branch

Look at the user's text.

**Pine branch** — treat it as Pine Script if it contains any of these tokens:

```
indicator(    study(    plot(    ta.    input(    hline(    overlay=
```

(`study(` is the legacy spelling of `indicator(`; treat them the same.)

**NL branch** — otherwise treat it as a natural-language request (e.g. "add a 50-day moving average", "show me RSI", "put Bollinger bands on this").

Set the overlay's `source` field accordingly at the end: `source: 'pine'` for the Pine branch, `source: 'nl'` for the NL branch. This drives a provenance badge in the legend, so always set it.

---

## Step 1 — Orchestration order (both branches)

Always run the tools in this order. The CLI lazy-loads MCP tool schemas; the research-overlay tools may need fetching first:

```
ToolSearch select:apply_research_overlay,load_research_overlay,list_research_overlays,delete_research_overlay
```

1. `get_current_symbol` — returns the symbol on the chart now (e.g. `BTC-USD`). Use it as the overlay's `sym` unless the user named a different symbol.
2. `get_visible_range` — returns `{ start, end, timeframe }`. Use its `timeframe` as the overlay's `tf` and to understand the window the user is looking at.
3. For **each** series the script/request needs: `compute_indicator { sym, tf, kind, params }` — returns `{ values, align }`. The math runs in the engine; you only assemble the result.
4. Assemble a single `ResearchOverlay` object whose `elements[]` holds the computed series **and** a top-level `recipe` field (see Step 5). The `recipe` is the machine-readable indicator spec; the frontend uses it to persist and later recompute the overlay automatically.
5. `apply_research_overlay` with that overlay object to render it. **One consent, one step** — applying the overlay also persists it automatically in the Research Library. Do NOT separately call `save_research_overlay`; that call is no longer part of this workflow.

**One-consent model:** `apply_research_overlay` is the single mutating call in this flow. The frontend hooks that call into `save_research_overlay` internally after a successful apply — the user sees one MCP consent prompt, not two. Never call `save_research_overlay` explicitly from this skill.

---

## Step 2 — compute_indicator: the only valid `kind` values

`compute_indicator` accepts `{ sym, tf, kind, params?, count? }`. `kind` MUST be one of these **15** built-ins — there are no others. Do **not** invent kinds:

```
close   open   high   low   volume
sma   ema   rsi   atr
bollinger_upper   bollinger_middle   bollinger_lower
donchian_high   donchian_low
realized_vol
```

Note the exact spelling: **`donchian_high` / `donchian_low`** (NOT `donchian_upper`/`donchian_lower`). Pass the period/length as `params`, e.g. `params: { period: 14 }`. `compute_indicator` returns `{ values: (number|null)[], align: 'right' | 'index' }`; cold-start positions are `null` (not padded). Copy the returned `values` and `align` straight onto your overlay element — do not re-derive them.

---

## Step 3 — The convertible-subset mapping table

This is the full set of Pine constructs you can convert. Anything not here is unsupported (see Step 6).

| Pine construct | autoplot mapping |
|---|---|
| `ta.sma(close, N)` | `compute_indicator { kind: 'sma', params: { period: N } }` → one `line` element |
| `ta.ema(close, N)` | `compute_indicator { kind: 'ema', params: { period: N } }` → one `line` element |
| `ta.rsi(close, N)` | `compute_indicator { kind: 'rsi', params: { period: N } }` → one `line` element, `pane: 'series'` |
| `ta.atr(N)` | `compute_indicator { kind: 'atr', params: { period: N } }` → one `line` element, `pane: 'series'` |
| Bollinger: `ta.sma(close,N)` ± `mult * ta.stdev(close,N)` | `bollinger_upper` + `bollinger_lower` → one `band` element; `bollinger_middle` → one `line` element (all `pane: 'price'`) |
| Donchian: `ta.highest(high,N)` / `ta.lowest(low,N)` | `donchian_high` + `donchian_low` → one `band` element (or two `line` elements) on `pane: 'price'` |
| `plot(series, ...)` | one `line` element holding that series |
| `indicator(..., overlay=true)` | element `pane: 'price'` (omit `pane`) |
| `indicator(..., overlay=false)` | element `pane: 'series'` (sub-pane) |
| `input(14, "Period")` / `input.int(14, ...)` | extract the default `14` into `params: { period: 14 }` |
| `color=color.red` / `color=#ff0000` in `plot()` | element `color: '#ff0000'` |
| `linewidth=2` in `plot()` | element `width: 2` |
| `hline(70)` / `hline(30)` | one `hline` element each, `price: 70` / `price: 30` |

---

## Step 4 — The pane rule (where does it render?)

Every `line` / `band` / `hline` element may carry an optional `pane` field: `'price'` or `'series'`. The rule:

- **`pane: 'price'`** (or just **omit `pane`** — it defaults to price and is backward-compatible): use this when `overlay=true`, OR when the indicator lives on the price scale — SMA, EMA, Bollinger bands, Donchian channel. These ride directly on the candles.
- **`pane: 'series'`**: use this when `overlay=false`, OR when the indicator is an **oscillator** that has its own scale — RSI (0–100), ATR, anything unbounded-around-zero or 0–100. These render in the stacked sub-pane below the price chart.

For SMA/EMA/Bollinger/Donchian, prefer to omit `pane` entirely — that is the exact, backward-compatible price-axis behavior. Only set `pane: 'series'` for genuine oscillators.

**Single sub-pane limit.** Only ONE oscillator sub-pane is wired. If a script or request needs two oscillators at once (e.g. RSI + a stochastic), do not try to render both — say so plainly and ask the user to pick one:

> "I can show one oscillator sub-pane at a time. Want RSI, or the other one?"

When an oscillator has guide lines (`hline(70)`, `hline(30)` for RSI), put those `hline` elements on the **same** `pane: 'series'` so the guides ride the same sub-pane as the oscillator line — not the price pane.

---

## Step 5 — Element & overlay shapes (exact payloads)

Elements are a discriminated union on the `type` field. The ones you will assemble:

```jsonc
// line — a single polyline
{ "type": "line", "values": [/* from compute_indicator */], "align": "right",
  "color": "#e6b450", "width": 2, "pane": "price" }   // omit pane for price axis

// band — shaded region between two series (Bollinger / Donchian)
{ "type": "band", "upper": [/* upper values */], "lower": [/* lower values */],
  "align": "right", "color": "#5b8def", "opacity": 0.15, "pane": "price" }

// hline — a full-width horizontal price line (RSI 70/30 guides, etc.)
{ "type": "hline", "price": 70, "label": "Overbought", "color": "#8a8f98",
  "dash": "4 4", "pane": "series" }
```

Field notes: `align` is REQUIRED on `line` and `band` (use whatever `compute_indicator` returned, normally `"right"`). `hline` uses `price` (a number), NOT `value`. `color`/`width`/`dash`/`opacity` are optional. `pane` is optional; absent ⇒ `'price'`.

The overlay wraps them. Always include the top-level `recipe` field alongside `elements`:

```jsonc
{
  "id": "rsi-14",                 // stable, kebab-ish; used as React + store key
  "sym": "BTC-USD",              // from get_current_symbol
  "tf": "1d",                    // from get_visible_range.timeframe
  "label": "RSI(14)",           // shown in the legend — use canonical form: RSI(14), SMA(50), BB(20,2)
  "source": "pine",             // 'pine' | 'nl' — drives the provenance badge
  "recipe": {                   // machine-readable spec; frontend uses this to persist + recompute
    "source": "pine",           // same value as top-level source
    "series": [
      { "kind": "rsi", "params": { "period": 14 }, "pane": "series" }
    ]
  },
  "elements": [ /* up to 50 */ ]
}
```

**Auto-label convention:** always use the canonical compact form — `RSI(14)`, `SMA(50)`, `EMA(20)`, `ATR(14)`, `BB(20,2)` for Bollinger, `DC(20)` for Donchian. Match the script's actual parameter values, not defaults.

`apply_research_overlay` takes this overlay object **directly as the payload** (not wrapped in `{ overlay: ... }`). `load_research_overlay` takes `{ id }`. Do NOT call `save_research_overlay` — persist-on-apply is automatic.

---

## Step 6 — Unsupported constructs (never fabricate)

These `ta.*` functions have NO built-in equivalent. Do NOT approximate them with hand-rolled math — name them explicitly and offer a supported alternative:

- `ta.macd` — not convertible. Offer EMA crossover (two `ema` lines) as the nearest supported study.
- `ta.stoch` — not convertible. Offer RSI as the available oscillator.
- `ta.vwap` — not convertible. Offer SMA/EMA as a price-trend overlay.
- `ta.wma` — not convertible. Offer SMA or EMA.

Other Pine constructs that are out of scope: `plotshape()`, `plotchar()`, `bgcolor()`, `security()` / `request.security()`, `strategy.*` order calls, multi-symbol logic, and any custom `for`/`while` series math. These cannot be expressed as a research overlay.

**Graceful partial conversion.** When a script mixes convertible and unconvertible constructs (e.g. a `plot(ta.sma(...))` alongside a `plotshape()` and a `security()` call), convert what you CAN, render it, and then tell the user clearly what was left out and why. Never silently drop pieces, and never fabricate the missing math. Example:

> "I plotted your 20-period SMA. I left out the `plotshape()` buy arrows and the `security()` higher-timeframe pull — those aren't expressible as a chart overlay here. Want the SMA alone, or should I describe an alternative for the arrows?"

---

## Step 7 — Caveats you MUST tell the user

- **Static snapshot, value cap 500.** Overlay value arrays cap at 500 points; `compute_indicator` clamps its window to 500. Beyond 500 visible bars the study is a STATIC snapshot of the most-recent 500-bar window — it does NOT tick-update and does not extend across the full history. If the user is zoomed out past ~500 bars, say so: the overlay covers only the most recent window.
- **No live updates.** Research overlays are computed once at apply time. They don't follow new bars. To refresh, recompute and re-apply.

---

## Step 8 — Consent-denied recovery (`-32006`)

`apply_research_overlay` is a mutation and may prompt the user for consent (unless `mcp.autoApprove = always`). If it returns MCP error code **`-32006`** (user denied consent, or the 60-second prompt timed out):

- Explain in plain language: the overlay was NOT applied because consent was declined.
- Offer to retry, or to adjust the `mcp.autoApprove` setting.
- NEVER auto-retry and NEVER hang waiting. Stop and hand control back to the user.

Note: `save_research_overlay` is NOT called by this skill — persist-on-apply is handled automatically by the frontend after a successful `apply_research_overlay`. There is only one consent prompt per indicator application.

---

## Worked scenarios

### A. Pine RSI → sub-pane

User pastes:

```pine
indicator("RSI", overlay=false)
length = input(14, "Length")
r = ta.rsi(close, length)
plot(r, color=color.purple, linewidth=2)
hline(70, "Overbought")
hline(30, "Oversold")
```

Detect Pine (`indicator(`, `ta.`, `input(`, `plot(`, `hline(`). `overlay=false` + RSI ⇒ sub-pane. Extract `length = 14`. Steps:

1. `get_current_symbol` → `BTC-USD`; `get_visible_range` → tf `1d`.
2. `compute_indicator { sym: "BTC-USD", tf: "1d", kind: "rsi", params: { period: 14 } }` → `{ values, align }`.
3. `apply_research_overlay`:

```jsonc
{
  "id": "rsi-14", "sym": "BTC-USD", "tf": "1d", "label": "RSI(14)", "source": "pine",
  "recipe": {
    "source": "pine",
    "series": [
      { "kind": "rsi", "params": { "period": 14 }, "pane": "series", "color": "#a855f7", "width": 2 }
    ]
  },
  "elements": [
    { "type": "line", "values": [/* … */], "align": "right", "color": "#a855f7", "width": 2, "pane": "series" },
    { "type": "hline", "price": 70, "label": "Overbought", "pane": "series", "dash": "4 4" },
    { "type": "hline", "price": 30, "label": "Oversold",   "pane": "series", "dash": "4 4" }
  ]
}
```

Note the `hline`s share `pane: 'series'` so the guides sit in the RSI sub-pane, not on price. The `recipe` captures the spec for automatic persist-on-apply — no separate save call needed.

### B. NL "add a 50-day moving average" → SMA price overlay

Detect NL. SMA is a price-scale study ⇒ price pane (omit `pane`). Steps:

1. `get_current_symbol` → `ETH-USD`; `get_visible_range` → tf `1d`.
2. `compute_indicator { sym: "ETH-USD", tf: "1d", kind: "sma", params: { period: 50 } }`.
3. `apply_research_overlay`:

```jsonc
{
  "id": "sma-50", "sym": "ETH-USD", "tf": "1d", "label": "SMA(50)", "source": "nl",
  "recipe": {
    "source": "nl",
    "series": [
      { "kind": "sma", "params": { "period": 50 }, "color": "#e6b450", "width": 2 }
    ]
  },
  "elements": [
    { "type": "line", "values": [/* … */], "align": "right", "color": "#e6b450", "width": 2 }
  ]
}
```

`source: 'nl'` because the request was plain language. Mention the 500-bar snapshot caveat if the user is zoomed far out.

### C. 3-plot Bollinger → ONE band + middle line

User pastes the canonical Bollinger script:

```pine
indicator("BB", overlay=true)
length = input(20, "Length")
mult   = input(2.0, "Mult")
basis  = ta.sma(close, length)
dev    = mult * ta.stdev(close, length)
plot(basis,       color=color.orange)
plot(basis + dev, color=color.blue)
plot(basis - dev, color=color.blue)
```

The three `plot()` calls (basis, basis+dev, basis−dev) collapse into ONE `band` element (upper+lower) plus one `line` element (the middle). `overlay=true` ⇒ price pane. Steps:

1. `get_current_symbol` + `get_visible_range`.
2. Three computes: `kind: "bollinger_upper"`, `kind: "bollinger_lower"`, `kind: "bollinger_middle"`, each with `params: { period: 20, k: 2 }` (the multiplier key is **`k`**, not `mult` — e.g. `params: { period: 20, k: 2 }`; defaults to k=2 if omitted).
3. `apply_research_overlay`:

```jsonc
{
  "id": "bb-20", "sym": "BTC-USD", "tf": "1d", "label": "BB(20,2)", "source": "pine",
  "recipe": {
    "source": "pine",
    "series": [
      { "kind": "bollinger", "params": { "period": 20, "k": 2 }, "color": "#5b8def" }
    ]
  },
  "elements": [
    { "type": "band", "upper": [/* bollinger_upper */], "lower": [/* bollinger_lower */],
      "align": "right", "color": "#5b8def", "opacity": 0.15 },
    { "type": "line", "values": [/* bollinger_middle */], "align": "right", "color": "#e6b450" }
  ]
}
```

One band, one middle line — do NOT emit three separate lines. The `recipe.series` uses the `'bollinger'` logical alias (not three separate `bollinger_upper/middle/lower` entries) since the frontend recompute helper handles the fan-out.

### D. Partial conversion (convertible + unconvertible mixed)

User pastes:

```pine
indicator("Mixed", overlay=true)
plot(ta.sma(close, 20), color=color.orange)
plotshape(ta.crossover(close, ta.sma(close,20)), style=shape.triangleup)
src = request.security(syminfo.tickerid, "D", close)
```

Detect Pine. Convert the `ta.sma(close, 20)` → one `line` element on price. The `plotshape()` and `request.security()` are out of scope. Steps:

1. compute SMA(20); `apply_research_overlay` with the single line, `source: 'pine'`, and a `recipe` with `{ kind: 'sma', params: { period: 20 } }`.
2. Tell the user plainly:

> "I plotted your SMA(20). I couldn't convert the `plotshape()` crossover arrows or the `request.security()` higher-timeframe pull — those aren't expressible as a chart overlay here. The SMA is a static snapshot of the most recent 500 bars and won't tick-update."

No silent drops, no fabricated math.
