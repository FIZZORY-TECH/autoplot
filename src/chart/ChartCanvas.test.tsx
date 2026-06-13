/**
 * src/chart/ChartCanvas.test.tsx — Asset-switch transition tests.
 *
 * Asserts:
 *  1. Skeleton baseline marker renders when loadingPhase === 'loading'.
 *  2. Skeleton baseline marker is absent when loadingPhase === 'idle'.
 *  3. Chart container carries data-loading-phase attribute tracking the phase.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChartCanvas } from './ChartCanvas';
import { useAppStore } from '../stores/useAppStore';
import type { Bar } from '../data/MarketDataProvider';

function makeBars(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 3_600_000,
    o: 100,
    h: 110,
    l: 90,
    c: 105,
    v: 1_000,
  }));
}

const MOCK_VIEW = { start: 0, end: 10, yMin: 80, yMax: 120 };

describe('ChartCanvas skeleton baseline', () => {
  beforeEach(() => {
    cleanup();
    // Reset loadingPhase to idle before each test.
    useAppStore.setState({ loadingPhase: 'idle' });
  });

  it('renders the skeleton baseline marker during loadingPhase === loading', () => {
    useAppStore.setState({ loadingPhase: 'loading' });
    render(
      <ChartCanvas
        bars={makeBars(10)}
        view={MOCK_VIEW}
      />,
    );
    expect(screen.getByTestId('chart-skeleton-baseline')).toBeTruthy();
  });

  it('does NOT render the skeleton baseline marker during loadingPhase === idle', () => {
    useAppStore.setState({ loadingPhase: 'idle' });
    render(
      <ChartCanvas
        bars={makeBars(10)}
        view={MOCK_VIEW}
      />,
    );
    expect(screen.queryByTestId('chart-skeleton-baseline')).toBeNull();
  });

  it('does NOT render the skeleton baseline marker during loadingPhase === exit', () => {
    useAppStore.setState({ loadingPhase: 'exit' });
    render(
      <ChartCanvas
        bars={makeBars(10)}
        view={MOCK_VIEW}
      />,
    );
    expect(screen.queryByTestId('chart-skeleton-baseline')).toBeNull();
  });

  it('does NOT render the skeleton baseline marker during loadingPhase === reveal', () => {
    useAppStore.setState({ loadingPhase: 'reveal' });
    render(
      <ChartCanvas
        bars={makeBars(10)}
        view={MOCK_VIEW}
      />,
    );
    expect(screen.queryByTestId('chart-skeleton-baseline')).toBeNull();
  });

  it('carries data-loading-phase attribute matching the store phase', () => {
    useAppStore.setState({ loadingPhase: 'loading' });
    const { container } = render(
      <ChartCanvas
        bars={makeBars(10)}
        view={MOCK_VIEW}
      />,
    );
    const wrap = container.querySelector('[data-loading-phase]');
    expect(wrap).toBeTruthy();
    expect(wrap!.getAttribute('data-loading-phase')).toBe('loading');
  });
});
