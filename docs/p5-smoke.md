> **REMOVED 2026-05-23** — chat UI removed; this smoke doc is retained for history only.

# P5 — Manual Smoke Checklist

> Source: [`docs/plan/P5-claude-cli.md`](./plan/P5-claude-cli.md) (P5-70) and
> [`docs/plan/README.md`](./plan/README.md) §2.6 capability surface.
>
> This file is the manual smoke-test plan invoked at the end of Wave 2 (W2-F).
> Every capability listed in §2.6 has at least one bullet here. Each bullet
> describes **what to do**, the **expected result**, and a PASS/FAIL slot for
> the smoke runner to fill in.

Format key:

- `[ ] PASS / [ ] FAIL` — tick whichever applies.
- `[TODO W2-x follow-up]` — known deferred work; the test still records the
  current behaviour but the gap is acknowledged.
- `KNOWN-DEFER` — listed at the bottom; the smoke runner does **not** fail the
  gate on these.

---

## Pre-conditions

- [ ] PASS / [ ] FAIL — macOS or Linux dev environment with a working Tauri
  toolchain (Xcode CLT / build-essential, Rust stable via rustup).
- [ ] PASS / [ ] FAIL — `claude` CLI is installed and on `PATH`.
  Record the version observed: `claude --version` →
  `__________________________________________________` ·
  cross-checked against `SUPPORTED_CLI` from `src/ai/claudeClient.ts`
  (currently `minVersion: '1.0.0'`, `maxKnown: '2.x'` — see the
  "Supported CLI version band" section at the bottom of this file).
- [ ] PASS / [ ] FAIL — `npm install` completes; `npm run tauri:dev` boots the
  app cleanly (Rust compile is slow on first run, incremental thereafter).
- [ ] PASS / [ ] FAIL — Fresh DB. To reset state, delete the SQLite file:
  - macOS: `~/Library/Application Support/com.tauri.dev/db.sqlite`
  - Linux: `~/.local/share/com.tauri.dev/db.sqlite`

  Record the path you actually used: `__________________________________________`.
  *(The bundle id is `com.tauri.dev` in dev mode; production bundle id may
  differ — note it here so re-runs of this smoke can wipe state quickly.)*

---

## Wave 1 baseline (W1-A / W1-B / W1-C)

These are already covered by the W1 acceptance gates and re-listed here for a
green-from-zero smoke pass.

- [ ] PASS / [ ] FAIL — Open the AI panel via the FAB (bottom-right aurora
  pill). The 440px right slide-out animates in.
- [ ] PASS / [ ] FAIL — `⌘J` (macOS) / `Ctrl+J` (Linux) toggles the panel
  open/closed. Routes through `src/stores/keyboard.ts`; no competing window
  listener.
- [ ] PASS / [ ] FAIL — Send "hello" in Research mode → text streams into
  the trace. Trace transitions through pending → live → done with the
  shimmer sweep on completion. The final `result` event captures a
  `session_id` (visible in `useAIStore.lastSessionIdByMode`).
- [ ] PASS / [ ] FAIL — Cancel mid-stream by clicking the Send button while a
  request is inflight. Subprocess receives SIGTERM; the panel returns to idle
  within ~2s.
- [ ] PASS / [ ] FAIL — Browser-only mode (`npm run dev`, no Tauri runtime):
  the FAB renders but the Send button is hidden; the disabled-FAB tooltip
  reads "AI requires the desktop app".

---

## Wave 2 — §2.6 capability surface (P5-70)

### MCP — W2-B

- [ ] PASS / [ ] FAIL — Add a `brave-search` MCP server, restart the panel,
  ask Claude "search for `<topic>`". Expect a `mcp__brave_search__search` row
  in the trace.

  **How to add the server (W2-B follow-up shipped):** Settings → MCP →
  expand "Add MCP server" → fill name `brave-search`, transport `stdio`,
  command `npx`, args (one per line) `-y` and
  `@modelcontextprotocol/server-brave-search`, env (KEY=VAL on its own
  line) `BRAVE_API_KEY=<your-key>` → Save. The row appears in the merged
  list with the green health dot once the 5s poller probes it. To edit
  later, click the row's **Edit** button — the form re-expands with
  prefilled values; Save replaces the entry. **Remove** prompts an inline
  confirm before deleting.

