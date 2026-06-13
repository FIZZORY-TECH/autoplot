/**
 * src/panels/FirstRun.tsx — First-run gate (W2-A + Wave 0).
 *
 * Centered overlay modal that probes `claudeTestConnection` once on app boot.
 * States:
 *   * `idle` (invisible)
 *   * `cli-not-found` / `cli-auth` / `cli-version-unsupported`  (W2-A)
 *   * `profile-setup`   — Wave 0 — bootstrap the isolated profile dir.
 *   * `profile-auth`    — Wave 0 — sign in inside the isolated profile.
 *
 * Once dismissed (test passes or user skips on the version-unsupported branch)
 * the modal hides and never reappears in the same session — re-opening the
 * panel can only happen via Settings → General → "Test connection".
 *
 * Browser-only mode (`__TAURI__` absent): the test rejects with `CliNotFound`
 * by design, so the gate appears with the install link. That's intentional —
 * gives Playwright + design preview a stable visual to capture.
 */

import { useEffect, useState } from 'react';
import {
  claudeTestConnection,
  profileAuthStatus,
  profileInit,
  profileSetApiKey,
} from '../lib/db';
import { useSettingsStore } from '../stores/useSettingsStore';
import { SUPPORTED_CLI } from '../ai/cliPaths';
import { ClaudeLoginPanel } from './auth/ClaudeLoginPanel';

type GateState =
  | { kind: 'idle' }
  | { kind: 'cli-not-found' }
  | { kind: 'cli-auth' }
  | { kind: 'cli-version-unsupported'; version: string }
  // Wave 0 — profile isolation states.
  | { kind: 'profile-setup' }
  | { kind: 'profile-auth' };

const INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code/quickstart';

