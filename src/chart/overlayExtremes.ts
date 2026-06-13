/**
 * src/chart/overlayExtremes.ts — y-bounds contribution from overlay value arrays.
 *
 * `collectOverlayExtremes` returns the [min, max] extremes found in visible
 * index ranges across a collection of overlay value sources so that the chart's
 * y-range can be widened to prevent overlay clipping.
 *
 * Two alignment modes are supported, matching the renderer conventions in
 * overlays.ts:
 *
 *   'bar-aligned'   — the array index equals the bar index (Bollinger upper/lower,
 *                     SMA lines).  Slice [lo0, hi0) directly.
 *
 *   'right-aligned' — the last value maps to the last visible bar (eIdx − 1),
 *                     i.e. seriesStart = eIdx − values.length.  Mirrors the logic
 *                     in customSeriesOverlay and aiOverlayGlow (tsless series that
 *                     hug the current view).
 *
 *   'data-right-aligned' — the last value maps to the last DATASET bar
 *                     (barCount − 1), i.e. seriesStart = barCount − values.length.
 *                     Used by research line/band with align:'right' so they stay
 *                     pinned to absolute bars as the view pans / bars prepend.
 *                     Requires the `barCount` argument; when it is absent this
 *                     mode falls back to 'right-aligned' (visible edge).
 *
 *   { constant: n } — a single price that applies across ALL bars (e.g. an
 *                     hline). It is always visible regardless of pan, so it
 *                     contributes its value to the union unconditionally — no
 *                     index/alignment math. Use this instead of smuggling the
 *                     price as a 1-element right-aligned `values` source.
 */

export type OverlayAlign = 'bar-aligned' | 'right-aligned' | 'data-right-aligned';

/**
 * One overlay contribution to the y-range union — either a positional value
 * series (`values` + `align`) or a constant price (`constant`).
 */
export type OverlayValueSource =
  | {
      /** Numeric values (null / undefined treated as gaps). */
      values: (number | null | undefined)[];
      /** How the array is positioned relative to bar indices. Default: 'bar-aligned'. */
      align?: OverlayAlign;
      constant?: undefined;
    }
  | {
      /** A constant price contributed across the whole window (e.g. hline). */
      constant: number;
      values?: undefined;
      align?: undefined;
    };

/**
 * Union the visible extremes of all overlay value sources into `[lo, hi]`.
 * Returns `[Infinity, -Infinity]` when no finite values are found (caller
 * keeps their existing bar-only bounds in that case).
 *
 * @param sources  Overlay value sources to union.
 * @param start    Fractional visible start (same unit as ViewWindow.start).
 * @param end      Fractional visible end   (same unit as ViewWindow.end).
 * @param barCount Total loaded bar count — the absolute anchor for the
 *                 'data-right-aligned' mode. Falls back to the visible edge
 *                 (`end`) when omitted.
 */
export function collectOverlayExtremes(
  sources: OverlayValueSource[],
  start: number,
  end: number,
  barCount?: number,
): { lo: number; hi: number } {
  const lo0 = Math.max(0, Math.floor(start));
  const hi0 = Math.ceil(end);   // exclusive upper bound used per renderer (visible edge)
  // Absolute dataset end (exclusive). Used to pin 'data-right-aligned' sources.
  const dataEnd = barCount ?? hi0;
  let lo = Infinity;
  let hi = -Infinity;

  const accumulate = (values: (number | null | undefined)[], seriesStart: number): void => {
    // Only walk the VISIBLE window [lo0, hi0); values outside it are off-screen
    // and must not contribute to the visible y-range.
    for (let i = lo0; i < hi0; i++) {
      const si = i - seriesStart;
      if (si < 0 || si >= values.length) continue;
      const v = values[si];
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  };

  for (const src of sources) {
    // Constant price (hline): always inside the window — contribute directly.
    if (src.constant !== undefined) {
      if (Number.isFinite(src.constant)) {
        if (src.constant < lo) lo = src.constant;
        if (src.constant > hi) hi = src.constant;
      }
      continue;
    }

    const { values, align = 'bar-aligned' } = src;
    if (!values.length) continue;

    if (align === 'bar-aligned') {
      // seriesStart = 0 (values[i] ↔ bar i).
      accumulate(values, 0);
    } else if (align === 'data-right-aligned') {
      // Pinned to the last DATASET bar — invariant under panning / prepend.
      accumulate(values, dataEnd - values.length);
    } else {
      // right-aligned: pinned to the visible right edge (eIdx − values.length).
      accumulate(values, hi0 - values.length);
    }
  }

  return { lo, hi };
}
