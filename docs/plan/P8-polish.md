# P8 — Polish, Performance, A11y

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Feature-complete app from [P7](./P7-strategy-agent.md).

**Goal:** the app feels production-grade: smooth, keyboard-friendly, accessible, performant.

## Checklist

### Animation pass
- [ ] **P8-1** Audit all transitions match prototype timings (`--t-fast/med/slow`, `--ease`, `--ease-spring`).
- [ ] **P8-2** Aurora + shimmer for AI thinking states (verify in dark + matches violet for strategy / cyan for research).
- [ ] **P8-3** Active asset switch — y-range animation feels right at all timeframes.

### Reduced motion (G-16)
- [ ] **P8-4** `prefers-reduced-motion: reduce` cuts shimmer, aurora, count-up animation; replaces with instant transitions.

### Keyboard parity
- [ ] **P8-5** Every icon-only button has a tooltip + ARIA label.
- [ ] **P8-6** Tab order through dock → actions → panels → composer.
- [ ] **P8-7** Focus rings visible on dark glass (use `outline-color: oklch(0.82 0.14 215)`).

### Performance
- [ ] **P8-8** Profile chart at 600 bars + 3 overlays + 20 signals. Target 60fps on M1.
- [ ] **P8-9** If <60fps, options: OffscreenCanvas + worker, batch overlay computations, drop animation frames during pan.
- [ ] **P8-10** Memory profile — no leaks across 1000 asset switches.

### Empty / error UX (G-13, G-15)
- [ ] **P8-11** First-run hint card on empty watchlist.
- [ ] **P8-12** Empty Library tab states.
- [ ] **P8-13** Toast component with severity levels (info/warn/error).
- [ ] **P8-14** Network offline banner.

### Logging (G-17)
- [ ] **P8-15** Rotating log file in Tauri app data dir (`~/Library/Application Support/...`).
- [ ] **P8-16** Log levels: error / warn / info / debug.
- [ ] **P8-17** Capture: market provider errors, AI subprocess errors, SQLite errors. Strip prompts/PII from logs by default.

### Library quotas (G-7)
- [ ] **P8-18** Soft cap on Library entries (e.g., 200 datasets, 100 strategies). Show warning at 80%.

### Accessibility audit
- [ ] **P8-19** Run axe / Tauri Pa11y (or manual VoiceOver pass on macOS) — fix critical findings.

### Full design-adoption audit (per [README §2.5](./README.md#25-design-adoption--app-design-is-binding))
- [ ] **P8-20** Side-by-side visual diff for every screen vs prototype rendered locally. Document any deltas; fix or surface as approved-deviation.
- [ ] **P8-21** Audit new surfaces (Settings panel, MCP/Skills/Hooks tabs, slash-command palette, first-run gate) against [README §2.7](./README.md#27-new-surfaces-beyond-the-prototype) design rules: same tokens, same glass treatments, same easings.
- [ ] **P8-22** Animation timing audit: every animation duration matches prototype (within ±20ms tolerance); easings exact match.

## Acceptance

60fps profile screencap on M1; reduced-motion honored; keyboard tour works end-to-end; full visual diff approved by user; tagged release-candidate.

## Hands off to

[P9 — Packaging & Release](./P9-release.md).
