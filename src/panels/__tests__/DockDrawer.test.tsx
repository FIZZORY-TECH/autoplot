/**
 * src/panels/__tests__/DockDrawer.test.tsx — Step 3 reusable drawer shell.
 *
 * Covers the three behaviors the wrapping steps depend on:
 *   1. mountOnOpen={false} (default) keeps children in the DOM when open=false
 *      (mount-stable: stable DOM for a11y / Playwright).
 *   2. mountOnOpen={true} renders children while open and UNMOUNTS them after
 *      close (verified via both the animationend path and the fallback timer).
 *   3. side='left' vs 'right' apply the correct edge positioning.
 *
 * Mirrors the repo's jsdom + testing-library setup (see TerminalPanel.test.tsx).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DockDrawer } from '../DockDrawer';

afterEach(() => {
  vi.useRealTimers();
});

describe('DockDrawer', () => {
  it('1. mountOnOpen=false keeps children mounted when open=false', () => {
    const { rerender } = render(
      <DockDrawer id="d1" side="right" ariaLabel="Test drawer" open>
        <div data-testid="child">body</div>
      </DockDrawer>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();

    rerender(
      <DockDrawer id="d1" side="right" ariaLabel="Test drawer" open={false}>
        <div data-testid="child">body</div>
      </DockDrawer>,
    );
    // Mount-stable: children stay in the DOM (off-screen), never unmounted.
    expect(screen.getByTestId('child')).toBeInTheDocument();
    // The drawer container itself is also still present.
    expect(screen.getByTestId('d1')).toBeInTheDocument();
  });

  it('2a. mountOnOpen=true renders children when open, unmounts on animationend', () => {
    const { rerender } = render(
      <DockDrawer id="d2" side="right" ariaLabel="Test drawer" mountOnOpen open>
        <div data-testid="child">body</div>
      </DockDrawer>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();

    // Close → drawer stays mounted to play the closing animation.
    rerender(
      <DockDrawer
        id="d2"
        side="right"
        ariaLabel="Test drawer"
        mountOnOpen
        open={false}
      >
        <div data-testid="child">body</div>
      </DockDrawer>,
    );
    expect(screen.queryByTestId('child')).toBeInTheDocument();

    // animationend fires → children unmount.
    fireEvent.animationEnd(screen.getByTestId('d2'));
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('d2')).not.toBeInTheDocument();
  });

  it('2b. mountOnOpen=true unmounts via the fallback timer if animationend never fires', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <DockDrawer id="d3" side="left" ariaLabel="Test drawer" mountOnOpen open>
        <div data-testid="child">body</div>
      </DockDrawer>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();

    rerender(
      <DockDrawer
        id="d3"
        side="left"
        ariaLabel="Test drawer"
        mountOnOpen
        open={false}
      >
        <div data-testid="child">body</div>
      </DockDrawer>,
    );
    // Still mounted immediately after close — fallback timer hasn't elapsed.
    expect(screen.queryByTestId('child')).toBeInTheDocument();

    // Advance past the ~260ms fallback (no animationend in jsdom) → unmount.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });

  it('3. side left vs right apply the correct edge positioning', () => {
    const { rerender } = render(
      <DockDrawer id="left-d" side="left" ariaLabel="Left drawer" open>
        <div>body</div>
      </DockDrawer>,
    );
    const leftEl = screen.getByTestId('left-d');
    expect(leftEl.style.left).toBe('var(--rail-w)');
    expect(leftEl.style.right).toBe('');

    rerender(
      <DockDrawer id="left-d" side="right" ariaLabel="Right drawer" open>
        <div>body</div>
      </DockDrawer>,
    );
    const rightEl = screen.getByTestId('left-d');
    expect(rightEl.style.right).toBe('var(--rail-w)');
    expect(rightEl.style.left).toBe('');
  });
});
