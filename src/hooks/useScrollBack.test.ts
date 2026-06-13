/**
 * src/hooks/useScrollBack.test.ts — Step 5a unit tests for `dedupByTs`.
 *
 * Tests the pure exported `dedupByTs` function from useScrollBack without any
 * React render. Effect-level assertions (arm/skip/stale-discard) are covered by
 * the Playwright scroll-back spec (tests/e2e/scrollback.spec.ts) because they
 * require the full app + mock provider loop, which is out of reach in jsdom.
 *
 * @testing-library/react IS a devDependency (^16.3.0) so renderHook is
 * available, but we intentionally stay pure here:
 *   - The hook's side effects (setBars, setXWindow) have complex dependencies
 *     (ohlcCache, useToastStore, getProvider) that would require significant
 *     mocking to isolate, adding noise without extra coverage.
 *   - The merge/dedup math is what Step 5a specifically needs to prove correct.
 *   - Playwright covers the full round-trip (fetch → prepend → viewport shift).
 */

import { describe, it, expect } from 'vitest';
import type { Bar } from '../data/MarketDataProvider';
import { dedupByTs } from './useScrollBack';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Bar with a given timestamp (other OHLCV fields are nominal). */
function bar(ts: number, close = 100): Bar {
  return { ts, o: close, h: close + 1, l: close - 1, c: close, v: 10 };
}

/**
 * Build an inclusive range of bars where each bar's ts is `start + i * step`
 * and its close is distinguishable by position (used in collision tests).
 */
