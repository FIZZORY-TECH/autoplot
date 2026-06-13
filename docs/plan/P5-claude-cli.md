> **REMOVED 2026-05-23** — chat UI removed; this phase doc is retained for history only.

# P5 — Claude CLI Integration: Full Capability Surface

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context — this phase is the largest and depends critically on [§2.6 Claude CLI Capability Surface](./README.md#26-claude-cli-capability-surface--full-parity).

**Inputs:** Output of P0–P4. User has `claude` CLI installed and authenticated. **Binding design source:** `app-design/project/agents.jsx` (550 lines), `Design System.html` §05 Agentic (aurora avatar, trace animation, strategy node flow). New surfaces (Settings panel, slash-command palette, MCP/Skills/Hooks lists) follow [README §2.7](./README.md#27-new-surfaces-beyond-the-prototype) design rules.

**Goal:** AI panel UI exists, round-trips a real `claude` subprocess via stream-json, AND exposes **every Claude CLI capability** per [README §2.6](./README.md#26-claude-cli-capability-surface--full-parity): MCP, Skills, subagents, slash commands, hooks, attachments, sessions/resume, permission modes, working-dir scoping, model selection, system prompts, tool allowlists.

This phase is large; it can be split between two agents working in parallel after P5a (subprocess + UI shell) is shared infrastructure for P5b (capability surfaces).

## Checklist

### P5a — Subprocess wrapper + UI shell

#### Rust subprocess wrapper (full flag passthrough)
- [ ] **P5-1** `src-tauri/src/commands/ai.rs` — Tauri command `ai_invoke(InvokeOpts)`. `InvokeOpts` accepts every CLI flag from [§2.6](./README.md#26-claude-cli-capability-surface--full-parity):
  ```
  prompt, system_prompt?, append_system?, model?, permission_mode?,
  session_id?, continue_last?, cwd, mcp_config_path?,
  allowed_tools[], disallowed_tools[], attachments[],
  verbose?, debug?
  ```
- [ ] **P5-2** Spawn `claude` with computed argv. Use `tokio::process::Command`; pipe stdin/stdout/stderr.
- [ ] **P5-3** Pump stdin with stream-json input messages (user message + content blocks + image attachments).
- [ ] **P5-4** Stream stdout line-by-line; parse JSON events; relay each to JS via Tauri's event API (`emit_to(window, "ai:event", evt)`).
- [ ] **P5-5** Capture and return final session ID; persist to per-mode last-session-id store.
- [ ] **P5-6** Per-conversation working directory jail under `~/Library/Application Support/autoplot/sessions/<session-id>/`. Created on first request; `--cwd` always set to this path.
- [ ] **P5-7** Error paths:
  - `claude` not on PATH → `CliNotFound`.
  - `claude --version` ok but invocation fails → `CliAuth` or `CliRuntime`.
  - Subprocess exits non-zero → include stderr in error.
- [ ] **P5-8** Configurable CLI path resolved (Settings override → `which claude` → `~/.local/bin/claude`).
- [ ] **P5-9** Cancellation: kill subprocess on user "stop" button or panel close.

#### TS client
- [ ] **P5-10** `src/ai/claudeClient.ts` — `invokeAI(opts: InvokeOpts) → AsyncIterable<AIEvent>`.
- [ ] **P5-11** Stream-JSON event parser. Tolerant to schema drift: known event types `system`, `user`, `assistant`, `tool_use`, `tool_result`, `result`, `error`. Unknown types logged + ignored.
- [ ] **P5-12** Event normalisation → typed AIEvent union for UI: `text_delta`, `tool_use_start`, `tool_use_end`, `subagent_dispatch`, `subagent_event`, `mcp_tool_use`, `skill_invoke`, `done`, `error`.
- [ ] **P5-13** Partial-line buffering across chunk boundaries.

#### Thinking trace (with subagent nesting per §2.6)
- [ ] **P5-14** State machine per request: steps[] with `pending → live (spinner) → done (checkmark) → shimmer sweep`. Visuals match `Design System.html` §05.
- [ ] **P5-15** **Nested sub-traces** for subagent dispatch — when a `subagent_dispatch` event fires, render an indented sub-trace block with tinted left rail. Sub-trace events flow into it.
- [ ] **P5-16** Render MCP tool calls (`mcp_tool_use`) as a distinct row with the MCP server's name and tool name.
- [ ] **P5-17** Render Skill invocations (`skill_invoke`) as a distinct row with skill name + a small skill glyph.
- [ ] **P5-18** Two preset trace shapes for Research vs Strategy (existing prototype design); but allow ad-hoc steps from real events to take over once they start arriving.

#### Panel shell (faithful to prototype)
- [ ] **P5-19** `src/panels/AgentsPanel.tsx` — pulsing aurora FAB (bottom-right) opens 440px right-edge slide-out. Token-perfect against prototype.
- [ ] **P5-20** Header: mode toggle (Research / Strategy — cyan vs violet aurora), Chat / Library tabs, close. Permission mode selector (default / acceptEdits / plan / bypass) — small chip in header.
- [ ] **P5-21** Mobile / narrow viewports: full-bleed panel.
- [ ] **P5-22** Aurora avatar component (spinning OKLCH gradient ring) — visually matches §05.
- [ ] **P5-23** Composer: paperclip (file picker for txt/csv/md/images), `/` opens slash-command palette (P5b), send button. Suggested prompt chips above composer.
- [ ] **P5-24** Per-session continue button: "Continue last research conversation" (if `last_session_id` exists).

### P5b — Full Claude CLI capability surface

#### Settings panel (new surface; §2.7)
- [ ] **P5-25** `src/panels/SettingsPanel.tsx` — right-edge slide-in. Tabs: General, Models, Tools & Permissions, MCP, Skills, Hooks, Privacy.
- [ ] **P5-26** **General tab:** Claude CLI path (with "Test connection" button running `claude --version`); data refresh interval; log level (`--verbose` toggle).
- [ ] **P5-27** **Models tab:** default model selector + per-mode override (Research = Sonnet, Strategy = Opus by default; user-overridable). Model list fetched from `claude --print --model help` or hardcoded fallback.
- [ ] **P5-28** **Tools & Permissions tab:** per-mode allowed-tools / disallowed-tools editors (multi-select chips). Default Research allowlist = `Read, WebSearch, WebFetch, mcp__*, fetch_ohlc, compute_indicator, return_dataset`. Default Strategy allowlist = Research + `validate_strategy, backtest_strategy, return_strategy`.
- [ ] **P5-29** First-run gate — if `claude --version` fails, show full-screen aurora-tinted glass card "Install Claude Code CLI" with install link + "Test again" button.

#### MCP server management (§2.6)
- [ ] **P5-30** **MCP tab in Settings:** list MCP servers from `~/.claude.json` and project-scoped `.mcp.json` (under app data dir). Each row: name, transport (stdio/http/sse), status dot (connected/error/disabled), edit/remove.
- [ ] **P5-31** Add MCP server flow: form for name, command, args, env, transport. On save, write to app-managed MCP config file.
- [ ] **P5-32** Pass `--mcp-config <app-managed-path>` on every `claude` invocation so MCP servers are available.
- [ ] **P5-33** Per-conversation MCP server enable/disable: chips in panel header showing each enabled MCP server; click to toggle for next request.
- [ ] **P5-34** Surface MCP tool calls in the thinking-trace as `mcp__<server>__<tool>` rows (P5-16).
- [ ] **P5-35** MCP server health check: poll connectivity in background; show stale dot in red.

#### Skills (§2.6)
- [ ] **P5-36** **Skills tab in Settings:** discover installed skills from `~/.claude/skills/<name>/SKILL.md` and any plugin-provided skill paths. Show name, description, type (user / plugin), enable toggle.
- [ ] **P5-37** Skills auto-available to the agent (Claude CLI handles invocation via Skill tool); we just need to NOT block them in tool allowlists.
- [ ] **P5-38** Composer "suggest skill" chips: when user starts typing, surface 1–3 most relevant skills as suggestions (simple substring match on description).
- [ ] **P5-39** Render Skill invocations in thinking-trace (P5-17).

#### Slash commands (§2.6)
- [ ] **P5-40** Discover slash commands from `~/.claude/commands/<name>.md`, plugin command paths, and project-scoped `<cwd>/.claude/commands/`.
- [ ] **P5-41** Composer `/` shortcut opens slash-command palette (new surface; visually matches asset Palette per §2.7).
- [ ] **P5-42** Selecting a command inserts its template into composer input; user can edit args before sending.
- [ ] **P5-43** App-shipped trading slash commands: `/explain` (explain current chart), `/research <metric>`, `/strategy <thesis>`, `/save-current` (save active overlay/strategy).

#### Subagents (§2.6)
- [ ] **P5-44** Surface subagent dispatch in thinking-trace (P5-15).
- [ ] **P5-45** Allow Strategy mode to dispatch a `Plan`-style subagent for thesis decomposition (used in P7 prompts).
- [ ] **P5-46** Settings → Tools tab includes a "Subagents" sub-section listing custom subagent definitions discovered from `~/.claude/agents/<name>.md`.

#### Hooks (§2.6)
- [ ] **P5-47** **Hooks tab in Settings:** read `settings.json` hook configuration and display each hook (event, matcher, command). User can edit JSON inline.
- [ ] **P5-48** Hook editor validates JSON shape against documented schema; surfaces errors inline.
- [ ] **P5-49** App-managed hook scope: hooks live in `~/Library/Application Support/autoplot/settings.json` and are merged with user `~/.claude/settings.json` at runtime via `--settings`.
- [ ] **P5-50** Optional opt-in app-injected hook for telemetry/audit (logs every tool use to local rotating log).

#### Attachments (§2.6)
- [ ] **P5-51** Composer paperclip accepts: text, CSV, JSON, Markdown, PNG, JPEG.
- [ ] **P5-52** Each attachment is COPIED to the session's `cwd` jail (P5-6) before invocation; path is referenced in the user message content blocks.
- [ ] **P5-53** Image attachments embedded as base64 image content blocks per stream-json schema.
- [ ] **P5-54** Attachment chips in the composer; click to inspect / remove before send.

#### Sessions, resume, history (§2.6)
- [ ] **P5-55** SQLite schema `ai_sessions(id, mode, cwd_path, model, created_at, last_used_at, summary)`.
- [ ] **P5-56** "History" sub-view in Library: list past sessions per mode with summary; click to resume (`--resume <id>`).
- [ ] **P5-57** "New conversation" button discards `last_session_id` for that mode.

#### Permission modes (§2.6)
- [ ] **P5-58** Mode selector chip in panel header: default / acceptEdits / plan / bypassPermissions.
- [ ] **P5-59** Default = `acceptEdits` for in-app calls (we control the tool allowlist).
- [ ] **P5-60** `plan` mode used when user prefixes prompt with "/plan" or toggles plan-mode chip — Claude returns a plan without applying. UI shows the plan and asks "Apply?" before next request.
- [ ] **P5-61** `bypassPermissions` requires a one-time "I understand" dialog; logged in audit trail.

### P5c — Privacy, logging, tests

#### Privacy (G-12, §2.6)
- [ ] **P5-62** Default policy: send only computed summary (last close, 24h change, indicator values for active overlays) plus user prompt; do NOT send raw 600-bar arrays unless user explicitly attaches them.
- [ ] **P5-63** Visible privacy hint in panel header: "Sending: prompt + summary stats. Click to inspect."
- [ ] **P5-64** "Inspect outgoing payload" modal — shows exactly what will be sent to `claude` for the next request, before the user hits send.
- [ ] **P5-65** **Privacy tab in Settings:** policy override (summary-only vs full-bars), strip-PII-from-logs toggle, audit log enabled toggle.

#### Tests
- [ ] **P5-66** Rust unit tests: subprocess wrapper handles missing CLI, auth fail, non-zero exit, cancellation.
- [ ] **P5-67** Vitest: stream-json parser handles partial line buffering, malformed lines, unknown event types.
- [ ] **P5-68** Vitest: argv builder produces correct `claude` invocation for every InvokeOpts permutation.
- [ ] **P5-69** Vitest: thinking-trace state machine handles nested subagent traces correctly.
- [ ] **P5-70** Manual: each capability in §2.6 has a manual smoke test recorded in `docs/p5-smoke.md`:
  - MCP: add a known MCP server (e.g. brave-search or filesystem); ask the agent to use it; see `mcp__*` row in trace.
  - Skills: install a sample skill; ask the agent to invoke it; see Skill row in trace.
  - Slash: type `/research`; see palette; insert template; send; see normal trace.
  - Subagents: ask Strategy mode to "decompose this thesis into a plan"; see indented sub-trace.
  - Hooks: configure a no-op `PostToolUse` hook; verify it fires.
  - Attachments: drop an image of a chart pattern; see Claude reference it.
  - Resume: send a prompt; restart app; click "continue last conversation"; verify Claude has memory of prior turn.
  - Plan mode: prefix `/plan`; verify response is a plan without side effects.

## Acceptance

- Free-form prompts stream a real Claude response with thinking-trace animation driven by real subprocess events.
- All capabilities in [§2.6](./README.md#26-claude-cli-capability-surface--full-parity) have a working UI surface and a green smoke test in `docs/p5-smoke.md`.
- Settings panel covers General, Models, Tools, MCP, Skills, Hooks, Privacy tabs.
- First-run gate works (uninstall `claude` → app shows install card).
- **Visual diff:** AgentsPanel + thinking trace + aurora avatar match prototype side-by-side.

## Risks

- `claude` CLI's stream-json schema may differ between versions — parser is tolerant; pin a known-good CLI version range and document it.
- MCP servers can be flaky; surface errors clearly without breaking the agent flow.
- Tauri 2.x event API throughput at high token rates — benchmark; consider batching deltas.
- Skill discovery paths may differ across Claude Code versions — abstract behind a single resolver.

## Hands off to

[P6 — AI Co-Research Agent](./P6-research-agent.md) (Research uses tools allowlist + MCP), [P7 — AI Co-Strategy Agent + Backtest](./P7-strategy-agent.md) (Strategy uses subagents + plan mode).
