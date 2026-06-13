/**
 * Sticky-to-bottom + jump-pill hook.
 *
 * While the user is within 80px of the
 * bottom of the scroll container, every content change auto-scrolls back to
 * the bottom. As soon as the user scrolls up past that threshold, sticky lock
 * disengages and a "↓ Latest" pill is offered; clicking it smooth-scrolls
 * back and re-engages stick.
 *
 * `notifyContentChange()` is called from a `useEffect` upstream whenever the
 * trace's last step detail length grows or a new step lands, so the hook
 * doesn't need to MutationObserve the DOM.
 *
 * Reduced-motion: smooth-scroll degrades to instant `scrollTop` assignment.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion } from '../lib/reducedMotion';

const STICKY_THRESHOLD_PX = 80;

export interface StickyScrollApi {
  stickToBottom: boolean;
  showJumpPill: boolean;
  unreadCount: number;
  scrollToBottom: () => void;
  notifyContentChange: () => void;
}

function distanceFromBottom(el: HTMLDivElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function useStickyScroll(
  ref: RefObject<HTMLDivElement>,
): StickyScrollApi {
  const [stickToBottom, setStickToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const stickRef = useRef(stickToBottom);
  const rafRef = useRef<number | null>(null);

  // Keep a ref mirror so the scroll listener (registered once) can always read
  // the freshest value without re-binding on every state flip.
  useEffect(() => {
    stickRef.current = stickToBottom;
  }, [stickToBottom]);

  // Bind the scroll listener once per ref. Threshold logic is the only state
  // mutation; unreadCount is reset whenever stickToBottom flips back true.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const d = distanceFromBottom(el);
      const shouldStick = d <= STICKY_THRESHOLD_PX;
      if (shouldStick !== stickRef.current) {
        stickRef.current = shouldStick;
        setStickToBottom(shouldStick);
        if (shouldStick) setUnreadCount(0);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [ref]);

  const notifyContentChange = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (stickRef.current) {
      // Defer the scrollTop write to the next frame so the new content has
      // landed in the DOM (the parent's render commit precedes ours).
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const node = ref.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
      });
    } else {
      setUnreadCount((n) => n + 1);
    }
  }, [ref]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || typeof el.scrollTo !== 'function') {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    stickRef.current = true;
    setStickToBottom(true);
    setUnreadCount(0);
  }, [ref]);

  return {
    stickToBottom,
    showJumpPill: !stickToBottom,
    unreadCount,
    scrollToBottom,
    notifyContentChange,
  };
}
