/**
 * src/chart/chartTimeFormat.ts — Shared compact event-timestamp formatter.
 *
 * Used by OverlayInfoPanel, EventListPopover, and EventReaderModal to render
 * a short "MMM d, HH:MM" label next to every event hotspot or reader header.
 * Extracted here to eliminate three identical private `fmtTs` copies.
 *
 * Output is local-timezone, using the user's locale — consistent with the
 * axis-tick locale choice documented in axisFormat.ts.
 */

/**
 * Format a Unix-millisecond timestamp as a compact local datetime string.
 * Returns "—" for invalid inputs.
 *
 * Options produce output such as "Jun 9, 14:05" (locale-dependent).
 */
export function fmtTs(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
