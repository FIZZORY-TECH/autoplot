# AGENTS.md

Tool-agnostic guide for AI coding agents (Cursor, Codex CLI, GitHub Copilot, Aider, etc.) working in this repo. Claude Code users: see `CLAUDE.md` for Claude-specific skills, hooks, and dispatcher precedence.

Tauri desktop app — a "cinematic dark-glass" trading research workspace. React + TypeScript frontend, Rust backend, real public crypto data (Coinbase / Binance / Kraken). **AI surface: Claude CLI via Terminal (PTY) only.** The chat UI was removed 2026-05-23; CLI/Terminal is now the only way to interact with Claude. Research and paper trading only — never places real orders.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server only (no Rust). Falls back to mock data when `__TAURI__` runtime isn't available. |
| `npm run tauri:dev` | Full Tauri dev mode (frontend + Rust). First run compiles Rust — slow; later runs are incremental. |
| `npm run build` | `tsc && vite build` (frontend production build) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `.ts`/`.tsx` |
| `npm test` | Vitest unit tests (jsdom env, `src/**/*.test.{ts,tsx}`) |
| `npm run test:e2e` | Playwright (auto-starts Vite at `http://localhost:1420`) |
| Single vitest | `npx vitest run path/to/file.test.ts` |
| Single Playwright | `npx playwright test tests/e2e/foo.spec.ts` |
| Rust tests | `cd src-tauri && cargo test` |

Vite dev server is locked to **port 1420 with `strictPort: true`** — Tauri requires it.

## First read

- [docs/INDEX.md](docs/INDEX.md) — full doc index, scan-in-10-seconds map.
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — domain terms (Bar, Tf, Dataset, Strategy, etc.).
- [docs/adr/](docs/adr/README.md) — frozen architectural decisions.
- [docs/reference/tauri-ipc.md](docs/reference/tauri-ipc.md) — generated IPC contract.

## Frozen rules

- **[ADR-0001](docs/adr/0001-market-data-provider-frozen.md)** — `MarketDataProvider` interface is frozen; do not mutate `fetchHistory` / `subscribeRealtime` / `search`.
- **[ADR-0002](docs/adr/0002-timeframe-set-locked.md)** — `Tf` is locked to `'1h' | '4h' | '1d' | '1w'`. Do not add 5m or 15m.
- **[ADR-0003](docs/adr/0003-claude-profile-isolation.md)** — Claude CLI subprocess uses `<data_dir>/autoplot/claude-home/`; the user's `~/.claude*` is never touched.
- **[ADR-0004](docs/adr/0004-design-binding-prototype.md)** — `app-design/project/` is the binding design spec; production must match tokens, motion, and component shapes. Never copy prototype source files into `src/`.
- **[ADR-0005](docs/adr/0005-append-only-migrations.md)** — SQLite migrations are append-only; new migrations add a file + array entry, prior migrations are never edited.

## Conventions

- Rust serializes struct fields as snake_case; the TS `Mark` / DB types mirror that exactly so no per-row remapping is needed at the boundary.
- The frontend logs `console.warn('[TODO P8 toast] ...')` for failures that will become user-visible toasts in P8 — leave these markers in place when adding new failure paths.
- `tsconfig.json` has `noUnusedLocals` and `noUnusedParameters` strict; prefix intentional unused with `_` or use `void x` (see the `void hydrated` pattern in `AppShell.tsx`).

## For Claude users

See `CLAUDE.md` for Claude-Code-specific skills, hooks, and dispatcher precedence.
