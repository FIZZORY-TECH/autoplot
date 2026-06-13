/**
 * src/chart/useOverlayData.ts — Memoized overlay computation hook.
 *
 * Caches computed indicator arrays keyed by (sym, tf, type) using a simple
 * Map-based LRU capped at MAX_CACHE entries. No external LRU lib needed.
 *
 * Usage:
 *   const { smaValues, bbResult } = useOverlayData(bars, sym, tf, 'ma20');
 */

import { useMemo } from 'react';
import { sma, bollinger, BollingerResult } from '../engine/indicators';
import type { Bar, Tf } from '../data/MarketDataProvider';

// ---------------------------------------------------------------------------
// Simple LRU cache (Map preserves insertion order; we evict the oldest key).
// ---------------------------------------------------------------------------

const MAX_CACHE = 32;

interface CacheEntry {
  smaValues20: (number | null)[];
  smaValues50: (number | null)[];
  bbResult: BollingerResult;
}

// Use a module-level map so the cache survives across React renders
// without useRef (renderers are value-equal by key if bars don't change).
const _cache = new Map<string, CacheEntry>();

function lruGet(key: string): CacheEntry | undefined {
  if (!_cache.has(key)) return undefined;
  // Move to end (most-recently-used)
  const v = _cache.get(key)!;
  _cache.delete(key);
  _cache.set(key, v);
  return v;
}

function lruSet(key: string, value: CacheEntry): void {
  if (_cache.has(key)) _cache.delete(key);
  else if (_cache.size >= MAX_CACHE) {
    // Evict oldest (first) entry
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
  _cache.set(key, value);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface OverlayData {
  /** SMA-20 values aligned to bars array (null for first 19 bars). */
  smaValues20: (number | null)[];
  /** SMA-50 values aligned to bars array (null for first 49 bars). */
  smaValues50: (number | null)[];
  /** Bollinger Bands (period 20, k 2). */
  bbResult: BollingerResult;
}

/**
 * Compute and memoize overlay data for a given (sym, tf) pair.
 * The `type` parameter is reserved for future per-type routing but currently
 * all three indicators are computed together so that toggling overlays on/off
 * doesn't trigger recomputation.
 *
 * @param bars  Full bar series (600 bars)
 * @param sym   Asset symbol e.g. 'BTC'
 * @param tf    Timeframe e.g. '1h'
 * @param _type  Reserved — pass 'all' for now
 */
export function useOverlayData(
  bars: Bar[],
  sym: string,
  tf: Tf,
  _type = 'all',
): OverlayData {
  // Derive a stable cache key. We include bars.length and the last bar's ts
  // so that live-update appends invalidate the cache correctly.
  const cacheKey = useMemo(() => {
    const lastTs = bars.length ? String(bars[bars.length - 1]?.ts ?? 0) : '0';
    return `${sym}:${tf}:${bars.length}:${lastTs}`;
  }, [bars, sym, tf]);

  return useMemo(() => {
    const existing = lruGet(cacheKey);
    if (existing) return existing;

    const closes = bars.map((b) => b.c);
    const entry: CacheEntry = {
      smaValues20: sma(closes, 20),
      smaValues50: sma(closes, 50),
      bbResult: bollinger(closes, 20, 2),
    };
    lruSet(cacheKey, entry);
    return entry;
  }, [cacheKey, bars]);
}
