/**
 * src/chart/signals.test.ts — W5-C12
 *
 * Structural assertions on the signals renderer using a stub canvas context.
 * No pixel testing — we count beginPath()/fill()/stroke() calls and assert
 * fillStyle/strokeStyle assignments + setLineDash usage.
 */

import { describe, it, expect } from 'vitest';
import { renderSignals, signalsOverlay, SIGNAL_GREEN, SIGNAL_RED } from './signals';
import type { Bar } from '../data/MarketDataProvider';
import type { Trade } from '../engine/backtest';
import type { ChartLayout, ViewWindow, RenderContext, ThemeTokens } from './types';

class StubCtx {
  fillCalls = 0;
  strokeCalls = 0;
  beginPathCalls = 0;
  setLineDashCalls: number[][] = [];
  fillStyles: string[] = [];
  strokeStyles: string[] = [];
  saveCalls = 0;
  restoreCalls = 0;
  // Mutable props that real CanvasRenderingContext2D exposes.
  set fillStyle(v: string) { this.fillStyles.push(v); }
  get fillStyle(): string { return this.fillStyles[this.fillStyles.length - 1] ?? ''; }
  set strokeStyle(v: string) { this.strokeStyles.push(v); }
  get strokeStyle(): string { return this.strokeStyles[this.strokeStyles.length - 1] ?? ''; }
  lineWidth = 1;
  save(): void { this.saveCalls++; }
  restore(): void { this.restoreCalls++; }
  beginPath(): void { this.beginPathCalls++; }
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  fill(): void { this.fillCalls++; }
  stroke(): void { this.strokeCalls++; }
  setLineDash(arr: number[]): void { this.setLineDashCalls.push([...arr]); }
}

function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push({ ts: i * 60_000, o: 100, h: 110, l: 90, c: 105, v: 1 });
  }
  return bars;
}

const view: ViewWindow = { start: 0, end: 100, yMin: 0, yMax: 200 };
const layout: ChartLayout = { x: 0, y: 0, w: 1000, h: 600 };
const viewport = { view, layout };

describe('renderSignals', () => {
  it('no-ops when trades or bars are empty', () => {
    const ctx = new StubCtx();
    renderSignals(ctx as unknown as CanvasRenderingContext2D, viewport, [], makeBars(10));
    expect(ctx.beginPathCalls).toBe(0);

    const ctx2 = new StubCtx();
    renderSignals(ctx2 as unknown as CanvasRenderingContext2D, viewport, [
      { entryBar: 0, exitBar: 1, entryPrice: 100, exitPrice: 105, pnl: 5, pnlPct: 0.05 },
    ], []);
    expect(ctx2.beginPathCalls).toBe(0);
  });

  it('draws 2 triangles + 1 connector per trade (3 beginPath each)', () => {
    const ctx = new StubCtx();
    const trades: Trade[] = [
      { entryBar: 5, exitBar: 10, entryPrice: 100, exitPrice: 110, pnl: 10, pnlPct: 0.1 },
      { entryBar: 20, exitBar: 25, entryPrice: 100, exitPrice: 95, pnl: -5, pnlPct: -0.05 },
    ];
    renderSignals(
      ctx as unknown as CanvasRenderingContext2D,
      viewport,
      trades,
      makeBars(50),
    );
    // 3 paths per trade: entry triangle, exit triangle, connector.
    expect(ctx.beginPathCalls).toBe(trades.length * 3);
    // Entry triangle is filled (1 fill per trade); exit triangle filled when
    // not openAtEnd (1 per trade for these); connector is stroked.
    expect(ctx.fillCalls).toBe(trades.length * 2);
    // Strokes: 1 connector per trade = 2.
    expect(ctx.strokeCalls).toBe(trades.length);
    // setLineDash invoked twice per trade (set then reset).
    expect(ctx.setLineDashCalls.length).toBe(trades.length * 2);
    // Save/restore balanced.
    expect(ctx.saveCalls).toBe(1);
    expect(ctx.restoreCalls).toBe(1);
  });

  it('connector color is green for pnl>0, red for pnl<=0', () => {
    const ctx = new StubCtx();
    const trades: Trade[] = [
      { entryBar: 5, exitBar: 10, entryPrice: 100, exitPrice: 110, pnl: 10, pnlPct: 0.1 },
      { entryBar: 20, exitBar: 25, entryPrice: 100, exitPrice: 95, pnl: -5, pnlPct: -0.05 },
    ];
    renderSignals(
      ctx as unknown as CanvasRenderingContext2D,
      viewport,
      trades,
      makeBars(50),
    );
    expect(ctx.strokeStyles).toContain(SIGNAL_GREEN);
    expect(ctx.strokeStyles).toContain(SIGNAL_RED);
  });

  it('openAtEnd uses outline (stroke) instead of fill for the exit triangle', () => {
    const ctx = new StubCtx();
    const trades: Trade[] = [
      {
        entryBar: 5,
        exitBar: 49,
        entryPrice: 100,
        exitPrice: 105,
        pnl: 5,
        pnlPct: 0.05,
        openAtEnd: true,
      },
    ];
    renderSignals(
      ctx as unknown as CanvasRenderingContext2D,
      viewport,
      trades,
      makeBars(50),
    );
    // Entry filled (1) + exit outlined (0) = 1 fill total for the triangles.
    expect(ctx.fillCalls).toBe(1);
    // Strokes: exit triangle outline (1) + connector (1) = 2.
    expect(ctx.strokeCalls).toBe(2);
  });

  it('signalsOverlay returns a ChartRenderer that delegates to renderSignals', () => {
    const ctx = new StubCtx();
    const trades: Trade[] = [
      { entryBar: 5, exitBar: 10, entryPrice: 100, exitPrice: 110, pnl: 10, pnlPct: 0.1 },
    ];
    const renderer = signalsOverlay(trades);
    const theme: ThemeTokens = { up: '', down: '', grid: '', hairline: '', fg: '', bg: '' };
    const rc: RenderContext = {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      bars: makeBars(50),
      view,
      theme,
      dpr: 1,
      layout,
    };
    renderer.render(rc);
    // 3 beginPath calls per trade.
    expect(ctx.beginPathCalls).toBe(3);
  });
});
