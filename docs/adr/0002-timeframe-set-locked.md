# ADR-0002: Timeframe Set Locked to 4-Tier (G-4)

Status: Accepted (2026-05-10)

## Context

The `Tf` type in `src/data/MarketDataProvider.ts` is declared as the union `'1h' | '4h' | '1d' | '1w'` with the explicit comment: "Canonical 4-tier timeframe set. User-locked per G-4 resolution. Do NOT add 5m or 15m."

The `app-design/project/` prototype renders a 6-tier control (including `5m` and `15m`), but per `docs/plan/README.md` the G-4 gap was explicitly resolved in favor of the 4-tier set sourced from `docs/requirement.md §4.2`. The prototype's 6-tier toolbar is NOT the spec on this dimension.

Locking the timeframe set keeps the chart-type morph, the y-range animation, the warm-bar cache schema, and the per-provider rate budgets all calibrated to a known, finite axis. Adding sub-hourly timeframes would also require new WS streams, new bar-aggregation logic, and a higher rate ceiling for every provider.

## Decision

The timeframe vocabulary is `'1h' | '4h' | '1d' | '1w'` and only that. Do NOT widen `Tf`. Adapters MUST refuse any other timeframe value at the boundary. UI surfaces (toolbar, palette, agent prompts) MUST expose only these four tokens, regardless of what the prototype shows.

## Consequences

- Adding `'5m'`, `'15m'`, `'30m'`, `'12h'`, `'1mo'`, etc. to `Tf` is forbidden.
- The toolbar, command palette, AI agent argument schemas, and persisted settings MUST whitelist only the four tokens.
- Provider adapters MAY internally request finer granularity for aggregation but MUST NOT surface non-canonical timeframes through `MarketDataProvider`.
- The prototype's 6-tier toolbar is reproduced visually with only the four tokens enabled; any additional tokens shown in the prototype are dropped (per §2.5 component fidelity yields to G-4).
- A change requires a new ADR superseding this one, explicit user approval, and coordinated review of provider rate budgets and the warm-bar schema.

Source: src/data/MarketDataProvider.ts:5-6, docs/plan/README.md:219, docs/plan/README.md:330
