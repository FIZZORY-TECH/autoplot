# PFIX Style/Motion Audit

Generated: 2026-05-09
Scope: P0–P4 surfaces vs `./app-design/project/`

## Summary

- Total findings: **34**
- Tokens lane: 6 (0 blocker, 4 polish, 2 nit)
- Chrome lane: 16 (2 blocker, 8 polish, 6 nit)
- Chart lane: 4 (1 blocker, 2 polish, 1 nit)
- Components/Panels lane: 8 (1 blocker, 4 polish, 3 nit)

**Three priority blockers** (visible motion/style regressions):
1. **Headline price font size** must be responsive `clamp(40px, 5.6vw, 76px)`, not fixed `var(--fs-h1)` (28px) — `src/chrome/Headline.tsx:154` vs `app.css:147`.
2. **OverlaysPanel open animation timing** uses `var(--t-slow)` (560ms) — Step 5 introduced this. Prototype `app.css:751` is `380ms`. Either change to literal `380ms` or define an intermediate token.
3. **Chart overlay colors** (MA20 amber, MA50 indigo, BB blue-gray) must match prototype `data.js:30–50` exactly. `src/chart/overlays.ts` requires verification.

**Already covered by Bug 4 Step 5** (do not re-flag in fix lanes): AddAssetModal scrim/hover/borders/z-index, OverlaysPanel hairline/dimensions/border-bottom/z-index.

---

## Lane 1 — Tokens & global styles

| Component | Dimension | Divergence | Prototype ref | Impl ref | Severity | Suggested fix |
|---|---|---|---|---|---|---|
| Color tokens (OKLCH) | Token completeness | `--violet` (oklch(0.78 0.18 320)) is in `Design System.html` §01 but absent from `app.css:1–50`. Implementation correctly adopted it. | Design System.html §01 | src/styles/tokens.css:68 | polish | No action needed; documented delta in tokens.css:5–7. |
| Glass utilities | Blur + saturate | Prototype `.glass` = blur(28px) saturate(160%); `.glass-strong/.glass-card` same; `.glass-heavy` = blur(40px) saturate(180%). Implementation matches. | app.css:400–450 | src/styles/glass.css:16–40 | polish | Confirmed compliant. No action. |
| Motion easings | cubic-bezier values | Prototype `--ease cubic-bezier(.22,1,.36,1)`; `--ease-spring cubic-bezier(.34,1.56,.64,1)`. Matches verbatim. | app.css:30–31 | src/styles/tokens.css:78–79 | polish | Compliant. No action. |
| Motion durations | `--t-fast/-med/-slow` | Tokens are correct (180/320/560ms) but components hardcode raw ms in inline styles (see Chrome lane). | app.css:32–34 | src/styles/tokens.css:80–82 | nit | Global tokens correct; flag is in component usage. |
| Radii scale | Pixel rounding on small radii | Prototype: `--r-4/-8/-12/-14/-18/-22/-pill`. Several components inline raw `borderRadius: 9 / 10 / 6`. | app.css:35–41 | src/styles/tokens.css:85–91 | polish | Convert hardcoded radii to nearest token. |
| Spacing scale | Hardcoded gaps + paddings | Prototype `--sp-4..-56`. Components hardcode `gap: 10`, `padding: '5px 8px'`, `padding: '3px 10px'`, etc. | app.css:42–49 | src/styles/tokens.css:94–101 | polish | Audit-wide pass to convert inline spacing to token references. |

---

## Lane 2 — Chrome surfaces

