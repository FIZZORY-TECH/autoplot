/**
 * src/panels/__tests__/PanelHeader.test.tsx — the canonical panel header (S4).
 *
 * Covers the behaviors the wiring phase depends on:
 *   1. the eyebrow label renders;
 *   2. the close button fires onClose and carries its aria-label + data-testid;
 *   3. children render inside the right-aligned slot;
 *   4. no slot wrapper is emitted when there are no children.
 *
 * Mirrors the repo's jsdom + testing-library setup (see DockDrawer.test.tsx).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelHeader } from '../PanelHeader';

describe('PanelHeader', () => {
  it('1. renders the eyebrow label', () => {
    render(<PanelHeader label="Watchlist" closeLabel="Close watchlist" onClose={() => {}} />);
    const label = screen.getByText('Watchlist');
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass('panel-head-label');
  });

  it('2. close button fires onClose and carries aria-label + data-testid', () => {
    const onClose = vi.fn();
    render(
      <PanelHeader
        label="Watchlist"
        closeLabel="Close watchlist"
        closeTestId="asset-panel-close"
        onClose={onClose}
      />,
    );
    const btn = screen.getByTestId('asset-panel-close');
    expect(btn).toHaveAttribute('aria-label', 'Close watchlist');
    expect(btn).toHaveClass('panel-head-close');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('3. children render in the right-aligned slot', () => {
    render(
      <PanelHeader label="Terminal" closeLabel="Close Terminal panel" onClose={() => {}}>
        <span data-testid="sub">(Claude CLI)</span>
      </PanelHeader>,
    );
    const child = screen.getByTestId('sub');
    expect(child).toBeInTheDocument();
    // The slot wrapper is the child's parent and carries the slot class.
    expect(child.parentElement).toHaveClass('panel-head-slot');
  });

  it('4. emits no slot wrapper when there are no children', () => {
    const { container } = render(
      <PanelHeader label="Watchlist" closeLabel="Close watchlist" onClose={() => {}} />,
    );
    expect(container.querySelector('.panel-head-slot')).toBeNull();
  });
});
