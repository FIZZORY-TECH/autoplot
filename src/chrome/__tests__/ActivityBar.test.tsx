/**
 * src/chrome/__tests__/ActivityBar.test.tsx — Step 4 activity-bar rails.
 *
 * Covers:
 *   1. Left rail renders no buttons (left rail is no longer used; all drawers moved to right).
 *   2. Right rail renders the correct ordered icons (watchlist, terminal, portfolio,
 *      indicator/Overlays, settings).
 *   3. Clicking an icon calls useDockStore.toggle (open-state flips).
 *   4. aria-pressed reflects the open drawer for the rail's side.
 *   5. ArrowDown moves roving focus to the next button.
 *
 * Mirrors the repo's jsdom + testing-library setup (see DockDrawer.test.tsx).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useDockStore } from '../../stores/useDockStore';
import { ActivityBar } from '../ActivityBar';

describe('ActivityBar', () => {
  beforeEach(() => {
    useDockStore.setState({ openLeft: null, openRight: null });
  });

  it('1. left rail renders no buttons (all drawers moved to right rail)', () => {
    render(<ActivityBar side="left" />);
    const bar = screen.getByRole('toolbar', { name: /left dock/i });
    const buttons = within(bar).queryAllByRole('button');
    // Left rail has no drawers assigned; it renders an empty toolbar.
    expect(buttons).toHaveLength(0);
  });

  it('2. right rail renders watchlist, research library, terminal, portfolio, Indicators, settings in order', () => {
    render(<ActivityBar side="right" />);
    const bar = screen.getByRole('toolbar', { name: /right dock/i });
    const labels = within(bar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Watchlist',
      'Research Library',
      'Terminal',
      'Portfolio',
      'Indicators',
      'Settings',
    ]);
  });

  it('3. clicking an icon calls useDockStore.toggle (flips open-state)', () => {
    render(<ActivityBar side="right" />);
    fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
    expect(useDockStore.getState().openRight).toBe('portfolio');
    // Second click toggles it back closed.
    fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
    expect(useDockStore.getState().openRight).toBeNull();
  });

  it('4. aria-pressed reflects the open drawer for the side', () => {
    useDockStore.setState({ openRight: 'settings' });
    render(<ActivityBar side="right" />);
    expect(
      screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('5. ArrowDown moves roving focus to the next button', () => {
    render(<ActivityBar side="right" />);
    // Watchlist is first in RIGHT_ORDER, so it is the initially-tabbable button;
    // Research Library is now the next button after it.
    const watchlist = screen.getByRole('button', { name: 'Watchlist' });
    const research = screen.getByRole('button', { name: 'Research Library' });
    // Roving tabindex: first button tabbable, rest -1.
    expect(watchlist.getAttribute('tabindex')).toBe('0');
    expect(research.getAttribute('tabindex')).toBe('-1');

    watchlist.focus();
    fireEvent.keyDown(watchlist, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(research);
    expect(research.getAttribute('tabindex')).toBe('0');
    expect(watchlist.getAttribute('tabindex')).toBe('-1');
  });
});
