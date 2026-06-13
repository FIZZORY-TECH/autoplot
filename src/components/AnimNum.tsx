/**
 * src/components/AnimNum.tsx — Animated numeric counter.
 *
 * On prop change, RAF-interpolates from the previous displayed value to the
 * new target over `durationMs` (default 320 = `--t-med`) with cubic-out
 * easing. Renders a <span> with `font-variant-numeric: tabular-nums` so
 * digit width never jiggles.
 *
 * Used by P2.1's Headline; demoed here in AppShell pending real wiring.
 */

import { useEffect, useRef, useState } from 'react';
import { fmtPrice } from '../engine/indicators';

interface AnimNumProps {
  value: number;
  format?: (v: number) => string;
  durationMs?: number;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_DURATION_MS = 320;

function cubicOut(t: number): number {
  const t1 = t - 1;
  return t1 * t1 * t1 + 1;
}

function useReducedMotion(): boolean {
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

export function AnimNum({
  value,
  format = fmtPrice,
  durationMs = DEFAULT_DURATION_MS,
  className,
  style,
}: AnimNumProps): JSX.Element {
  const [display, setDisplay] = useState<number>(value);
  const fromRef = useRef<number>(value);
  const startRef = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    // First render — just show the value, nothing to animate from.
    if (!Number.isFinite(value)) return;

    if (reducedMotion || durationMs <= 0) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }

    fromRef.current = display;
    startRef.current = performance.now();

    const tick = (now: number): void => {
      const elapsed = now - startRef.current;
      const raw = Math.min(elapsed / durationMs, 1);
      const t = cubicOut(raw);
      const next = fromRef.current + (value - fromRef.current) * t;
      setDisplay(next);
      if (raw < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(value);
        fromRef.current = value;
        rafRef.current = 0;
      }
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    // We intentionally exclude `display` and `format` from deps — re-running
    // the effect on every interpolation tick would reset the animation.
  }, [value, durationMs, reducedMotion]);

  return (
    <span
      className={className}
      style={{ fontVariantNumeric: 'tabular-nums', ...style }}
    >
      {format(display)}
    </span>
  );
}

export default AnimNum;
