/**
 * src/chart/EventReaderModal.test.tsx — Step S8
 *
 * Asserts the reader renders its four sections (title / content / timestamp /
 * source badge), gates the SourceBadge on `sourceUrl`, exposes the dialog a11y
 * contract (role/aria-modal/aria-labelledby + Esc), and degrades to a plain
 * fade under prefers-reduced-motion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { EventReaderModal } from './EventReaderModal';
import type { ExpandableEvent } from './EventListPopover';

function makeEvent(overrides: Partial<ExpandableEvent> = {}): ExpandableEvent {
  return {
    source: 'research',
    id: 'research:ov1:0',
    overlayId: 'ov1',
    elementIndex: 0,
    label: 'FOMC raises rates 25bps',
    ts: 1_700_000_000_000,
    content: 'The committee decided to raise the target range by a quarter point.',
    sourceUrl: 'https://www.federalreserve.gov/news',
    sourceName: 'federalreserve.gov',
    ...overrides,
  };
}

let matchMediaReduced = false;

beforeEach(() => {
  matchMediaReduced = false;
  // jsdom has no matchMedia — stub it; toggle `matchMediaReduced` per test.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduce') ? matchMediaReduced : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => cleanup());

describe('EventReaderModal', () => {
  it('renders nothing when event is null', () => {
    const { container } = render(<EventReaderModal event={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders title, content, and timestamp', () => {
    render(<EventReaderModal event={makeEvent()} onClose={() => {}} />);
    expect(screen.getByText('FOMC raises rates 25bps')).toBeTruthy();
    expect(
      screen.getByText(/raise the target range by a quarter point/),
    ).toBeTruthy();
    // Timestamp section present (mono formatter output is non-empty).
    expect(screen.getByTestId('event-reader-ts').textContent).toBeTruthy();
  });

  it('exposes the dialog a11y contract', () => {
    render(<EventReaderModal event={makeEvent()} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId as string)?.textContent).toContain(
      'FOMC raises rates 25bps',
    );
  });

  it('renders SourceBadge only when sourceUrl is present', () => {
    const { rerender } = render(
      <EventReaderModal event={makeEvent()} onClose={() => {}} />,
    );
    expect(screen.queryByLabelText(/Open source/)).toBeTruthy();

    rerender(
      <EventReaderModal
        event={makeEvent({ sourceUrl: undefined, sourceName: undefined })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/Open source/)).toBeNull();
  });

  it('closes on Esc and on scrim click', () => {
    const onClose = vi.fn();
    render(<EventReaderModal event={makeEvent()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('event-reader-scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not close when the card itself is clicked', () => {
    const onClose = vi.fn();
    render(<EventReaderModal event={makeEvent()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('event-reader-card'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses a plain fade (no translate/scale) under prefers-reduced-motion', () => {
    matchMediaReduced = true;
    render(
      <EventReaderModal
        event={makeEvent()}
        onClose={() => {}}
        originRect={{ x: 10, y: 10, w: 24, h: 24 }}
      />,
    );
    const card = screen.getByTestId('event-reader-card');
    // Reduced motion collapses the enter transform to scale only (no translate
    // from the origin rect) and the transition omits the spring transform.
    expect(card.style.transition).toContain('opacity');
    expect(card.style.transition).not.toContain('transform');
  });
});
