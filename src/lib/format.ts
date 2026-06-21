/**
 * src/lib/format.ts — Shared number-formatting helpers.
 *
 * Extracted to avoid duplication across chart/Crosshair and chrome/Headline.
 */

import type { Tf } from '../data/MarketDataProvider';

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

// ---------------------------------------------------------------------------
// Bar-timestamp formatter (crosshair hover readout)
// ---------------------------------------------------------------------------

/**
 * Lazy Intl.DateTimeFormat instances — created on first call so tests can
 * override process.env.TZ before the first invocation (same pattern as
 * src/chart/axisFormat.ts).  Locale is left undefined so the runtime uses
 * 'en-US' semantics universally; no explicit timeZone means the user's local
 * zone is used, matching the chart axis labels (see axisFormat.ts header).
 */
const _barIntraday: { v?: Intl.DateTimeFormat } = {};
const _barDaily:    { v?: Intl.DateTimeFormat } = {};

function barIntradayFmt(): Intl.DateTimeFormat {
  return (_barIntraday.v ??= new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }));
}

function barDailyFmt(): Intl.DateTimeFormat {
  return (_barDaily.v ??= new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }));
}

/**
 * Format a bar timestamp for the crosshair hover readout, scaled to the
 * active chart timeframe.
 *
 * - Intraday timeframes ('1h', '4h', and any containing 'm' or 'h') →
 *   e.g. "Jun 21, 14:00"  (month abbrev, day, 24-h HH:MM in local time)
 * - Daily / weekly timeframes ('1d', '1w', any containing 'd' or 'w') →
 *   e.g. "Jun 21, 2026"
 * - Unknown timeframe strings default to the intraday format.
 * - Returns "—" for non-finite or NaN timestamps.
 *
 * @param ts - Bar timestamp as Unix milliseconds (matches Bar.ts from MarketDataProvider).
 * @param tf - Active chart timeframe.
 */
export function fmtBarTime(ts: number, tf: Tf | string): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  // Detect daily/weekly by suffix: '1d' or '1w'.
  // Check for a trailing 'd' or 'w' (not preceded by other letters) to avoid
  // false positives from arbitrary strings (e.g. "unknown" contains 'w').
  const isDaily = /\d[dw]$/.test(tf);
  return isDaily ? barDailyFmt().format(d) : barIntradayFmt().format(d);
}