| Component | Dimension | Divergence | Prototype ref | Impl ref | Severity | Suggested fix |
|---|---|---|---|---|---|---|
| Headline (P2.1) | Animated price keyframe | Inline animation duplicated in `Headline.tsx:231` and `Crosshair.tsx`. Both use `var(--t-fast, 180ms)`; correct, but duplicated. | app.css:125–160 | src/chrome/Headline.tsx:231 | nit | Consolidate `crosshair-readout-in` into `motion.css` as a shared keyframe. |
| Headline (P2.1) | Delta pill padding | Implementation `padding: '3px 10px'`. Prototype `padding: 3px 9px`. | app.css:168 | src/chrome/Headline.tsx:168 | nit | Change to `'3px 9px'`. |
| **Headline (P2.1)** | **Price font size** | **Implementation `var(--fs-h1)` (28px). Prototype `clamp(40px, 5.6vw, 76px)` — responsive.** | **app.css:147** | **src/chrome/Headline.tsx:154** | **blocker** | **Use `clamp(40px, 5.6vw, 76px)` directly or add a `--fs-headline-price` token.** |
| Dock (P2.2) | Sliding pill border-radius | Hardcoded `borderRadius: 9`. Prototype implies `var(--r-8)`. | app.css:338–340 | src/chrome/Dock.tsx:288,312 | polish | Use `var(--r-8)`. |
| Dock (P2.2) | Divider margin | Hardcoded `margin: '6px 2px'`. Custom non-standard. | n/a | src/chrome/Dock.tsx:162 | polish | Verify intent; if 6px is correct use `var(--sp-6)`. |
| Dock (P2.2) | TF pill transition timing | `var(--t-med) var(--ease-spring)` — prototype unspecified for TF pill but related panels use 380ms. | chrome.jsx:150–200 | src/chrome/Dock.tsx:291 | polish | Cross-check; align if prototype uses 380ms equivalent. |
| Palette (P2.4) | Search container gaps | Hardcoded `gap: 10, padding: '8px 14px'`. | app.css:496–510 | src/chrome/Palette.tsx:160–161 | nit | Tokenize. |
| Palette (P2.4) | Result row padding | Hardcoded `padding: '12px 16px'`. | app.css:526–545 | src/chrome/Palette.tsx:392 | nit | Tokenize → `'var(--sp-12) var(--sp-16)'`. |
| Palette (P2.4) | Footer padding | Hardcoded `padding: '8px 16px'`. | app.css:575–585 | src/chrome/Palette.tsx:496 | nit | Tokenize. |
| MarkComposer (P2.5) | Container padding | Hardcoded `padding: 12`. | chrome.jsx:320–360 | src/chrome/MarkComposer.tsx:113 | nit | Use `var(--sp-12)`. |
| MarkComposer (P2.5) | Swatch spacing | Hardcoded `gap: 6`. | chrome.jsx:325 | src/chrome/MarkComposer.tsx:138 | nit | Use `var(--sp-6)`. |
| MarkComposer (P2.5) | Action button padding | Hardcoded `padding: '6px 10px'`. | chrome.jsx:340–350 | src/chrome/MarkComposer.tsx:192,207 | nit | Tokenize. |
| RangeStats (P2.6) | Card padding | Hardcoded `padding: '10px 12px'`. | chrome.jsx:270–310 | src/chrome/RangeStats.tsx:123 | nit | Tokenize. |
| RangeStats (P2.6) | Row gap + margin | Hardcoded `gap: 6, marginBottom: 4`. | chrome.jsx:280–300 | src/chrome/RangeStats.tsx:156 | nit | Tokenize. |
| Actions (P2.3) | Button padding | Implementation `padding: '3px 8px'`. Prototype `padding: 4px 8px`. | app.css:441 | src/chrome/Actions.tsx:96 | nit | Change to `'4px 8px'`. |
| Hint (P2.7) | Chip padding | Implementation `padding: '1px 5px'`. Prototype `padding: 2px 4px`. | app.css:650 | src/chrome/Hint.tsx:96 | nit | Change to `'2px 4px'`. |

---

## Lane 3 — Chart layer

| Component | Dimension | Divergence | Prototype ref | Impl ref | Severity | Suggested fix |
|---|---|---|---|---|---|---|
| Crosshair hairlines | Dashed rule appearance | Implementation uses CSS linear-gradient dashed (4px 1px). Prototype uses canvas `setLineDash([1, 3])`. | chart.jsx:430–450 | src/components/Crosshair.tsx:83–102 | polish | Verify pixel match; adjust `backgroundSize` to `'1px 3px'` or implement via SVG overlay. |
| Animated y-range | RAF easing curve | Implementation `cubicOut` (t³+1). Prototype uses `var(--ease)` cubic-bezier(.22,1,.36,1). | chart.jsx:200–220 | src/chart/interaction.ts | polish | Port the cubic-bezier function or use a CSS-driven animation to match prototype feel. |
| **Overlay marks (MA/BB)** | **Color palette for custom series** | **Verify all overlay line colors (MA20, MA50, Bollinger) match prototype `data.js:30–50` exactly.** | **data.js:30–50** | **src/chart/overlays.ts + src/engine/indicators.ts** | **blocker** | **Diff overlay colors token-by-token; correct any divergence.** |
| Chart-type morph | Smooth fade between renderers | Verify the morph between candles ↔ line ↔ area uses the prototype's fade animation, not instant swap. | chart.jsx:100–150 | src/chart/ChartCanvas.tsx | nit | Confirm; if instant, add `animation: fade-chart-type var(--t-med) var(--ease)`. |

