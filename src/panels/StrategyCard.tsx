/**
 * src/panels/StrategyCard.tsx — Wave 5 / W5-C12 (P7 Co-Strategy)
 *
 * The user-facing surface for an AI-drafted strategy. Renders:
 *
 *   - Name + thesis
 *   - Embedded `<RuleGraph>` of `strategy.rules`
 *   - Perf stats panel (win rate / Sharpe / max DD / N), with an "Indicative"
 *     badge when N < 10 (or perf === null), and a "No trades found in window"
 *     fallback when perf === null
 *   - One of two CTAs (NEVER both):
 *       • mode='normal'        → `apply` chip-toggle (sets `aiActiveStrategyId`).
 *                                 Mutually exclusive across all StrategyCards.
 *       • mode='plan-outline'  → primary `Apply` button (calls `onApply` so
 *                                 the parent can re-run the prompt outside
 *                                 of plan-mode in `acceptEdits`).
 *   - Footnote: "Fees and slippage ignored in v1."
 *
 * Loading state (`perf === undefined`) renders a shimmer placeholder for
 * the perf row.
 *
 * Token-fidelity: `.strat-card`, `.strat-card-head`, `.strat-name`, and
 * `.strat-perf` are all declared in `app-design/project/app.css` §1593–1672.
 * Additional styles (Indicative badge, footnote, primary Apply CTA, loading
 * shimmer) are appended to `src/styles/agents.css` under the W5-C12 banner.
 * They reuse existing tokens (--ink-0/1/3, --hairline, --ease).
 */

import { useAppStore } from '../stores/useAppStore';
import { RuleGraph } from '../components/RuleGraph';
import type { Strategy, PerfStats } from '../ai/schemas';

export interface StrategyCardProps {
  strategy: Strategy;
  onApply?: () => void;
  onDelete?: () => void;
  /**
   * 'normal' (default) — show the apply chip-toggle.
   * 'plan-outline'      — show the primary Apply CTA only (no toggle).
   *                       Used by the AgentsPanel when rendering plan-mode
   *                       outline cards before the strategy is validated.
   */
  mode?: 'normal' | 'plan-outline';
}

const N_INDICATIVE_THRESHOLD = 10;

function formatPct(v: number, digits = 1): string {
  return (v * 100).toFixed(digits) + '%';
}

function formatSharpe(v: number): string {
  return v.toFixed(2);
}

interface PerfRowProps {
  perf: PerfStats | null | undefined;
}

function PerfRow({ perf }: PerfRowProps): JSX.Element {
  // Loading state — perf===undefined means backtest hasn't finished.
  if (perf === undefined) {
    return (
      <div className="strat-perf compact" data-testid="strat-perf-loading">
        <span className="strat-perf-shimmer" aria-label="Loading perf stats" />
      </div>
    );
  }

  // Empty state — perf===null means N=0 trades in the window.
  if (perf === null) {
    return (
      <div
        className="strat-perf compact strat-perf-indicative"
        data-testid="strat-perf-empty"
      >
        <span className="strat-perf-badge" data-testid="strat-perf-badge-indicative">
          Indicative
        </span>
        <span className="strat-perf-empty-msg">No trades found in window</span>
      </div>
    );
  }

  const indicative = perf.trades < N_INDICATIVE_THRESHOLD;
  return (
    <div
      className={`strat-perf compact${indicative ? ' strat-perf-indicative' : ''}`}
      data-testid="strat-perf"
    >
      {indicative && (
        <span className="strat-perf-badge" data-testid="strat-perf-badge-indicative">
          Indicative
        </span>
      )}
      <span>
        {formatPct(perf.winRate, 0)} <i>WR</i>
      </span>
      <span>
        {formatSharpe(perf.sharpe)} <i>Sharpe</i>
      </span>
      <span>
        {formatPct(perf.maxDrawdown, 1)} <i>DD</i>
      </span>
      <span>
        {perf.trades} <i>N</i>
      </span>
    </div>
  );
}

export function StrategyCard({
  strategy,
  onApply,
  onDelete,
  mode = 'normal',
}: StrategyCardProps): JSX.Element {
  const activeStrategyId = useAppStore((s) => s.aiActiveStrategyId);
  const setActive = useAppStore((s) => s.setAiActiveStrategy);

  const isApplied = activeStrategyId === strategy.id;

  const onToggleApply = (): void => {
    // Mutual exclusion — setting a non-null id auto-clears any prior;
    // toggling OFF clears unconditionally. We DO NOT pass trades here:
    // the Composer is responsible for stashing the backtest output the
    // moment a strategy is applied. Without trades the chart signals
    // pass simply renders nothing — graceful empty state.
    if (isApplied) {
      setActive(null);
    } else {
      setActive(strategy.id);
    }
  };

  return (
    <div className="strat-card" data-testid="strategy-card">
      <div className="strat-card-head">
        <span className="strat-name">{strategy.name}</span>
        {mode === 'normal' ? (
          <button
            type="button"
            className={`ds-toggle ${isApplied ? 'on' : ''}`}
            onClick={onToggleApply}
            aria-pressed={isApplied}
            data-testid="strategy-apply-toggle"
          >
            {isApplied ? 'on chart' : 'apply'}
          </button>
        ) : (
          // Plan-outline mode hides the toggle entirely so the two CTAs
          // never collide. The primary Apply button is rendered in the
          // footer below.
          onDelete && (
            <button
              type="button"
              className="ds-toggle"
              onClick={onDelete}
              aria-label="Discard outline"
              data-testid="strategy-discard"
            >
              discard
            </button>
          )
        )}
      </div>

      {strategy.thesis && (
        <p className="strat-thesis" data-testid="strategy-thesis">
          {strategy.thesis}
        </p>
      )}

      <RuleGraph rules={strategy.rules} />

      <PerfRow perf={strategy.perf} />

      {mode === 'plan-outline' && (
        <div className="strat-card-footer-cta">
          <button
            type="button"
            className="strat-apply-primary"
            onClick={onApply}
            data-testid="strategy-apply-primary"
          >
            Apply
          </button>
        </div>
      )}

      <p className="strat-footnote" data-testid="strategy-footnote">
        Fees and slippage ignored in v1.
      </p>
    </div>
  );
}

export default StrategyCard;
