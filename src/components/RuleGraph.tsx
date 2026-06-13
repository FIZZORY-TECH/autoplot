/**
 * src/components/RuleGraph.tsx — Wave 5 / W5-C12 (P7 Co-Strategy)
 *
 * Horizontal flow visualisation of a `Strategy.rules` shape:
 *
 *     Trigger → [Filter] → Entry → Exit
 *
 * The "Trigger" node is a synthetic anchor — there is no `trigger` field in
 * the schema; it serves as a visual on-ramp so the diagram reads left→right
 * with a starting point. The Filter node is omitted when `rules.filters` is
 * absent (Trigger connects directly to Entry).
 *
 * Each node renders compact AND-pills inside (one pill per condition) using
 * the `indicator op value` format. The first node ("Trigger") shows the
 * first entry condition — by convention the first entry rule IS the trigger.
 *
 * Token-fidelity (per `app-design/project/app.css` §1633–1672):
 *   - `.strat-flow`, `.strat-node`, `.strat-edge`, `.sn-badge`, `.sn-body`,
 *     `.sn-kind`, `.sn-label` — verbatim class names, all already declared
 *     in `app.css` and inherited via `agents.css` / token import.
 *   - Per-stage badge colors (trigger=amber, filter=cyan, entry=emerald,
 *     exit=rose) come from the existing rules and are NOT redeclared here.
 *   - Animations: `nodeIn` 360ms ease + `edgeIn` 360ms ease cascade — defined
 *     in `app.css`. We just stagger via inline `animationDelay`.
 *
 * No new colors/tokens introduced.
 */

import React from 'react';
import type { Strategy, StrategyCondition, IndicatorRef } from '../ai/schemas';

type RuleKind = 'trigger' | 'filter' | 'entry' | 'exit';

const KIND_BADGE: Record<RuleKind, string> = {
  trigger: 'T',
  filter: 'F',
  entry: 'E',
  exit: 'X',
};

const KIND_LABEL: Record<RuleKind, string> = {
  trigger: 'trigger',
  filter: 'filter',
  entry: 'entry',
  exit: 'exit',
};

function formatRhs(value: number | IndicatorRef): string {
  if (typeof value === 'number') {
    // Trim trailing zeros for readability.
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  }
  // IndicatorRef — show ref(period) when a period-like param is present.
  const params = value.params ?? {};
  const period = params.period ?? params.length ?? params.n;
  return period != null ? `${value.ref}(${period})` : value.ref;
}

function formatCondition(c: StrategyCondition): string {
  const params = c.params ?? {};
  const period = params.period ?? params.length ?? params.n;
  const lhs = period != null ? `${c.indicator}(${period})` : c.indicator;
  return `${lhs} ${c.op} ${formatRhs(c.value)}`;
}

interface NodeProps {
  kind: RuleKind;
  conditions: StrategyCondition[];
  delayMs: number;
}

function Node({ kind, conditions, delayMs }: NodeProps): JSX.Element {
  return (
    <div
      className={`strat-node ${kind}`}
      data-testid={`rule-node-${kind}`}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <span className="sn-badge" aria-hidden>
        {KIND_BADGE[kind]}
      </span>
      <div className="sn-body">
        <span className="sn-kind">{KIND_LABEL[kind]}</span>
        {conditions.length > 0 ? (
          <span className="sn-label rule-graph-pills">
            {conditions.map((c, i) => (
              <span className="rule-graph-pill" key={i}>
                {formatCondition(c)}
              </span>
            ))}
          </span>
        ) : (
          <span className="sn-label">—</span>
        )}
      </div>
    </div>
  );
}

function Edge({ delayMs }: { delayMs: number }): JSX.Element {
  return (
    <div
      className="strat-edge"
      aria-hidden
      data-testid="rule-edge"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <svg viewBox="0 0 14 14" width="14" height="14">
        <path
          d="M2 7h10M9 4l3 3-3 3"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export interface RuleGraphProps {
  rules: Strategy['rules'];
}

export function RuleGraph({ rules }: RuleGraphProps): JSX.Element {
  const hasFilter = !!rules.filters && rules.filters.length > 0;

  // The "trigger" node mirrors the first entry condition by convention.
  // The "entry" node shows all entry conditions (including the trigger)
  // so the AND-clause stays accurate.
  const triggerConds: StrategyCondition[] = rules.entry.slice(0, 1);

  const nodes: { kind: RuleKind; conds: StrategyCondition[] }[] = [
    { kind: 'trigger', conds: triggerConds },
    ...(hasFilter ? [{ kind: 'filter' as RuleKind, conds: rules.filters! }] : []),
    { kind: 'entry', conds: rules.entry },
    { kind: 'exit', conds: rules.exit },
  ];

  return (
    <div className="strat-flow" data-testid="rule-graph">
      {nodes.map((n, i) => (
        <React.Fragment key={n.kind}>
          <Node kind={n.kind} conditions={n.conds} delayMs={i * 120} />
          {i < nodes.length - 1 && <Edge delayMs={i * 120 + 60} />}
        </React.Fragment>
      ))}
    </div>
  );
}

export default RuleGraph;
