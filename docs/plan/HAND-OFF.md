# Session hand-off — 2026-05-10 — P5 complete, P6/P7 next

## Master plan
The dispatch plan that drove P5→P6→P7 defined five waves:
- Wave 1 (P5a) — subprocess wrapper + AI panel **[DONE]**
- Wave 2 (P5b) — full CLI capability surface (7 Settings tabs + privacy) **[DONE]**
- Wave 3 — folded into Wave 2 (W2-G)
- Wave 4 (P6) — Co-Research mode (Dataset DSL + tool round-trip + chip stack + glow overlay) **[NEXT]**
- Wave 5 (P7) — Co-Strategy + Backtest engine **[after Wave 4]**

## What shipped this session

### Wave 1 (P5a) — Foundation
- **Rust** `src-tauri/src/commands/ai.rs` — `ai_invoke` (single-shot stream-json subprocess wrapper), `ai_cancel`, `claude_test_connection`, argv builder with full CLI capability flags, per-conversation cwd jail at `<dirs::data_dir>/autoplot/sessions/<id>/`, attachment copy + canonicalize traversal check, base64 image embedding, `AiError` taxonomy (`CliNotFound`/`CliAuth`/`CliRuntime`/`Cancelled`), concurrency guard (`busy` literal on second in-flight), SIGTERM cancel with cleanup of orphan ai_sessions row.
- **Migration** `0007_ai_sessions.sql` — `ai_sessions(id, mode, cwd_path, model, created_at, last_used_at, summary)`.
- **TS** `src/ai/claudeClient.ts` — `invokeAI` async-iterable, `parseStreamLine` + `parseStreamLineMulti` (tolerant), `summarisePayload` deterministic summary, `previewInvokeOpts` (W2-G addition), `SUPPORTED_CLI` constant.
- **TS types** `src/ai/types.ts` — full `AIEvent` union, `InvokeOpts`, `Attachment`, `Mode`, `PermissionMode`, `SummarisedPayload`.
- **Stores** `useAIStore` (panel chrome, traces, inflight flags, `composerModeByMode` tri-state, plan-mode `permissionModeUsed`+`originalPrompt`, `permissionModeOverrideByMode`, `foldTextIntoPlanOutline`); `useSettingsStore` (durable settings inc. `cliPath`, `modelByMode`, `permissionModeByMode`, `allowedToolsByMode`, `disallowedToolsByMode`, `verboseLogging`, `privacyMode`, `auditLogEnabled`, `stripPiiFromLogs`, `dataRefreshIntervalSec`, `bypassConfirmed`, `disabledSkills`); `useSettingsUiStore` (`panelOpen`, `activeTab`, `inspectOpen`); `useMcpStore` (`servers`, `statuses`, `disabledByConversation`).
- **UI** `AgentsFAB` (browser-only mode disabled with tooltip), `AgentsPanel` (440px right slide), `Composer` (textarea + paperclip + slash + send/cancel), `AuroraAvatar`, `ThinkingTrace` state machine, `__capture_helpers.ts` DEV-only seeders.
- **Keyboard** ⌘J/Ctrl+J for AI panel, ⌘,/Ctrl-, for Settings panel; routed through `src/stores/keyboard.ts` dispatcher (no competing window listeners).

