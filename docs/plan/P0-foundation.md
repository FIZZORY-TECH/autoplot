# P0 — Foundation

## Status

**Completed** — landed in session 1 (P0.1 → P0.3). Verified via:
- `npm run lint && npm run typecheck && npm test && cargo test` all green (part of the end-of-chain pass)
- Visual-diff screenshots captured in `docs/visual-diff/P0/`
- `/_/design` preview route renders and matches `app-design/project/Design System.html` side-by-side

The full dispatch record for this phase is retained in the project history.

**Key deviations from original spec:**
- *P0-16/P0-17 design preview:* `/_/design` route added and gated behind `import.meta.env.DEV`; screenshots captured to `docs/visual-diff/P0/` for tail-end review per A6 rather than a blocking per-phase diff (per A6 policy).
- *P0-15 Geist vendoring:* SIL OFL confirmed to allow redistribution; Geist + Geist Mono woff2 vendored under `src/assets/fonts/` with `OFL.txt`; system-font fallback chain (`system-ui`, `ui-monospace`) retained per A5.
- *P0-24 tag:* `v0.0.0-foundation` git tag was not applied (continuous run; user opted out of per-phase checkpoints per A8 policy — no silent skip, but tagging was non-critical).
- *SQLite migration runner (beyond original spec):* `src-tauri/migrations/0001_init.sql` and `_migrations` runner added in P0.3 per A1. Original P0 spec did not list a migration runner; it was resolved in the dispatch plan as a cross-phase necessity.
- *Zustand store skeletons:* `useAppStore`, `useWatchlistStore`, `useLibraryStore`, `useAIStore`, `useSettingsStore` created as empty type stubs per P0.3 dispatch prompt.
- *CSS layout reservation vars:* `--reserve-left: 0px; --reserve-right: 0px;` added to `:root` per A4 in P0.2.

**Hand-off:** P1 — Core Charting (complete; see P1 status block).

---

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context (locked-in decisions, design adoption, CLI capability surface, gaps).

**Inputs:** empty repo (only `app-design/` and `docs/`). No `package.json`, no `src-tauri/`. Locked-in tech decisions from [README §2](./README.md#2-locked-in-tech-decisions).

**Goal:** the project builds, lints, tests, runs `tauri dev`, and renders an empty dark-glass shell with correct typography and design tokens.

## Checklist

- [x] **P0-1** Initialise Tauri + Vite + React + TS project (`npm create tauri-app@latest`). Place under repo root; do NOT touch `app-design/`.
- [x] **P0-2** Install runtime deps: `react@18`, `react-dom@18`, `zustand`, `zod`, `clsx`, `react-error-boundary`.
- [x] **P0-3** Install dev deps: `typescript`, `vite`, `@vitejs/plugin-react`, `eslint`, `@typescript-eslint/*`, `prettier`, `vitest`, `@testing-library/react`, `playwright`.
- [x] **P0-4** Configure ESLint (typescript-eslint recommended) + Prettier. Add `.editorconfig`.
- [x] **P0-5** Configure Vitest with jsdom for React; smoke test `App` renders.
- [x] **P0-6** Configure Playwright skeleton (no tests yet — just runner config).
- [x] **P0-7** Configure Rust side: ensure `cargo test` runs; add `rusqlite` and `tokio` (basic features) ready for later phases (don't implement).

### Design adoption (binding — see [README §2.5](./README.md#25-design-adoption--app-design-is-binding))
- [x] **P0-8** Read `app-design/project/Design System.html` end-to-end. It is the canonical token spec.
- [x] **P0-9** Create `src/styles/tokens.css` — port OKLCH variables, glass tints, hairlines verbatim from `app-design/project/app.css:1-50` AND cross-check against `Design System.html` §01 Color. Where they differ, `Design System.html` wins.
- [x] **P0-10** Port full motion system to `src/styles/tokens.css`: `--ease`, `--ease-spring`, durations `--t-fast` (180ms), `--t-med` (320ms), `--t-slow` (560ms). Cross-checked against `Design System.html` §03 Motion.
- [x] **P0-11** Port radii scale (4, 8, 12, 14, 18, 22, pill) and spacing scale (4, 6, 8, 12, 16, 22, 32, 56) verbatim.
- [x] **P0-12** Port typography ramp (Display 76px mono, H1 28px, H2 16px, Body 13px, Mono readout/meta, Eyebrow). Tabular numerals globally.
- [x] **P0-13** Create `src/styles/glass.css` — `.glass`, `.glass-strong`, `.glass-heavy` utilities; inset highlight + drop shadow combos from `Design System.html` §03 Form (`shadow-glass`).
- [x] **P0-14** Create `src/styles/motion.css` — keyframes for shimmer, aurora, pulse, spring; `prefers-reduced-motion: reduce` overrides cut shimmer/aurora.
- [x] **P0-15** ~~Embed Geist + Geist Mono as **local** fonts~~ — *vendored under SIL OFL with system-font fallback path retained per A5. `OFL.txt` lives at `src/assets/fonts/OFL.txt`.*
- [x] **P0-16** Render a tokens preview page (dev-only route `/_/design`) that shows every token, every glass treatment, every component pattern from `Design System.html` so we can side-by-side it. Removed/gated in production build.
- [x] **P0-17** Visual diff: screenshots captured to `docs/visual-diff/P0/` for tail-end review per A6 (not blocking per-phase).

### App skeleton
- [x] **P0-18** Build a base layout shell: full-bleed `<main>` with dark background; render an "empty" placeholder.
- [x] **P0-19** Skeleton Zustand stores: `useAppStore`, `useWatchlistStore`, `useLibraryStore`, `useAIStore`, `useSettingsStore`. Empty types.
- [x] **P0-20** Wrap app in `<ErrorBoundary>` with a glass-styled fallback.

### Tooling / repo hygiene
- [x] **P0-21** Add `npm scripts`: `dev`, `tauri:dev`, `build`, `lint`, `test`, `test:e2e`, `typecheck`.
- [x] **P0-22** GitHub Actions CI: lint + typecheck + vitest + cargo test on push.
- [x] **P0-23** Write `README.md` with quickstart (Node + Rust + Claude CLI prerequisites).
- [x] **P0-24** Commit baseline. *~Tag `v0.0.0-foundation`~* — tag skipped; continuous run, user opted out of per-phase checkpoints.

## Acceptance

- `npm run tauri:dev` opens a dark window with Geist typography and visibly correct tokens.
- `/_/design` page is visually indistinguishable from `app-design/project/Design System.html`.
- `npm run lint && npm run typecheck && npm test && cargo test` all pass; CI green.

## Risks

- Geist licensing for redistribution — confirm SIL OFL terms.

## Hands off to

[P1 — Core Charting](./P1-core-charting.md).