- [ ] PASS / [ ] FAIL — **MCP merge precedence (silent).** Define a server
  named `foo` in BOTH `~/.claude.json` and `<dirs::data_dir>/autoplot/mcp.json`
  with different `command` values. Restart the panel. The MCP tab should
  show the *app version*'s command — confirming app config wins on name
  collision. (No UI hint surfaced; this is `claude` CLI's documented merge
  behaviour.)

- [ ] PASS / [ ] FAIL — MCP health check: with the brave-search server
  enabled, the row's status dot should reach the connected (green) state
  within ~5s of the MCP tab being active (W2-B follow-up shipped — a
  background poller probes every server while the tab is mounted).
  Disable the binary or flip its API key to invalid → on the next 5s
  tick the dot turns red, the row's "checked Xs ago" timestamp updates,
  the AgentsPanel header MCP chip turns red, and the "MCP unavailable"
  inline banner appears above the trace with the failing server name
  and a × to dismiss for the session.

### Skills — W2-C

- [ ] PASS / [ ] FAIL — Drop a sample SKILL.md at
  `~/.claude/skills/test-skill/SKILL.md` (any short description). Restart
  the panel → Settings → Skills tab lists it. Toggle it enabled. Send
  "use the test-skill on this prompt." Expect a `skill_invoke` row in the
  trace with the skill name.

- [ ] PASS / [ ] FAIL — Type `/` at the start of an empty composer → the
  SlashPalette opens above the textarea. The four app-shipped commands
  appear: `/explain`, `/research`, `/strategy`, `/save-current`. Any
  user/plugin/project-scoped commands appear alongside them.

- [ ] PASS / [ ] FAIL — **Slash-command precedence.** From the project
  root, drop a `<cwd>/.claude/commands/explain.md` (project-scoped). Type
  `/` → the project version shows; the app-shipped version is suppressed
  (`shadowed: true` filter in `SlashPalette.tsx`). Restart the panel; the
  effect persists.

### Hooks — W2-D1

- [ ] PASS / [ ] FAIL — Settings → Hooks tab → paste a no-op `PostToolUse`
  hook in the JSON editor:

  ```json
  {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "echo hi" }]
      }
    ]
  }
  ```

  Click Save. The green check confirms the schema validates. Send any
  prompt that triggers a tool call (e.g. "list files in this directory").
  Inspect the audit log at
  `<dirs::data_dir>/autoplot/logs/audit.log` — a JSONL line should
  appear for the `PostToolUse` event (gated on the audit-log-enabled
  toggle from Privacy tab).

- [ ] PASS / [ ] FAIL — **Audit log shape.** Enable the toggle in the
  Privacy tab → send a prompt → the log line matches the documented
  schema: `{ ts, mode, session_id, event_type, tool_name, ... }`. Path
  resolved by `auditLogPath()` (Tauri command).

### Subagents — W2-D1

- [ ] PASS / [ ] FAIL — Drop a sample agent spec at
  `~/.claude/agents/researcher.md` (with a YAML front-matter naming the
  agent). Restart the panel → Settings → Tools tab → Subagents sub-section
  lists `researcher`.

- [ ] PASS / [ ] FAIL — In Strategy mode, send the prompt:
  > Decompose this thesis using a Plan subagent: BTC mean-revert on RSI<30.

  Expect a `subagent_dispatch` row in the trace with nested children
  (or, if the CLI emits child events ambiguously, flat-rendered with a
  `[TODO P8 toast]` marker — confirm against `useAIStore.applyEvent`'s
  current `subagent_event` handling).

### Attachments — W2-E

- [ ] PASS / [ ] FAIL — Composer paperclip → pick a 1 KB CSV file. A chip
  appears in the composer with the file name + size. Send the prompt →
  the CLI receives the file as a `document` content block. Verify by
  inspecting `<dirs::data_dir>/autoplot/sessions/<id>/attachments/`
  — the file should be copied into the session jail.

- [ ] PASS / [ ] FAIL — **Image downsample.** 4096×3000 PNG (~5 MB) →
  Composer auto-downsamples to longest-edge 2048 px before upload (becomes
  2048×1500). The chip label appends "(resized)"; tooltip shows
  "<original-size> → <new-size>, resized to ≤2048px". The bytes written to
  the session jail at
  `<dirs::data_dir>/autoplot/sessions/<id>/attachments/` match the
  resized blob, not the original.

- [ ] PASS / [ ] FAIL — **Image downsample saves an over-cap image.** A
  4096×3000 JPEG that's ~12 MB at full size: Composer downsamples first,
  the result lands under 10 MB and is accepted (chip shows "(resized)").

