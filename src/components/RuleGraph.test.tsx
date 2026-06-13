/**
 * src/components/RuleGraph.test.tsx — W5-C12
 *
 *   - 4 nodes (Trigger → Filter → Entry → Exit) when filters present
 *   - 3 nodes (Trigger → Entry → Exit) when filters absent
 *   - AND-pills render for each condition with `indicator op value` text
 *   - Edges count = nodes - 1
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { RuleGraph } from './RuleGraph';
import type { Strategy } from '../ai/schemas';

function makeRules(withFilters: boolean): Strategy['rules'] {
  return {
    entry: [
      { indicator: 'rsi', op: '<', value: 30, params: { period: 14 } },
      { indicator: 'close', op: '>', value: { ref: 'sma', params: { period: 200 } } },
    ],
    exit: [
      { indicator: 'rsi', op: '>', value: 55, params: { period: 14 } },
    ],
    ...(withFilters
      ? { filters: [{ indicator: 'volume', op: '>', value: 1000 }] }
      : {}),
  };
}

describe('RuleGraph', () => {
  afterEach(() => cleanup());

  it('renders 4 nodes when filters are present', () => {
    const { getAllByTestId, getByTestId } = render(<RuleGraph rules={makeRules(true)} />);
    const nodes = getAllByTestId(/^rule-node-/);
    expect(nodes.length).toBe(4);
    expect(getByTestId('rule-node-trigger')).toBeTruthy();
    expect(getByTestId('rule-node-filter')).toBeTruthy();
    expect(getByTestId('rule-node-entry')).toBeTruthy();
    expect(getByTestId('rule-node-exit')).toBeTruthy();
    // 3 edges between 4 nodes.
    expect(getAllByTestId('rule-edge').length).toBe(3);
  });

  it('renders 3 nodes when filters are absent (Trigger → Entry → Exit)', () => {
    const { getAllByTestId, queryByTestId, getByTestId } = render(
      <RuleGraph rules={makeRules(false)} />,
    );
    const nodes = getAllByTestId(/^rule-node-/);
    expect(nodes.length).toBe(3);
    expect(queryByTestId('rule-node-filter')).toBeNull();
    expect(getByTestId('rule-node-trigger')).toBeTruthy();
    expect(getByTestId('rule-node-entry')).toBeTruthy();
    expect(getByTestId('rule-node-exit')).toBeTruthy();
    // 2 edges between 3 nodes.
    expect(getAllByTestId('rule-edge').length).toBe(2);
  });

  it('renders AND-pills with indicator op value text', () => {
    const { getByTestId } = render(<RuleGraph rules={makeRules(true)} />);
    const entry = getByTestId('rule-node-entry');
    // Two entry conditions → two pills.
    expect(entry.textContent).toContain('rsi(14) < 30');
    expect(entry.textContent).toContain('close > sma(200)');
    // The exit node has one condition.
    const exit = getByTestId('rule-node-exit');
    expect(exit.textContent).toContain('rsi(14) > 55');
  });
});
