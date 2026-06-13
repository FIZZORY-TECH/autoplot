# ADR-0004: Design Adoption Is Binding (`app-design/project/` Is the Spec)

Status: Accepted (2026-05-10)

## Context

`./app-design/project/` is a ~5.5k-LOC HTML/JSX prototype of the full UI with deterministic mock data. The user has explicitly approved this prototype as the accepted design — `docs/plan/README.md` §2.5 states it is "not a reference, it is the approved specification." Production must reproduce its tokens, glass treatments, animations, component shapes, and interaction patterns at pixel fidelity.

When the prototype's `Design System.html` and the older `app.css` disagree, `Design System.html` wins (per §2.5 token reconciliation rules). New colors, easings, radii, or visual paradigms beyond what the prototype specifies require explicit user approval (§2.5, §2.7, §2.9). Each UI-touching phase ends with a side-by-side visual diff against the prototype, and acceptance requires the diff to pass.

The prototype's INTERNAL code (its `window.*` globals, `<script type="text/babel">` loading) is NOT preserved — production uses idiomatic React + TS. Copying prototype source files into `src/` and renaming them is explicitly forbidden (§2.5 line 85): the prototype is a visual + behavioral specification, not a code template.

## Decision

Production UI MUST achieve token-for-token, motion-for-motion, hairline-for-hairline parity with `app-design/project/`. When tokens conflict, `Design System.html` is authoritative over `app.css`. Adding a new color, easing, radius, animation curve, or visual paradigm not present in the prototype REQUIRES explicit user approval. Do NOT copy prototype files into `src/` — port idiomatically into the existing component/store/hook architecture. Always edit existing files in `src/chrome/`, `src/chart/`, `src/panels/`, `src/components/`, `src/styles/`; never create separate mockup HTML at `docs/`, `mockups/`, etc.

## Consequences

- Visual drift from the prototype is a phase-acceptance blocker; each UI-touching phase (P0, P1, P2, P3, P5, P6, P7, P8) requires a passing visual diff.
- Introducing a fresh palette token, easing curve, or radius without user sign-off is forbidden.
- Copy-pasting prototype `.html`/`.jsx` into `src/` is forbidden; idiomatic TS port only.
- New surfaces required by added requirements (Settings panel, MCP/Skills UI) MUST inherit the existing token system — no fresh design language (§2.7).
- The `prototype-fidelity` skill MUST be invoked for any UI edit, audit, or screenshot diff.

Source: docs/plan/README.md:64-88, docs/plan/README.md:127-140, .claude/skills/prototype-fidelity/SKILL.md
