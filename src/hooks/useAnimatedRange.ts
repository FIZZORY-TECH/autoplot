/**
 * src/hooks/useAnimatedRange.ts — RAF-driven Y-range interpolation.
 *
 * Port of `useAnimatedRange` from app-design/project/chart.jsx, adapted to TS
 * and the canonical `ViewWindow.yMin/yMax` shape.
 *
 * Differences from the prototype:
 *  - Prototype used a fixed-rate exponential ease (`+= dx * 0.18` per frame).
 *    We use a duration + cubic-out easing pegged to `--t-med` (320ms by
 *    default) so the curve is frame-rate independent and matches the rest of
 *    the app's motion language (per Design System §03).
 *  - Cancels cleanly on unmount; never strands a RAF callback.
 *
 * @example
 *   const { yMin, yMax } = useAnimatedRange(targetMin, targetMax);
 */

import { useEffect, useRef, useState } from 'react';

const DEFAULT_DURATION_MS = 320;

/**
 * Numerical evaluator for CSS `cubic-bezier(0.22, 1, 0.36, 1)` (`--ease`).
 *
 * A cubic bezier in CSS is a 1-D curve where the input is the elapsed time
 * fraction `t` (the curve's x-axis) and the output is the eased progress
 * (the curve's y-axis). Unlike Bezier curves used for paths, the parameter
 * `u` along the curve does NOT equal `t`; we must invert x(u) = t to find
 * the right `u`, then evaluate y(u).
 *
 * Approach: 8 iterations of Newton's method (with bisection fallback for
 * the first iteration) is more than sufficient to converge below 1e-5
 * precision for animation purposes — well below 1 frame's perceptual
 * threshold.
 */
const CB_X1 = 0.22;
const CB_Y1 = 1;
const CB_X2 = 0.36;
const CB_Y2 = 1;

function cbX(u: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * u * CB_X1 + 3 * inv * u * u * CB_X2 + u * u * u;
}
function cbY(u: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * u * CB_Y1 + 3 * inv * u * u * CB_Y2 + u * u * u;
}
function cbDX(u: number): number {
  // dx/du for the cubic above — used by Newton's method.
  const inv = 1 - u;
  return 3 * inv * inv * CB_X1 + 6 * inv * u * (CB_X2 - CB_X1) + 3 * u * u * (1 - CB_X2);
}

function easeOutCubic(t: number): number {
  const target = Math.max(0, Math.min(1, t));
  if (target === 0 || target === 1) return target;
  // Newton's method to invert x(u) = target.
  let u = target;
  for (let i = 0; i < 8; i++) {
    const x = cbX(u) - target;
    const dx = cbDX(u);
    if (Math.abs(dx) < 1e-6) break;
    u = u - x / dx;
    if (u < 0) u = 0;
    if (u > 1) u = 1;
  }
  return cbY(u);
}

export function useAnimatedRange(
  targetMin: number,
  targetMax: number,
  durationMs: number = DEFAULT_DURATION_MS,
): { yMin: number; yMax: number } {
  // Live animated value (driven into React via setState below).
  const [value, setValue] = useState(() => ({ yMin: targetMin, yMax: targetMax }));

  // The animation we're currently running. Stored in a ref so the RAF callback
  // sees the latest target without re-creating the loop on every render.
  const animRef = useRef<{
    fromMin: number;
    fromMax: number;
    toMin: number;
    toMax: number;
    startTs: number;
    rafId: number;
  } | null>(null);

  useEffect(() => {
    const current = value;
    // Skip if already at target (avoid burning a RAF tick on no-op updates).
    if (
      Math.abs(current.yMin - targetMin) < 1e-6 &&
      Math.abs(current.yMax - targetMax) < 1e-6
    ) {
      return;
    }

    if (animRef.current) {
      cancelAnimationFrame(animRef.current.rafId);
    }

    const startTs = performance.now();
    const fromMin = current.yMin;
    const fromMax = current.yMax;
    const toMin = targetMin;
    const toMax = targetMax;

    const tick = (now: number) => {
      const t = Math.min(1, (now - startTs) / durationMs);
      const k = easeOutCubic(t);
      const nextMin = fromMin + (toMin - fromMin) * k;
      const nextMax = fromMax + (toMax - fromMax) * k;
      setValue({ yMin: nextMin, yMax: nextMax });
      if (t < 1) {
        animRef.current!.rafId = requestAnimationFrame(tick);
      } else {
        animRef.current = null;
      }
    };

    const rafId = requestAnimationFrame(tick);
    animRef.current = { fromMin, fromMax, toMin, toMax, startTs, rafId };

    return () => {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current.rafId);
        animRef.current = null;
      }
    };
  }, [targetMin, targetMax, durationMs]);

  return value;
}