export function FirstRun(): JSX.Element | null {
  const cliPath = useSettingsStore((s) => s.cliPath);
  const setCliPath = useSettingsStore((s) => s.setCliPath);
  const [state, setState] = useState<GateState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);
  const effectiveState: GateState = state;

  // One-shot probe on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const version = await claudeTestConnection(cliPath ?? undefined);
        if (cancelled) return;
        if (!isVersionSupported(version)) {
          setState({ kind: 'cli-version-unsupported', version });
          return;
        }
        setState({ kind: 'idle' });
      } catch (err) {
        if (cancelled) return;
        setState(classifyError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only probe: we explicitly want this to run once at boot. Re-running
    // on cliPath edits would fight the user typing in the modal's input.
  }, []);

  const runTest = async () => {
    setPending(true);
    try {
      const version = await claudeTestConnection(cliPath ?? undefined);
      if (!isVersionSupported(version)) {
        setState({ kind: 'cli-version-unsupported', version });
      } else {
        setState({ kind: 'idle' });
      }
    } catch (err) {
      setState(classifyError(err));
    } finally {
      setPending(false);
    }
  };

  const runProfileInit = async () => {
    setPending(true);
    setProfileError(null);
    try {
      await profileInit();
      // After init, advance to auth (the CLI in the isolated profile won't
      // have credentials yet — auth doesn't carry over from `~/.claude`).
      setState({ kind: 'profile-auth' });
    } catch (err) {
      setProfileError(errMsg(err));
    } finally {
      setPending(false);
    }
  };

  const onLoginSuccess = async () => {
    setProfileError(null);
    try {
      // Refresh status; Rust truth wins. The caller doesn't need it but the
      // round-trip ensures the CLI's `.claude.json` write is durable.
      await profileAuthStatus(cliPath ?? undefined);
      await runTest();
    } catch (err) {
      setProfileError(errMsg(err));
    }
  };

  const useApiKey = async () => {
    if (!apiKeyDraft.trim()) {
      setProfileError('Enter an API key first.');
      return;
    }
    setPending(true);
    setProfileError(null);
    try {
      await profileSetApiKey(apiKeyDraft.trim());
      setApiKeyDraft('');
      // Re-test against the isolated profile — the new env block should
      // satisfy the CLI's auth check.
      await runTest();
    } catch (err) {
      setProfileError(errMsg(err));
    } finally {
      setPending(false);
    }
  };

  if (dismissed) return null;
  if (effectiveState.kind === 'idle') return null;

  return (
    <div className="firstrun-overlay" role="dialog" aria-modal="true" aria-labelledby="firstrun-title">
      <div className="firstrun-card">
        {effectiveState.kind === 'cli-not-found' && (
          <>
            <div className="firstrun-title" id="firstrun-title">Claude CLI not found</div>
            <div className="firstrun-body">
              Install it from <a href={INSTALL_URL} target="_blank" rel="noreferrer">{INSTALL_URL}</a>,
              or set the path manually below.
            </div>
            <div className="settings-row">
              <label htmlFor="firstrun-cli-path">CLI path</label>
              <input
                id="firstrun-cli-path"
                type="text"
                placeholder="/usr/local/bin/claude"
                value={cliPath ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setCliPath(v.length === 0 ? null : v);
                }}
              />
            </div>
            <div className="firstrun-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={runTest}
                disabled={pending}
              >
                {pending ? 'Testing…' : 'Test again'}
              </button>
            </div>
          </>
        )}
        {effectiveState.kind === 'cli-auth' && (
          <>
            <div className="firstrun-title" id="firstrun-title">Claude CLI not authenticated</div>
            <div className="firstrun-body">
              Run <code>claude</code> once in a terminal to authenticate.
            </div>
            <div className="firstrun-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={() => setState({ kind: 'profile-setup' })}
                disabled={pending}
              >
                Set up isolated profile
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={runTest}
                disabled={pending}
              >
                {pending ? 'Testing…' : 'Test again'}
              </button>
            </div>
          </>
        )}
        {effectiveState.kind === 'cli-version-unsupported' && (
          <>
            <div className="firstrun-title" id="firstrun-title">Claude CLI version may be unsupported</div>
            <div className="firstrun-body">
              Detected: <code>{effectiveState.version}</code>. Latest is recommended
              (supported band: {SUPPORTED_CLI.minVersion}–{SUPPORTED_CLI.maxKnown}).
            </div>
            <div className="firstrun-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={() => setDismissed(true)}
              >
                Continue anyway
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={runTest}
                disabled={pending}
              >
                {pending ? 'Testing…' : 'Test again'}
              </button>
            </div>
          </>
        )}
        {effectiveState.kind === 'profile-setup' && (
          <>
            <div className="firstrun-title" id="firstrun-title">Set up isolated Claude profile</div>
            <div className="firstrun-body">
              The app uses a dedicated profile so nothing it does bleeds into
              your main <code>~/.claude</code>. We'll create one at
              <br />
              <code>&lt;data_dir&gt;/autoplot/claude-home/</code>.
              <br />
              <br />
              Your main profile stays read-only — you can optionally import MCP
              servers later from Settings → MCP.
            </div>
            {profileError && (
              <div className="firstrun-body" role="alert" style={{ color: 'var(--danger, #f88)' }}>
                {profileError}
              </div>
            )}
            <div className="firstrun-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={runProfileInit}
                disabled={pending}
              >
                {pending ? 'Creating…' : 'Create profile'}
              </button>
            </div>
          </>
        )}
        {effectiveState.kind === 'profile-auth' && (
          <>
            <div className="firstrun-title" id="firstrun-title">Sign in to the isolated profile</div>
            <div className="firstrun-body">
              Authentication doesn't carry over from your main profile.
            </div>
            <ClaudeLoginPanel
              cliPath={cliPath ?? undefined}
              onSuccess={() => void onLoginSuccess()}
              onCancel={() => setProfileError(null)}
            />
            <div className="firstrun-body" style={{ marginTop: 8 }}>
              Or use an API key instead:
            </div>
            <div className="settings-row">
              <label htmlFor="firstrun-api-key">ANTHROPIC_API_KEY</label>
              <input
                id="firstrun-api-key"
                type="password"
                placeholder="sk-ant-..."
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                autoComplete="off"
              />
            </div>
            {profileError && (
              <div className="firstrun-body" role="alert" style={{ color: 'var(--danger, #f88)' }}>
                {profileError}
              </div>
            )}
            <div className="firstrun-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={useApiKey}
                disabled={pending || apiKeyDraft.trim().length === 0}
              >
                Use API key instead
              </button>
              <button
                type="button"
                className="settings-btn ghost"
                onClick={runTest}
                disabled={pending}
              >
                {pending ? 'Testing…' : 'Test sign-in'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyError(err: unknown): GateState {
  const msg = errMsg(err);
  // Rust returns the AiError Display: `CliNotFound`, `CliRuntime: <reason>`,
  // and the W1-A pipeline emits `CliAuth` via the `ai:event` stream rather
  // than as a sync return — but the test path uses ai_error::Display so we
  // also pattern-match the auth substring on the runtime error.
  if (/CliNotFound/i.test(msg)) return { kind: 'cli-not-found' };
  if (/CliAuth/i.test(msg) || /not authenticated/i.test(msg) || /authentication required/i.test(msg)) {
    return { kind: 'cli-auth' };
  }
  // Generic CliRuntime — surface the not-found gate so the user can fix the
  // path; the inline Test-again button is the recovery route.
  return { kind: 'cli-not-found' };
}

function errMsg(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return '';
  }
}

/**
 * Loose semver-band check against {@link SUPPORTED_CLI}. Strings outside the
 * band fall through to the version-unsupported branch — but the gate only
 * advises "Continue anyway"; we never block on it (per W2-A spec).
 */
function isVersionSupported(version: string): boolean {
  // Pull "X.Y.Z" out of the first line — `claude --version` prints something
  // like "claude 1.2.3 (Claude Code …)".
  const m = version.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return true; // Unparseable → don't gate; let the user proceed.
  const major = Number(m[1]);
  const minMajor = Number(SUPPORTED_CLI.minVersion.split('.')[0]);
  // `maxKnown` is "2.x" — accept anything <= max major + 1 advisory window.
  const maxMajor = Number(SUPPORTED_CLI.maxKnown.split('.')[0]);
  if (Number.isFinite(major) && Number.isFinite(minMajor) && Number.isFinite(maxMajor)) {
    return major >= minMajor && major <= maxMajor;
  }
  return true;
}