### Wave 2 (P5b) — Full capability surface
All 7 Settings tabs (`SettingsPanel.tsx` with stable `data-w2-stub` insertion points):
- **General** — CLI path + Test connection (calls `claude --version`); verbose toggle; data refresh interval.
- **Models** — default + per-mode model overrides.
- **Tools & Permissions** — chip multi-select for allowed/disallowed tools per mode (defaults seeded once via `settingsSeededV1`); per-mode permission-mode dropdown; Subagents sub-section (lists `~/.claude/agents/*.md`).
- **MCP** — Add/Edit/Remove form for app-managed config at `<dirs::data_dir>/autoplot/mcp.json`; merge view (app > user > project, silent precedence); 5s health-poller scoped to MCP-tab-active; per-conversation chip in AgentsPanel.
- **Skills** — discovery from app/user/plugin/project paths with shadowed indicator; enable/disable persisted to `disabledSkills`; SlashPalette opens on `/` in composer; 4 app-shipped commands (`/explain`, `/research`, `/strategy`, `/save-current`) installed at boot.
- **Hooks** — JSON editor with shape validation + audit-log toggle; appends JSONL to `<app_dir>/logs/audit.log` via `src/ai/audit.ts`; `--settings <app-managed-path>` passed to every invoke.
- **Privacy** — `summary-only` vs `full-bars` mode; strip-PII toggle (TS via `src/ai/pii.ts` + Rust mirror via `maybe_strip_pii`); audit-log enable; `verbose_strip_pii` flag flows through `InvokeOpts` to the Rust verbose log writer.
- **FirstRun modal** — three states (`cli-not-found`/`cli-auth`/`cli-version-unsupported`); reads optional capture override for visual-diff.
- **Permission-mode chip popover** in panel header — per-conversation override + bypass confirm dialog gated by `bypassConfirmed`.
- **`/plan ` prefix** in Composer → forces `permissionMode: 'plan'` for one send → trace folds text steps into a single `plan_outline` step on `done` → Apply CTA re-runs without prefix in `acceptEdits`.
- **Attachments** — file picker, 5 MB text / 10 MB image cap with canvas-based downsample to longest-edge 2048 px (`src/ai/imageResize.ts`); `attachment_write_temp` Rust command.
- **Library** sub-tabs (Datasets / Strategies / History) — Datasets/Strategies are P6/P7 placeholders; History is functional with Resume + Delete + New conversation.
- **Privacy chip** in panel header → opens `InspectPayloadModal` (full JSON of next-request body, base64 elision to 60 chars + size, text-attachment collapse > 2 KB with expand button, Copy + Esc).

### Header overflow fix (last edit)
- Restored prototype's `ag-head` shape (mode toggle + Chat tab + Library tab + ×).
- Removed redundant top-level History tab (Library has its own History sub-tab).
- Renamed Thread → Chat per `agents.jsx:322` label parity.
- Added second row `.ag-status-row` directly below header for the 3 Wave-2 chips (MCP / Privacy / Permission-mode + popover). All token-compliant; structural hairline only.
- See `src/panels/AgentsPanel.tsx:120-200` and `src/styles/agents.css:104` for the diff.

## Numbers

- **vitest:** 247 / 247 (16 files; baseline at session start was 184)
- **cargo test:** 115 / 115 (baseline 71)
- **typecheck / lint / cargo check:** clean
- **Visual diff:** 23 PNGs in `docs/visual-diff/P5/` (8 Wave-1 rebuild/prototype pairs + 15 Wave-2 surfaces)
- **Manual smoke:** `docs/p5-smoke.md` — full P5-70 checklist, KNOWN-DEFER list now empty

## Key files & paths

### Source files created/heavily-modified
- `src-tauri/src/commands/{ai,mcp,skills,settings_hooks}.rs` — all four registered in `lib.rs::invoke_handler!`.
- `src-tauri/migrations/0007_ai_sessions.sql`.
- `src/ai/{claudeClient,types,audit,pii,skillResolver,imageResize,ThinkingTrace}.ts`.
- `src/ai/__capture_helpers.ts` + `__capture_state.ts` (DEV-only).
- `src/panels/{AgentsFAB,AgentsPanel,Composer,SettingsPanel,SettingsFAB,FirstRun,LibraryTab,SlashPalette,PermissionModePopover,InspectPayloadModal}.tsx`.
- `src/components/AuroraAvatar.tsx`.
- `src/stores/{useAIStore,useSettingsStore,useSettingsUiStore,useMcpStore,keyboard}.ts`.
- `src/styles/agents.css` (the entire AI surface stylesheet).
- `scripts/capture-visual-diff-p5.mjs` (15 Wave-2 captures + Wave-1 reproductions).
- `docs/p5-smoke.md` (manual P5-70 checklist).
- `docs/visual-diff/P5/` (23 PNGs + NOTES.md).

