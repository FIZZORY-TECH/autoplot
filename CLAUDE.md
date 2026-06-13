# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Tauri desktop app — a "cinematic dark-glass" trading research workspace. React + TypeScript frontend, Rust backend, real public crypto data (Coinbase / Binance / Kraken), with a Claude CLI subprocess as the AI co-research/strategy agent. Research and paper trading only — never places real orders.

## Commands

<!-- doctest:cmd:start -->
| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server only (no Rust). The browser-only path falls back to mock data when `__TAURI__` runtime isn't available. |
| `npm run tauri:dev` | Full Tauri dev mode (frontend + Rust). First run compiles Rust — slow; later runs are incremental. |
| `npm run build` | `tsc && vite build` (frontend production build) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `.ts`/`.tsx` |
| `npm test` | Vitest unit tests (jsdom env, files matching `src/**/*.test.{ts,tsx}`) |
| `npm run test:e2e` | Playwright (auto-starts Vite at `http://localhost:1420`) |
| Single vitest | `npx vitest run path/to/file.test.ts` (or `-t "name"` to filter by test name) |
| Single Playwright | `npx playwright test tests/e2e/foo.spec.ts` |
| Rust tests | `cd src-tauri && cargo test` |
| `npm run icons` | Regenerate all app icons from `public/logo-mark.svg` + `public/favicon.svg`. See the `brand-icons` skill before editing logo sources. |
<!-- doctest:cmd:end -->

The Vite dev server uses **port 1420 with `strictPort: true`** — Tauri requires it. Don't change.

`use-mock-provider=1` in `localStorage` forces the mock data provider for **quotes and history** (used by Playwright and offline dev). The symbol **catalog/search** is NOT mocked — `searchSymbols()` returns `[]` (with a `[TODO P8 toast]` warn) when there is no Tauri runtime; the real FTS5 catalog requires SQLite/`invoke`. Some Playwright specs are gated to Tauri-runtime-only and skipped in `vite dev`. The 10-min soak test at `tests/e2e/p4-soak.spec.ts` runs only with `SOAK=1`.

## Architecture (high level)

### Phased build plan
The project follows a strict phase plan in `docs/plan/` (P0 → P9). **P0–P4 + P8-forward complete; P5–P7 (chat UI) removed 2026-05-23.**

The chat UI (AI panel, composer, trace renderers, library tabs, slash palette, MCP consent toast, `useAIStore`, Rust `ai_invoke` family) was removed to simplify the codebase. **CLI/Terminal via PTY is now the only AI surface.** The MCP bridge (`bridgeRoundtrip.ts` → `ipc_bridge.rs`) and MCP-driven artifact UIs (StrategyArtifactPanel, DatasetCard, StrategyCard, RuleGraph) survive — they run via the PTY, not the chat UI.

See `docs/plan/README.md` for the full plan overview and phase summaries. Phase docs (P5–P7) are retained for history.

### Two-process split
- `src-tauri/` — Rust backend. SQLite (rusqlite, bundled), market-data REST adapters (reqwest + tokio), per-provider token-bucket rate limiters. Frontend never opens SQLite directly — all DB access flows through Tauri commands declared in `src-tauri/src/commands/{db,market}.rs` and called from `src/lib/db.ts` via `invoke`. Terminal mode is launched via `terminal_spawn`.
- `src/` — React 18 + TS frontend. WebSocket realtime is in TS (`src/data/adapters/{binance,coinbase,kraken}.ts`); REST history goes through Rust. The provider registry (`src/data/providerRegistry.ts`) hides the split and falls back to `MockMarketDataProvider` when the Tauri runtime is missing or an adapter isn't registered.

Frozen contracts: see [docs/adr/](docs/adr/README.md). Append-only migration rule lives in [ADR-0005](docs/adr/0005-append-only-migrations.md). Visual-diff capture scripts live in `scripts/` (e.g. `scripts/capture-renderers.mjs`).

## Conventions

- Rust serializes struct fields as snake_case; the TS `Mark` / DB types mirror that exactly so no per-row remapping is needed at the boundary.
- The frontend logs `console.warn('[TODO P8 toast] ...')` for failures that will become user-visible toasts in P8 — leave these markers in place when adding new failure paths.
- `tsconfig.json` has `noUnusedLocals` and `noUnusedParameters` strict; prefix intentional unused with `_` or use `void x` (see the `void hydrated` pattern in `AppShell.tsx`).

## Where to look

- [docs/INDEX.md](docs/INDEX.md) — full doc index
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — domain terms
- [docs/adr/](docs/adr/README.md) — frozen architectural decisions (10 ADRs incl. ADR-0010 portfolio model)
- [docs/reference/tauri-ipc.md](docs/reference/tauri-ipc.md) — IPC contract (generated; includes terminal + MCP bridge commands)
- [docs/plan/](docs/plan/README.md) — phase plans P0–P9 (P5–P7 removed 2026-05-23; docs retained for history)
- [app-design/project/](app-design/project/) — binding design prototype (P5–P7 UI screens no longer implemented)
- Portfolio panel + `portfolio_*` MCP tools: `src/panels/PortfolioPanel.tsx`, `src/stores/usePortfolioStore.ts`, `src-tauri/migrations/0018_portfolio.sql`
- Research Library panel + `save/list/load/delete_research_overlay` MCP tools: `src/panels/ResearchLibrary.tsx`, `src/stores/useResearchOverlayLibraryStore.ts`, `src-tauri/migrations/0019_research_overlays.sql`
- Nested CLAUDE.md exists at `src/chart/`, `src/data/`, `src/ai/`, `src/terminal/`, `src-tauri/`
- [.claude/skills/brand-icons/](.claude/skills/brand-icons/SKILL.md) — logo + icon pipeline (4 SVGs → 18 rasters via `npm run icons`)

## For non-Claude agents

See [AGENTS.md](AGENTS.md) for a tool-agnostic guide (Cursor, Codex CLI, Copilot, etc.).
