# autoplot — Build Plan (Overview)

> **NOTICE:** P5 (chat UI), P6 (research flow), and P7 (strategy flow) were **removed from the product on 2026-05-23**. The phase docs are preserved below for history. CLI/Terminal (via PTY) is now the only AI surface. See P8 for the surviving terminal + MCP IPC bridge architecture.

This is the source-of-truth build plan for the autoplot. Read this file once for global context, then jump to your assigned phase under `docs/plan/Px-*.md`.

- [P0 — Foundation](./P0-foundation.md)
- [P1 — Core Charting](./P1-core-charting.md)
- [P2 — Floating UI Surfaces](./P2-floating-ui.md)
- [P3 — Asset Panel + Watchlist](./P3-asset-panel.md)
- [P4 — Real Crypto Data Layer](./P4-crypto-data.md)
- [P5 — Claude CLI Full Capability Surface](./P5-claude-cli.md)
- [P6 — AI Co-Research Agent](./P6-research-agent.md)
- [P7 — AI Co-Strategy Agent + Backtest](./P7-strategy-agent.md)
- [P8 — Polish, Performance, A11y](./P8-polish.md)
- [P9 — Packaging & Release](./P9-release.md)

---

## Build Status

**P0–P7 complete + Wave 0 (profile isolation) landed.** Project is a runnable Tauri desktop app with live crypto data, persisted state, full chart UI, full Claude CLI capability surface, AI Co-Research, and AI Co-Strategy backtest engine.

