> **REMOVED 2026-05-23** — chat UI removed; this phase doc is retained for history only.

# P6 — AI Co-Research Agent

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of [P5](./P5-claude-cli.md) (full CLI capability surface). AI panel shell + claudeClient working with MCP/Skills/Subagents/Slash/Hooks. **Binding design source:** `app-design/project/agents.jsx` Research mode + dataset card layouts; `Design System.html` §05.

**Goal:** Research mode produces real, replottable, persistable datasets — leveraging MCP servers and Skills where helpful (e.g., a web-search MCP server can pull live news context; a math Skill can do indicator computation off-thread).

## Checklist

### Schema (G-10)
- [ ] **P6-1** Define Dataset Zod schema in `src/ai/schemas.ts`:
  ```ts
  Dataset = {
    id, label, color, sourceSym, kind: 'overlay' | 'series',
    values: number[], align: 'right' | 'index',
    prompt, createdAt
  }
  ```
- [ ] **P6-2** Export JSON Schema to `docs/schemas/dataset.schema.json` for documentation.

### Prompt + tools
- [ ] **P6-3** `src/ai/prompts/research.md` — system prompt explaining: app context, available indicators, expected output shape, when to call tools vs return prose.
- [ ] **P6-4** Define tool functions exposed to Claude:
  - `fetch_ohlc(sym, tf, count)` (returns last N bars)
  - `compute_indicator(sym, kind, params)` (server-computes via `engine/indicators.ts`)
  - `return_dataset(dataset)` (terminal — produces a Dataset card)
- [ ] **P6-5** Tool dispatch in `claudeClient.ts` — when Claude emits a `tool_use`, run locally, feed `tool_result` back as next message.

### Built-in presets (`docs/requirement.md` §5.6)
- [ ] **P6-6** Seed Library on first run: 30d realized vol, Correlation w/ ETH, Momentum z-score, Liquidity pressure, Funding rate proxy.
- [ ] **P6-7** Each preset has a fixed prompt + expected dataset shape; clicking the chip in composer triggers it.

### Reference data attachments
- [ ] **P6-8** Composer paperclip → file/CSV picker → parsed via `parseUserSeries` → attached as chip.
- [ ] **P6-9** Attachments serialized into prompt context (truncated/summarized if large to respect privacy default).

### Dataset card UI
- [ ] **P6-10** Inline message component: colored swatch · label · source asset · `plot` toggle.
- [ ] **P6-11** Toggling `plot` adds the AI overlay to chart with glow pass; chip in Active AI Chip Stack (top-center).
- [ ] **P6-12** `×` on chip clears the active overlay (does NOT delete from library).

### Library tab
- [ ] **P6-13** List saved datasets; row shows swatch + label + source + apply/remove.
- [ ] **P6-14** SQLite schema `datasets(id, json, created_at)`.

### Active AI Chip Stack (`docs/requirement.md` §7)
- [ ] **P6-15** `src/chrome/AIChipStack.tsx` — top-center glass chips; stacks with strategy chip ([P7](./P7-strategy-agent.md)) when both active.

### CLI capability integration
- [ ] **P6-16** Research mode tool allowlist (set in P5-28): `Read, WebSearch, WebFetch, mcp__*, fetch_ohlc, compute_indicator, return_dataset`.
- [ ] **P6-17** Permission mode for Research = `acceptEdits` (default). Plan mode available via `/plan` prefix.
- [ ] **P6-18** Default model for Research = Sonnet (faster, cheaper); user-overridable in Settings.
- [ ] **P6-19** Research-relevant MCP servers ship as suggestions in MCP tab: brave-search, fetch, time. (User installs; we just suggest.)
- [ ] **P6-20** Slash command `/research <metric>` shipped as app-bundled command (P5-43); template populates Research preset.

### Tests
- [ ] **P6-21** Vitest: schema validates real LLM output samples.
- [ ] **P6-22** Vitest: tool-dispatch round-trips.
- [ ] **P6-23** Playwright: run "30d realized vol" preset, plot dataset, restart, library still there, replot.
- [ ] **P6-24** Manual: invoke a Research prompt that uses an MCP web-search server — verify MCP rows appear in trace and source citations show up in the response.

## Acceptance

Preset and free-form prompts both produce a Dataset that plots with glow; survives reload. MCP/Skills usable from Research.

## Risks

- LLM may return malformed JSON despite system prompt — implement one-retry-with-error-feedback policy.

## Hands off to

[P7 — AI Co-Strategy Agent + Backtest](./P7-strategy-agent.md).
