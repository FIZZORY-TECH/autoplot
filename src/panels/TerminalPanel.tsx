/**
 * src/panels/TerminalPanel.tsx — the multi-session AI terminal HOST.
 *
 * Wraps a set of XtermPanels in DockDrawer (side="right", id="terminal").
 *
 * Lifecycle INVERSION (AI-session-manager):
 *   - This DockDrawer uses `mountOnOpen={false}` (the DEFAULT for the shared
 *     component — only THIS call site relies on it). Closing the Terminal
 *     drawer HIDES the host (off-screen transform), it does NOT unmount. So the
 *     XtermPanel cleanup → handle.dispose() → terminal_kill chain NO LONGER
 *     fires on close → the PTYs survive. Reopening reveals the same live xterms.
 *   - dispose / terminal_kill is reached ONLY on explicit Exit (the host
 *     unmounts that one xterm) and on CLI self-exit (terminalClient self-tears
 *     down; we just unmount + markIdle).
 *
 * Multi-session host:
 *   - Renders ONE mounted XtermPanel per session it has mounted, keyed by
 *     session id. The active session (useDockStore.activeSessionId) is shown;
 *     the rest are kept MOUNTED but `display:none` so their terminal:data /
 *     terminal:exit listeners stay live (background busy + self-exit detection).
 *     A detach-while-hidden approach is explicitly rejected.
 *   - Bounded by the backend MAX_SESSIONS = 4.
 *
 * Busy wiring: every PTY data frame → markActivity(id); every exit → markIdle.
 *
 * Per-session exit bar: a per-id restart counter + per-id exit record. Only the
 * ACTIVE session's bar is visible; "Restart" resumes that session.
 *
 * The host registers a bridge (mountSession / disposeSession) with
 * sessionActions so the Sessions panel + rail drive it via the action API.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { XtermPanel } from '../terminal/XtermPanel';
import { useDockStore } from '../stores/useDockStore';
import { useAiSessionStore } from '../stores/useAiSessionStore';
import { useToastStore } from '../stores/useToastStore';
import {
  registerSessionHost,
  resolveSpawn,
  rejectSpawn,
  resumeSession,
  startNewSession,
  isSessionCapError,
  capToast,
  type MountIntent,
} from '../terminal/sessionActions';
import { SessionTabs } from '../terminal/SessionTabs';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';

/** A mounted xterm descriptor. `restartKey` bumps to force a fresh remount
 *  (new PTY) without re-keying the React element off the session id. */
interface Mount {
  id: string;
  resume: boolean;
  restartKey: number;
}

