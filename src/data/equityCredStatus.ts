/**
 * src/data/equityCredStatus.ts — Equity credentials status broadcaster.
 *
 * Emits a typed error when the Alpaca adapter is absent (no credentials)
 * so the UI can show a hard-fail state instead of silently showing mock prices.
 *
 * Also emits a transient `connected` pulse the moment a successful save +
 * reload lands, so the banner surface can briefly confirm the change outside
 * the (now-dismissed) modal. The pulse is a one-shot — listeners observe a
 * `connected: true` snapshot and are expected to fade it out on their own
 * cadence; the broadcaster does NOT auto-clear it.
 *
 * Intentionally dependency-free (no Zustand, no React) so the data layer
 * can call it without pulling UI deps — mirrors the `mockStatus.ts` pattern.
 */

import { ohlcCache } from './ohlcCache';

export type EquityFailReason = 'no_credentials' | 'fetch_failed' | 'auth_failed';

export interface EquityCredStatus {
  /** True when at least one equity fetch has failed due to missing/invalid creds. */
  failed: boolean;
  reason?: EquityFailReason;
  /** Human-readable detail for tooltip / banner. */
  detail?: string;
  /**
   * Monotonic counter that increments each time the credentials are
   * successfully saved + reloaded. Listeners can observe the bump as a
   * one-shot "connected" pulse and render an ephemeral success surface.
   * Starts at 0 (never connected this session). Optional so existing
   * `useState<EquityCredStatus>({ failed: false })` call sites elsewhere in
   * the codebase keep type-checking without changes.
   */
  connectedAt?: number;
}

type Listener = (state: EquityCredStatus) => void;

const listeners = new Set<Listener>();
let current: EquityCredStatus = { failed: false, connectedAt: 0 };

/**
 * Mark the equity data path as failed or clear it.
 * Idempotent — repeated calls with the same state don't notify listeners.
 */
export function setEquityCredFailed(
  failed: boolean,
  reason?: EquityFailReason,
  detail?: string,
): void {
  if (
    current.failed === failed &&
    current.reason === reason &&
    current.detail === detail
  ) {
    return;
  }
  current = { ...current, failed, reason, detail };
  for (const l of Array.from(listeners)) {
    try {
      l(current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[equityCredStatus] listener threw', err);
    }
  }
}

/**
 * Mark equity credentials as freshly connected. Clears any prior failure
 * state and bumps `connectedAt`, which subscribers can observe as a
 * one-shot "we just connected" pulse for ephemeral success UI.
 */
export function setEquityConnected(): void {
  // Evict stale alpaca bars so the next fetchHistory goes to Rust with the
  // newly-saved credentials rather than hitting the in-memory cache.
  ohlcCache.clearProvider('alpaca');
  current = {
    failed: false,
    reason: undefined,
    detail: undefined,
    connectedAt: (current.connectedAt ?? 0) + 1,
  };
  for (const l of Array.from(listeners)) {
    try {
      l(current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[equityCredStatus] listener threw', err);
    }
  }
}

/**
 * Subscribe to equity credential status changes.
 * Listener is invoked immediately with the current state on registration.
 * Returns an unsubscribe function.
 */
export function subscribeEquityCredStatus(cb: Listener): () => void {
  listeners.add(cb);
  try {
    cb(current);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[equityCredStatus] listener threw on initial replay', err);
  }
  return () => {
    listeners.delete(cb);
  };
}

/** Cheap synchronous read. */
export function isEquityCredFailed(): boolean {
  return current.failed;
}

/** Get the current status snapshot (for tests / one-off checks). */
export function getEquityCredStatus(): EquityCredStatus {
  return current;
}