### Reference contracts
- `ai:event` envelope (Rust → TS): `{ kind: "raw", payload }` | `{ kind: "exit", code }` | `{ kind: "error", message, raw? }`. Error-message literals `"CliAuth"`, `"CliNotFound"`, `"Cancelled"` route to typed `error` events.
- `AIEvent` union (TS internal) — see `src/ai/types.ts`. Stable across the codebase.
- Settings persistence path — `dbAppStateSet('settings', JSON.stringify({ schema_version: 1, ...slots }))` via `hydrate.ts::mountSettingsSync` (debounced 200ms, gated on `hydrated`).
- App-managed config files at `<dirs::data_dir>/autoplot/`: `mcp.json`, `settings.json`, `commands/*.md`, `logs/audit.log`, `logs/ai-stderr.log`, `sessions/<id>/`, `tmp/<uuid>-<name>`.

## Outstanding manual gates

These cannot be automated — require a real `claude` CLI on PATH and `npm run tauri:dev`:

1. Walk through `docs/p5-smoke.md` end-to-end. KNOWN-DEFER section is empty; everything is meant to be shippable.
2. Visual review of `docs/visual-diff/P5/` — 8 Wave-1 prototype/rebuild pairs to compare side-by-side; 15 Wave-2 surfaces to eyeball against the prototype's design language.
3. Verify the just-shipped header overflow fix (`npm run dev` will do — no `claude` needed): panel opens cleanly at 440 px; status row chips wrap if narrow; "Chat" + "Library" + × in primary row.

## Next step

Wave 4 (P6 Co-Research). Per the plan, **W4-A and W4-B can dispatch in parallel** (no shared files; W4-A is schemas/Rust/prompts; W4-B is UI/chart/migration). **W4-C waits** for both.

Specifically:
- **W4-A** — Zod `Dataset` schema with pinned enums (`Indicator`, `Op`, `Dataset.kind`, `Dataset.align`); `ai_send_tool_result` Rust command + persistent stdin writer (this is the deferred-from-W1-A piece); tool-dispatch loop in `claudeClient.ts` (serial event order, 30 s soft timeout per handler); handlers for `fetch_ohlc` / `compute_indicator` / `return_dataset`; Research system prompt `src/ai/prompts/research.md`.
- **W4-B** — `src/panels/DatasetCard.tsx`, `src/panels/LibraryDatasets.tsx`, `src/chrome/AIChipStack.tsx` (top-center, mutually-exclusive plot toggle, `--reserve-*` layout via existing pattern); AI overlay glow pass in `src/chart/overlays.ts`; migration `0008_datasets.sql` + `db_datasets_*` Tauri commands; seed Library presets (30d realized vol, Correlation w/ ETH, Momentum z-score, Liquidity pressure, Funding rate proxy) gated by `app_state['library.datasets_seeded']`.
- **W4-C** — CSV reference attachments via `parseUserSeries` (port from prototype `data.js`); vitest schema validation + tool-dispatch round-trips + preset re-seed idempotency + mock-mode path; Playwright `p6-research-flow.spec.ts`; visual diff `docs/visual-diff/P6/`.

Read `docs/plan/P6-research-agent.md` for the granular checklist (it holds the full Wave-4 brief).

## Recovery / re-entry tips

- `cargo` is at `~/.cargo/bin/cargo`, not on PATH. Use the absolute path.
- Vite dev server uses port **1420** with `strictPort: true` — Tauri requires it; do not change.
- Tauri v2 setup runs OUTSIDE the Tokio runtime — use `tauri::async_runtime::block_on` for async work in `setup`.
- The `MarketDataProvider` interface is FROZEN (A3); `Tf` is locked to `'1h' | '4h' | '1d' | '1w'`.
- Every UI edit must respect `prototype-fidelity` — `app-design/project/agents.jsx` + `app.css` §05 is the spec, NOT a sketch.
- Per `CLAUDE.md` keyboard rule, never add a competing `window.addEventListener('keydown', …)` — extend `src/stores/keyboard.ts` instead.
- Migrations are append-only. Wave 4 will add `0008_datasets.sql`; Wave 5 will add `0009_strategies.sql`.
- The user's session token IS shared with subagents. Last session, dispatching 7 parallel Wave 2 agents hit the rate limit. Prefer sequential or 2-3-at-a-time fan-out for heavy waves.
