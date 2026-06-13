/**
 * src/panels/auth/ClaudeLoginPanel.tsx — shared in-app Claude OAuth login UI.
 *
 * Owns the lifecycle of one `profile_login` invocation: spawns the CLI under
 * the isolated profile, subscribes to the `auth:login:line` Tauri event so
 * the modal mirrors the CLI's stdout (OAuth URL, "waiting for browser…",
 * etc.), and exposes Cancel + error surface. Reused by FirstRun (initial
 * sign-in) and SettingsPanel → Account (re-login).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { profileLogin, profileLoginCancel } from '../../lib/db';

interface ClaudeLoginPanelProps {
  cliPath?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const MAX_VISIBLE_LINES = 6;

export function ClaudeLoginPanel({
  cliPath,
  onSuccess,
  onCancel,
}: ClaudeLoginPanelProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (unlistenRef.current) {
        try {
          unlistenRef.current();
        } catch {
          // unlisten can throw if the runtime is gone; safe to ignore.
        }
        unlistenRef.current = null;
      }
    };
  }, []);

  const detach = useCallback(() => {
    if (unlistenRef.current) {
      try {
        unlistenRef.current();
      } catch {
        // best-effort
      }
      unlistenRef.current = null;
    }
  }, []);

  const handleSignIn = useCallback(async () => {
    setRunning(true);
    setError(null);
    setLines([]);

    // Subscribe before spawning so we don't miss the first lines. `listen`
    // is imported dynamically so browser-only mode (no `__TAURI__`) doesn't
    // crash at module load — it falls through to the `profileLogin` reject.
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<{ stream: string; line: string }>(
        'auth:login:line',
        (ev) => {
          if (!mountedRef.current) return;
          const line = ev.payload?.line ?? '';
          if (!line) return;
          setLines((prev) => {
            const next = [...prev, line];
            return next.length > MAX_VISIBLE_LINES
              ? next.slice(next.length - MAX_VISIBLE_LINES)
              : next;
          });
        },
      );
      unlistenRef.current = unlisten;
    } catch (err) {
      // No Tauri runtime — surface the same error the invoke would.
      if (mountedRef.current) {
        setError(errMsg(err));
        setRunning(false);
      }
      return;
    }

    try {
      await profileLogin(cliPath);
      if (!mountedRef.current) return;
      detach();
      setRunning(false);
      onSuccess();
    } catch (err) {
      if (!mountedRef.current) return;
      detach();
      setRunning(false);
      setError(errMsg(err));
    }
  }, [cliPath, detach, onSuccess]);

  const handleCancel = useCallback(async () => {
    if (running) {
      try {
        await profileLoginCancel();
      } catch {
        // Cancel is idempotent — ignore.
      }
    }
    detach();
    setRunning(false);
    setLines([]);
    setError(null);
    onCancel();
  }, [running, detach, onCancel]);

  return (
    <div className="claude-login-panel">
      {!running && lines.length === 0 && (
        <div className="firstrun-body">
          Opens your browser to sign in with your Claude account. The CLI
          handles the OAuth handshake under the isolated profile.
        </div>
      )}
      {lines.length > 0 && (
        <pre
          className="firstrun-body"
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            margin: 0,
            opacity: 0.85,
          }}
          aria-live="polite"
        >
          {lines.join('\n')}
        </pre>
      )}
      {error && (
        <div
          className="firstrun-body"
          role="alert"
          style={{ color: 'var(--danger, #f88)' }}
        >
          {error}
        </div>
      )}
      <div className="firstrun-actions">
        {!running ? (
          <>
            <button
              type="button"
              className="settings-btn"
              onClick={() => void handleSignIn()}
            >
              Sign in with Claude
            </button>
            <button
              type="button"
              className="settings-btn ghost"
              onClick={() => void handleCancel()}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="settings-btn"
            onClick={() => void handleCancel()}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}
