/**
 * src/chart/layers/GenericResearchLayer.test.ts — Step 7
 *
 * Pure-helper assertions (alignment mapping, mismatch guard, contrast check) +
 * a structural smoke test that renders an overlay containing EVERY element type
 * against a stub canvas and asserts: no throw, hit regions registered, bands
 * break on nulls, and the align:'index' mismatch warns/toasts exactly once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderResearchOverlays,
  seriesStartFor,
  reportIndexMismatch,
  _resetMismatchGuards,
} from './GenericResearchLayer';
import { relativeLuminance, contrastRatio } from '../researchPalette';
import type { ResearchOverlay } from '../../ai/schemas';
import type { Bar } from '../../data/MarketDataProvider';
import type { ChartLayout, RenderContext, ThemeTokens, ViewWindow } from '../types';
import type { HitRegion } from '../hitRegions';

// ---------------------------------------------------------------------------
// Stub canvas context (no pixels — call counting only).
// ---------------------------------------------------------------------------

class StubCtx {
  beginPathCalls = 0;
  fillCalls = 0;
  strokeCalls = 0;
  fillRectCalls = 0;
  set fillStyle(_v: string) {}
  get fillStyle(): string { return ''; }
  set strokeStyle(_v: string) {}
  get strokeStyle(): string { return ''; }
  lineWidth = 1;
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  save(): void {}
  restore(): void {}
  beginPath(): void { this.beginPathCalls++; }
  moveTo(_x?: number, _y?: number): void {}
  lineTo(_x?: number, _y?: number): void {}
  arc(): void {}
  arcTo(): void {}
  closePath(): void {}
  fill(): void { this.fillCalls++; }
  stroke(): void { this.strokeCalls++; }
  fillRect(): void { this.fillRectCalls++; }
  fillText(): void {}
  setLineDash(): void {}
  measureText(): { width: number } { return { width: 20 }; }
}

function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push({ ts: i * 60_000, o: 100, h: 110, l: 90, c: 105, v: 1 });
  }
  return bars;
}

const layout: ChartLayout = { x: 0, y: 0, w: 1000, h: 600 };
const view: ViewWindow = { start: 0, end: 100, yMin: 0, yMax: 200 };
const theme: ThemeTokens = {
  up: 'green', down: 'red', grid: '#222', hairline: '#333', fg: '#eee', bg: '#111',
};

function makeRc(hitRegions: HitRegion[]): { ctx: StubCtx; rc: RenderContext } {
  const ctx = new StubCtx();
  const rc: RenderContext = {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    bars: makeBars(100),
    view,
    theme,
    dpr: 1,
    layout,
    hitRegions,
  };
  return { ctx, rc };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('seriesStartFor', () => {
  it("'index' anchors series index 0 ↔ bar 0", () => {
    // barCount is irrelevant for 'index' (seriesStart is always 0).
    expect(seriesStartFor('index', 50, 100)).toBe(0);
  });
  it("'right' anchors the last value to the last DATASET bar (not the visible edge)", () => {
    // last value (index len-1) maps to bar barCount-1 → seriesStart = barCount - len.
    expect(seriesStartFor('right', 30, 100)).toBe(70);
  });
  it("'right' is INVARIANT under panning — same barCount → same seriesStart", () => {
    // The pin must depend only on the dataset length, never on the visible
    // window. A series of 30 over a 100-bar dataset always starts at bar 70,
    // regardless of where the view is panned.
    expect(seriesStartFor('right', 30, 100)).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// Regression: right-aligned line/band stay pinned to absolute bars under pan
// ---------------------------------------------------------------------------

describe("align:'right' stays pinned to absolute bars when the view pans", () => {
  beforeEach(() => _resetMismatchGuards());

  // Capture the x of every moveTo/lineTo so we can assert the series x-mapping
  // does NOT move when the visible window pans left.
  class XCaptureCtx extends StubCtx {
    xs: number[] = [];
    override moveTo(x: number): void {
      this.xs.push(x);
    }
    override lineTo(x: number): void {
      this.xs.push(x);
    }
  }

  function renderLineAt(viewStart: number, viewEnd: number, barCount: number): number[] {
    const ctx = new XCaptureCtx();
    const rc: RenderContext = {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      bars: makeBars(barCount),
      view: { start: viewStart, end: viewEnd, yMin: 0, yMax: 200 },
      theme,
      dpr: 1,
      layout,
      hitRegions: [],
    };
    const ov: ResearchOverlay = {
      id: 'pin',
      sym: 'BTC',
      tf: '1h',
      label: 'pin',
      // 5 values right-aligned → must sit on the LAST 5 dataset bars (95..99).
      elements: [{ type: 'line', align: 'right', values: [10, 20, 30, 40, 50] }],
    };
    renderResearchOverlays(rc.ctx, rc, { pin: ov });
    return ctx.xs;
  }

  it('a right-aligned line draws at the same pixel xs in a wide view and a panned-left view', () => {
    // Wide view: bars 0..100 visible. Panned view: bars 90..100 visible. The
    // last 5 dataset bars are visible in BOTH, so the series xs must be the same
    // ABSOLUTE bar positions — but mapped to different pixels because the window
    // differs. Instead we assert the underlying bar indices are identical by
    // re-deriving them: in both cases the series must occupy bars 95..99.
    const wide = renderLineAt(0, 100, 100); // span 100 over 1000px → 10px/bar
    // Bars 95..99 at i+0.5 → x = (95.5..99.5)/100 * 1000 = 955..995
    expect(wide).toEqual([955, 965, 975, 985, 995]);

    const panned = renderLineAt(90, 100, 100); // span 10 over 1000px → 100px/bar
    // Same bars 95..99 at i+0.5 → x = (95.5-90)/10*1000 .. = 550, 650, 750, 850, 950
    expect(panned).toEqual([550, 650, 750, 850, 950]);
  });

  it('panning left so the series is fully off-screen draws nothing (no slide-into-view)', () => {
    // View bars 0..10. The right-aligned series lives on bars 95..99 → off-screen.
    const xs = renderLineAt(0, 10, 100);
    expect(xs).toEqual([]);
  });

  it('after a prepend (barCount grows), the right-aligned series tracks the new last bar', () => {
    // Simulate prepending 20 older bars: dataset is now 120 bars, the series of
    // 5 must now sit on bars 115..119 (still the LAST 5), not 95..99.
    const xs = renderLineAt(110, 120, 120); // bars 110..119 visible, 100px/bar
    // Bars 115..119 at i+0.5 → (115.5-110)/10*1000 = 550, 650, 750, 850, 950
    expect(xs).toEqual([550, 650, 750, 850, 950]);
  });
});

// ---------------------------------------------------------------------------
// Regression: ts-anchored elements unaffected by prepend / pan
// ---------------------------------------------------------------------------

describe('ts-anchored elements resolve ts→index per frame (prepend-immune)', () => {
  beforeEach(() => _resetMismatchGuards());

  class XCaptureCtx extends StubCtx {
    xs: number[] = [];
    override moveTo(x: number): void {
      this.xs.push(x);
    }
  }

  // Build bars where ts = (firstIndexTs + i)*60_000 — a prepend lowers the ts
  // of bar[0], so the SAME event ts shifts to a higher bar index.
  function makeBarsFrom(firstTsIndex: number, n: number): Bar[] {
    const bars: Bar[] = [];
    for (let i = 0; i < n; i++) {
      bars.push({ ts: (firstTsIndex + i) * 60_000, o: 100, h: 110, l: 90, c: 105, v: 1 });
    }
    return bars;
  }

  function renderMarkerAt(bars: Bar[], viewStart: number, viewEnd: number, ts: number) {
    const ctx = new XCaptureCtx();
    const hitRegions: HitRegion[] = [];
    const rc: RenderContext = {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      bars,
      view: { start: viewStart, end: viewEnd, yMin: 0, yMax: 200 },
      theme,
      dpr: 1,
      layout,
      hitRegions,
    };
    const ov: ResearchOverlay = {
      id: 'm',
      sym: 'BTC',
      tf: '1h',
      label: 'm',
      elements: [{ type: 'markers', points: [{ ts, price: 100, shape: 'circle' }] }],
    };
    renderResearchOverlays(rc.ctx, rc, { m: ov });
    return hitRegions.find((r) => r.kind === 'research');
  }

  it('a marker stays on its timestamp bar regardless of how many bars precede it', () => {
    const eventTs = 50 * 60_000;
    // Before: dataset bars carry ts 0..99*60_000 → event sits at bar 50.
    const before = renderMarkerAt(makeBarsFrom(0, 100), 0, 100, eventTs);
    // After prepend of 20 OLDER bars: dataset bars carry ts -20..99*60_000, so
    // bar[0] is now ts=-20*60_000 and the SAME event ts is at bar 70. Showing
    // the same absolute bars (now window 20..120) must keep the marker on its
    // event — its pixel x is unchanged because the visible bar is the same.
    const after = renderMarkerAt(makeBarsFrom(-20, 120), 20, 120, eventTs);
    // before: bar 50, span 100/1000px → (50.5/100)*1000 = 505
    expect(before?.x).toBe(505);
    // after: bar 70 visible window 20..120 span 100 → (70.5-20)/100*1000 = 505
    expect(after?.x).toBe(505);
  });
});

describe('contrast helpers', () => {
  it('white-on-black is the maximum 21:1 ratio', () => {
    const lWhite = relativeLuminance(255, 255, 255);
    const lBlack = relativeLuminance(0, 0, 0);
    expect(contrastRatio(lWhite, lBlack)).toBeCloseTo(21, 0);
  });
  it('identical colors give 1:1 and are order-independent', () => {
    const l = relativeLuminance(120, 120, 120);
    expect(contrastRatio(l, l)).toBeCloseTo(1, 5);
    expect(contrastRatio(0.5, 0.1)).toBeCloseTo(contrastRatio(0.1, 0.5), 10);
  });
});

describe('reportIndexMismatch (one-shot per overlay id)', () => {
  beforeEach(() => _resetMismatchGuards());

  it('warns + toasts exactly once per id, never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => {
      reportIndexMismatch('ov-1', 40, 100);
      reportIndexMismatch('ov-1', 40, 100);
      reportIndexMismatch('ov-1', 40, 100);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    // A different id warns again.
    reportIndexMismatch('ov-2', 10, 100);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Render smoke test — every element type
// ---------------------------------------------------------------------------

describe('renderResearchOverlays — all element types', () => {
  beforeEach(() => _resetMismatchGuards());

  const overlay: ResearchOverlay = {
    id: 'all-types',
    sym: 'BTC',
    tf: '1h',
    label: 'Everything',
    elements: [
      { type: 'line', align: 'right', values: [100, null, 120, 130] },
      // band with a null hole in the MIDDLE → polygon must break (2 fills).
      {
        type: 'band',
        align: 'right',
        upper: [150, 152, null, 158, 160],
        lower: [140, 142, null, 148, 150],
      },
      { type: 'hline', price: 105, label: 'support' },
      {
        type: 'markers',
        points: [
          { ts: 0, price: 100, shape: 'triangle-up' },
          { ts: 60_000, shape: 'circle', anchor: 'above' },
          { ts: 120_000, shape: 'diamond', anchor: 'below' },
        ],
      },
      { type: 'event_mark', kind: 'pin', ts: 180_000, label: 'pin' },
      { type: 'event_mark', kind: 'vline', ts: 240_000, label: 'vline' },
      { type: 'event_mark', kind: 'range', ts: 300_000, ts_end: 600_000, label: 'range' },
      { type: 'text', ts: 360_000, price: 130, content: 'note' },
      {
        type: 'hotspot',
        ts: 420_000,
        price: 125,
        panel: { title: 'HS', rows: [{ label: 'k', value: 'v' }] },
      },
    ],
  };

  it('renders without throwing and registers hit regions for every element', () => {
    const hitRegions: HitRegion[] = [];
    const { rc } = makeRc(hitRegions);
    expect(() =>
      renderResearchOverlays(rc.ctx, rc, { [overlay.id]: overlay }),
    ).not.toThrow();

    const research = hitRegions.filter((r) => r.kind === 'research');
    // line(1) + band(1) + hline(1) + markers(3) + event_mark(3) + text(1) +
    // hotspot(1) = 11 regions.
    expect(research.length).toBe(11);
    // Hotspot region carries its explicit panel.
    const hs = research.find(
      (r) => (r.payload as { panel?: unknown }).panel !== undefined,
    );
    expect(hs).toBeDefined();
  });

  it('band with a null hole produces TWO filled polygons (break, no fill-to-zero)', () => {
    const hitRegions: HitRegion[] = [];
    const { ctx, rc } = makeRc(hitRegions);
    const bandOnly: ResearchOverlay = {
      ...overlay,
      id: 'band-only',
      elements: [overlay.elements[1]], // the band
    };
    renderResearchOverlays(rc.ctx, rc, { b: bandOnly });
    // Two contiguous runs ([0,1] and [3,4]) → two fills.
    expect(ctx.fillCalls).toBe(2);
  });

  it("align:'index' mismatch warns once without throwing", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hitRegions: HitRegion[] = [];
    const { rc } = makeRc(hitRegions);
    const mismatched: ResearchOverlay = {
      id: 'mm',
      sym: 'BTC',
      tf: '1h',
      label: 'mm',
      // align:'index' but length (3) ≠ visible bar count.
      elements: [{ type: 'line', align: 'index', values: [1, 2, 3] }],
    };
    expect(() =>
      renderResearchOverlays(rc.ctx, rc, { mm: mismatched }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
