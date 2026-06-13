# Documentation Index

Scan-in-10-seconds map of every documentation artifact in this repo. Each entry says when to read it.

## Root
- [README.md](../README.md) — Quick-start commands. *Read when:* first contact with the repo.
- [CLAUDE.md](../CLAUDE.md) — Agent instructions, architecture, conventions. *Read when:* starting any task in this repo.

## docs/
- [docs/INDEX.md](INDEX.md) — This file.
- [docs/GLOSSARY.md](GLOSSARY.md) — Domain term glossary. *Read when:* an unfamiliar term appears.
- [docs/requirement.md](requirement.md) — Original UX spec. *Read when:* questioning a UX choice from before P0.
- [docs/p5-smoke.md](p5-smoke.md) — P5 manual smoke checklist for the Claude CLI surface. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
- [docs/p7-smoke.md](p7-smoke.md) — P7 manual smoke checklist for the Strategy agent. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.

## docs/plan/
- [docs/plan/README.md](plan/README.md) — Phase-plan overview, design adoption rules, verification matrix. *Read when:* before any phase work or UI change.
- [docs/plan/P0-foundation.md](plan/P0-foundation.md) — P0: app shell, Tauri scaffolding, base tokens. *Read when:* touching foundation or chrome.
- [docs/plan/P1-core-charting.md](plan/P1-core-charting.md) — P1: Canvas2D chart pipeline + renderers. *Read when:* touching `src/chart/`.
- [docs/plan/P2-floating-ui.md](plan/P2-floating-ui.md) — P2: dock, palette, headline actions, overlays panel. *Read when:* touching floating UI.
- [docs/plan/P3-asset-panel.md](plan/P3-asset-panel.md) — P3: asset panel + watchlist. *Read when:* touching `src/panels/` or watchlist.
- [docs/plan/P4-crypto-data.md](plan/P4-crypto-data.md) — P4: real Coinbase/Binance/Kraken adapters + rate limiting. *Read when:* touching `src/data/adapters/` or Rust market commands.
- [docs/plan/P5-claude-cli.md](plan/P5-claude-cli.md) — P5: Claude CLI capability surface. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
- [docs/plan/P6-research-agent.md](plan/P6-research-agent.md) — P6: Co-Research agent + Dataset tools. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
- [docs/plan/P7-strategy-agent.md](plan/P7-strategy-agent.md) — P7: Co-Strategy agent + backtest engine. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
- [docs/plan/P8-polish.md](plan/P8-polish.md) — P8: toast layer, error UX, accessibility. *Read when:* converting `[TODO P8 toast]` markers or polishing UX.
- [docs/plan/P9-release.md](plan/P9-release.md) — P9: packaging, signing, release. *Read when:* preparing a build for distribution.
- [docs/plan/HAND-OFF.md](plan/HAND-OFF.md) — Cross-phase status and handoff notes (incl. Wave 0, PFIX). *Read when:* picking up where a previous wave left off.

## docs/adr/
- [docs/adr/README.md](adr/README.md) — Architecture Decision Records. *Read when:* questioning a frozen rule (e.g. `MarketDataProvider`, `Tf` set, snake_case wire format).
- [docs/adr/0006-terminal-pty-mode.md](adr/0006-terminal-pty-mode.md) — PTY Terminal mode design. *Read when:* touching `src/terminal/` or `src-tauri/src/commands/terminal.rs`.
- [docs/adr/0007-app-mcp-bridge.md](adr/0007-app-mcp-bridge.md) — App MCP bridge + `autoplot-mcp` sidecar. *Read when:* touching `src-tauri/src/ipc_bridge.rs`, sidecar tools, or `MCPConsentToast`.
- [docs/adr/0008-equities-provider.md](adr/0008-equities-provider.md) — Equities provider union widening (Alpaca) + provider-mandatory-in-WHERE invariant. *Read when:* adding a new provider, touching `AssetClass`/`Provider` unions, or querying `bars`/`marks`/`watchlist`/`trends`.

