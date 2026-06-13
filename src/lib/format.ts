/**
 * src/lib/format.ts — Shared number-formatting helpers.
 *
 * Extracted to avoid duplication across chart/Crosshair and chrome/Headline.
 */

/**
 * Format a volume (or any large absolute number) with K / M / B suffix.
 * Returns "—" for non-finite inputs.
 *
 * Output is identical across all call sites. Callers must render inside a
 * container that carries `font-variant-numeric: tabular-nums` (or the
 * equivalent CSS token) so the digits are mono-spaced.
 */
export function fmtVol(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(2) + 'K';
  return v.toFixed(2);
}
