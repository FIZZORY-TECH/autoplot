# autoplot

autoplot is a cinematic dark-glass desktop trading-research workspace (Tauri + React/TypeScript + Rust) with live public crypto and equity data and a Claude CLI co-research agent. It is research and paper-trading only — it never places real orders.

## Prerequisites

- **Node.js** 20+
- **Rust** 1.75+ (install via [rustup](https://rustup.rs))
- **Claude CLI** installed and authenticated (`claude --version` should work)
- macOS with Xcode Command Line Tools (`xcode-select --install`)

## Quickstart

```bash
npm install
npm run tauri:dev
```

The first `tauri:dev` compiles the Rust backend — this takes a few minutes on first run. Subsequent runs are fast thanks to incremental compilation.

## Building from source

`npm run tauri:dev` first runs `npm run build:sidecar`, which compiles a Rust sidecar binary — so a **Rust/Cargo toolchain is required** (see Prerequisites). The prebuilt sidecar binary is intentionally gitignored, so cloners build it locally; no extra step is needed beyond running `npm run tauri:dev`.

## Available scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Start the Vite frontend dev server only |
| `npm run tauri:dev` | Start Tauri dev mode (frontend + Rust backend) |
| `npm run build` | Type-check + Vite production build |
| `npm run lint` | ESLint on all `.ts`/`.tsx` files |
| `npm run typecheck` | TypeScript check without emit |
| `npm test` | Vitest unit tests |
| `npm run test:e2e` | Playwright end-to-end tests |

## Project plan

See [`docs/plan/README.md`](./docs/plan/README.md) for the full phased build plan (P0 -> P9).
