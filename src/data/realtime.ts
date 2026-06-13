/**
 * src/data/realtime.ts — Realtime orchestrator (P4.5).
 *
 * Owns the SINGLE active WebSocket subscription across the whole app (per
 * P4-11 — one stream at a time, for the active asset only). Routes incoming
 * ticks to any number of registered listeners.
 *
 * Subscription policy:
 *   - `subscribe(provider, sym, tf)` is idempotent — calling with the same
 *     `(provider, sym, tf)` triple is a no-op.
 *   - Switching to a different triple tears down the old WS first, then opens
 *     the new one. Listeners are preserved across the switch.
 *
 * Tick merge helper:
 *   - `mergeTick(bars, tick)` collapses an incoming tick into the local bar
 *     array. Ticks with `ts` matching the last bar are treated as in-progress
 *     updates (replace last bar). Ticks with newer `ts` append a new bar.
 *     Stale ticks (`ts` < last) are ignored.
 */
import type { Bar, Provider, Tf } from './MarketDataProvider';
import { getProvider } from './providerRegistry';
import { useAppStore } from '../stores/useAppStore';

class RealtimeOrchestrator {
  private currentUnsub: (() => void) | null = null;
  private currentKey: string | null = null;
  private listeners = new Set<(bar: Bar) => void>();

  /**
   * Subscribe to live ticks for `(provider, sym, quote, tf)`. Idempotent: a
   * call with the same tuple as the current subscription is a no-op. A call
   * with a different tuple tears down the existing subscription first.
   *
   * ADR-0009 — `quote` is part of the canonical identity. SOL/USDT and
   * SOL/USDC are different markets and must not share a WS stream.
   */
  subscribe(provider: Provider, sym: string, tf: Tf, quote?: string): void {
    const key = `${provider}:${sym}/${quote ?? ''}:${tf}`;
    if (this.currentKey === key && this.currentUnsub) return;

    // Tear down any existing subscription — listeners survive the switch.
    this.unsubscribe();

    this.currentKey = key;
    const p = getProvider(provider, quote);
    try {
      this.currentUnsub = p.subscribeRealtime(sym, tf, (bar) => {
        // Stamp the most-recent tick time on the global store so the
        // `Headline` "stale" badge can fade in/out automatically.
        try {
          useAppStore.getState().setLastTickAt(Date.now());
        } catch {
          // Store update failed (e.g. in a non-react test env) — non-fatal.
        }
        // Snapshot listeners so a removal during dispatch doesn't skip neighbours.
        for (const l of Array.from(this.listeners)) {
          try {
            l(bar);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[realtime] listener threw', err);
          }
        }
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[realtime] WS subscribe threw for ${key}:`, err);
      this.currentUnsub = null;
      this.currentKey = null;
    }
  }

  /** Tear down the active subscription, if any. Listeners are preserved. */
  unsubscribe(): void {
    if (this.currentUnsub) {
      try {
        this.currentUnsub();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[realtime] unsubscribe threw', err);
      }
    }
    this.currentUnsub = null;
    this.currentKey = null;
  }

  /**
   * Register a tick listener. Returns an unregister callback.
   * Listeners persist across `subscribe` switches.
   */
  onTick(cb: (bar: Bar) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Diagnostic — current subscription key, or null when idle. */
  get activeKey(): string | null {
    return this.currentKey;
  }

  /** Diagnostic — number of registered listeners. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Process-wide singleton. Tests should construct their own if isolation is needed. */
export const realtime = new RealtimeOrchestrator();

/**
 * Merge a live tick into a bar array.
 *
 * Rules:
 *   - `tick.ts === lastBar.ts` → replace the last bar (in-progress update).
 *   - `tick.ts > lastBar.ts`   → append the new bar.
 *   - `tick.ts < lastBar.ts`   → ignore (stale tick).
 *
 * Returns a new array if the bars changed, or the same reference if not —
 * lets React skip unnecessary re-renders via `setBars(prev => mergeTick(...))`.
 */
export function mergeTick(bars: Bar[], tick: Bar): Bar[] {
  if (bars.length === 0) {
    return [tick];
  }
  const last = bars[bars.length - 1];
  if (tick.ts === last.ts) {
    // Replace the in-progress bar.
    const next = bars.slice(0, -1);
    next.push(tick);
    return next;
  }
  if (tick.ts > last.ts) {
    return [...bars, tick];
  }
  // Stale — ignore.
  return bars;
}
