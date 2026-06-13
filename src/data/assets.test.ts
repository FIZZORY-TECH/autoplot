/**
 * src/data/assets.test.ts
 *
 * Tests for `hashToOklch` — ADR-0009 color fallback for the dynamic symbol catalog.
 *
 * Covers:
 *  1. Determinism
 *  2. Distinctness across ≥ 6 representative inputs
 *  3. Hue band exclusion: no hue in [70, 110) across 200 sampled keys
 *  4. OKLCH format validity
 *  5. WCAG AA contrast ≥ 4.5:1 vs --bg-0 across 200 sampled keys
 */

import { describe, it, expect } from 'vitest';
import { hashToOklch } from './assets';

// ---------------------------------------------------------------------------
// Private helpers: OKLCH → linear sRGB → WCAG relative luminance
// ---------------------------------------------------------------------------

/**
 * Convert OKLCH to linear sRGB components (no clamping — raw conversion).
 * Uses the CSS Color 4 spec pipeline:
 *   OKLCH → OKLab → XYZ-D65 → linear sRGB
 */
function oklchToLinearSrgb(l: number, c: number, h: number): [number, number, number] {
  // Step 1: OKLCH → OKLab
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  // Step 2: OKLab → LMS (via inverse of the OKLab → LMS cube-root matrix)
  // M1_inv (from CSS Color 4 spec / oklab reference):
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  // Step 3: cube each component to get LMS
  const lms_l = l_ * l_ * l_;
  const lms_m = m_ * m_ * m_;
  const lms_s = s_ * s_ * s_;

  // Step 4: LMS → linear sRGB via M2_inv (Oklab reference matrix)
  const r =  4.0767416621 * lms_l - 3.3077115913 * lms_m + 0.2309699292 * lms_s;
  const g = -1.2684380046 * lms_l + 2.6097574011 * lms_m - 0.3413193965 * lms_s;
  const bv =  -0.0041960863 * lms_l - 0.7034186147 * lms_m + 1.7076147010 * lms_s;

  return [r, g, bv];
}

/** Apply sRGB gamma companding (linear → gamma-encoded). */
function linearToGamma(v: number): number {
  const abs = Math.abs(v);
  if (abs <= 0.0031308) return 12.92 * v;
  return Math.sign(v) * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
}

/** WCAG relative luminance from a gamma-encoded sRGB triple [0, 1]. */
function relLuminance(r: number, g: number, b: number): number {
  const toLinear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * WCAG contrast ratio between two relative luminances.
 * Returns (lighter + 0.05) / (darker + 0.05).
 */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Parse `oklch(L C H)` string → { l, c, h }.
 * Handles both integer and decimal hue values.
 */
function parseOklch(s: string): { l: number; c: number; h: number } {
  const m = s.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/);
  if (!m) throw new Error(`Cannot parse oklch string: ${s}`);
  return { l: parseFloat(m[1]), c: parseFloat(m[2]), h: parseFloat(m[3]) };
}

/**
 * Convert an `oklch(...)` string to WCAG relative luminance.
 */
function oklchStringToLuminance(s: string): number {
  const { l, c, h } = parseOklch(s);
  const [lr, lg, lb] = oklchToLinearSrgb(l, c, h);
  // Apply gamma to get sRGB [0,1], then compute luminance from gamma values.
  const gr = linearToGamma(lr);
  const gg = linearToGamma(lg);
  const gb = linearToGamma(lb);
  return relLuminance(gr, gg, gb);
}

// ---------------------------------------------------------------------------
// Resolve --bg-0 from tokens.css: oklch(0.11 0.008 260)
// This is the darkest background in the dark-glass palette.
// ---------------------------------------------------------------------------
const BG0_OKLCH = 'oklch(0.11 0.008 260)';
const BG0_LUMINANCE = oklchStringToLuminance(BG0_OKLCH);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hashToOklch', () => {
  // 1. Determinism
  it('produces the same result on repeated calls (determinism)', () => {
    expect(hashToOklch('BTC/USDT')).toBe(hashToOklch('BTC/USDT'));
    expect(hashToOklch('ETH/USDT')).toBe(hashToOklch('ETH/USDT'));
    expect(hashToOklch('SOL/USDC')).toBe(hashToOklch('SOL/USDC'));
  });

  // 2. Distinctness across ≥ 6 representative inputs
  it('produces distinct colors for different symbols', () => {
    const inputs = [
      'BTC/USDT',
      'ETH/USDT',
      'SOL/USDC',
      'AAPL/USD',
      'MSFT/USD',
      'NVDA/USD',
      'DOGE/USDT',
      'XRP/USDT',
    ];
    const results = inputs.map(hashToOklch);
    const unique = new Set(results);
    // All 8 inputs must produce distinct colors
    expect(unique.size).toBe(inputs.length);
  });

  // 3. Hue band exclusion: no hue in [70, 110) across 200 sampled keys
  it('never produces a hue in the excluded [70, 110) band for 200 sampled keys', () => {
    for (let i = 0; i < 200; i++) {
      const key = `key-${i}`;
      const result = hashToOklch(key);
      const { h } = parseOklch(result);
      // Hue must be in [0, 70) OR [110, 360) — never in [70, 110)
      const inExcludedBand = h >= 70 && h < 110;
      expect(
        inExcludedBand,
        `key-${i} produced hue ${h} which is in the excluded [70, 110) band`,
      ).toBe(false);
    }
  });

  // 4. OKLCH format validity
  it('output matches the expected oklch format', () => {
    const pattern = /^oklch\(0\.74 0\.16 \d+(\.\d+)?\)$/;
    const testInputs = [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDC', 'AAPL/USD', 'UNKNOWN/XYZ',
      'key-0', 'key-99', 'key-199', '', 'X',
    ];
    for (const input of testInputs) {
      expect(hashToOklch(input)).toMatch(pattern);
    }
  });

  // 5. WCAG AA contrast ≥ 4.5:1 vs --bg-0 across 200 sampled keys
  it('achieves WCAG AA contrast (≥ 4.5:1) vs --bg-0 for 200 sampled keys', () => {
    const minRequired = 4.5;
    let minContrast = Infinity;

    for (let i = 0; i < 200; i++) {
      const key = `key-${i}`;
      const result = hashToOklch(key);
      const fgLuminance = oklchStringToLuminance(result);
      const ratio = contrastRatio(fgLuminance, BG0_LUMINANCE);

      if (ratio < minContrast) minContrast = ratio;

      expect(
        ratio,
        `key-${i} → ${result} has contrast ${ratio.toFixed(2)}:1 vs ${BG0_OKLCH} (< ${minRequired}:1)`,
      ).toBeGreaterThanOrEqual(minRequired);
    }

    // Surface the minimum contrast in the console for the report
    console.log(
      `[hashToOklch] min contrast across 200 samples: ${minContrast.toFixed(2)}:1 vs ${BG0_OKLCH}`,
    );
  });
});
