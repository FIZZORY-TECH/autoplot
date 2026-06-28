/**
 * src/terminal/sessionActions.ts — the single coordination API for the
 * multi-session AI terminal. The Sessions panel and the activity rail import
 * these functions; the Terminal host (TerminalPanel) registers itself once so
 * the actions can drive its mounted-xterm set.
 *
 * Ownership split:
 *   - `useDockStore.activeSessionId` is the SOLE owner of WHICH session shows.
 *   - `useAiSessionStore` owns persisted rows + RUNNING/IDLE + busy state.
 *   - The HOST (TerminalPanel) owns the live xterm mounts + their PTY handles.
 *     It mounts one `XtermPanel` per RUNNING session (keyed by session id),
 *     reveals the active one, and keeps the rest mounted-but-hidden so their
 *     `terminal:data` / `terminal:exit` listeners stay live (background busy +
 *     self-exit detection). It registers `mountSession` / `disposeSession`
 *     bridges below.
 *
 * Lifecycle differences (DELIBERATE):
 *   - Closing the Terminal drawer HIDES the host (mountOnOpen={false}) → no
 *     dispose → the PTYs survive. Reopening reveals the same live xterms.
 *   - EXIT disposes ONE session's handle (→ terminal_kill) by UNMOUNTING that
 *     one xterm, then `markIdle(id)`. Exit ≠ Delete — the row stays.
 *
 * In-flight guard: `isSpawning` blocks a second New/Resume until the first
 * spawn promise settles, so rapid double-clicks cannot create a duplicate row
 * or a double PTY. There is NO ordering/teardown invariant — the old
 * mountOnOpen teardown race is gone — this guard is purely anti-duplicate.
 */

import { useDockStore } from '../stores/useDockStore';
import { useAiSessionStore } from '../stores/useAiSessionStore';
import type { Mode } from '../ai/types';

// ---------------------------------------------------------------------------
// Cap error — a recognizable typed value so callers (SessionsPanel) can show
// "You can run at most 4 sessions at once — exit one to start another."
// ---------------------------------------------------------------------------

/** The backend cap-rejection string (echoed verbatim from Rust). */
export const MAX_SESSIONS_REACHED = 'max_sessions_reached';

/** Thrown by `startNewSession` / `resumeSession` when the backend `MAX_SESSIONS`
 *  cap (4) is hit. `instanceof SessionCapError` is the recognizable signal. */
export class SessionCapError extends Error {
  constructor(message = MAX_SESSIONS_REACHED) {
    super(message);
    this.name = 'SessionCapError';
  }
}

/** True when an error reflects the backend concurrent-session cap. */
export function isSessionCapError(err: unknown): boolean {
  return (
    err instanceof SessionCapError ||
    (err instanceof Error && err.message.includes(MAX_SESSIONS_REACHED))
  );
}

// ---------------------------------------------------------------------------
// Cap toast — exported so SessionTabs and TerminalPanel can share the idiom
// without duplicating the lazy-import + push call.
// ---------------------------------------------------------------------------

export const CAP_MESSAGE =
  'You can run at most 4 sessions at once — exit one to start another.';

export function capToast(): void {
  console.warn('[TODO P8 toast] session cap', CAP_MESSAGE);
  void import('../stores/useToastStore').then((m) =>
    m.useToastStore.getState().push({
      kind: 'warn',
      title: 'Session limit reached',
      detail: CAP_MESSAGE,
    }),
  );
}

// ---------------------------------------------------------------------------
// Defaults — the AI terminal runs in `research` mode out of the claude-home
// jail (Rust resolves cwd when null). `claude-home` is the recorded cwd_path
// sentinel; the frontend never has the resolved absolute path.
// ---------------------------------------------------------------------------

const DEFAULT_MODE: Mode = 'research';
const DEFAULT_CWD_PATH = 'claude-home';

export interface StartSessionOptions {
  mode?: Mode;
  model?: string | null;
  title?: string | null;
}

// ---------------------------------------------------------------------------
// Host bridge — TerminalPanel registers these once on mount. The actions stay
// pure store/intent logic; the host owns the actual xterm mounts + PTY handles.
// ---------------------------------------------------------------------------

