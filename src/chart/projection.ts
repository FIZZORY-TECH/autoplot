import type { RenderContext } from './types';

type View = RenderContext['view'];
type Layout = RenderContext['layout'];

export function barIdxToPx(idx: number, view: View, layout: Layout): number {
  const span = Math.max(1e-9, view.end - view.start);
  return layout.x + ((idx - view.start) / span) * layout.w;
}

export function priceToPx(price: number, view: View, layout: Layout): number {
  const range = Math.max(1e-9, view.yMax - view.yMin);
  return layout.y + (1 - (price - view.yMin) / range) * layout.h;
}

// Find the closest fractional bar index for a given timestamp (binary search
// + linear interp between adjacent bars for sub-bar precision).
export function tsToBarIdx(ts: number, bars: { ts: number }[]): number {
  if (!bars.length) return 0;
  if (ts <= bars[0]!.ts) return 0;
  if (ts >= bars[bars.length - 1]!.ts) return bars.length - 1;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.ts <= ts) lo = mid;
    else hi = mid;
  }
  const a = bars[lo]!.ts;
  const b = bars[hi]!.ts;
  if (b === a) return lo;
  return lo + (ts - a) / (b - a);
}