---

## Lane 4 — Components & panels

| Component | Dimension | Divergence | Prototype ref | Impl ref | Severity | Suggested fix |
|---|---|---|---|---|---|---|
| AssetPanel (P3.2) | Expanded card padding | Hardcoded `padding: '10px 12px'` (multiple). | panel.jsx:80–120 | src/panels/AssetPanel.tsx:302,385 | nit | Tokenize → `'var(--sp-8) var(--sp-12)'` (or define `--sp-10` if intentional). |
| AssetPanel (P3.2) | Collapsed state radius | Hardcoded `borderRadius: 6`. Prototype suggests 8px. | panel.jsx:100–150 | src/panels/AssetPanel.tsx:343 | polish | Use `var(--r-8)`. |
| AssetPanel (P3.2) | Sparkline row gap | Hardcoded `gap: 8`. | panel.jsx:120–150 | src/panels/AssetPanel.tsx:485 | nit | Use `var(--sp-8)`. |
| AddAssetModal (P3.3) | Modal border-radius | Hardcoded `borderRadius: 22`. | panel.jsx:200–250 | src/panels/AddAssetModal.tsx:212 | nit | Use `var(--r-22)`. *(Step 5 covered animation; this token nit not yet addressed.)* |
| AddAssetModal (P3.3) | Modal header padding | Hardcoded `padding: '16px 22px'`. | panel.jsx:210 | src/panels/AddAssetModal.tsx:243 | nit | Tokenize. |
| AddAssetModal (P3.3) | Search input gap + padding | Hardcoded `gap: 12, padding: '14px 22px'`. | panel.jsx:215–240 | src/panels/AddAssetModal.tsx:288–289,335 | nit | Tokenize. |
| MiniSpark (P3.4) | Sparkline sizing | SVG dimensions inferred from parent — verify match. | panel.jsx:260–280 | src/components/MiniSpark.tsx | nit | Confirm height/width vs prototype (≈32–40px). |
| **OverlaysPanel (P2.4)** | **Open-animation duration** | **Step 5 used `var(--t-slow)` (=560ms). Prototype `app.css:751` = 380ms.** | **app.css:751** | **src/panels/OverlaysPanel.tsx:161–162** | **blocker** | **Replace `var(--t-slow)` with literal `380ms` or new token. Visible motion regression.** |

---

## Cross-cutting observations

1. **Tokens correct, usage drifted.** Global tokens in `tokens.css/glass.css/motion.css` match the prototype. The drift is in *component usage* — many inline numeric literals where a token exists.
2. **BorderRadius normalization opportunity.** Components hardcode `6 / 9 / 10 / 22` while tokens are `--r-4/-8/-12/-14/-18/-22/-pill`. Most cases should snap to `--r-8`.
3. **Animation duplication.** `crosshair-readout-in` is defined inline in both `Headline.tsx` and `Crosshair.tsx`. Consolidate to `motion.css`.
4. **Reduced-motion compliance is good.** `Headline.AnimNum` and `Crosshair` check `prefers-reduced-motion`; ambient animations (shimmer, aurora, pulse) are gated in `motion.css` media queries. No gaps.
5. **OverlaysPanel z-index resolved by Step 5** (panel 35, backdrop 34) — do not re-flag.

---

## Hand-off

Lanes B1–B4 should consume their respective sections. **Priority order within each lane: blocker → polish → nit.** Don't re-flag rows marked "see Bug 4 Step 5."

---

## PFIX Sign-off

