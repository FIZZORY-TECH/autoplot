/**
 * src/chrome/Headline.test.tsx — coverage for the redesigned Headline.
 *
 * Asserts:
 *  1. Stale badge appears at >60s gap, hidden at <60s, hidden when null.
 *  2. Delta pill renders with '+' / '-' sign matching the sign of the
 *     24-bar close-to-close change.
 *  3. OHLCV swap slot: both the range/volume and OHLCV rows are mounted
 *     (crossfade), and the slot parent is position: relative.
 *  4. 24h range + volume derivation uses the last 24 bars.
 *  5. Reduced-motion path: no `.tick-flash` element ever mounts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

import { Headline } from './Headline';
import { useAppStore } from '../stores/useAppStore';
import type { Bar } from '../data/MarketDataProvider';
import { fmtPrice } from '../engine/indicators';

function bar(ts: number, o: number, h: number, l: number, c: number, v: number): Bar {
  return { ts, o, h, l, c, v };
}

function fmtVolLocal(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(2) + 'K';
  return v.toFixed(2);
}

/** Build N deterministic bars with given (l, h, v) progression. */
function deterministicBars(n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const l = 100 + i;
    const h = 200 + i;
    const o = 150 + i;
    const c = 150 + i;
    const v = 10 * (i + 1);
    out.push(bar(1_700_000_000_000 + i * 3_600_000, o, h, l, c, v));
  }
  return out;
}

