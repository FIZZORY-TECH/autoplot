/**
 * src/ai/devEventFixtures.test.ts — guards that the DEV event/series mock
 * fixture builds a valid ResearchOverlay (passes the same Zod contract the MCP
 * bridge enforces) and covers every documented case.
 */
import { describe, it, expect } from 'vitest';
import { ResearchOverlay } from './schemas';
import {
  buildDevOverlay,
  buildDevTimeline,
  buildDevSeries,
  DEV_OVERLAY_ID,
  DEV_SERIES_ID,
} from './devEventFixtures';
import type { Bar } from '../data/MarketDataProvider';

// 40 synthetic bars at 1h spacing.
const BARS: Bar[] = Array.from({ length: 40 }, (_, i) => ({
  ts: 1_700_000_000_000 + i * 3_600_000,
  o: 100 + i,
  h: 105 + i,
  l: 95 + i,
  c: 100 + i + (i % 5),
  v: 1000 + i,
}));

describe('devEventFixtures', () => {
  const overlay = buildDevOverlay(BARS, 'BTC', '1h');

  it('overlay passes ResearchOverlay.safeParse', () => {
    const parsed = ResearchOverlay.safeParse(overlay);
    expect(parsed.success).toBe(true);
  });

  it('uses the stable dev overlay id', () => {
    expect(overlay.id).toBe(DEV_OVERLAY_ID);
  });

  const marks = overlay.elements.filter((e) => e.type === 'event_mark');

  it('case 1 — single pin with full data (content + source_url + source_name)', () => {
    const full = marks.find(
      (m) => m.kind === 'pin' && m.content && m.source_url && m.source_name,
    );
    expect(full).toBeTruthy();
  });

  it('case 2 — cluster of 3 events sharing one ts', () => {
    const byTs = new Map<number, number>();
    for (const m of marks) byTs.set(m.ts, (byTs.get(m.ts) ?? 0) + 1);
    expect([...byTs.values()].some((n) => n === 3)).toBe(true);
  });

  it('case 3 — event with NO content but a source_url', () => {
    expect(marks.some((m) => !m.content && m.source_url)).toBe(true);
  });

  it('case 4 — event with content but NO source_url', () => {
    expect(marks.some((m) => m.content && !m.source_url)).toBe(true);
  });

  it('case 5 — vline event', () => {
    expect(marks.some((m) => m.kind === 'vline')).toBe(true);
  });

  it('case 6 — range event with ts_end', () => {
    const range = marks.find((m) => m.kind === 'range');
    expect(range).toBeTruthy();
    expect(range?.ts_end).toBeGreaterThan(range!.ts);
  });

  it('case 7 — long-content event (multi-paragraph)', () => {
    expect(marks.some((m) => (m.content?.length ?? 0) > 800)).toBe(true);
  });

  it('case 8 — varied distinct source_names', () => {
    const sources = new Set(marks.map((m) => m.source_name).filter(Boolean));
    expect(sources.size).toBeGreaterThanOrEqual(4);
  });

  it('all event ts values anchor to real loaded bar timestamps', () => {
    const barTs = new Set(BARS.map((b) => b.ts));
    for (const m of marks) {
      expect(barTs.has(m.ts)).toBe(true);
      if (m.kind === 'range') expect(barTs.has(m.ts_end!)).toBe(true);
    }
  });

  it('case 9 — timeline layer with bare degraded events (no content/source)', () => {
    const tl = buildDevTimeline(BARS);
    expect(tl.events.length).toBeGreaterThanOrEqual(2);
    for (const ev of tl.events) {
      expect('content' in ev).toBe(false);
      expect('source_url' in ev).toBe(false);
    }
  });

  it('case 10 — series dataset (kind:series, index-aligned, one value per bar)', () => {
    const series = buildDevSeries(BARS, 'BTC', '1h');
    expect(series.id).toBe(DEV_SERIES_ID);
    expect(series.kind).toBe('series');
    expect(series.align).toBe('index');
    expect(series.values.length).toBe(BARS.length);
    // bounded 0..100 oscillator with cold-start nulls
    expect(series.values.slice(0, 14).every((v) => v === null)).toBe(true);
    for (const v of series.values) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('reseed nonce varies placement', () => {
    const a = buildDevOverlay(BARS, 'BTC', '1h', 1);
    const b = buildDevOverlay(BARS, 'BTC', '1h', 2);
    const tsA = a.elements.filter((e) => e.type === 'event_mark').map((m) => m.ts);
    const tsB = b.elements.filter((e) => e.type === 'event_mark').map((m) => m.ts);
    expect(tsA).not.toEqual(tsB);
  });
});