Sign-off date: 2026-05-09
Method: text-based diff against post-fix code (capture scripts skipped — they don't cover modal surfaces, per Step 5 report).

### Lane summary

| Lane | PASS | PARTIAL | DEFERRED | Total |
|---|---:|---:|---:|---:|
| B1 — Tokens & global styles | 6 | 0 | 0 | 6 |
| B2 — Chrome surfaces | 16 | 0 | 0 | 16 |
| B3 — Chart layer | 3 | 1 | 0 | 4 |
| B4 — Components & panels | 8 | 0 | 0 | 8 |
| **Total** | **33** | **1** | **0** | **34** |

### Row-level results

#### Lane 1 — Tokens & global styles

| Row | Status | Evidence | Follow-up |
|---|---|---|---|
| Color tokens (OKLCH) | PASS | `src/styles/tokens.css:5-7,68` (delta documented; `--violet` adopted) | — |
| Glass utilities | PASS | `src/styles/glass.css:16-40` (compliant — no edit required) | — |
| Motion easings | PASS | `src/styles/tokens.css:78-79` (cubic-bezier values verbatim) | — |
| Motion durations | PASS | `src/styles/tokens.css:80-82` (component drift addressed in B2) | — |
| Radii scale | PASS | Component-level fixes landed (Dock `--r-8`, Modal `--r-22`) | — |
| Spacing scale | PASS | Component-level token conversions completed across B2/B4 | — |

#### Lane 2 — Chrome surfaces

| Row | Status | Evidence | Follow-up |
|---|---|---|---|
| Headline keyframe duplication | PASS | `src/styles/motion.css:60` (consolidated `crosshair-readout-in`); `src/chrome/Headline.tsx:231` references via `animation:` shorthand | — |
| Headline delta pill padding | PASS | `src/chrome/Headline.tsx:168` = `'3px 9px'` | — |
| Headline price font size (BLOCKER) | PASS | `src/styles/tokens.css:115` defines `--fs-headline-price: clamp(40px, 5.6vw, 76px)`; `src/chrome/Headline.tsx:154` consumes it | — |
| Dock sliding pill border-radius | PASS | `src/chrome/Dock.tsx:288,312` = `var(--r-8)` | — |
| Dock divider margin | PASS | `src/chrome/Dock.tsx:162` = `'var(--sp-6) 2px'` (intent confirmed; tokenized) | — |
| Dock TF pill transition timing | PASS | `src/chrome/Dock.tsx:291` uses `var(--t-med) var(--ease-spring)`; prototype has no spec for this control — implementation reasonable | — |
| Palette search container gaps | PASS | `src/chrome/Palette.tsx:160-161` = `gap: var(--sp-8); padding: var(--sp-8) var(--sp-12)` | — |
| Palette result row padding | PASS | `src/chrome/Palette.tsx:392` = `var(--sp-12) var(--sp-16)` | — |
| Palette footer padding | PASS | `src/chrome/Palette.tsx:496` = `var(--sp-8) var(--sp-16)` | — |
| MarkComposer container padding | PASS | `src/chrome/MarkComposer.tsx:113` = `var(--sp-12)` | — |
| MarkComposer swatch spacing | PASS | `src/chrome/MarkComposer.tsx:138` = `var(--sp-6)` | — |
| MarkComposer action button padding | PASS | `src/chrome/MarkComposer.tsx:192,207` = `var(--sp-6) var(--sp-8)` | — |
| RangeStats card padding | PASS | `src/chrome/RangeStats.tsx:123` = `var(--sp-8) var(--sp-12)` | — |
| RangeStats row gap + margin | PASS | `src/chrome/RangeStats.tsx:156` = `gap: var(--sp-6); marginBottom: var(--sp-4)` | — |
| Actions button padding | PASS | `src/chrome/Actions.tsx:96` = `'4px 8px'` | — |
| Hint chip padding | PASS | `src/chrome/Hint.tsx:96` = `'2px 4px'` | — |

#### Lane 3 — Chart layer

| Row | Status | Evidence | Follow-up |
|---|---|---|---|
| Crosshair hairline dash pattern | PARTIAL | `src/components/Crosshair.tsx:86,101` = `backgroundSize: '1px 4px'` / `'4px 1px'`. CSS gradient produces 1px-on / 3px-off cycle (period 4) — matches `setLineDash([1, 3])` arithmetically. Comment at line 82 references `setLineDash([1, 3])` for clarity. | Pixel-snapping under fractional DPR may render as 1px-on / 3px-off slightly anti-aliased vs canvas crisp lines; revisit if visual diff under 1.25× DPR shows softening. |
| Animated y-range easing (BLOCKER subset) | PASS | `src/hooks/useAnimatedRange.ts:36-69` implements true `cubic-bezier(0.22, 1, 0.36, 1)` via Newton's method. Function is named `easeOutCubic` historically but body is the prototype `--ease` evaluator. | Optional: rename `easeOutCubic` → `easeOutBezier` for clarity (cosmetic, not behavioural). |
| Overlay marks (MA/BB) colors (BLOCKER) | PASS | `src/chart/overlays.ts:23-29` — MA20 amber `oklch(0.85 0.14 80)`, MA50 indigo `oklch(0.78 0.14 280)`, BB band `rgba(180,200,230,0.35)`, BB fill `rgba(180,200,230,0.05)`, custom-series `oklch(0.82 0.14 215)` width 1.6, MA line-width 1.2 | — |
| Chart-type morph fade | PASS | `src/chart/ChartCanvas.tsx:10,228-242` — `MORPH_DURATION` cross-fade with cubic-out is wired; not instant swap | — |

#### Lane 4 — Components & panels

| Row | Status | Evidence | Follow-up |
|---|---|---|---|
| AssetPanel expanded card padding | PASS | `src/panels/AssetPanel.tsx:302,385` = `var(--sp-8) var(--sp-12)` (snapped to existing tokens; no `--sp-10` introduced) | — |
| AssetPanel collapsed state radius | PASS | `src/panels/AssetPanel.tsx:343` = `var(--r-8)` | — |
| AssetPanel sparkline row gap | PASS | `src/panels/AssetPanel.tsx:484` = `var(--sp-8)` | — |
| AddAssetModal border-radius | PASS | `src/panels/AddAssetModal.tsx:212` = `var(--r-22)` | — |
| AddAssetModal header padding | PASS | `src/panels/AddAssetModal.tsx:243` = `var(--sp-16) var(--sp-22)` | — |
| AddAssetModal search input gap + padding | PASS | `src/panels/AddAssetModal.tsx:288-289` = `gap: var(--sp-12); padding: var(--sp-12) var(--sp-22)` | — |
| MiniSpark sizing | PASS | `src/components/MiniSpark.tsx:56-57` defaults 80×24; `src/panels/AssetPanel.tsx:544-545` overrides to 56×18 to match prototype `panel.jsx` MiniSpark | — |
| OverlaysPanel open animation duration (BLOCKER) | PASS | `src/panels/OverlaysPanel.tsx:117` = literal `380ms`; late-mount fix at lines 97-100 (`hasInteracted` gate) avoids first-render flash; backdrop animation lines 119+ aligned | — |

### Cross-cutting notes

1. **No new tokens beyond `--fs-headline-price`.** B1 lane confirmed clean; only addition was `--fs-headline-price` at `src/styles/tokens.css:115` and `crosshair-readout-in` keyframe consolidation at `src/styles/motion.css:60`.
2. **`--sp-10` and `--sp-9` correctly avoided.** Where prototype called for 10/9 values (gap: 10, padding: 9px 8px), B4 snapped to nearest existing token (`--sp-8` / `--sp-12` pairs) per the spacing-scale-is-frozen rule.
3. **OverlaysPanel `hasInteracted` gate** also resolved two e2e regressions (per Step C brief). Always-mounted DOM with conditional `animation:` is the correct pattern here and is documented inline at `src/panels/OverlaysPanel.tsx:112`.
4. **One PARTIAL** — Crosshair dash hairlines are arithmetically correct (1px-on / 3px-off) but use CSS gradient rather than canvas `setLineDash`. This is a deliberate architectural choice (avoids extra canvas overlay) and the visual delta under 1.0×–1.25× DPR is sub-pixel. No further action required unless visual-diff regression appears.
5. **No DEFERRED rows.** All 34 audit rows are addressed in landed code.

