/**
 * src/panels/StrategyCard.test.tsx — W5-C12
 *
 *   - 4 perf states (valid / Indicative N<10 / N=null empty / loading=undefined)
 *   - mutual exclusion of `apply` toggle across two cards
 *   - mode='plan-outline' shows primary Apply CTA, NOT the chip toggle
 *   - mode='normal' shows the chip toggle, NOT the primary Apply CTA
 *   - footnote present on every card
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { StrategyCard } from './StrategyCard';
import { useAppStore } from '../stores/useAppStore';
import type { Strategy } from '../ai/schemas';

function makeStrategy(id: string, perf: Strategy['perf']): Strategy {
  return {
    id,
    name: `Strategy ${id}`,
    thesis: 'Test thesis',
    rules: {
      entry: [{ indicator: 'rsi', op: '<', value: 30, params: { period: 14 } }],
      exit: [{ indicator: 'rsi', op: '>', value: 55, params: { period: 14 } }],
    },
    perf,
    version: 1,
    createdAt: 1_700_000_000_000,
  };
}

describe('StrategyCard', () => {
  beforeEach(() => {
    useAppStore.setState({ aiActiveStrategyId: null, aiActiveStrategyTrades: null });
  });
  afterEach(() => cleanup());

  it('renders valid perf stats when N >= 10', () => {
    render(
      <StrategyCard
        strategy={makeStrategy('a', { winRate: 0.58, sharpe: 1.42, maxDrawdown: -0.082, trades: 41 })}
      />,
    );
    expect(screen.getByTestId('strat-perf')).toBeTruthy();
    expect(screen.queryByTestId('strat-perf-badge-indicative')).toBeNull();
    expect(screen.getByText(/41/)).toBeTruthy();
  });

  it('shows Indicative badge when N < 10', () => {
    render(
      <StrategyCard
        strategy={makeStrategy('a', { winRate: 0.5, sharpe: 0.4, maxDrawdown: -0.05, trades: 4 })}
      />,
    );
    expect(screen.getByTestId('strat-perf-badge-indicative')).toBeTruthy();
  });

  it('shows empty-state message and Indicative badge when perf is null', () => {
    render(<StrategyCard strategy={makeStrategy('a', null)} />);
    expect(screen.getByTestId('strat-perf-empty')).toBeTruthy();
    expect(screen.getByTestId('strat-perf-badge-indicative')).toBeTruthy();
    expect(screen.getByText(/No trades found in window/i)).toBeTruthy();
  });

  it('renders loading shimmer when perf is undefined', () => {
    render(<StrategyCard strategy={makeStrategy('a', undefined)} />);
    expect(screen.getByTestId('strat-perf-loading')).toBeTruthy();
    expect(screen.queryByTestId('strat-perf')).toBeNull();
  });

  it('always renders the v1 fees/slippage footnote', () => {
    render(<StrategyCard strategy={makeStrategy('a', null)} />);
    expect(screen.getByTestId('strategy-footnote').textContent).toMatch(
      /fees and slippage ignored/i,
    );
  });

  it('mutual exclusion: toggling card B clears card A', () => {
    const a = makeStrategy('a', { winRate: 0.5, sharpe: 1, maxDrawdown: -0.05, trades: 20 });
    const b = makeStrategy('b', { winRate: 0.6, sharpe: 1.1, maxDrawdown: -0.06, trades: 30 });
    const { container } = render(
      <>
        <StrategyCard strategy={a} />
        <StrategyCard strategy={b} />
      </>,
    );
    const toggles = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="strategy-apply-toggle"]',
    );
    expect(toggles.length).toBe(2);

    // Apply card A.
    fireEvent.click(toggles[0]);
    expect(useAppStore.getState().aiActiveStrategyId).toBe('a');
    expect(toggles[0].getAttribute('aria-pressed')).toBe('true');
    expect(toggles[1].getAttribute('aria-pressed')).toBe('false');

    // Apply card B → A clears.
    fireEvent.click(toggles[1]);
    expect(useAppStore.getState().aiActiveStrategyId).toBe('b');
    expect(toggles[0].getAttribute('aria-pressed')).toBe('false');
    expect(toggles[1].getAttribute('aria-pressed')).toBe('true');

    // Toggle card B off → null.
    fireEvent.click(toggles[1]);
    expect(useAppStore.getState().aiActiveStrategyId).toBeNull();
  });

  it('mode=plan-outline shows primary Apply CTA and NOT the chip toggle', () => {
    const onApply = vi.fn();
    render(
      <StrategyCard
        mode="plan-outline"
        strategy={makeStrategy('a', null)}
        onApply={onApply}
      />,
    );
    const primary = screen.getByTestId('strategy-apply-primary');
    expect(primary).toBeTruthy();
    expect(screen.queryByTestId('strategy-apply-toggle')).toBeNull();
    fireEvent.click(primary);
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('mode=normal shows the chip toggle and NOT the primary Apply CTA', () => {
    render(<StrategyCard strategy={makeStrategy('a', null)} />);
    expect(screen.getByTestId('strategy-apply-toggle')).toBeTruthy();
    expect(screen.queryByTestId('strategy-apply-primary')).toBeNull();
  });
});