- [ ] PASS / [ ] FAIL — **Image still over cap after downsample → reject.**
  Construct an image whose post-2048-px-resize bytes still exceed 10 MB
  (uncommon; typically requires very-high-bit-depth content). Composer
  rejects with the inline error "exceeds the 10 MB image cap even after
  resize"; the file is NOT copied to the jail and NOT sent.

### Sessions / Resume — W2-D2

- [ ] PASS / [ ] FAIL — Send a prompt → wait for `done` → restart the app.
  Open AgentsPanel → Library tab → History sub-tab. The session appears in
  the list. Click Resume → trace shell hydrates (empty steps, status
  `done`); the next Send passes `--resume <id>` to the CLI. Verify with
  the verbose CLI log if `verboseLogging` is enabled.

- [ ] PASS / [ ] FAIL — **"Continue last conversation"** — send a prompt,
  wait for `done`, then click the "Continue last conversation" button in
  Composer. Next Send passes `--continue`.

- [ ] PASS / [ ] FAIL — **"New conversation"** — clears
  `lastSessionIdByMode[mode]`. The "Continue last" button hides until a
  new session lands.

### Plan mode + Apply CTA — W2-D3

- [ ] PASS / [ ] FAIL — Prefix a prompt with `/plan ` → the hint chip
  appears below the textarea ("Plan mode for this run"). Send → the trace
  streams text steps mid-stream. On completion, all text steps fold into a
  single `plan_outline` card showing the accumulated text + an Apply CTA.

- [ ] PASS / [ ] FAIL — Click Apply on the plan outline → the prompt
  re-runs **without the `/plan ` prefix** in `acceptEdits` mode → produces
  a normal trace. Verify by inspecting the new `currentRequest`'s
  `permissionModeUsed === 'acceptEdits'`.

- [ ] PASS / [ ] FAIL — **Permission-mode chip popover.** Click the chip
  in the panel header → choose `bypassPermissions` → the confirm dialog
  appears. Confirm once → the flag persists
  (`useSettingsStore.bypassConfirmed === true`). Subsequent selections of
  bypass mode do NOT re-prompt. Reset via Privacy tab → "Clear
  bypass-confirmed flag" button → the next bypass selection re-prompts.

### Privacy — W2-G

- [ ] PASS / [ ] FAIL — The Privacy chip in the panel header reads
  "summary" (default `privacyMode === 'summary-only'`). Tooltip on hover:
  "Outgoing payload is summarised (click to inspect)".

- [ ] PASS / [ ] FAIL — Toggle Privacy tab → privacyMode → `full-bars`.
  The chip updates to "full bars" and the tooltip switches to "Outgoing
  payload includes raw bars — click to inspect".

- [ ] PASS / [ ] FAIL — **Inspect-payload modal (W2-G shipped).** Click
  the Privacy chip → modal opens centered with formatted JSON of the
  next-request `InvokeOpts` (built via `previewInvokeOpts(mode)` in
  `src/ai/claudeClient.ts` — deterministic, never writes temp files).
  Image attachment base64 `data` is elided to first 60 chars + `…
  (<size> bytes)`; text attachment bodies >2 KB collapse to a 200-char
  prefix + `... (collapsed; expand)` with an inline "Expand
  attachment[N] body" button that toggles to the full text and back.
  The Copy button writes the FULL un-elided payload JSON to the
  clipboard. Esc closes the modal (routed through the
  `src/stores/keyboard.ts` precedence chain — modal closes ahead of the
  composer-reset rung).

- [ ] PASS / [ ] FAIL — **Strip-PII toggle (audit log).** Enable in
  Privacy tab. Issue a prompt that contains a string like
  `token=abc123` or `user@example.com`. Inspect the audit-log JSONL line
  — the captured prompt is sanitised to `token=[REDACTED]` / `[EMAIL]`.
  (Note: the inline-secret regex in `src/ai/pii.ts` requires `=` or `:`
  after the keyword, so free-form `Bearer abc123` is **not** stripped —
  use `bearer:abc123` to verify the bearer pattern.)

