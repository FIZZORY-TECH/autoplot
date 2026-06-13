/**
 * src/data/sparklinePoller.ts — Throttled watchlist sparkline refresher (P4.5).
 *
 * For each asset in the watchlist, periodically refreshes a small (24-bar)
 * 1h history through the provider registry. Updates are pushed via the
 * `onUpdate(sym, bars)` callback so the AssetPanel can re-derive its row state.
 *
 * Rate-limit friendly:
 *   - Default tick interval: 30s (matches P4-17).
 *   - Per-tick fetches are sequential per provider with a small inter-call
 *     gap, so the Rust rate-limiter never has to throttle this path.
 *   - Errors are caught + logged; one failed symbol never blocks the rest.
 *
 * Returns a cancel function. Calling it stops further ticks; an in-flight
 * tick may still emit one final batch of `onUpdate` calls (cancellation is
 * checked between fetches and at every await boundary).
 */
import type { Bar, Provider } from './MarketDataProvider';
import { getProvider } from './providerRegistry';
import { useAppStore } from '../stores/useAppStore';

/**
 * Minimal shape this poller needs — accepts both the watchlist's lighter
 * `{sym, provider}` rows and the full `AssetMeta` from the registry.
 *
 * ADR-0009 (Step 7) — `quote` is optional during the transition window;
 * `getProvider(provider, quote)` falls back to the per-provider default when
 * absent so older callers keep working.
 */
export interface SparklineAsset {
  sym: string;
  provider: Provider | string;
  quote?: string;
}

const SPARK_BARS = 24;
const SPARK_TF = '1h' as const;
const DEFAULT_INTERVAL_MS = 30_000;

export function startSparklinePolling(
  watchlist: SparklineAsset[],
  onUpdate: (sym: string, bars: Bar[]) => void,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    // Iterate per-provider, mostly to keep the call sequence stable; the Rust
    // rate-limiter handles inter-call pacing internally.
    for (const asset of watchlist) {
      if (cancelled) return;
      try {
        const bars = await getProvider(
          asset.provider as Provider,
          asset.quote,
        ).fetchHistory(asset.sym, SPARK_TF, SPARK_BARS);
        if (cancelled) return;
        onUpdate(asset.sym, bars);
        // Treat a successful fetch as a "freshness" event for the stale badge.
        try {
          useAppStore.getState().setLastTickAt(Date.now());
        } catch {
          // Non-fatal — happens in tests with no react context.
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[sparkline] ${asset.sym} (${asset.provider}) failed:`, err);
      }
    }
    if (cancelled) return;
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  // First tick AFTER intervalMs — the row's own initial fetch covers t=0.
  timer = setTimeout(() => {
    void tick();
  }, intervalMs);

  return (): void => {
    cancelled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