/** A request for the host to mount an xterm for `id`. `resume` selects
 *  `--resume` (true) vs `--session-id` (false). Resolves once the PTY is live
 *  (host calls `resolveSpawn`), rejects with `SessionCapError` on the cap. */
export interface MountIntent {
  id: string;
  resume: boolean;
}

interface HostBridge {
  /** Mount (or, if already mounted, reveal) an xterm for the intent. */
  mountSession: (intent: MountIntent) => void;
  /** Unmount the xterm for `id` (→ cleanup effect disposes the PTY). */
  disposeSession: (id: string) => void;
}

let host: HostBridge | null = null;

/** Called once by TerminalPanel on mount. Returns an unregister fn for unmount. */
export function registerSessionHost(bridge: HostBridge): () => void {
  host = bridge;
  return () => {
    if (host === bridge) host = null;
  };
}

// Pending spawn promises, keyed by session id. The host resolves/rejects these
// from its onSpawned / onSpawnError callbacks so the action's returned promise
// reflects the real PTY outcome (incl. the cap rejection).
const pendingSpawns = new Map<
  string,
  { resolve: () => void; reject: (e: Error) => void }
>();

/** Host hook: the PTY for `id` is live. Settles the action promise + clears the
 *  in-flight guard. Commits the session row only on this success path. */
export function resolveSpawn(id: string): void {
  const p = pendingSpawns.get(id);
  if (p) {
    pendingSpawns.delete(id);
    p.resolve();
  }
  isSpawning = false;
}

/** Host hook: the PTY spawn for `id` failed. Settles (rejects) the action
 *  promise + clears the in-flight guard. Maps the cap to `SessionCapError`.
 *
 *  StrictMode safety: an `Error('spawn_aborted')` (the dev double-mount path —
 *  React mounts, cleans up mid-spawn, then remounts the SAME element) clears
 *  the guard immediately but defers the promise reject by a macrotask, so the
 *  immediate remount's `resolveSpawn` (or a genuine `rejectSpawn`) preempts it.
 *  A genuine unmount-mid-spawn (no remount) still rejects after the defer, so
 *  the promise never deadlocks. */
export function rejectSpawn(id: string | undefined, err: Error): void {
  const aborted = err.message === 'spawn_aborted';
  const finalErr = isSessionCapError(err) ? new SessionCapError() : err;
  // The id may be undefined if the spawn rejected before resolving an id; in
  // that case fall back to the only pending entry.
  const key = id ?? (pendingSpawns.size === 1 ? [...pendingSpawns.keys()][0] : undefined);

  // The guard is always cleared so re-entry (incl. the StrictMode remount) is
  // never blocked.
  isSpawning = false;

  if (key === undefined) return;

  if (aborted) {
    // Defer: if the same pending entry is still present (and unchanged) on the
    // next macrotask, no remount preempted it → reject it. Otherwise a remount
    // already settled/replaced it → do nothing.
    const pending = pendingSpawns.get(key);
    if (!pending) return;
    setTimeout(() => {
      const still = pendingSpawns.get(key);
      if (still === pending) {
        pendingSpawns.delete(key);
        still.reject(finalErr);
      }
    }, 0);
    return;
  }

  const p = pendingSpawns.get(key);
  if (p) {
    pendingSpawns.delete(key);
    p.reject(finalErr);
  }
}

// ---------------------------------------------------------------------------
// In-flight guard
// ---------------------------------------------------------------------------

let isSpawning = false;

/** Read-only view of the in-flight guard (testing / defensive callers). */
export function isSpawnInFlight(): boolean {
  return isSpawning;
}

// ---------------------------------------------------------------------------
// Helper: reveal a session in the terminal drawer.
// ---------------------------------------------------------------------------