- [ ] PASS / [ ] FAIL — **Strip-PII toggle (verbose CLI log) (W2-G).**
  With the Strip-PII toggle enabled and `verboseLogging` on
  (Settings → General), send a prompt that triggers a verbose log line
  containing `bearer:abc123`. Open the verbose log file at
  `<dirs::data_dir>/autoplot/logs/ai-stderr.log` and confirm the
  literal `bearer:abc123` has been replaced with `bearer=[REDACTED]`
  (the regex's capture group always reformats with `=`). Disable the
  toggle and re-run — the next stderr lines should be written verbatim
  again (pass-through). Stdout (`ai:event`) is **not** stripped by
  design; the live trace UI keeps the raw values for rendering.

### First-run gate — W2-A

- [ ] PASS / [ ] FAIL — **`cli-not-found`** — rename or remove `claude`
  from `PATH` (e.g. `mv $(which claude) /tmp/claude.bak`). Restart the
  app → the FirstRun modal shows the `cli-not-found` state with the
  install link + path-override input. Set the path manually back to the
  binary's location → click "Test again" → the modal clears.

- [ ] PASS / [ ] FAIL — **`cli-auth`** — break authentication by exporting
  `ANTHROPIC_API_KEY=invalid` in the CLI's environment (or unsetting it
  on a system that requires it for the test invocation). Restart the app.
  The modal shows the `cli-auth` state with copy: "Run `claude` once in
  a terminal to authenticate."

- [ ] PASS / [ ] FAIL — **`cli-version-unsupported`** — install a
  deliberately-old `claude` CLI (e.g. v0.x) → the modal shows the
  `cli-version-unsupported` state with "Detected: v0.x" and a "Continue
  anyway" button. Clicking dismisses the modal for the session.

### Concurrency / Cancellation — W1-A

- [ ] PASS / [ ] FAIL — Spam-click Send during an in-flight request. The
  second click is rejected with a `busy` state — the UI shows
  "Working… click to cancel". The first request continues to completion.

- [ ] PASS / [ ] FAIL — Cancel mid-stream during a long request. The Rust
  process receives SIGTERM; if `cwd_path` was created but no event landed
  before cancel, the half-written `ai_sessions` row is removed (verify
  with `db_ai_sessions_list`).

---

## Wave 2-G follow-up shipped

The "Inspect outgoing payload" modal previously listed in KNOWN-DEFER is now
shipped and exercised by the Privacy smoke step above:

- **W2-G — Inspect-payload modal.** The `.ag-privacy-chip` in the
  AgentsPanel header is now a button that opens a centered glass modal
  (`src/panels/InspectPayloadModal.tsx`) showing the next-request body
  built by `previewInvokeOpts(mode)` in `src/ai/claudeClient.ts`. The
  preview helper mirrors `Composer.tsx:buildInvokeOpts` exactly EXCEPT
  it never writes temp MCP / settings / attachment files — synthetic
  placeholder paths (`<temp>/<placeholder-…>`) stand in. The modal's
  Esc handler is routed through `src/stores/keyboard.ts`'s precedence
  chain (added ABOVE the "Close composer" rung); no new global keydown
  listener.

## Wave 2-B follow-up shipped

The two W2-B deferrals previously listed in KNOWN-DEFER are now complete
and exercised by the MCP smoke flow above:

- **W2-B — MCP Add/Edit/Remove forms.** Settings → MCP tab now exposes a
  collapsible "Add MCP server" form (name / transport / command + args +
  env for stdio, URL for http/sse) that writes via
  `mcpAppConfigUpsert`. App-tagged rows show **Edit** + **Remove**
  buttons; user/project rows render disabled with a tooltip explaining
  the source. Conflicts with an existing app row offer an inline "Edit
  existing" link.
- **W2-B — Background 5s health poller.** A `useEffect` inside the MCP
  tab body polls `mcp_health_check` every 5s while the tab is active
  (initial poll fires immediately on mount; cleanup clears the interval
  on tab switch / panel close). The AgentsPanel header MCP chip turns
  red when any non-conversation-disabled server is unhealthy with a
  status timestamp <30s old; an inline "MCP unavailable" banner above
  the trace surfaces the most recent error with a per-session × to
  dismiss.

## KNOWN-DEFER summary

The following items are surfaced inline above as `KNOWN-DEFER`. They are
**out of scope** for the W2 acceptance gate; the smoke run records
behaviour but does not fail on them.

_(no remaining W2-G KNOWN-DEFER items — Inspect modal shipped; see
"Wave 2-G follow-up shipped" above.)_

These are tracked as W2-x follow-ups.

---

## Supported CLI version band