function setMatchMedia(matches: boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = vi.fn().mockReturnValue({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

describe('Headline', () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState({
      hoveredBarIdx: null,
      lastTickAt: null,
      loadingPhase: 'idle',
    });
    setMatchMedia(false);
  });

  // -------------------------------------------------------------------------
  // 1. Stale badge threshold
  // -------------------------------------------------------------------------

  it('shows the "stale" badge when lastTickAt is older than 60s', () => {
    const bars = deterministicBars(30);
    useAppStore.setState({ lastTickAt: Date.now() - 70_000 });
    render(<Headline bars={bars} activeSym="BTC" />);
    expect(screen.getByTestId('headline-stale-badge')).toBeTruthy();
    expect(screen.getByTestId('headline-stale-badge').textContent).toBe('stale');
  });

  it('does NOT show the "stale" badge when lastTickAt is recent', () => {
    const bars = deterministicBars(30);
    useAppStore.setState({ lastTickAt: Date.now() - 5_000 });
    render(<Headline bars={bars} activeSym="BTC" />);
    expect(screen.queryByTestId('headline-stale-badge')).toBeNull();
  });

  it('does NOT show the "stale" badge when lastTickAt is null', () => {
    const bars = deterministicBars(30);
    useAppStore.setState({ lastTickAt: null });
    render(<Headline bars={bars} activeSym="BTC" />);
    expect(screen.queryByTestId('headline-stale-badge')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Delta sign rendering
  // -------------------------------------------------------------------------

  it('renders a positive delta with a leading "+"', () => {
    // 30 bars: ref close (bar -25) = 100, last close = 200 → positive
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) {
      // ascending closes: i=5 (ref) → 100, i=29 (last) → 200
      const c = 100 + (i - 5) * (100 / 24);
      bars.push(bar(1_700_000_000_000 + i * 3_600_000, c, c + 1, c - 1, c, 100));
    }
    const { container } = render(<Headline bars={bars} activeSym="BTC" />);
    const pill = container.querySelector('.delta-pill') as HTMLElement | null;
    expect(pill).toBeTruthy();
    expect(pill!.textContent!.trim().startsWith('+')).toBe(true);
  });

  it('renders a negative delta with a leading "-"', () => {
    // descending closes — ref close > last close → negative
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) {
      const c = 200 - (i - 5) * (100 / 24);
      bars.push(bar(1_700_000_000_000 + i * 3_600_000, c, c + 1, c - 1, c, 100));
    }
    const { container } = render(<Headline bars={bars} activeSym="BTC" />);
    const pill = container.querySelector('.delta-pill') as HTMLElement | null;
    expect(pill).toBeTruthy();
    expect(pill!.textContent!.trim().startsWith('-')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. OHLCV swap on hover
  // -------------------------------------------------------------------------

  it('mounts both range/volume and OHLCV rows (crossfade); swap slot is position: relative', () => {
    const bars = deterministicBars(30);

    // Unhovered — range/volume labels visible; OHLCV still in the DOM (opacity 0).
    useAppStore.setState({ hoveredBarIdx: null });
    const { container, rerender } = render(<Headline bars={bars} activeSym="BTC" />);

    // Range labels ('L', 'H', 'Vol') and OHLCV labels ('O', 'C') both render.
    expect(container.textContent).toContain('Vol');
    expect(container.textContent).toContain('O');
    expect(container.textContent).toContain('C');

    // The swap-slot parent is position: relative (the OHLCV layout driver
    // sits in normal flow; range/volume overlays absolutely on top).
    const relSlots = Array.from(
      container.querySelectorAll('div'),
    ).filter((d) => (d as HTMLElement).style.position === 'relative');
    expect(relSlots.length).toBeGreaterThan(0);

    // Hovered — OHLCV becomes the visible row.
    act(() => {
      useAppStore.setState({ hoveredBarIdx: 10 });
    });
    rerender(<Headline bars={bars} activeSym="BTC" />);
    // Still in DOM — OHLCV labels present.
    expect(container.textContent).toContain('O');
    expect(container.textContent).toContain('H');
    expect(container.textContent).toContain('L');
    expect(container.textContent).toContain('C');
    expect(container.textContent).toContain('V');
  });

  // -------------------------------------------------------------------------
  // 4. Range/volume derivation
  // -------------------------------------------------------------------------

  it('derives 24h L/H/Vol over the last 24 bars', () => {
    const bars = deterministicBars(30);
    // Last 24 bars are indices 6..29:
    //   min low  = 100 + 6  = 106
    //   max high = 200 + 29 = 229
    //   sum vol  = sum of 10*(i+1) for i in 6..29
    let expectedVol = 0;
    for (let i = 6; i < 30; i++) expectedVol += 10 * (i + 1);

    const { container } = render(<Headline bars={bars} activeSym="BTC" />);

    const text = container.textContent ?? '';
    expect(text).toContain(fmtPrice(106));
    expect(text).toContain(fmtPrice(229));
    expect(text).toContain(fmtVolLocal(expectedVol));
  });

  // -------------------------------------------------------------------------
  // 5. Reduced-motion path
  // -------------------------------------------------------------------------

  it('never mounts a .tick-flash element when prefers-reduced-motion is set', () => {
    setMatchMedia(true);
    const bars1 = deterministicBars(30);
    const { container, rerender } = render(<Headline bars={bars1} activeSym="BTC" />);
    expect(container.querySelector('.tick-flash')).toBeNull();

    // Trigger a price change by feeding a fresh array with a different last close.
    const bars2 = bars1.slice();
    const last = bars2[bars2.length - 1];
    bars2[bars2.length - 1] = { ...last, c: last.c + 25 };
    rerender(<Headline bars={bars2} activeSym="BTC" />);

    expect(container.querySelector('.tick-flash')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Loading state renders skeleton spans
  // -------------------------------------------------------------------------

  it('renders headline-skel-price and headline-skel-pill when loadingPhase === loading', () => {
    useAppStore.setState({ loadingPhase: 'loading' });
    const bars = deterministicBars(30);
    render(<Headline bars={bars} activeSym="BTC" />);
    expect(screen.getByTestId('headline-skel-price')).toBeTruthy();
    expect(screen.getByTestId('headline-skel-pill')).toBeTruthy();
  });

  it('does NOT render skeleton spans when loadingPhase === idle', () => {
    useAppStore.setState({ loadingPhase: 'idle' });
    const bars = deterministicBars(30);
    render(<Headline bars={bars} activeSym="BTC" />);
    expect(screen.queryByTestId('headline-skel-price')).toBeNull();
    expect(screen.queryByTestId('headline-skel-pill')).toBeNull();
  });
});