export function TerminalPanel(): JSX.Element {
  const open = useDockStore((s) => s.openRight === 'terminal');
  const activeSessionId = useDockStore((s) => s.activeSessionId);
  const close = () => useDockStore.getState().close('right');

  // The set of xterms this host currently has mounted (one PTY each). Driven by
  // the action bridge (mountSession / disposeSession) registered below.
  const [mounts, setMounts] = useState<Mount[]>([]);
  // Per-session exit record: { code } once a session's PTY exits, cleared on
  // restart. Keyed by session id so each session has its own exit bar.
  const [exited, setExited] = useState<Record<string, { code: number }>>({});

  // ---- Host bridge: mount / dispose ---------------------------------------
  // mountSession: add a mount for the id (or, if it already exists, force a
  // fresh remount by bumping its restartKey). Clears any stale exit record.
  const mountSession = useCallback((intent: MountIntent) => {
    setExited((prev) => {
      if (prev[intent.id] === undefined) return prev;
      const { [intent.id]: _gone, ...rest } = prev;
      return rest;
    });
    setMounts((prev) => {
      const existing = prev.find((m) => m.id === intent.id);
      if (existing) {
        // Re-mount fresh (Restart / re-resume): bump restartKey, update resume.
        return prev.map((m) =>
          m.id === intent.id
            ? { ...m, resume: intent.resume, restartKey: m.restartKey + 1 }
            : m,
        );
      }
      return [...prev, { id: intent.id, resume: intent.resume, restartKey: 0 }];
    });
  }, []);

  // disposeSession: unmount the xterm for id → its cleanup effect disposes the
  // PTY (terminal_kill). No-op if already gone (tolerates self-exit).
  const disposeSession = useCallback((id: string) => {
    setMounts((prev) => prev.filter((m) => m.id !== id));
    setExited((prev) => {
      if (prev[id] === undefined) return prev;
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  useEffect(() => {
    const unregister = registerSessionHost({ mountSession, disposeSession });
    return unregister;
  }, [mountSession, disposeSession]);

  // ---- Per-mount event handlers -------------------------------------------
  // markActivity on EVERY data frame (incl. hidden/background sessions).
  const handleData = useCallback((sessionId: string) => {
    useAiSessionStore.getState().markActivity(sessionId);
  }, []);

  // onSpawned → settle the action promise (commits recordSpawn there).
  const handleSpawned = useCallback((sessionId: string) => {
    resolveSpawn(sessionId);
  }, []);

  // onSpawnError → settle (reject) the action promise; unmount the dead xterm.
  // EXCEPT a StrictMode `spawn_aborted` (dev double-mount of the SAME element):
  // leave it mounted so the immediate remount can re-spawn — rejectSpawn defers
  // its reject so a real remount preempts it.
  const handleSpawnError = useCallback(
    (sessionId: string | undefined, err: Error) => {
      rejectSpawn(sessionId, err);
      if (sessionId !== undefined && err.message !== 'spawn_aborted') {
        setMounts((prev) => prev.filter((m) => m.id !== sessionId));
      }
    },
    [],
  );

  // onExit (PTY self-exit / crash): terminalClient already self-disposed the
  // handle (never re-kill). Record the exit, flip IDLE (clears the busy timer),
  // and UNMOUNT this one xterm — its cleanup runs handle.dispose() which is a
  // no-op post-exit (idempotent). Exit ≠ Delete: the session row survives.
  const handleExit = useCallback((id: string, code: number) => {
    setExited((prev) => ({ ...prev, [id]: { code } }));
    useAiSessionStore.getState().markIdle(id);
    setMounts((prev) => prev.filter((m) => m.id !== id));

    if (code === 0) {
      useToastStore.getState().push({ kind: 'info', title: 'Claude session ended' });
    } else {
      useToastStore.getState().push({
        kind: 'error',
        title: `Claude session exited (code ${code})`,
      });
    }
  }, []);

  // ---- Render --------------------------------------------------------------
  const activeExit = activeSessionId !== null ? exited[activeSessionId] ?? null : null;

  // Restart the ACTIVE exited session — resume its conversation (fresh PTY).
  const restartActive = useCallback(() => {
    if (activeSessionId === null) return;
    void resumeSession(activeSessionId).catch(() => {
      // Cap / failure surfaces via toast in the xterm + the action rejection.
    });
  }, [activeSessionId]);

  // ---- Auto-start on open --------------------------------------------------
  // When the Terminal drawer transitions CLOSED → OPEN and no session is active,
  // never land the user on an empty terminal: reveal the most-recent RUNNING
  // session if one exists, otherwise spawn a fresh one (once). The
  // open-transition guard (prevOpenRef) makes this fire only on the edge — not
  // on every render — and the activeSessionId check + the action's own in-flight
  // guard together prevent any double-spawn.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open || wasOpen) return; // only the closed → open edge

    if (useDockStore.getState().activeSessionId !== null) return;

    // Prefer revealing the most-recent RUNNING session (sessions are stored
    // newest/last-used first, so the first RUNNING id is the most recent).
    const { sessions, runState } = useAiSessionStore.getState();
    const mostRecentRunning = sessions.find((s) => runState[s.id] === 'RUNNING');
    if (mostRecentRunning) {
      useDockStore.getState().setActiveSession(mostRecentRunning.id);
      return;
    }

    // No live session — spawn one. The in-flight guard makes a redundant call a
    // no-op (resolves to '').
    void startNewSession().catch((err) => {
      if (isSessionCapError(err)) {
        capToast();
      } else {
        console.warn('[TODO P8 toast] auto-start session failed', err);
      }
    });
  }, [open]);

  return (
    <DockDrawer
      side="right"
      id="terminal"
      ariaLabel="Claude CLI terminal"
      // mountOnOpen={false} (the shared default): closing HIDES, never unmounts,
      // so the PTYs survive a drawer close. ONLY this call site relies on it.
      mountOnOpen={false}
      open={open}
    >
      {/* Header */}
      <PanelHeader
        label="Terminal"
        closeLabel="Close Terminal panel"
        onClose={close}
      >
        <span className="terminal-panel-sub">(Claude CLI)</span>
      </PanelHeader>

      {/* Session tab strip — one tab per session (RUNNING + IDLE), the active
          one carries an accent hairline edge; "+" starts a new session. Folds
          the retired SessionsPanel drawer into the Terminal header. */}
      <SessionTabs />

      {/* Body — one mounted XtermPanel per session. The active one is shown;
          the rest stay MOUNTED (display:none) so their PTY listeners stay live. */}
      <div className="terminal-panel-body">
        {mounts.map((m) => {
          const isActive = m.id === activeSessionId;
          return (
            <div
              key={m.id}
              style={{
                // Keep hidden sessions mounted (listeners live) but invisible
                // and inert. Active session fills the body.
                display: isActive ? 'flex' : 'none',
                flexDirection: 'column',
                width: '100%',
                height: '100%',
              }}
              aria-hidden={isActive ? undefined : true}
            >
              <XtermPanel
                // restartKey forces a fresh xterm (new PTY) on Restart/re-resume
                // while keeping the wrapper keyed by stable session id.
                key={`${m.id}:${m.restartKey}`}
                cols={120}
                rows={32}
                sessionId={m.id}
                resume={m.resume}
                onData={handleData}
                onExit={(code) => handleExit(m.id, code)}
                onSpawned={handleSpawned}
                onSpawnError={handleSpawnError}
              />
            </div>
          );
        })}
      </div>

      {/* Per-session exit / restart bar — shows once the ACTIVE session's PTY
          ends. Each session has its own exit record; only the active one is
          visible. Restart resumes that session (fresh PTY). */}
      {activeExit !== null && (
        <div className="glass terminal-exit-bar" role="status">
          <span className="terminal-exit-msg">
            Session ended
            {activeExit.code !== 0 && (
              <span className="terminal-exit-code">(code {activeExit.code})</span>
            )}
          </span>
          <button
            type="button"
            className="terminal-restart-btn"
            aria-label="Restart Claude session"
            onClick={restartActive}
          >
            Restart session
          </button>
        </div>
      )}
    </DockDrawer>
  );
}