/** Set the active session and open the terminal drawer. Used by start, open, and resume. */
function revealSession(id: string): void {
  useDockStore.getState().setActiveSession(id);
  useDockStore.getState().openDrawer('terminal');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Start a brand-new AI session.
 *   guard → crypto.randomUUID() → set activeSessionId → open Terminal drawer →
 *   host mounts a fresh xterm + spawns `terminal_spawn({ resume:false })` →
 *   on PTY-live, `recordSpawn` commits the row (RUNNING).
 * Resolves with the new session id. Rejects with `SessionCapError` on the cap
 * (the optimistic row is rolled back). Re-entry while a spawn is in flight is
 * ignored (resolves to the empty string).
 */
export async function startNewSession(opts: StartSessionOptions = {}): Promise<string> {
  if (isSpawning) return '';
  isSpawning = true;

  const id = crypto.randomUUID();
  const mode = opts.mode ?? DEFAULT_MODE;

  // Reveal target + open the drawer BEFORE mounting so the host shows it.
  revealSession(id);

  const spawned = new Promise<void>((resolve, reject) => {
    pendingSpawns.set(id, { resolve, reject });
  });

  // Ask the host to mount a fresh xterm (resume:false → --session-id <id>).
  if (host) {
    host.mountSession({ id, resume: false });
  } else {
    // No host registered (should not happen in-app) — fail closed.
    pendingSpawns.delete(id);
    isSpawning = false;
    throw new Error('terminal host not mounted');
  }

  try {
    await spawned;
  } catch (err) {
    // Spawn failed (cap or otherwise) — nothing was recorded yet, so there's no
    // row to roll back; just clear the active selection if it's still us.
    if (useDockStore.getState().activeSessionId === id) {
      useDockStore.getState().setActiveSession(null);
    }
    throw err;
  }

  // PTY is live → commit the row (sets RUNNING automatically).
  await useAiSessionStore.getState().recordSpawn({
    id,
    mode,
    cwd_path: DEFAULT_CWD_PATH,
    model: opts.model ?? null,
    title: opts.title ?? null,
  });

  return id;
}

/**
 * Reveal an already-RUNNING session's hidden xterm. No spawn, no guard — the
 * PTY is already live and mounted; we only flip the active id + open the drawer.
 */
export function openSession(id: string): void {
  revealSession(id);
}

/**
 * Resume an IDLE session (its PTY died, e.g. across an app restart).
 *   guard → set activeSessionId → open drawer → host mounts a fresh xterm +
 *   spawns `terminal_spawn({ session_id:<sameId>, resume:true })` → on PTY-live,
 *   bump last_used_at + flip RUNNING (via recordSpawn, which re-upserts the row).
 * Rejects with `SessionCapError` on the cap. Re-entry while spawning is ignored.
 */
export async function resumeSession(
  id: string,
  opts: StartSessionOptions = {},
): Promise<void> {
  if (isSpawning) return;
  isSpawning = true;

  const existing = useAiSessionStore.getState().sessions.find((s) => s.id === id);
  const mode = opts.mode ?? existing?.mode ?? DEFAULT_MODE;
  const cwdPath = existing?.cwd_path ?? DEFAULT_CWD_PATH;
  const model = opts.model ?? existing?.model ?? null;
  const title = opts.title ?? existing?.title ?? null;

  revealSession(id);

  const spawned = new Promise<void>((resolve, reject) => {
    pendingSpawns.set(id, { resolve, reject });
  });

  if (host) {
    host.mountSession({ id, resume: true });
  } else {
    pendingSpawns.delete(id);
    isSpawning = false;
    throw new Error('terminal host not mounted');
  }

  try {
    await spawned;
  } catch (err) {
    if (useDockStore.getState().activeSessionId === id) {
      useDockStore.getState().setActiveSession(null);
    }
    throw err;
  }

  // PTY is live → re-upsert the row (bumps last_used_at) + flip RUNNING.
  await useAiSessionStore.getState().recordSpawn({
    id,
    mode,
    cwd_path: cwdPath,
    model,
    title,
  });
}

/**
 * Exit a RUNNING session: dispose its PTY (host unmounts the one xterm → its
 * cleanup effect calls handle.dispose() → terminal_kill { session_id }), then
 * `markIdle(id)` (clears the busy timer). Exit ≠ Delete — the row stays IDLE.
 * Tolerates a session whose PTY already self-exited (handle self-disposed) —
 * unmounting an already-disposed xterm is a no-op; never re-kills.
 */
export function exitSession(id: string): void {
  if (host) host.disposeSession(id);
  useAiSessionStore.getState().markIdle(id);
  // If we just exited the active session, clear the selection so the host shows
  // nothing rather than a torn-down xterm.
  if (useDockStore.getState().activeSessionId === id) {
    useDockStore.getState().setActiveSession(null);
  }
}
