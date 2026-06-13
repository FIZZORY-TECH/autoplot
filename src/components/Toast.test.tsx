/**
 * src/components/Toast.test.tsx — Wave C1 toast presentational tests.
 *
 * Covers:
 *   - Pointer-drag past 80px → onDismiss called with the toast id.
 *   - A drag distance below the threshold doesn't dismiss.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { Toast } from './Toast';
import type { Toast as ToastT } from '../stores/useToastStore';

/**
 * Fire a native PointerEvent through React's delegated listener with the
 * required fields populated. `fireEvent.pointer*` strips clientX in jsdom
 * because jsdom-side PointerEvent doesn't carry MouseEvent fields by default.
 */
function dispatchPointer(
  el: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
): void {
  const evt = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 0,
    button: 0,
  });
  // Mark as pointer event for React's synthetic shim.
  Object.defineProperty(evt, 'pointerId', { value: 1 });
  Object.defineProperty(evt, 'pointerType', { value: 'mouse' });
  act(() => {
    el.dispatchEvent(evt);
  });
}

function makeToast(over: Partial<ToastT> = {}): ToastT {
  return {
    id: 't-1',
    kind: 'info',
    title: 'Hi',
    createdAt: Date.now(),
    ...over,
  };
}

describe('<Toast />', () => {
  it('calls onDismiss when dragged past 80px', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast toast={makeToast()} onDismiss={onDismiss} />,
    );
    const card = container.querySelector('.toast') as HTMLDivElement;
    expect(card).toBeTruthy();

    // Stub setPointerCapture / releasePointerCapture (jsdom doesn't implement).
    card.setPointerCapture = vi.fn();
    card.releasePointerCapture = vi.fn();

    dispatchPointer(card, 'pointerdown', 0);
    dispatchPointer(card, 'pointermove', 100);
    dispatchPointer(card, 'pointerup', 100);
    expect(onDismiss).toHaveBeenCalledWith('t-1');
  });

  it('does not dismiss when drag distance is below 80px', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast toast={makeToast()} onDismiss={onDismiss} />,
    );
    const card = container.querySelector('.toast') as HTMLDivElement;
    card.setPointerCapture = vi.fn();
    card.releasePointerCapture = vi.fn();
    dispatchPointer(card, 'pointerdown', 0);
    dispatchPointer(card, 'pointermove', 40);
    dispatchPointer(card, 'pointerup', 40);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('truncates detail at 80 chars', () => {
    const long = 'a'.repeat(120);
    const { container } = render(
      <Toast toast={makeToast({ detail: long })} onDismiss={() => undefined} />,
    );
    const detailEl = container.querySelector('.toast-detail');
    expect(detailEl?.textContent?.length).toBeLessThanOrEqual(80);
  });

  it('Esc dismisses focused toast', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast toast={makeToast()} onDismiss={onDismiss} />,
    );
    const card = container.querySelector('.toast') as HTMLDivElement;
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('t-1');
  });
});
