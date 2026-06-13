import { useEffect, useState } from 'react';

/** One-shot read of the OS `prefers-reduced-motion` preference. SSR/jsdom-safe.
 *  Prefer `useReducedMotion` in React components so the value tracks live OS
 *  toggles; this is for one-off, non-reactive reads. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Reactive `prefers-reduced-motion` hook — subscribes to the media query's
 * `change` event so the flag updates when the user toggles the OS preference
 * live (not just at first render). SSR/jsdom-safe: guards `window`/`matchMedia`
 * and cleans up its listener. Shared by AnimNum/Headline-style motion gates and
 * the DockDrawer width transition + chart-inset transition.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fn = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, []);
  return reduced;
}
