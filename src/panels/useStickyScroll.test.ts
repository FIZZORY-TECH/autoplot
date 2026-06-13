/**
 * Wave A4 — useStickyScroll unit tests.
 *
 * Stubs a div with controllable `scrollHeight` / `clientHeight` / `scrollTop`,
 * exercises the 80px threshold, and verifies that:
 *   - within threshold → stickToBottom stays true; pill hidden.
 *   - past threshold → stickToBottom flips to false; pill visible.
 *   - notifyContentChange increments unreadCount when unstuck.
 *   - scrollToBottom resets unreadCount + re-engages stick.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useStickyScroll } from './useStickyScroll';

interface FakeScrollNode {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  _scrollHandler?: (this: HTMLDivElement, ev: Event) => void;
  addEventListener: (
    type: string,
    handler: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (type: string, handler: EventListenerOrEventListenerObject) => void;
  scrollTo?: (opts: ScrollToOptions) => void;
}

function makeNode(scrollHeight = 1000, clientHeight = 200): FakeScrollNode {
  const node: FakeScrollNode = {
    scrollHeight,
    clientHeight,
    scrollTop: 0,
    addEventListener(type, handler) {
      if (type === 'scroll') {
        this._scrollHandler = handler as (this: HTMLDivElement, ev: Event) => void;
      }
    },
    removeEventListener() {
      this._scrollHandler = undefined;
    },
  };
  return node;
}

function renderStickyHook(node: FakeScrollNode) {
  return renderHook(() => {
    const ref = useRef<HTMLDivElement>(node as unknown as HTMLDivElement);
    return useStickyScroll(ref);
  });
}

beforeEach(() => {
  // rAF is used by `notifyContentChange` for the scrollTop write — drive it
  // synchronously in tests so we don't have to wait for real frames.
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    },
  );
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStickyScroll', () => {
  it('stays sticky while distanceFromBottom <= 80px', () => {
    const node = makeNode(1000, 200);
    // distance = scrollHeight - scrollTop - clientHeight = 1000 - 750 - 200 = 50
    node.scrollTop = 750;
    const { result } = renderStickyHook(node);

    expect(result.current.stickToBottom).toBe(true);
    expect(result.current.showJumpPill).toBe(false);

    act(() => {
      node._scrollHandler?.call(
        node as unknown as HTMLDivElement,
        new Event('scroll'),
      );
    });
    expect(result.current.stickToBottom).toBe(true);
    expect(result.current.showJumpPill).toBe(false);
  });

  it('unsticks when distanceFromBottom > 80px and exposes the pill', () => {
    const node = makeNode(1000, 200);
    // distance = 1000 - 700 - 200 = 100 → past threshold
    node.scrollTop = 700;
    const { result } = renderStickyHook(node);

    act(() => {
      node._scrollHandler?.call(
        node as unknown as HTMLDivElement,
        new Event('scroll'),
      );
    });

    expect(result.current.stickToBottom).toBe(false);
    expect(result.current.showJumpPill).toBe(true);
  });

  it('increments unreadCount on notifyContentChange while unstuck', () => {
    const node = makeNode(1000, 200);
    node.scrollTop = 700; // unstuck
    const { result } = renderStickyHook(node);

    act(() => {
      node._scrollHandler?.call(
        node as unknown as HTMLDivElement,
        new Event('scroll'),
      );
    });
    expect(result.current.stickToBottom).toBe(false);

    act(() => {
      result.current.notifyContentChange();
      result.current.notifyContentChange();
    });
    expect(result.current.unreadCount).toBe(2);
  });

  it('auto-scrolls (no unread bump) on notifyContentChange while sticky', () => {
    const node = makeNode(1000, 200);
    node.scrollTop = 800; // distance = 0 → stick
    const { result } = renderStickyHook(node);

    act(() => {
      result.current.notifyContentChange();
    });
    expect(result.current.unreadCount).toBe(0);
    // rAF stub ran synchronously → scrollTop got pinned to scrollHeight.
    expect(node.scrollTop).toBe(1000);
  });

  it('scrollToBottom resets unreadCount and re-engages stick', () => {
    const node = makeNode(1000, 200);
    node.scrollTop = 700; // unstuck
    const { result } = renderStickyHook(node);

    act(() => {
      node._scrollHandler?.call(
        node as unknown as HTMLDivElement,
        new Event('scroll'),
      );
      result.current.notifyContentChange();
      result.current.notifyContentChange();
    });
    expect(result.current.unreadCount).toBe(2);

    act(() => {
      result.current.scrollToBottom();
    });

    expect(result.current.unreadCount).toBe(0);
    expect(result.current.stickToBottom).toBe(true);
    expect(result.current.showJumpPill).toBe(false);
  });
});