The supported `claude` CLI band is exported from
[`src/ai/claudeClient.ts`](../src/ai/claudeClient.ts) as `SUPPORTED_CLI`:

```ts
export const SUPPORTED_CLI = {
  minVersion: '1.0.0',
  maxKnown: '2.x',
} as const;
```

Record the exact `claude --version` output the smoke was performed against:

```
Observed:  __________________________________________________________________

Compared to band:  1.0.0 ≤ observed ≤ 2.x ?  [ ] yes / [ ] no
```

Out-of-band CLI shifts (e.g. a new `3.x` major) get caught by the
FirstRun modal's `cli-version-unsupported` state. If observed is outside
the band, also bump `SUPPORTED_CLI.maxKnown` and rerun the smoke.

---

## `--settings` merge order verification

`commands/settings_hooks.rs` writes the app-managed `settings.json` to
`<dirs::data_dir>/autoplot/settings.json`. `ai_invoke` passes
`--settings <app-managed-path>` AFTER the user's `~/.claude/settings.json`
defaults. The assumption is that **the app config overrides the user
config on key conflict** — i.e. `--settings` merges *on top of* the user
defaults.

This is the documented `claude` CLI behaviour, but versions can shift it.

**Verification:** define the same hook entry in both
`~/.claude/settings.json` (with one `command`) and the app-managed
`settings.json` (with a different `command`). Send any prompt that fires
the hook. Inspect which `command` actually ran.

```
Observed override winner:  [ ] app config / [ ] user config / [ ] both / [ ] neither

Notes:  ____________________________________________________________________
       ____________________________________________________________________
```

If the merge order changes upstream, update
`commands/settings_hooks.rs:apply_app_settings_path` to match.

## Profile isolation (Wave 0)

The app's Claude profile lives at `<dirs::data_dir>/autoplot/claude-home/`
and is wholly isolated from the user's main `~/.claude*`. Verify each:

1. **Dir created on first boot.** `<data_dir>/autoplot/claude-home/` exists
   with subdirs `agents/`, `skills/`, `commands/`, `plugins/`, and a `settings.json`
   pre-seeded as `{}`. `.claude.json` is NOT pre-seeded — the CLI owns it.

2. **Settings isolation.** Editing the Hooks tab writes to
   `<claude-home>/settings.json`. `~/.claude/settings.json` is unchanged
   (`shasum -a 256 ~/.claude/settings.json` byte-identical pre/post).

3. **MCP isolation.** `Settings → MCP` lists only servers from
   `<data_dir>/autoplot/mcp.json` (source `app`) and
   `<claude-home>/.claude.json` (source `user`). The user's main
   `~/.claude.json` is NOT read by the listing flow.

4. **Agents/skills isolation.** `Settings → Skills` and the subagents list
   only surface entries planted under `<claude-home>/{agents,skills,plugins}/`.

5. **Argv has the three new flags.** Spawn an `ai_invoke` round-trip with
   `verbose: true` and grep the verbose log for argv:
   - `--strict-mcp-config`
   - `--setting-sources user`
   - `--mcp-config <claude-home>/.claude.json`
   - `--settings <claude-home>/settings.json`
   And the env: `CLAUDE_CONFIG_DIR=<claude-home>` set; the documented leaky
   set (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_MODEL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`)
   removed.

6. **MCP import works.** `Settings → MCP → "Import MCP servers from main
   profile"` copies `~/.claude.json:mcpServers` entries into the app config.
   Run `shasum -a 256 ~/.claude.json` pre/post — must be byte-identical
   (read-only). Run a second time → 0 imported (idempotent).

7. **Keychain reads expected, env_clear NOT used.** During a 30s session run
   `fs_usage -w -f filesys claude | grep '\.claude'` — should show ZERO
   accesses to `~/.claude*` (only `<claude-home>/*` and
   `~/Library/Keychains/...`). If `__CFBundleIdentifier`, `XPC_SERVICE_NAME`,
   `SSH_AUTH_SOCK`, or `LC_*` env vars are missing from the spawned env, we
   regressed to `env_clear()` — fix `commands/ai.rs` Command builder.

8. **Legacy detect-and-warn observed (when applicable).** If pre-Wave-0
   fragments exist at `<data_dir>/autoplot/{mcp.json, settings.json,
   commands/}`, the Tauri stderr log should contain a single
   `[legacy-profile] found pre-Wave-0 fragment at <path>; left in place
   (no migration)` line per detected path. We do NOT migrate, move, or delete.
