/**
 * src/chart/researchPalette.ts — D5 color validation for agent-authored
 * research overlays.
 *
 * Agent `color` strings are NOT trusted verbatim. They are validated against an
 * allowed palette derived from the design tokens (`--accent`, `--up`, `--down`,
 * `--warn`, `--violet`, `--emerald`, plus a cyan), resolved ONCE via
 * getComputedStyle and cached (mirrors `getAxisFont` in axes.ts). A color that
 * fails a ≥3:1 relative-luminance contrast ratio against `--bg-0` is rejected
 * and the caller falls back to `colorForIndex`.
 *
 * Resolution is needed because tokens are OKLCH; the canvas can resolve any CSS
 * color string to a concrete RGB via a throwaway 2D context, which we use both
 * to canonicalize palette entries and to luminance-check agent colors.
 */

import { colorForIndex } from '../stores/useDatasetStore';

/** Token names whose resolved colors form the allowed research palette. */
const PALETTE_TOKENS = ['--accent', '--up', '--down', '--warn', '--violet', '--emerald'] as const;
/** A cyan that is not a single token but is explicitly allowed by the spec. */
const EXTRA_CYAN = 'oklch(0.82 0.14 215)';

/** Minimum contrast ratio an agent color must clear against `--bg-0`. */
const MIN_CONTRAST = 3;

interface ResolvedPalette {
  /** Canonical "r,g,b" strings of the allowed palette (for membership checks). */
  allowed: Set<string>;
  /** Relative luminance of `--bg-0` (for the contrast gate). */
  bgLuminance: number;
}

let _cache: ResolvedPalette | null = null;
let _ctx: CanvasRenderingContext2D | null = null;

/**
 * Memo of resolved `validateResearchColor` results, keyed by `${color}|${idx}`.
 * Inputs are immutable per element, but `validateResearchColor` runs per element
 * (and per marker POINT) every frame — each call otherwise does a fillRect +
 * getImageData GPU-sync readback on the 1×1 canvas. Memoizing collapses thousands
 * of per-frame readbacks to one per unique (color, fallback-index) pair. The idx
 * is part of the key because it selects the fallback color when validation fails.
 */
const _validateMemo = new Map<string, string>();

/** Lazily create a 1×1 offscreen 2D context used to canonicalize CSS colors. */
function colorCtx(): CanvasRenderingContext2D | null {
  if (_ctx) return _ctx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  _ctx = canvas.getContext('2d');
  return _ctx;
}

/** Resolve any CSS color string to `[r, g, b]` (0–255), or null when invalid. */
function toRgb(color: string): [number, number, number] | null {
  const ctx = colorCtx();
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  // If the assignment was rejected (invalid color) fillStyle stays '#000000'.
  // Re-test by setting a sentinel first to distinguish a genuine black.
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  if (data[3] === 0) return null;
  return [data[0], data[1], data[2]];
}

/** WCAG relative luminance from sRGB 0–255 components. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio between two relative luminances (order-independent). */
export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function resolvePalette(): ResolvedPalette {
  if (_cache) return _cache;

  const allowed = new Set<string>();
  let bgLuminance = 0.02; // fallback ≈ --bg-0 (very dark) for SSR/test.

  if (typeof document !== 'undefined') {
    const style = getComputedStyle(document.documentElement);
    for (const token of PALETTE_TOKENS) {
      const raw = style.getPropertyValue(token).trim();
      if (!raw) continue;
      const rgb = toRgb(raw);
      if (rgb) allowed.add(rgb.join(','));
    }
    const cyan = toRgb(EXTRA_CYAN);
    if (cyan) allowed.add(cyan.join(','));

    const bgRaw = style.getPropertyValue('--bg-0').trim();
    const bgRgb = bgRaw ? toRgb(bgRaw) : null;
    if (bgRgb) bgLuminance = relativeLuminance(bgRgb[0], bgRgb[1], bgRgb[2]);
  }

  _cache = { allowed, bgLuminance };
  return _cache;
}

/**
 * Validate an agent-supplied color. Returns the color unchanged when it resolves
 * to a member of the allowed palette AND clears the contrast gate against
 * `--bg-0`; otherwise returns the index-mapped fallback (`colorForIndex`).
 *
 * @param color     Agent color string (may be undefined → fallback).
 * @param fallbackIdx  Stable index used by `colorForIndex` for the fallback.
 */
export function validateResearchColor(color: string | undefined, fallbackIdx: number): string {
  const memoKey = `${color ?? ''}|${fallbackIdx}`;
  const memoized = _validateMemo.get(memoKey);
  if (memoized !== undefined) return memoized;

  const result = computeValidatedColor(color, fallbackIdx);
  _validateMemo.set(memoKey, result);
  return result;
}

function computeValidatedColor(color: string | undefined, fallbackIdx: number): string {
  const fallback = colorForIndex(fallbackIdx);
  if (!color) return fallback;

  const rgb = toRgb(color);
  if (!rgb) return fallback;

  const { allowed, bgLuminance } = resolvePalette();
  const key = rgb.join(',');
  if (!allowed.has(key)) return fallback;

  const lum = relativeLuminance(rgb[0], rgb[1], rgb[2]);
  if (contrastRatio(lum, bgLuminance) < MIN_CONTRAST) return fallback;

  return color;
}

/** TEST-ONLY: reset the memoized palette so a test can re-resolve tokens. */
export function _resetResearchPaletteCache(): void {
  _cache = null;
  _ctx = null;
  _validateMemo.clear();
}
