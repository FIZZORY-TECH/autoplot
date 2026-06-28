/**
 * src/terminal/SessionTabs.tsx — the Terminal header tab strip.
 *
 * Folds session management INTO the Terminal (the standalone SessionsPanel
 * drawer is retired). One tab per session from `useAiSessionStore.sessions`
 * (RUNNING + IDLE both shown, in the store's order — newest/last-used first).
 *
 * Each tab carries the signature element: a status DOT.
 *   - IDLE        → static muted dot (--ink-3).
 *   - RUNNING-quiet → accent dot, `session-breathe`.
 *   - RUNNING-busy  → the 3-dot `session-stream-dot` micro-indicator (driven by
 *                     a per-id `busyUntil` subscription).
 * Tabs themselves stay quiet: hairline dividers, the ACTIVE tab marked only by
 * a subtle accent hairline edge (no fill, no glow). All motion is
 * transform/opacity-only and respects reduced-motion (see motion.css).
 *
 * Click a tab: RUNNING → `openSession`; IDLE → `resumeSession` (cap → toast).
 * Hover-revealed per-tab actions (quiet, .lib-rm idiom): always rename (✎ →
 * inline input); RUNNING → exit (✕, stays as IDLE); IDLE → forget (🗑, two-click
 * confirm → `remove`). A "+" affordance at the end starts a new session.
 *
 * Reuses the existing session-dot / session-stream / motion CSS unchanged; the
 * tab chrome lives in panels.css (.session-tab*).
 */

import { useEffect, useRef, useState } from 'react';
import { useDockStore } from '../stores/useDockStore';
import { useAiSessionStore } from '../stores/useAiSessionStore';
import {
  startNewSession,
  openSession,
  resumeSession,
  exitSession,
  isSessionCapError,
  capToast,
} from './sessionActions';
import type { AiSession } from '../lib/db';

