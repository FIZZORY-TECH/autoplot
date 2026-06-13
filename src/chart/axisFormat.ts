/**
 * src/chart/axisFormat.ts — Pure, stateless helpers for X-axis tick labelling.
 *
 * This module is deliberately canvas-free so it can be unit-tested without a
 * DOM/canvas environment (no CanvasRenderingContext2D, no React, no Tauri).
 *
 * Timestamps are stored as Unix milliseconds UTC (per Bar.ts), but labels are
 * formatted in the user's LOCAL time zone. This is an intentional design
 * choice: traders look at their local clock when reading charts, so "Jun 9
 * 14:00" should mean 14:00 in the user's city, not in UTC. Day/year boundary
 * comparisons also use local calendar fields (getFullYear/getMonth/getDate) so
 * they stay consistent with what the labels actually show, and DST transitions
 * do not cause spurious boundary swaps.
 *
 * Formatters are created lazily on first use (stored in module-scope vars) so
 * a test can set process.env.TZ before the first call and the formatter will
 * pick up the correct time zone.
 */

// ---------------------------------------------------------------------------
// Tier thresholds
// ---------------------------------------------------------------------------

/** If the visible span per label is below this, show HH:mm labels.  ~12 h. */
export const INTRADAY_MAX_MS = 12 * 3_600_000;

/** If the visible span per label is below this, show MMM d labels.  ~25 d. */
export const DAY_MAX_MS = 25 * 86_400_000;

// ---------------------------------------------------------------------------
// Tier type
// ---------------------------------------------------------------------------

/**
 * 'time'  → HH:mm (with day-boundary override → "MMM d")
 * 'day'   → MMM d  (with year-boundary override → "MMM yyyy")
 * 'month' → MMM    (with year-boundary override → "yyyy")
 */
export type AxisTier = 'time' | 'day' | 'month';

// ---------------------------------------------------------------------------
// Tier selector
// ---------------------------------------------------------------------------

/**
 * Choose the appropriate label tier given the millisecond span that each
 * rendered tick represents (visible time span ÷ number of ticks).
 */
export function pickTier(perLabelSpanMs: number): AxisTier {
  if (perLabelSpanMs < INTRADAY_MAX_MS) return 'time';
  if (perLabelSpanMs < DAY_MAX_MS) return 'day';
  return 'month';
}

// ---------------------------------------------------------------------------
// Lazy formatter factory
// ---------------------------------------------------------------------------

// These are created on first use so tests can override TZ before any call.
// Each slot holds one optional instance; lazyFmt fills it on first access.
function lazyFmt(slot: { v?: Intl.DateTimeFormat }, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return (slot.v ??= new Intl.DateTimeFormat(undefined, opts));
}

const _time:    { v?: Intl.DateTimeFormat } = {};
const _day:     { v?: Intl.DateTimeFormat } = {};
const _dayYear: { v?: Intl.DateTimeFormat } = {};
const _month:   { v?: Intl.DateTimeFormat } = {};
const _year:    { v?: Intl.DateTimeFormat } = {};

// ---------------------------------------------------------------------------
// Local-calendar helpers (consistent with local-time formatting)
// ---------------------------------------------------------------------------

function localDay(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function localYear(d: Date): number {
  return d.getFullYear();
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format a single X-axis tick timestamp into a short, single-line string.
 *
 * @param ts       - Unix milliseconds of the bar being labelled.
 * @param tier     - Formatting tier from `pickTier`.
 * @param prevTs   - Timestamp of the PREVIOUS rendered tick, or null if this is
 *                   the first visible tick.  Used to detect calendar-boundary
 *                   crossings that trigger the fallback format.
 *
 * Fallback rules (all in local time):
 *   tier 'time':  normally "HH:mm"; first tick OR new calendar day  → "MMM d"
 *   tier 'day':   normally "MMM d"; first tick OR new year           → "MMM yyyy"
 *   tier 'month': normally "MMM";   first tick OR new year           → "yyyy"
 */
export function formatAxisTick(ts: number, tier: AxisTier, prevTs: number | null): string {
  // Construct the current tick's Date once; reuse for both boundary comparison
  // and Intl formatting (avoids a second Date allocation per tick).
  const date = new Date(ts);
  const prev = prevTs !== null ? new Date(prevTs) : null;

  if (tier === 'time') {
    const boundary = prev === null || localDay(date) !== localDay(prev);
    return boundary
      ? lazyFmt(_day, { month: 'short', day: 'numeric' }).format(date)
      : lazyFmt(_time, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  if (tier === 'day') {
    const boundary = prev === null || localYear(date) !== localYear(prev);
    return boundary
      ? lazyFmt(_dayYear, { month: 'short', year: 'numeric' }).format(date)
      : lazyFmt(_day, { month: 'short', day: 'numeric' }).format(date);
  }

  // tier === 'month'
  const boundary = prev === null || localYear(date) !== localYear(prev);
  return boundary
    ? lazyFmt(_year, { year: 'numeric' }).format(date)
    : lazyFmt(_month, { month: 'short' }).format(date);
}