function barRange(
  startTs: number,
  endTs: number,
  step: number,
  closeOffset = 0,
): Bar[] {
  const out: Bar[] = [];
  for (let ts = startTs; ts <= endTs; ts += step) {
    out.push(bar(ts, 100 + closeOffset));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Basic dedup + ascending order
// ---------------------------------------------------------------------------

describe('dedupByTs — basic dedup and ordering', () => {
  it('returns bars in ascending ts order', () => {
    const input = [bar(300), bar(100), bar(200)];
    const result = dedupByTs(input);
    expect(result.map((b) => b.ts)).toEqual([100, 200, 300]);
  });

  it('removes exact ts duplicates', () => {
    const input = [bar(100), bar(200), bar(200), bar(300)];
    const result = dedupByTs(input);
    expect(result.length).toBe(3);
    expect(result.map((b) => b.ts)).toEqual([100, 200, 300]);
  });

  it('empty input returns empty array', () => {
    expect(dedupByTs([])).toEqual([]);
  });

  it('single bar is returned unchanged', () => {
    const b = bar(500, 42);
    expect(dedupByTs([b])).toEqual([b]);
  });
});

// ---------------------------------------------------------------------------
// 2. Merge of [...older, ...bars] — later entry wins on collision
// ---------------------------------------------------------------------------

describe('dedupByTs — later entry wins on ts collision', () => {
  it('when older and bars share a ts, the bars (later) entry wins', () => {
    // Pass [...older, ...bars]: bar at ts=200 appears in both.
    // The second occurrence (from bars) should win.
    const olderBar = bar(200, 50);  // older page — stale close
    const loadedBar = bar(200, 99); // already-loaded bar — may carry live tick
    const merged = dedupByTs([olderBar, loadedBar]);
    expect(merged.length).toBe(1);
    expect(merged[0].c).toBe(99); // loaded bar wins
  });

  it('all collisions resolve with the later (loaded) bars winning', () => {
    const older = [bar(100, 1), bar(200, 2), bar(300, 3)];
    const loaded = [bar(200, 20), bar(300, 30), bar(400, 40)]; // 200 + 300 collide
    const merged = dedupByTs([...older, ...loaded]);
    expect(merged.length).toBe(4);
    expect(merged.map((b) => b.ts)).toEqual([100, 200, 300, 400]);
    // Colliding bars: loaded (later) wins
    expect(merged.find((b) => b.ts === 200)!.c).toBe(20);
    expect(merged.find((b) => b.ts === 300)!.c).toBe(30);
    // Non-colliding older bar is preserved
    expect(merged.find((b) => b.ts === 100)!.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Overlap arithmetic: `inserted = merge.length - bars.length`
// ---------------------------------------------------------------------------

describe('dedupByTs — overlap arithmetic (inserted count)', () => {
  /**
   * Scenario from the plan:
   *   older = [200..620]  (step 1 → 421 bars: ts 200, 201, …, 620)
   *   bars  = [500..900]  (step 1 → 401 bars: ts 500, 501, …, 900)
   *   overlap region: [500..620] = 121 bars
   *   merged = [200..900] = 701 bars
   *   inserted = 701 - 401 = 300  (not 421 — the overlap is deduplicated)
   *
   * We use step=1 (ms) for simplicity; the math is the same as step=3600000.
   */
  it('inserted = merged.length - bars.length is 300, not 421, when older=[200..620] bars=[500..900]', () => {
    const older = barRange(200, 620, 1, 0);   // 421 bars, ts 200..620
    const loaded = barRange(500, 900, 1, 10); // 401 bars, ts 500..900
    expect(older.length).toBe(421);
    expect(loaded.length).toBe(401);

    const merged = dedupByTs([...older, ...loaded]);
    expect(merged.length).toBe(701); // ts 200..900 = 701 unique slots

    const inserted = merged.length - loaded.length;
    expect(inserted).toBe(300); // 421 older − 121 overlap = 300 net new bars
  });

  it('no overlap: inserted == older.length', () => {
    const older = barRange(100, 299, 1);  // 200 bars, ts 100..299
    const loaded = barRange(300, 499, 1); // 200 bars, ts 300..499
    const merged = dedupByTs([...older, ...loaded]);
    expect(merged.length).toBe(400);
    const inserted = merged.length - loaded.length;
    expect(inserted).toBe(200); // full older window is new
  });

  it('100% overlap: inserted == 0 (no new bars added)', () => {
    const older = barRange(300, 499, 1);  // same window as loaded
    const loaded = barRange(300, 499, 1);
    const merged = dedupByTs([...older, ...loaded]);
    expect(merged.length).toBe(loaded.length);
    const inserted = merged.length - loaded.length;
    expect(inserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Empty older page → loaded bars unchanged
// ---------------------------------------------------------------------------

describe('dedupByTs — empty older page (hasMoreHistory=false signal)', () => {
  /**
   * When `older` is empty the hook sets `hasMoreHistory=false` and never calls
   * dedupByTs. But if it WERE called with [], the result must equal loaded bars
   * so the invariant holds: `merge.length - bars.length === 0` → no prepend →
   * the hook would correctly detect nothing was inserted.
   */
  it('empty older returns loaded bars unchanged (count stable, no dedup loss)', () => {
    const loaded = [bar(500), bar(600), bar(700)];
    const merged = dedupByTs([...[], ...loaded]);
    expect(merged.length).toBe(loaded.length);
    expect(merged.map((b) => b.ts)).toEqual([500, 600, 700]);
  });

  it('empty older produces inserted=0', () => {
    const loaded = [bar(1), bar(2), bar(3)];
    const merged = dedupByTs([...[], ...loaded]);
    const inserted = merged.length - loaded.length;
    expect(inserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Realistic timeframe scenario (hourly bars)
// ---------------------------------------------------------------------------

describe('dedupByTs — realistic hourly bar merge', () => {
  const HOUR = 3_600_000;
  const BASE = 1_720_000_000_000; // arbitrary epoch-ms anchor

  it('prepending 300 hourly bars before 600 loaded bars yields 900 total', () => {
    // Simulates the typical scroll-back: fetch PAGE_OLDER=300 older bars.
    const older = Array.from({ length: 300 }, (_, i) => bar(BASE + i * HOUR));
    const loaded = Array.from({ length: 600 }, (_, i) => bar(BASE + (300 + i) * HOUR));
    const merged = dedupByTs([...older, ...loaded]);
    expect(merged.length).toBe(900);
    expect(merged[0].ts).toBe(BASE);
    expect(merged[899].ts).toBe(BASE + 899 * HOUR);
  });

  it('no ts duplicates in merged output (all unique)', () => {
    const older = Array.from({ length: 10 }, (_, i) => bar(BASE + i * HOUR));
    const loaded = Array.from({ length: 10 }, (_, i) => bar(BASE + (5 + i) * HOUR)); // 5-bar overlap
    const merged = dedupByTs([...older, ...loaded]);
    const tsList = merged.map((b) => b.ts);
    const unique = new Set(tsList);
    expect(unique.size).toBe(tsList.length); // no duplicates
    expect(merged.length).toBe(15); // 10 + 10 - 5 overlap = 15
  });
});
