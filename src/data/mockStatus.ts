/**
 * src/data/mockStatus.ts — Mock-mode status broadcaster.
 *
 * The provider registry can silently fall back to `MockMarketDataProvider`
 * (e.g. when running outside the Tauri runtime, when `localStorage
 * .use-mock-provider === '1'`, or when a Rust adapter isn't registered yet).
 * That fallback used to be invisible to the user, who would then read prices
 * off the chart thinking they were live.
 *
 * This tiny module surfaces that state so a `<MockBadge />` (or any other
 * UI) can subscribe and render a visible indicator. It is intentionally
 * dependency-free — no Zustand, no React — so the data layer can call it
 * without pulling UI deps.
 */

export interface MockStatus {
  active: boolean;
  /** Human-readable explanation; shown in the badge tooltip. */
  reason?: string;
}

type Listener = (state: MockStatus) => void;

const listeners = new Set<Listener>();
let current: MockStatus = { active: false };

/**
 * Mark mock-mode as active or inactive. Idempotent — repeated calls with the
 * same `active` flag don't notify listeners unless the reason changed.
 */
export function setMockActive(active: boolean, reason?: string): void {
  if (current.active === active && current.reason === reason) return;
  current = { active, reason };
  for (const l of Array.from(listeners)) {
    try {
      l(current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mockStatus] listener threw', err);
    }
  }
}

/**
 * Subscribe to mock-status changes. The listener is invoked immediately with
 * the current state so subscribers don't need to query separately. Returns an
 * unsubscribe function.
 */
export function subscribeMockStatus(cb: Listener): () => void {
  listeners.add(cb);
  // Replay the current state synchronously so the UI doesn't flicker on mount.
  try {
    cb(current);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mockStatus] listener threw on initial replay', err);
  }
  return () => {
    listeners.delete(cb);
  };
}

/** Cheap synchronous read — useful for tests and one-off checks. */
export function isMockActive(): boolean {
  return current.active;
}
