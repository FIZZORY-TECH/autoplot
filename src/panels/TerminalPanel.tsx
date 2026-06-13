/**
 * src/panels/TerminalPanel.tsx — Claude CLI terminal docked to the right side.
 *
 * Wraps XtermPanel in DockDrawer (side="right", id="terminal", mountOnOpen).
 * The drawer is default-open at launch (useDockStore initializes openRight to
 * 'terminal'). DockDrawer owns all framing, positioning, and animation.
 *
 * PTY teardown: DockDrawer's mountOnOpen prop unmounts children once the
 * closing animation completes. XtermPanel's cleanup effect (return from its
 * mount useEffect) disposes the PTY session automatically on unmount.
 *
 * Accessibility: role="dialog", aria-label="Claude CLI terminal" — provided
 * by DockDrawer. No separate focus trap (mirrors StrategyArtifactPanel
 * decision; DockDrawer handles focus return).
 */

import { useCallback, useState } from 'react';
import { XtermPanel } from '../terminal/XtermPanel';
import { useDockStore } from '../stores/useDockStore';
import { useToastStore } from '../stores/useToastStore';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';

export function TerminalPanel(): JSX.Element {
  const open = useDockStore((s) => s.openRight === 'terminal');
  const close = () => useDockStore.getState().close('right');

  // restartKey fully remounts XtermPanel — incrementing disposes the old PTY
  // session (idempotent-dispose invariant) and spawns a fresh one. A later
  // step renders the "Session ended · Restart session" bar that calls
  // restart(); this step provides the plumbing it hangs off.
  const [restartKey, setRestartKey] = useState(0);
  // Tracks the most recent PTY exit (null = session live). The restart-bar
  // step reads this to know whether to show its affordance and the exit code.
  const [exited, setExited] = useState<{ code: number } | null>(null);

  const restart = useCallback(() => {
    setExited(null);
    setRestartKey((k) => k + 1);
  }, []);

  const handleExit = useCallback((code: number) => {
    setExited({ code });
    if (code === 0) {
      useToastStore.getState().push({
        kind: 'info',
        title: 'Claude session ended',
      });
    } else {
      useToastStore.getState().push({
        kind: 'error',
        title: `Claude session exited (code ${code})`,
      });
    }
  }, []);

  return (
    <DockDrawer
      side="right"
      id="terminal"
      ariaLabel="Claude CLI terminal"
      mountOnOpen
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

      {/* Body — XtermPanel fills available space */}
      <div className="terminal-panel-body">
        <XtermPanel
          key={restartKey}
          cols={120}
          rows={32}
          onExit={handleExit}
        />
      </div>

      {/* Exit / restart bar — shown once the PTY session ends. Clears on
          restart() (which also remounts XtermPanel via restartKey, bringing
          the session-start overlay back). */}
      {exited !== null && (
        <div className="glass terminal-exit-bar" role="status">
          <span className="terminal-exit-msg">
            Session ended
            {exited.code !== 0 && (
              <span className="terminal-exit-code">(code {exited.code})</span>
            )}
          </span>
          <button
            type="button"
            className="terminal-restart-btn"
            aria-label="Restart Claude session"
            onClick={restart}
          >
            Restart session
          </button>
        </div>
      )}
    </DockDrawer>
  );
}