// ---------------------------------------------------------------------------
// Names. Two forms per session:
//   - The SHORT form shown IN the tab (must fit the 110–200px budget without
//     ellipsizing to noise): a renamed title wins; else a compact "Jun 28, 14:00"
//     timestamp derived from created_at. No verbose "Session · " prefix.
//   - The LONG form used for the tooltip + aria-label: the title when set, else
//     a fully-spelled "Session started Jun 28, 14:00" so the unambiguous label
//     stays discoverable on hover / to assistive tech.
// (Salvaged from SessionsPanel; the prefix was dropped from the in-tab form.)
// ---------------------------------------------------------------------------
function timestamp(createdAtMs: number): string {
  const d = new Date(createdAtMs);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date}, ${time}`;
}

/** Short, in-tab display name (title wins; else the compact timestamp). */
function displayName(s: AiSession): string {
  return s.title || s.summary || timestamp(s.created_at);
}

/** Long, unambiguous name for the tooltip + aria-label. */
function longName(s: AiSession): string {
  return s.title || s.summary || `Session started ${timestamp(s.created_at)}`;
}

// ---------------------------------------------------------------------------
// One tab — subscribes to runState + busyUntil for THIS id so its dot flips
// reactively when the 700ms busy window lapses or the session goes idle.
// ---------------------------------------------------------------------------
interface SessionTabProps {
  session: AiSession;
}

function SessionTab({ session }: SessionTabProps): JSX.Element {
  const id = session.id;
  const running = useAiSessionStore((s) => s.runState[id] === 'RUNNING');
  // Subscribe to the timestamp (not isBusy()) so the tab re-renders reactively
  // when busyUntil changes; derive the boolean in render.
  const busyUntil = useAiSessionStore((s) => s.busyUntil[id]);
  const busy = running && busyUntil !== undefined && Date.now() < busyUntil;

  const isActive = useDockStore((s) => s.activeSessionId === id);

  // Inline rename.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  // Forget (delete) arming confirm — two-click, IDLE tabs only.
  const [arming, setArming] = useState(false);
  const armingTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(armingTimer.current);
    };
  }, []);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  // Click a tab → switch (RUNNING reveal) or resume (IDLE relaunch).
  const handleActivate = () => {
    if (renaming) return;
    if (running) {
      openSession(id);
    } else {
      resumeSession(id).catch((err) => {
        if (isSessionCapError(err)) capToast();
        else console.warn('[TODO P8 toast] resume session failed', err);
      });
    }
  };

  const handleExit = (e: React.MouseEvent) => {
    e.stopPropagation();
    exitSession(id);
  };

  const beginRename = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    // Pre-fill with the current title; an unnamed session starts empty so the
    // auto-name shows as the input placeholder (what it falls back to).
    setDraft(session.title ?? '');
    setRenaming(true);
  };

  // Double-click the name to rename in place. preventDefault keeps the dblclick
  // from text-selecting the label; the single onClick still fires once but is a
  // no-op here because handleActivate early-returns while `renaming` is true.
  const handleNameDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    beginRename();
  };

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next.length > 0 && next !== session.title) {
      void useAiSessionStore.getState().rename(id, next);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenaming(false);
    }
  };

  const handleForget = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!arming) {
      setArming(true);
      window.clearTimeout(armingTimer.current);
      armingTimer.current = window.setTimeout(() => setArming(false), 3000);
      return;
    }
    window.clearTimeout(armingTimer.current);
    setArming(false);
    void useAiSessionStore.getState().remove(id);
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleActivate();
    }
  };

  const name = displayName(session);
  const fullName = longName(session);
  const statusLabel = running ? (busy ? 'working' : 'running') : 'idle';

  return (
    <div
      className={`session-tab${isActive ? ' session-tab--active' : ''}`}
      data-testid="session-tab"
      data-session-id={id}
      data-run-state={running ? 'RUNNING' : 'IDLE'}
      data-busy={busy ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      aria-label={`${fullName} (${statusLabel})`}
      title={fullName}
      onClick={handleActivate}
      onKeyDown={onTabKeyDown}
    >
      {/* Signature element — the status dot. */}
      {busy ? (
        <span className="session-stream" aria-hidden="true">
          <span className="session-stream-dot" />
          <span className="session-stream-dot" />
          <span className="session-stream-dot" />
        </span>
      ) : (
        <span
          className={`session-dot ${running ? 'session-dot--running' : 'session-dot--idle'}`}
          aria-hidden="true"
        />
      )}

      {renaming ? (
        <input
          ref={renameRef}
          type="text"
          className="session-tab__rename"
          value={draft}
          placeholder={timestamp(session.created_at)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Rename session ${fullName}`}
        />
      ) : (
        <span
          className="session-tab__name"
          onDoubleClick={handleNameDoubleClick}
        >
          {name}
        </span>
      )}

      {/* Hover-revealed per-tab actions. */}
      <span className="session-tab__actions">
        <button
          type="button"
          className="session-tab__act"
          data-action="rename"
          onClick={beginRename}
          aria-label={`Rename session ${fullName}`}
          title="Rename"
        >
          ✎
        </button>
        {running ? (
          <button
            type="button"
            className="session-tab__act"
            data-action="exit"
            onClick={handleExit}
            aria-label={`Stop session ${fullName}`}
            title="Stop this session (keeps it in your list)"
          >
            ✕
          </button>
        ) : (
          <button
            type="button"
            className={`session-tab__act session-tab__act--danger${arming ? ' arming' : ''}`}
            data-action="forget"
            onClick={handleForget}
            aria-label={arming ? 'Confirm forget session' : `Forget session ${fullName}`}
            title={
              arming
                ? "Forget this session? It stays in the Claude CLI's own history on disk."
                : 'Forget session'
            }
          >
            {arming ? '?' : '🗑'}
          </button>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab strip — the full header row of tabs + the "+" new-session affordance.
// ---------------------------------------------------------------------------
export function SessionTabs(): JSX.Element {
  const sessions = useAiSessionStore((s) => s.sessions);

  // Disable the "+" while a spawn is in flight (the action's own in-flight guard
  // also makes a second call a no-op; '' resolve = ignored). We can't subscribe
  // to the module-level guard reactively, so use a local pending flag.
  const [pending, setPending] = useState(false);

  const handleNew = () => {
    if (pending) return;
    setPending(true);
    startNewSession()
      .then((newId) => {
        void newId; // '' = ignored by the in-flight guard — no-op.
      })
      .catch((err) => {
        if (isSessionCapError(err)) capToast();
        else console.warn('[TODO P8 toast] start new session failed', err);
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="session-tabs" role="tablist" aria-label="Terminal sessions" data-testid="session-tabs">
      <div className="session-tabs__scroll">
        {sessions.map((s) => (
          <SessionTab key={s.id} session={s} />
        ))}
      </div>
      <button
        type="button"
        className="session-tabs__new"
        data-testid="session-tabs-new"
        onClick={handleNew}
        disabled={pending}
        aria-label="Start a new session"
        title="Start a new session"
      >
        +
      </button>
    </div>
  );
}

export default SessionTabs;