## docs/reference/
- [docs/reference/tauri-ipc.md](reference/tauri-ipc.md) — Tauri IPC contract (commands, payloads, error shapes). *Read when:* adding or calling an `invoke()`.
- [docs/reference/credential-storage.md](reference/credential-storage.md) — Provider credential storage: plaintext `credentials.json` (`0600` on Unix) at `<OS data dir>/autoplot/`, `ALPACA_KEY_ID`/`ALPACA_SECRET_KEY` env override, Windows permission caveat, one-time re-entry for users upgrading from the old keychain build, security posture. *Read when:* wiring Alpaca/provider credentials, debugging missing-credential fallback, or migrating off the removed keychain build.

## docs/schemas/
- [docs/schemas/dataset.schema.json](schemas/dataset.schema.json) — Dataset JSON Schema (Indicator enum lives here). *Read when:* generating or validating Datasets.
- [docs/schemas/strategy.schema.json](schemas/strategy.schema.json) — Strategy JSON Schema (Op enum, Condition shape). *Read when:* generating or validating Strategies.

## docs/audit/
- [docs/audit/PFIX-style-audit.md](audit/PFIX-style-audit.md) — Post-P4 prototype-fidelity style audit (PFIX wave). *Read when:* doing a fidelity pass or adding the Trend Line tool.

## Module READMEs / nested CLAUDE.md

- [src/ai/CLAUDE.md](../src/ai/CLAUDE.md) — MCP bridge + tool handlers (schemas, seeds, validators, backtester). *Read when:* touching MCP bridge or artifact rendering tools.
- [src/terminal/CLAUDE.md](../src/terminal/CLAUDE.md) — PTY lifecycle, wire format, dispose contract, xterm lazy-import discipline, browser-mode placeholder. *Read when:* touching `terminalClient.ts` or `XtermPanel.tsx`.
- [src-tauri/sidecars/autoplot-mcp/README.md](../src-tauri/sidecars/autoplot-mcp/README.md) — Sidecar MCP server: env vars, token handshake, wire protocol, full 31-tool surface, error codes, build/test. *Read when:* touching `ipc_bridge.rs`, sidecar crate, or `MCPConsentToast`.
- [src/data/CLAUDE.md](../src/data/CLAUDE.md) — Data layer rules: frozen `MarketDataProvider` interface, provider registry, process split (REST → Rust, WS → TS). *Read when:* touching `src/data/`.

## src/data/adapters — Market data adapters

| Adapter (TS) | Adapter (Rust) | Asset class | Read when |
|---|---|---|---|
| [src/data/adapters/binance.ts](../src/data/adapters/binance.ts) | `src-tauri/src/providers/binance.rs` | crypto | Touching Binance WS or REST integration. |
| [src/data/adapters/coinbase.ts](../src/data/adapters/coinbase.ts) | `src-tauri/src/providers/coinbase.rs` | crypto | Touching Coinbase WS or REST integration. |
| [src/data/adapters/kraken.ts](../src/data/adapters/kraken.ts) | `src-tauri/src/providers/kraken.rs` | crypto | Touching Kraken WS or REST integration. |
| [src/data/adapters/alpaca.ts](../src/data/adapters/alpaca.ts) | [src-tauri/src/providers/alpaca.rs](../src-tauri/src/providers/alpaca.rs) | equity | Touching Alpaca IEX/SIP integration; see [ADR-0008](adr/0008-equities-provider.md). |

## CI
- [.github/workflows/docs.yml](../.github/workflows/docs.yml) — lychee link check (offline on every PR/push, online weekly via cron).
- [src/__doctests__/claude-md.test.ts](../src/__doctests__/claude-md.test.ts) — Vitest doctest asserting CLAUDE.md `npm run …` commands resolve to real `package.json` scripts.

## docs/visual-diff/
Side-by-side prototype-vs-rebuild captures per phase. P0–P4 are image-only; P5–P7 are historical (chat UI removed 2026-05-23).
- [docs/visual-diff/P5/NOTES.md](visual-diff/P5/NOTES.md) — P5 visual-diff notes. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
- [docs/visual-diff/P6/NOTES.md](visual-diff/P6/NOTES.md) — P6 visual-diff notes. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
- [docs/visual-diff/P7/NOTES.md](visual-diff/P7/NOTES.md) — P7 visual-diff notes. **(REMOVED 2026-05-23)** *Read when:* reviewing chat UI history.
