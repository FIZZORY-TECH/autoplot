> **REMOVED 2026-05-23** — chat UI removed; this phase doc is retained for history only.

# P7 — AI Co-Strategy Agent + Backtest Engine

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of [P6](./P6-research-agent.md). **Binding design source:** `app-design/project/agents.jsx` Strategy mode + strategy card layouts + animated rule-graph (Trigger → Filter → Entry → Exit nodes); `Design System.html` §05 strategy node flow.

**Goal:** Strategy mode → Claude (often via dispatched Plan-style subagent for thesis decomposition) proposes rules in DSL → local engine executes them on real bars → real WR/Sharpe/DD/N → signals render on chart.

## Checklist

### Schema (G-9)
- [ ] **P7-1** Define Strategy DSL Zod schema in `src/ai/schemas.ts`:
  ```ts
  Strategy = {
    id, name, thesis,
    rules: {
      entry: Condition[],   // AND-of-conditions
      exit: Condition[],
      filters?: Condition[]
    },
    perf?: { wr, sharpe, dd, n },
    version: 1,
    createdAt
  }
  Condition = { indicator, op, value, params? }
  ```
- [ ] **P7-2** Export to `docs/schemas/strategy.schema.json`.
- [ ] **P7-3** DSL `version` field for future migrations (G-18).

### Backtest engine
- [ ] **P7-4** `src/engine/backtest.ts` — pure function `(bars, strategy) → { trades, perf }`.
- [ ] **P7-5** Walk bars; evaluate entry conditions on each bar; track open position; evaluate exit conditions; record paired trades.
- [ ] **P7-6** Compute perf: WR (win rate), Sharpe (annualised on returns), DD (max drawdown), N (trade count).
- [ ] **P7-7** Vitest golden tests for known toy strategies (e.g., RSI<30 buy / RSI>70 sell on a synthetic series).

### Prompt + tools
- [ ] **P7-8** `src/ai/prompts/strategy.md` — system prompt with DSL grammar + few-shot examples.
- [ ] **P7-9** Tools: `fetch_ohlc`, `validate_strategy(json)` (returns ok or error), `backtest_strategy(json)` (returns perf), `return_strategy(strategy)` (terminal).
- [ ] **P7-10** Validation pipeline: Claude returns rules → Zod parse → if fails, feed error back to Claude (one retry) → backtest → return.

### Strategy card UI
- [ ] **P7-11** Inline card: name + animated rule graph + perf stats (WR / SR / DD / N).
- [ ] **P7-12** `apply` toggle pushes signals onto chart.
- [ ] **P7-13** Animated rule graph: horizontal flow Trigger → Filter → Entry → Exit, color-coded, edges fade in.

### Chart signal rendering (`docs/requirement.md` §6.5)
- [ ] **P7-14** Buy = upward green triangle below price; Sell = downward red triangle above price.
- [ ] **P7-15** Dashed connector between paired buy/sell — green if profitable, red if losing.
- [ ] **P7-16** Active strategy chip in Active AI Chip Stack with signal count.

### Edits (no manual editor — AI only)
- [ ] **P7-17** "Tighten stop to 2%" or similar prompt → send current strategy JSON + edit prompt to Claude → return updated DSL → re-validate + re-backtest → update card.

### Built-in presets (`docs/requirement.md` §6.7)
- [ ] **P7-18** Seed Library on first run: RSI(14) mean-revert, Donchian 20/10 breakout. Use real DSL, not hard-coded signals.

### Library tab (Strategy)
- [ ] **P7-19** SQLite schema `strategies(id, json, created_at)`.
- [ ] **P7-20** Card shows rule graph + compact perf + apply/remove.

### CLI capability integration
- [ ] **P7-21** Strategy mode tool allowlist (set in P5-28): Research's set + `validate_strategy, backtest_strategy, return_strategy`.
- [ ] **P7-22** Default model for Strategy = Opus (better reasoning for rule design); user-overridable.
- [ ] **P7-23** Subagent dispatch: Strategy system prompt instructs Claude to consider dispatching a `Plan`-type subagent for thesis decomposition before authoring rules. Sub-traces render via P5-15.
- [ ] **P7-24** Plan-mode integration: prefixing `/plan` runs Strategy in `--permission-mode plan`; output is a strategy outline that the user must explicitly "Apply" to materialise the DSL + backtest.
- [ ] **P7-25** Slash command `/strategy <thesis>` shipped (P5-43).

### Tests
- [ ] **P7-26** Vitest: full backtest pipeline — synthetic bars + known strategy → expected trades.
- [ ] **P7-27** Playwright: describe a thesis, see strategy with real perf, apply, see signals.
- [ ] **P7-28** Manual: ask Strategy to "decompose this thesis using a Plan subagent"; verify nested sub-trace renders correctly.

## Acceptance

Describing a thesis produces a backtested strategy with real numbers; signals render correctly; editing a strategy updates the chart; subagent dispatch and plan-mode both work end-to-end.

## Risks

- Sharpe calc on small N is noisy — mark perf as "indicative" when N < 10.
- Backtest performance — 600 bars × small ruleset is trivial; if user later wants 5000 bars, profile.

## Hands off to

[P8 — Polish, Performance, A11y](./P8-polish.md).