- Verification: **421 vitest + 137 cargo tests green**; lint / typecheck / build all clean.
- Live data verified: Binance + Coinbase + Kraken REST smokes succeeded against production APIs.
- Visual-diff screenshots captured in `docs/visual-diff/{P0,P1,P2,P3,P5,P6,P7}/` (P6 + P7 PNGs are generated lazily — see each phase's `NOTES.md`).
- **PFIX wave (post-P4 fixes):** mock-mode badge; Coinbase WS aggregates running OHLC; AssetPanel collapsed-by-default + decoupled; Trend Line tool; AddAssetModal + OverlaysPanel motion parity; style/motion audit (`docs/audit/PFIX-style-audit.md`) closed 34 findings.
- **Wave 0 — Claude profile isolation (NEW, locked-in requirement).** App now uses a dedicated Claude profile at `<dirs::data_dir>/autoplot/claude-home/`; subprocess spawns inherit env (no `env_clear`) but pass `CLAUDE_CONFIG_DIR=<claude-home>`, `--strict-mcp-config`, `--setting-sources user`, and `env_remove` of `ANTHROPIC_*` / `CLAUDE_CODE_USE_*`. The user's main `~/.claude` is **never read or written** by the app. FirstRun walks new users through profile setup + sign-in (terminal CTA or `ANTHROPIC_API_KEY` fallback). MCP-import button does an explicit one-shot read-only copy from `~/.claude.json` for users who curated MCP servers in their main profile. See §2.6 capability table for argv changes.
- **P5 (Claude CLI surface):** subprocess wrapper, stream-json parser, AI panel + composer + aurora avatar + thinking trace, all 7 Settings tabs (General / Models / Tools / MCP / Skills / Hooks / Privacy), slash-command palette, FirstRun gate, attachments (text + CSV + image with downsample), per-conversation MCP chips, audit log, payload inspector, plan-mode "Apply" CTA. `docs/p5-smoke.md` covers the manual checklist.
- **P6 (AI Co-Research):** Dataset Zod schema (15-entry Indicator enum + 8-op Op enum + AND-only rule + right/index align semantics), tool round-trip (`fetch_ohlc` / `compute_indicator` / `return_dataset`) with serial dispatch + 30 s soft timeout + `unknown_tool_use` event, Research system prompt, DatasetCard / LibraryDatasets / AIChipStack, AI overlay glow pass on chart, `0008_datasets.sql` + `db_datasets_*`, idempotent first-run seed of 5 presets, CSV-attachment path via `parseUserSeries`. `docs/visual-diff/P6/` + `tests/e2e/p6-research-flow.spec.ts`.
- **P7 (AI Co-Strategy + Backtest):** pure `src/engine/backtest.ts` (1-unit sizing; exit-before-entry order; prior-bar cross-cache; cold-start skip; per-tf Sharpe annualisation; DD on equity curve; N=0 → null; open-position-at-end), Strategy Zod schema (`StrategyCondition` named to avoid W4-A `Condition` collision), Strategy prompt + `validate_strategy` / `backtest_strategy` / `return_strategy` tools with one-retry validate-retry pipeline + `*_exhausted` events, StrategyCard (4 perf states incl. "Indicative" badge for N<10) + RuleGraph + `signals.ts` (triangles + dashed connector, survives chart-type morph), `0009_strategies.sql` + `db_strategies_*`, idempotent seed of RSI mean-revert + Donchian breakout, edits-flow (full-DSL replace preserving id+createdAt). 5000-bar perf benchmark recorded at ~1–2 ms (gate at 250 ms). `docs/p7-smoke.md` + `docs/visual-diff/P7/`.
- **Outstanding manual gates:** visual-diff PNG regeneration (capture scripts wired but require running dev server); `docs/p5-smoke.md` + `docs/p7-smoke.md` end-to-end against a real `claude` CLI; `tests/e2e/p4-soak.spec.ts` 10-min soak (`SOAK=1`); Tauri-runtime-only Playwright specs.
- **Known active bug (P0, manual):** under `npm run tauri:dev`, sending an AI chat message has been reported by the user as "error then chat refresh." Three fixes have landed (`--cwd` argv removal; user-message bubble rendering; `.claude.json` bootstrap-seed + orphan-trace selector fallback + listener-leak); user has not yet re-verified after the third fix. Tracked under HAND-OFF; if reproducer persists, see audit notes from the QA + senior-engineer dispatches that converged on `claude-home/.claude.json` not being seeded combined with `AgentsPanel.activeTrace` returning `null` when no `session_started` event ever fires.

**Next up: P8** — Polish, Performance, A11y. See `docs/plan/P8-polish.md`.

---

## 1. Context

`docs/requirement.md` is a rich UX/visual specification for a "borderless, mostly-textless, cinematic dark-glass" trading research workspace. The companion `app-design/project/` is a Claude Design HTML/JSX prototype (~5.5k LOC) that already demonstrates the full UI with deterministic mock data and zero backend wiring.

The plan covers:
1. Analysis of the requirement and called-out missing/ambiguous parts.
2. Two added engineering requirements: **React-based** + **AI features powered by Claude subscription credit / Claude CLI**.
3. Phased work breakdown for downstream agents.

## 2. Locked-in Tech Decisions

These were resolved in planning and are **inputs** for every downstream agent — not up for re-debate without explicit user approval.

| Concern | Decision | Reasoning |
|---|---|---|
| Shell | **Tauri (Rust + WebView)** | Required to run `claude` CLI subprocess, bundle SQLite, ship a native desktop binary |
| UI framework | **React 18 + TypeScript + Vite** | Per added requirement |
| **Design source of truth** | **`./app-design/project/` is the approved, accepted design — adopt it. Not advisory.** | User has explicitly approved the prototype's visual + interaction design. Pixel-level fidelity is required. See §2.5. |
| AI provider | **Claude CLI subprocess** (`claude --print --output-format=stream-json`) | Uses user's Claude subscription credit instead of an API key |
| **AI capability surface** | **Full Claude CLI parity** — MCP servers, Skills, subagents, slash commands, hooks, file/image attachments, sessions/resume, permission modes, working-directory scoping. Anything `claude` CLI can do, this app must be able to do. | User-stated requirement. See §2.6 and P5. |
| **Claude profile isolation** | **Dedicated profile at `<data_dir>/autoplot/claude-home/`** — app passes `CLAUDE_CONFIG_DIR=<claude-home>`, `--strict-mcp-config`, `--setting-sources user`, plus `env_remove` of `ANTHROPIC_*` / `CLAUDE_CODE_USE_*`. App never reads or writes `~/.claude*`. | User requirement (Wave 0). The user's main Claude profile must be untouched; app settings, MCP, agents, skills, commands, plugins, hooks all live under the app's dir. |
| Market data | **Real public crypto APIs** (Coinbase / Binance / Kraken) | Free, public, no key required |
| Stocks (NASDAQ/NYSE) | **Deferred — out of v1 scope** | No free real-time stock feed |
| Persistence | **Local SQLite** via Tauri commands | Single-device, durable, no cloud needed |
| Strategy engine | **Real deterministic backtest** running on local OHLC | AI proposes rules, engine evaluates |
| Trading scope | **Research / paper only** — never place real orders in v1 | Drastic scope reduction; no broker code |

## 2.5. Design Adoption — `./app-design/` is Binding

`./app-design/project/` is **not a reference**, it is **the approved specification**. The user has designed and accepted these visuals and interaction patterns; the rebuild's job is to reproduce them faithfully in production-grade React + TS while swapping the prototype's mock plumbing for real services.

**What "adopt" means concretely:**

1. **Visual fidelity is non-negotiable.** Every token, every glass treatment, every animation timing, every layout dimension in `app-design/project/app.css` and `Design System.html` is the spec. Production output must match — within reasonable rendering differences between Babel-standalone-in-browser vs Vite-built React, but visually indistinguishable to the user.
2. **Token-for-token port, not reinterpretation.** OKLCH variables, glass tints, hairline borders, motion easings, durations, spacing scale, radii scale, typography ramp — all copied verbatim into `src/styles/tokens.css`. Do not "improve" or rationalise them.
3. **Component shapes preserved.** Headline, Dock, Actions, Palette, ActivityBar (rails), DockDrawer, IndicatorPanel (docked; was OverlaysPanel), MarkComposer, AssetPanel (docked watchlist drawer), AddAssetModal, AgentsPanel, dataset cards, strategy cards, aurora avatar, thinking-trace rows, strategy flow nodes, AI chip stack — every component visible in the prototype must exist in the rebuild with the same role and the same look.
4. **Animations preserved.** Smooth chart-type morph, animated y-range on asset switch, animated price counter, aurora rotation on AI avatar, shimmer sweep on completed trace rows, spring on dock toggle, fade edges on strategy flow graph — every animation in the prototype carries to the rebuild.
5. **Interaction parity.** Mouse/touch behaviors (drag-pan, scroll-zoom, pinch, shift-drag range, tap), keyboard shortcuts (`⌘K`, `D`, `M`, `C`, `R`, `Esc`), hover-reveals, and modal dismissal patterns are all specified by the prototype.
6. **`Design System.html` is the canonical token reference.** When `app.css` and `Design System.html` disagree, `Design System.html` wins (it is the explicit showcase; `app.css` is the implementation).
7. **No design re-debate without user approval.** If a downstream agent finds a token or pattern that seems "wrong" or wants to substitute (e.g. swap glass for solid surface, add a new color, change easing), it must surface to the user for approval — it cannot redesign in-flight.

> **Dock supersedes floating anchoring ([ADR-0011](../adr/0011-activity-bar-drawer-dock.md)).** As of 2026-06-07 the panels are no longer free-floating cards — they are docked drawers behind two ~48px activity rails (VS Code-style). The prototype `app-design/project/` was updated to depict the dock. The **component shapes and tokens are preserved** (same glass, hairlines, `.dock-btn`, toggle rows, motion easings/durations), but **mounting and positioning are now dock-managed**: a single `useDockStore` owns one-per-side drawer open-state, drawers inset the chart via `--rail-w` + `--reserve-left`/`--reserve-right`, and the per-panel floating-position/open-flag pattern is gone. Coupling the reserve vars to drawer inset is the sanctioned exception recorded in ADR-0011 (the prior fidelity guidance against reserve-var coupling applied to floating panels only).

**What is explicitly allowed to change:**
- Internal code structure (TS modules, hooks, stores) — the prototype's `window.*` global pattern and `<script type="text/babel">` loading are NOT preserved; the rebuild uses idiomatic React + TS.
- Where data comes from — mock OHLC → real provider adapters (P4) — but the data shape consumed by the chart layer must be the same.
- Performance optimisations (OffscreenCanvas, virtualization) — provided they don't change the visual output.
- New surfaces required by added requirements (Settings panel for Claude CLI config, MCP/Skills management UI) — must follow existing design language. See §2.7.

**What "adopt" does NOT mean:**
- Copying the prototype's source files into `src/` and renaming. Idiomatic TypeScript + Vite + React is required; the prototype is a visual + behavioral specification, not a code template.
- Loading Babel-standalone or unpkg CDNs in production.

**Auditing design adoption.** Each UI-touching phase (P0, P1, P2, P3, P5, P6, P7, P8) ends with a side-by-side visual diff vs the prototype HTML rendered locally. Phase acceptance requires the diff to pass.

## 2.6. Claude CLI Capability Surface — Full Parity

The app must expose **every capability the `claude` CLI offers**, surfaced through the AI panel and the Settings panel. The user must never have to drop to a terminal to use a Claude feature. This is a load-bearing requirement that significantly shapes P5–P7.

**Capabilities to expose (each is a sub-task in P5 unless noted):**

| Capability | What it is | How exposed in app |
|---|---|---|
| **MCP servers** | User-configurable Model Context Protocol servers (`claude mcp add/remove/list`, `~/.claude.json` and project-scoped `.mcp.json`). | Settings panel → MCP tab: list / add / edit / remove servers. Servers automatically available to agent calls via `--mcp-config <file>` or pre-configured `~/.claude.json`. Per-conversation enable/disable. |
| **Skills** | Custom skills (`~/.claude/skills/<name>/SKILL.md` and plugin-provided skills). Invoked via Skill tool. | Settings panel → Skills tab: list installed skills (user + plugins). AI panel composer surfaces relevant skills as suggested chips. AI agent can auto-invoke skills via Skill tool. |
| **Subagents (Task tool)** | `claude` can dispatch sub-tasks to specialized subagents (`Explore`, `Plan`, `general-purpose`, custom). | Visible in thinking-trace as nested sub-traces. Strategy mode can dispatch a `Plan`-style subagent for thesis decomposition. User can configure custom subagents per project. |
| **Slash commands** | Custom commands in `~/.claude/commands/<name>.md` and plugin commands. | Composer supports `/` to open a slash-command palette listing available commands; selecting one inserts its template. |
| **Hooks** | Lifecycle hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, etc.) configured in `settings.json`. | Settings panel → Hooks tab: list configured hooks; edit JSON; explain when each fires. App-injected hook for telemetry/audit (opt-in). |
| **File / image attachments** | `claude` accepts file paths and images. | Composer paperclip supports text files, CSVs, images. Sent via stream-json `user` message with appropriate content blocks. |
| **Sessions & resume** | `claude --resume <id>`, `--continue`, session listing. | Each AI panel conversation maps to a session. "Continue last conversation" button. Per-mode session history (research vs strategy). |
| **Permission modes** | `--permission-mode {default, acceptEdits, plan, bypassPermissions}`. | Mode selector in AI panel header. Default = `acceptEdits` for in-app calls. `plan` mode used when user asks Claude to "design a strategy without applying". |
| **Working directory scoping** | `claude` runs inside a per-conversation cwd. (Note: there is no `--cwd` argv flag — that was wrongly attempted in a Wave 0 draft and removed; the correct mechanism is `Command::current_dir`.) | Each AI conversation has a scoped working dir under `<dirs::data_dir>/autoplot/sessions/<id>/`. User-attached files copied in; outputs read out. Tool use never escapes this jail by default. |
| **Profile dir scoping** (Wave 0) | `CLAUDE_CONFIG_DIR=<claude-home>` env var on every spawn. | Sandboxes the CLI's own config / auth / agents / skills / plugins / commands lookup to the app-managed dir. Combined with `--strict-mcp-config` + `--setting-sources user`, no read or write touches the user's main `~/.claude*`. |
| **Output format** | `--output-format {text, json, stream-json}` and `--input-format`. | Always `stream-json` for streaming UX. Documented internally. |
| **Model selection** | `--model <name>` (Opus, Sonnet, Haiku). | Settings panel: default model + per-mode override (Research = Sonnet, Strategy = Opus by default). |
| **System prompt** | `--system-prompt` and `--append-system-prompt`. | Per-mode system prompt files (`prompts/research.md`, `prompts/strategy.md`) appended via `--append-system-prompt`. User can edit in Settings. |
| **Allowed/disallowed tools** | `--allowed-tools`, `--disallowed-tools`. | Per-mode tool allowlist (e.g., Research can use `Read`, `WebSearch`, `mcp__*`; Strategy can additionally use `validate_strategy`, `backtest_strategy`). User-overridable in Settings. |
| **Plan mode** | `claude` plan-mode UX. | When user prefixes prompt with "/plan" or toggles Plan mode in panel, app passes `--permission-mode plan`. Thinking trace shows plan steps. |
| **Print / non-interactive mode** | `--print` for one-shot calls. | Used internally for every panel request (we drive the UI; we don't run interactive `claude`). |
| **Verbose / debug** | `--verbose`, `--debug`. | Settings panel "log level" selector toggles `--verbose`. |
| **CLI version + auth health** | `claude --version`, login check. | First-run gate. Settings "Test connection". |

**Implications for downstream agents:**
- P5's Rust subprocess wrapper (`src-tauri/src/commands/ai.rs`) must accept and pass through all CLI flags listed above; it is NOT just a thin "send prompt → get response" wrapper.
- P5 introduces three new Settings tabs: **MCP**, **Skills**, **Hooks** (in addition to general settings).
- P5 introduces the slash-command palette in the composer.
- P6 + P7 each declare a per-mode **tool allowlist** and **permission mode** so Research vs Strategy behave differently.
- The thinking-trace state machine (P5-14) must support **nested sub-traces** to render subagent dispatch.
- Claude Skills + MCP tool calls flow through the same stream-json events; the parser handles them generically.

## 2.7. New Surfaces Beyond the Prototype

The added requirements (Tauri + Claude CLI full surface) introduce UI that the prototype does not show. These must be designed in-language with the existing tokens/components.

| Surface | Purpose | Visual rule |
|---|---|---|
| **Settings panel** (P5) | CLI path, model defaults, MCP servers, Skills, Hooks, log level, permissions, privacy | Right-edge slide-in like AgentsPanel; tabbed; same glass treatment; mono numerals where applicable |
| **First-run / CLI-not-found gate** (P5) | If `claude --version` fails | Full-screen aurora-tinted glass card with install instructions and a "Test again" button |
| **Slash-command palette** (P5) | Composer `/` shortcut | Same visual as the asset Palette; aurora accent (cyan for research, violet for strategy) |
| **MCP server list / editor** (P5) | Manage MCP server configs | Glass list with add/edit/remove; status dot per server (connected/error/disabled) |
| **Skill list** (P5) | Manage installed skills | Glass list; per-skill enable toggle; description preview |
| **Subagent sub-trace** (P5) | Nested thinking trace | Indent + tinted left rail; same row visual as parent trace |
| **Toast / error banner** (P8) | Network, AI, persistence errors | Glass capsule, top-right, severity color (red/amber/cyan), auto-dismiss 6s |
| **Onboarding hint card** (P8) | First-run empty state | Glass card centered with key tips; dismissible |

These surfaces inherit the existing token system from §2.5; do not introduce new colors, easings, or radii unless explicitly approved.

## 2.8. Design Asset Inventory (`app-design/project/`)

Every file the rebuild must consult. Treat this as the design build manifest.

| File | Size | Role | When to read |
|---|---|---|---|
| `Design System.html` | 1257 lines | **Canonical token + component showcase.** Sections 01 Color, 02 Type, 03 Form, 04 Components, 05 Agentic, 06 Principles. | P0 (extract tokens), P5 (agentic patterns), P8 (final audit). |
| `autoplot.html` | 31 lines | Entry-point bootstrap; load order: data.js → chart.jsx → chrome.jsx → panel.jsx → agents.jsx → app.jsx. | P0 (understand bundling). |
| `app.css` | 1810 lines | All styles. Lines 1–50 define tokens; rest is per-component. | P0 (tokens), every UI phase (per-component CSS reference). |
| `data.js` | 190 lines | OHLC mock generator + indicator math (sma/ema/bollinger/rsi/heikin) + parser/formatter helpers. | P1 (port indicators verbatim). |
| `chart.jsx` | 692 lines | Canvas engine, 5 chart-type renderers, mouse/touch handlers, animated y-range, overlays draw. | P1 (the design source of truth for chart). |
| `chrome.jsx` | ~470 lines | ActivityBar (rails) + DockDrawer (ADR-0011), Watchlist orbs, Dock, Actions, Palette, IndicatorPanel (was OverlaysPanel), MarkComposer. | P2 (binding visual reference). |
| `panel.jsx` | 289 lines | Floating AssetPanel (expanded + collapsed), AddAssetModal, MiniSpark. | P3 (binding visual reference). |
| `agents.jsx` | 550 lines | AI panel (Research + Strategy), thinking trace, dataset/strategy cards, library, aurora avatar. | P5/P6/P7 (binding visual reference for AI surfaces). |
| `app.jsx` | 330 lines | Top-level state shape + wiring. | All phases (state contract reference). |
| `README.md` | — | Handoff bundle README. | Read once. |

## 2.9. Design Adoption Verification Matrix

A lookup table for every visible component: which prototype file is the source, which target file/module owns the rebuild, and which phase covers it. Downstream agents use this to know exactly what to read before touching a component.

| Visible component | Prototype source | Target module | Phase |
|---|---|---|---|
| Color tokens (OKLCH) | `app.css:1-50`, `Design System.html` §01 | `src/styles/tokens.css` | P0 |
| Glass utilities | `app.css` glass section, `Design System.html` §03 | `src/styles/glass.css` | P0 |
| Motion (easings, durations) | `app.css` motion vars, `Design System.html` §03 | `src/styles/motion.css` | P0 |
| Typography ramp | `Design System.html` §02 | `src/styles/tokens.css` (font-face), components | P0 |
| Radii + spacing scales | `Design System.html` §03 | `src/styles/tokens.css` | P0 |
| Chart canvas (5 types) | `chart.jsx`, `Design System.html` chart visuals | `src/chart/ChartCanvas.tsx` + `renderers/*` | P1 |
| Crosshair + price readout | `chart.jsx` | `src/chart/Crosshair.tsx` | P1 |
| MA / Bollinger / custom overlays | `chart.jsx`, `data.js` | `src/chart/overlays.ts` | P1 |
| Animated y-range | `chart.jsx` (`useAnimatedRange`) | `src/chart/interaction.ts` (RAF interpolator) | P1 |
| Headline + animated price + delta pill | `chrome.jsx`, `Design System.html` §04 | `src/chrome/Headline.tsx` | P2 |
| Dock (chart-type + tf + tools) | `chrome.jsx`, `Design System.html` §04 | `src/chrome/Dock.tsx` | P2 |
| Actions cluster (top-right) | `chrome.jsx` | `src/chrome/Actions.tsx` | P2 |
| Command palette | `chrome.jsx` | `src/chrome/Palette.tsx` | P2 |
| Indicator panel (toggles + custom series) | `chrome.jsx` (`IndicatorPanel`, docked) | `src/panels/IndicatorPanel.tsx` | P2 (re-docked per ADR-0011) |
| Activity rails (left + right) | `chrome.jsx` (`ActivityBar`) | `src/chrome/ActivityBar.tsx` | ADR-0011 |
| Dock drawer shell (one-per-side) | `chrome.jsx` (`DockDrawer`) + `app.css` `.dock-drawer` | `src/panels/DockDrawer.tsx` | ADR-0011 |
| Drawer open-state (single source) | `app.jsx` dock wiring (`openLeft`/`openRight`) | `src/stores/useDockStore.ts` | ADR-0011 |
| Mark composer | `chrome.jsx`, `Design System.html` §04 | `src/chrome/MarkComposer.tsx` | P2 |
| Marks rendered on chart | `chart.jsx` mark layer | `src/chart/marks.ts` | P2 |
| Range Scope tool + stats card | `chart.jsx` + `chrome.jsx` | `src/chart/rangeScope.ts` + `src/chrome/RangeStats.tsx` | P2 |
| Hint strip | `chrome.jsx` | `src/chrome/Hint.tsx` | P2 |
| Asset Panel (expanded) | `panel.jsx` | `src/panels/AssetPanel.tsx` | P3 |
| Asset Panel (collapsed) | `panel.jsx` | `src/panels/AssetPanel.tsx` (collapsed branch) | P3 |
| Active-asset highlight | `panel.jsx` | `AssetPanel.tsx` | P3 |
| Add Asset modal | `panel.jsx` | `src/panels/AddAssetModal.tsx` | P3 |
| MiniSpark sparkline | `panel.jsx` | `src/components/MiniSpark.tsx` | P3 |
| AI FAB (pulsing aurora) | `agents.jsx`, `Design System.html` §05 | `src/panels/AgentsFAB.tsx` | P5 |
| AI panel shell (440px slide-out) | `agents.jsx` | `src/panels/AgentsPanel.tsx` | P5 |
| Mode toggle (Research/Strategy) | `agents.jsx` | `AgentsPanel.tsx` header | P5 |
| Aurora avatar (spinning gradient) | `agents.jsx`, `Design System.html` §05 | `src/components/AuroraAvatar.tsx` | P5 |
| Thinking trace rows | `agents.jsx`, `Design System.html` §05 | `src/ai/ThinkingTrace.tsx` | P5 |
| Composer (paperclip + send + chips) | `agents.jsx` | `src/panels/Composer.tsx` | P5 |
| Suggested prompt chips | `agents.jsx` | `src/panels/PromptChips.tsx` | P5 |
| Reference attachment chips | `agents.jsx` | `src/panels/AttachmentChips.tsx` | P5 |
| Dataset card (inline in thread) | `agents.jsx` | `src/panels/DatasetCard.tsx` | P6 |
| Library tab — datasets | `agents.jsx` | `src/panels/LibraryDatasets.tsx` | P6 |
| Active AI Chip Stack (top-center) | `agents.jsx`, `app.jsx` | `src/chrome/AIChipStack.tsx` | P6 |
| Strategy card + animated rule graph | `agents.jsx`, `Design System.html` §05 (strategy flow) | `src/panels/StrategyCard.tsx` + `src/components/RuleGraph.tsx` | P7 |
| Buy/sell signals on chart | `chart.jsx` signals layer | `src/chart/signals.ts` | P7 |
| Dashed pair connector (P&L color) | `chart.jsx` | `src/chart/signals.ts` | P7 |
| Library tab — strategies | `agents.jsx` | `src/panels/LibraryStrategies.tsx` | P7 |
| **Settings panel** (NEW — §2.7) | n/a (follows tokens) | `src/panels/SettingsPanel.tsx` | P5 |
| **MCP / Skills / Hooks tabs** (NEW) | n/a | `src/panels/Settings/{MCP,Skills,Hooks}.tsx` | P5 |
| **Slash-command palette** (NEW) | matches asset Palette | `src/panels/SlashPalette.tsx` | P5 |
| **First-run CLI gate** (NEW) | n/a | `src/screens/FirstRun.tsx` | P5 |
| **Subagent sub-trace** (NEW) | extension of trace | `ThinkingTrace.tsx` (nested branch) | P5 |
| **Toast / error banner** (NEW) | n/a | `src/components/Toast.tsx` | P8 |
| **Onboarding hint card** (NEW) | n/a | `src/screens/Onboarding.tsx` | P8 |

## 3. Gaps in `docs/requirement.md`

Things the spec does not cover — every downstream phase should treat these as known unknowns and resolve in-phase or surface back to the user.

### 3.1 Engineering / data
- ~~**G-1** Provider rate-limit and caching strategy unspecified.~~ **Resolved (P4):** Token-bucket rate-limiter in Rust (`src-tauri/src/providers/rate_limit.rs`); memory LRU + SQLite warm cache per A2.
- ~~**G-2** Real-time updates strategy — WebSocket for active asset vs REST polling for sparklines.~~ **Resolved (P4):** WS in TS for active asset; REST polling (30s throttled, batched per provider) for sparklines per A2.
- ~~**G-3** Historical depth and pagination — Binance `klines` caps at 1000 per call; need backfill plan.~~ **Resolved (P4):** Chain calls when `count > 1000`; implemented in Rust Binance adapter.
- ~~**G-4** Timeframe set inconsistency.~~ **Resolved (P1/P2, USER-LOCKED):** 4-tier `1h/4h/1d/1w` per `docs/requirement.md §4.2`. Prototype's 6-tier set not used.
- ~~**G-5** Custom user-pasted series — no schema, no alignment rule, no error UX.~~ **Resolved (P2):** Custom series textarea in OverlaysPanel; parsed by `parseUserSeries`; row count + parse errors shown inline.
- ~~**G-6** Marks/comments durability across sessions not explicit.~~ **Resolved (P2):** Marks persisted to SQLite (`0002_marks.sql`); survive app restart.
- **G-7** Library quotas (datasets/strategies) — no soft cap. *Still deferred to P8 — both Library tabs ship without quotas; if performance / UX regresses, P8 introduces a soft cap.*

### 3.2 AI / Claude integration
- ~~**G-8** Claude CLI invocation contract — spawn-per-request vs long-lived; `--resume` semantics.~~ **Resolved (pre-P0 / P5 spec):** spawn-per-request, persist `last_session_id` per mode, "Continue" button uses `--resume`.
- ~~**G-9** Strategy DSL schema (JSON contract returned by Claude) is not defined.~~ **Resolved (P7):** Zod `Strategy` schema in `src/ai/schemas.ts`; JSON Schema mirror at `docs/schemas/strategy.schema.json`. `StrategyCondition` named to avoid collision with W4-A's Dataset `Condition`. Validate-retry pipeline at `src/ai/dispatchTools.ts` with `*_exhausted` events.
- ~~**G-10** Dataset JSON schema (Research output) is not defined.~~ **Resolved (P6):** Zod `Dataset` schema in `src/ai/schemas.ts` (15-entry Indicator enum, 8-op Op enum, AND-only rule, right/index align semantics); JSON Schema mirror at `docs/schemas/dataset.schema.json`.
- ~~**G-11** Failure modes — `claude` not installed / not authenticated / rate-limited UX path.~~ **Resolved (P5 + Wave 0):** `FirstRun` modal handles `cli-not-found` / `cli-auth` / `cli-version-unsupported` / `profile-setup` / `profile-auth` states; argv preview + `Test connection` button surface CLI health.
- ~~**G-12** Privacy — what data leaves the machine (full bars vs summaries).~~ **Resolved (P5 W2-G):** default policy is `summary-only` (`summarisePayload` strips raw 600-bar arrays); user can toggle `full-bars` in Privacy tab. Strip-PII toggle applies to verbose CLI log + audit log. Inspect-payload modal lets the user see exactly what is sent.
- **G-19** **Full Claude CLI capability surface required.** Spec §5–§6 only describe two AI agents; the locked-in requirement (§2.6) is that the app must surface every CLI capability. **P5 shipped this**; future Claude CLI features added upstream are an ongoing maintenance commitment.
- ~~**G-20** **MCP server config storage and merge.**~~ **Resolved (P5 + Wave 0):** app-managed `--mcp-config <claude-home/.claude.json>` + `--strict-mcp-config`. `mcp_import_from_user_profile` is a one-shot read-only opt-in for users with curated `~/.claude.json` MCP servers.
- ~~**G-21** **Skill discovery semantics.**~~ **Resolved (P5 + Wave 0):** `src/ai/skillResolver.ts` reads only from `<claude-home>/skills/` (and plugin paths under the same root). User's main `~/.claude/skills/` is OFF LIMITS.
- ~~**G-22** **Profile isolation — app must not pollute user's main `~/.claude` profile.**~~ **Resolved (Wave 0):** dedicated profile at `<data_dir>/autoplot/claude-home/`. Cargo + vitest tests assert `~/.claude*` is never touched. See §2 Locked-in Tech Decisions and §2.6 capability table.

### 3.3 Product / UX
- ~~**G-13** First-run / empty-state UX undefined.~~ **Resolved (P5 + Wave 0):** `FirstRun.tsx` handles five states (`cli-not-found` / `cli-auth` / `cli-version-unsupported` / `profile-setup` / `profile-auth`) with concrete CTAs.
- ~~**G-14** Settings panel undefined (CLI path, refresh interval, log level).~~ **Resolved (P5):** 7-tab Settings panel (General / Models / Tools / MCP / Skills / Hooks / Privacy) at `src/panels/SettingsPanel.tsx`.
- **G-15** Toast / non-fatal error UX undefined. *Deferred to P8.* `[TODO P8 toast]` markers are sprinkled through the codebase; P8 wires them up to a real toast component. Inline error hint with Retry CTA already lands in `AgentsPanel.tsx` for AI-error path (Wave 0 fix).
- **G-16** A11y guarantees for icon-only UI undefined. *Deferred to P8.*
- **G-17** Logging / telemetry not specified. *Partly resolved:* opt-in audit log at `<data_dir>/autoplot/logs/audit.log`; verbose CLI stderr at `<data_dir>/autoplot/logs/ai-stderr.log` (gated by `verboseLogging` setting + privacy strip-PII).
- **G-18** Versioning of saved Library entries (DSL evolution). *Partly resolved:* both `Dataset` and `Strategy` carry `version: 1`; migrator deferred until v2 forces a schema change.

## 4. Target File / Module Layout

```
autoplot/
├─ src-tauri/                       # Rust side
│  ├─ src/
│  │  ├─ main.rs
│  │  ├─ commands/
│  │  │  ├─ market.rs               # crypto provider adapters
│  │  │  ├─ ai.rs                   # claude CLI subprocess
│  │  │  ├─ db.rs                   # SQLite (rusqlite)
│  │  │  └─ settings.rs
│  │  └─ providers/                 # MarketDataProvider trait + impls
│  └─ tauri.conf.json
├─ src/                             # React + TS
│  ├─ main.tsx, App.tsx
│  ├─ chart/
│  │  ├─ ChartCanvas.tsx
│  │  ├─ renderers/{candles,heikin,bars,line,area,mountain}.ts
│  │  ├─ interaction.ts             # mouse + touch + zoom
│  │  ├─ overlays.ts                # MA / Bollinger / custom / AI
│  │  └─ axes.ts
│  ├─ panels/
│  │  ├─ AssetPanel.tsx, AddAssetModal.tsx
│  │  ├─ AgentsPanel.tsx
│  │  └─ OverlaysPanel.tsx
│  ├─ chrome/                       # Headline, Dock, Actions, Palette, Hint, Composer
│  ├─ ai/
│  │  ├─ claudeClient.ts            # Tauri command + stream-json parser
│  │  ├─ thinkingTrace.ts           # state machine
│  │  ├─ schemas.ts                 # Dataset / Strategy DSL (Zod)
│  │  └─ prompts/{research.md,strategy.md}
│  ├─ engine/
│  │  ├─ indicators.ts              # SMA/EMA/Bollinger/RSI (port of data.js)
│  │  └─ backtest.ts                # rule executor + perf stats
│  ├─ data/
│  │  ├─ MarketDataProvider.ts
│  │  ├─ adapters/{coinbase,binance,kraken}.ts
│  │  ├─ ohlcCache.ts
│  │  └─ realtime.ts                # WS for active asset
│  ├─ store/                        # Zustand: app, watchlist, library, ai
│  ├─ hooks/, lib/, styles/{tokens.css, glass.css, motion.css}
│  └─ types/
├─ docs/
│  ├─ requirement.md                # existing
│  ├─ plan/                         # this directory
│  ├─ adr/                          # architecture decisions
│  └─ schemas/{dataset.schema.json,strategy.schema.json}
└─ tests/
```

## 5. Phase Map (one-line summaries)

| # | Phase | Goal | Rough effort |
|---|---|---|---|
| ✅ [P0](./P0-foundation.md) | Foundation | Scaffold Tauri+React+TS, port design tokens, design-adoption preview page | 1 wk |
| ✅ [P1](./P1-core-charting.md) | Core Charting | Canvas engine, 5 chart types, interaction, prototype-fidelity diff | 1–2 wk |
| ✅ [P2](./P2-floating-ui.md) | Floating UI Surfaces | Headline, Dock, Palette, Overlays panel, Marks | 1 wk |
| ✅ [P3](./P3-asset-panel.md) | Asset Panel + Watchlist | Floating draggable panel, Add modal, persistence | 3–5 d |
| ✅ [P4](./P4-crypto-data.md) | Real Crypto Data Layer | Coinbase/Binance/Kraken REST + WS | 1–1.5 wk |
| ✅ [P5](./P5-claude-cli.md) | **Claude CLI Full Capability Surface** | Subprocess + stream-json + MCP + Skills + Subagents + Slash + Hooks + Permission modes + 7-tab Settings + Wave-0 profile isolation | 2–3 wk (shipped) |
| ✅ [P6](./P6-research-agent.md) | AI Co-Research Agent | Dataset DSL, tool round-trip, presets, plot toggle, glow overlay, library, CSV attachments | 1–1.5 wk (shipped) |
| ✅ [P7](./P7-strategy-agent.md) | AI Co-Strategy Agent + Backtest | Strategy DSL, real backtest engine, validate-retry pipeline, signals layer, RuleGraph, library + edits flow | 2 wk (shipped) |
| [P8](./P8-polish.md) | Polish, Performance, A11y | 60fps, keyboard parity, reduced-motion, full visual diff audit, surface `[TODO P8 toast]` markers as real toasts | 1 wk |
| [P9](./P9-release.md) | Packaging & Release | Signed .dmg, auto-updater, README | 3–5 d |

Total rough estimate: **11–15 weeks** of single-engineer effort (revised up from prior estimate due to P5's expanded scope). Phases are mostly sequential; P3 and parts of P2 can run in parallel after P1; P5a/P5b can be split across two agents.

## 6. What is explicitly OUT of v1 scope

- NASDAQ / NYSE / equity data integration (deferred per locked-in decision).
- Real broker / live order placement (out of scope forever per locked-in decision).
- Multi-user / cloud sync — single-device SQLite is sufficient.
- Mobile native build (Tauri mobile is possible but separate; touch parity within the desktop webview covers spec touch requirements).
- AI fine-tuning / custom model training (we use whatever models Claude CLI exposes via `--model`).
- Light theme (locked dark per spec §1).
- **Design re-interpretation.** Per §2.5, the prototype design is binding. New colors, easings, radii, or visual paradigms are out of scope without explicit user approval.

### NOT out of scope (explicit inclusion clarifications)
- **Every Claude CLI capability** is in scope per §2.6 — including capabilities Anthropic adds in future CLI versions, which become an ongoing maintenance commitment.
- **Settings panel** with MCP / Skills / Hooks / Tools / Permissions / Privacy tabs is in scope (P5).
- **All design surfaces shown in `app-design/project/`** are in scope; nothing is "demo only".

## 7. Open Questions — Status After P0–P7 + Wave 0

These were the open questions before P0. Status updated after the P5/P6/P7 + Wave 0 sessions.

1. ~~**G-4** Timeframe set.~~ **RESOLVED — USER-LOCKED:** 4-tier `1h/4h/1d/1w` per `docs/requirement.md §4.2`. Frozen in `Tf` type in `src/data/MarketDataProvider.ts`.
2. ~~**G-12** Privacy default.~~ **RESOLVED (P5 W2-G):** default `summary-only`; user-toggleable `full-bars` in Privacy tab; inspect-payload modal shows the exact next-request body.
3. **G-7** Library quotas. **STILL PENDING** — deferred to P8 (P6/P7 ship without quotas; revisit only if performance regresses).
4. ~~**Geist font licensing**~~ **RESOLVED (P0):** SIL OFL.
5. ~~**First-run UX copy.**~~ **RESOLVED (P5 + Wave 0):** five-state `FirstRun.tsx` with concrete CTAs.
6. ~~**Default model assignment.**~~ **RESOLVED (P5 + W5-B):** Research = Sonnet (default), Strategy = Opus (default). User-overridable in Settings → Models.
7. ~~**App-managed vs user-managed MCP/Skills/Hooks scope.**~~ **RESOLVED (P5 + Wave 0):** app-managed via `<claude-home>/{settings.json, .claude.json, agents/, skills/, commands/, plugins/}`. User's main `~/.claude*` is OFF LIMITS.
8. ~~**Plan-mode UX in Strategy** (P7-24).~~ **RESOLVED (P7 W5-C12):** plan-mode StrategyCard renders an outline-only variant with a primary `Apply` CTA that re-runs the prompt in `acceptEdits`. Distinct from the `apply` toggle on validated strategies (which materialises chart signals).
9. **Active bug — AI chat refresh on send.** Three fixes have landed (`--cwd` removal, user-bubble rendering, `.claude.json` bootstrap-seed + orphan-trace fallback + listener-leak). User has not yet re-verified after the third fix. Tracked in `docs/plan/HAND-OFF.md` for the next session.

## 8. How to Use This Plan Going Forward

- **For the user:** review §3 (gaps) + §7 (open questions) before starting P0. Approve or revise the locked-in decisions in §2.
- **For the next agent (any phase):**
  1. Read this `README.md` once for global context (decisions, design adoption rules, CLI capability surface, gaps).
  2. Open `docs/plan/Px-*.md` for your phase.
  3. The phase **Inputs** block tells you what should already exist; the **Checklist** is your work; the **Acceptance** block is your done criteria; the **Hands off to** block tells you who picks up next.
- **Tracking progress:** check boxes in the per-phase file as work completes. Each phase header can be linked from the project board / Jira / GitHub issues.
- **Cross-phase concerns** (G-1 through G-21) are tagged in the relevant phase tasks — grep across `docs/plan/` for the tag (e.g. `G-12`) to find every place a gap is addressed.
