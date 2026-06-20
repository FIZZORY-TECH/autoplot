/**
 * src/panels/AlpacaCredentialsModal.tsx — Alpaca API credentials entry modal.
 *
 * Presents two password-type inputs (Key ID, Secret) and calls the existing
 * `set_provider_credentials` Tauri command on save. After saving, calls
 * `reload_provider('alpaca')` so the Rust side re-registers the adapter with
 * the new credentials without an app restart.
 *
 * Pattern mirrors AddAssetModal: same glass modal scrim, same design tokens,
 * same motion (addmodal-scrim-in / addmodal-in keyframes).
 *
 * Failure-mode taxonomy (post file-credential migration, 2026-05-23):
 * The save flow has three distinct branches; each one drives a different UI
 * state through `classifySaveError`:
 *
 *   1. SAVE THREW — `set_provider_credentials` rejected. Sub-classified by
 *      message prefix:
 *        - 'credential write error (…): <reason>' OR
 *          'credential file readback mismatch (…)' → kind:'file-write'
 *          → recoverable (usually a non-writable data folder). "Try again"
 *          button re-runs the full save with the still-populated form values.
 *        - anything else → kind:'unknown'
 *          → recoverable. "Try again" button.
 *
 *   2. SAVE OK, RELOAD THREW — credentials ARE persisted to credentials.json
 *      but the in-memory provider didn't pick them up.
 *        - Internally tagged kind:'reload-missing'.
 *        - Copy explicitly tells the user the save succeeded.
 *        - Primary action is "Reload provider" which calls
 *          reload_provider('alpaca') directly (no re-save).
 *        - Secondary fallback copy: "or restart the app".
 *        - Modal stays open until the user picks a path.
 *
 *   3. HAPPY PATH — both succeeded.
 *        - Emerald flash on the Save button (existing behavior).
 *        - Modal dismisses after a short hold.
 *        - `setEquityConnected()` fires a one-shot pulse so the
 *          EquityCredsBanner can swap into a 3s emerald "Connected"
 *          confirmation outside the (now-gone) modal.
 *
 * Robustness invariants:
 *   - Save button is disabled and renders a spinner while saving.
 *   - Form inputs are read-only while saving (the user can't edit mid-write).
 *   - A second click while a save is in flight is ignored (the `saving` guard
 *     in handleSave returns early).
 *   - Esc still closes the modal; Enter on either input still triggers save.
 *
 * Security invariants (consistent with credentials.rs):
 *   - The secret is NEVER logged.
 *   - The secret is NEVER read back from the backend after writing.
 *   - Both inputs default to type="password" so the OS screen-recording
 *     overlay can redact them (Secret may be temporarily unmasked by user).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  setEquityCredFailed,
  setEquityConnected,
} from '../data/equityCredStatus';
import { ensureFreshCatalog } from '../data/symbolCatalog';
import { useToastStore } from '../stores/useToastStore';

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

export type SaveErrorKind =
  | 'file-write'
  | 'reload-missing'
  // Probe-phase failure kinds (new — 2026-05-24, pre-flight credentials probe):
  //   auth            — Alpaca returned 401/403 with an unauthorized / invalid-key body.
  //   no_market_data  — Alpaca returned 403 with a "subscription does not permit" body.
  //   network         — reqwest connect/timeout/request error from the probe HTTP call.
  // These are produced by `invoke('probe_alpaca_credentials')`; the
  // `file-write` kind comes from `set_provider_credentials`.
  | 'auth'
  | 'no_market_data'
  | 'network'
  | 'unknown';

export interface ClassifiedSaveError {
  kind: SaveErrorKind;
  title: string;
  detail: string;
  /** True when the user has a meaningful next-action button. */
  recoverable: boolean;
}

/**
 * Parse an arbitrary error thrown by `invoke('set_provider_credentials')`
 * or `invoke('reload_provider')` into one of four UX-meaningful kinds.
 *
 * The Rust side surfaces stable English prefixes — see
 * `src-tauri/src/commands/credentials.rs` and `commands/market.rs`. The
 * classifier ONLY does substring matching on the message (no regex over
 * user-controlled content), so a benign rename on the Rust side downgrades
 * gracefully to `kind:'unknown'`.
 */
export function classifySaveError(err: unknown): ClassifiedSaveError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown error';
  const lower = raw.toLowerCase();

  if (
    lower.includes('credential write error') ||
    lower.includes('credential file readback mismatch')
  ) {
    // Surface the reason after the first ':' when present (mirrors the old
    // file-write reason extraction), so the user sees just the underlying cause.
    const after = raw.split(':').slice(1).join(':').trim();
    const reason = after.length > 0 ? after : '';
    return {
      kind: 'file-write',
      title: "Couldn't save your credentials",
      detail: `We couldn't write your keys to the local credentials file. Check that the app's data folder is writable, then try again.${reason ? ' ' + reason : ''}`,
      recoverable: true,
    };
  }

  if (
    lower.includes('credentials missing after save') ||
    lower.includes('alpaca: credentials missing')
  ) {
    return {
      kind: 'reload-missing',
      title: 'Saved, but reload failed',
      detail:
        'Your credentials were saved locally, but the live provider didn’t pick them up. Try the reload, or restart the app.',
      recoverable: true,
    };
  }

  return {
    kind: 'unknown',
    title: "Couldn't save credentials",
    detail: raw,
    recoverable: true,
  };
}

// ---------------------------------------------------------------------------
// Small inline glyphs reused by the error action row + Save button.
// ---------------------------------------------------------------------------

function SpinnerGlyph(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      className="alpaca-spin"
    >
      <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
    </svg>
  );
}

function ArrowGlyph(): JSX.Element {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 9 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 4.5h5M5 2l2 2.5L5 7" />
    </svg>
  );
}

function errorActionButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-6)',
    padding: '6px 12px',
    borderRadius: 'var(--r-pill)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--warn)',
    background: disabled
      ? 'color-mix(in oklab, var(--warn) 6%, transparent)'
      : 'color-mix(in oklab, var(--warn) 18%, transparent)',
    border:
      '1px solid color-mix(in oklab, var(--warn) 45%, transparent)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    transition: 'all var(--t-fast) var(--ease)',
  };
}

// ---------------------------------------------------------------------------
// Probe contract — mirrors `ProbeResponse` in
// src-tauri/src/commands/credentials.rs (snake_case fields).
// ---------------------------------------------------------------------------

type ProbeResponse =
  | {
      ok: true;
      sample_close: number;
      sample_symbol: string;
      fetched_at: string;
      latency_ms: number;
    }
  | {
      ok: false;
      kind: 'auth' | 'no_market_data' | 'network' | 'unknown';
      message: string;
      http_status?: number;
    };

/**
 * Two-phase save state machine. The shape mirrors the UX spec exactly:
 *
 *   idle      — user is editing the form.
 *   saving    — Step 1 of 2 · saving locally.
 *   probing   — Step 2 of 2 · contacting alpaca.markets.
 *   connected — terminal happy state; modal will dismiss shortly.
 *
 * Error branches are encoded as a tagged `kind` on the existing
 * `ClassifiedSaveError` object — the machine itself just goes back to
 * either `idle` (after the user corrects the form) or stays on the error
 * card with a recovery action.
 */
type SaveMode = 'idle' | 'saving' | 'probing' | 'connected';

/**
 * Build a `ClassifiedSaveError` from a probe failure. Each branch produces
 * UX-meaningful title/detail/recoverable triples; the modal then renders a
 * branch-specific recovery action.
 */
function classifyProbeError(probe: Extract<ProbeResponse, { ok: false }>): ClassifiedSaveError {
  switch (probe.kind) {
    case 'auth':
      return {
        kind: 'auth',
        title: 'Alpaca rejected these keys',
        detail:
          'Double-check the Key ID and Secret. Paper keys (PK…) only work against paper endpoints; live keys (AK…) only against live.',
        recoverable: true,
      };
    case 'no_market_data':
      return {
        kind: 'no_market_data',
        title: "Market Data isn't enabled on this account",
        detail:
          "Your Alpaca account is valid, but it doesn't have Market Data access. Open Alpaca → Settings → Market Data to enable it.",
        recoverable: true,
      };
    case 'network':
      return {
        kind: 'network',
        title: "Couldn't reach Alpaca",
        detail:
          "Check your connection, then retry. Your keys are saved locally — you won't need to re-enter them.",
        recoverable: true,
      };
    case 'unknown':
    default:
      return {
        kind: 'unknown',
        title: 'Verification failed',
        detail: probe.message || 'Alpaca returned an unexpected response.',
        recoverable: true,
      };
  }
}

export interface AlpacaCredentialsModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after successful save + reload so the parent can refresh bars. */
  onSaved?: () => void;
}

/** Local prefers-reduced-motion mirror (avoid extra cross-file dep for one modal). */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fn = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, []);
  return reduced;
}

/**
 * Open an external URL in the user's default browser via the Tauri opener
 * plugin. Soft-fails if the plugin isn't available (e.g. plain vite dev).
 */
async function openExternal(url: string): Promise<void> {
  try {
    const mod = await import('@tauri-apps/plugin-opener');
    await mod.openUrl(url);
  } catch {
    // Fallback: best-effort window.open (works in plain vite dev).
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // swallow
    }
  }
}

export function AlpacaCredentialsModal({
  open,
  onClose,
  onSaved,
}: AlpacaCredentialsModalProps): JSX.Element | null {
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [secretVisible, setSecretVisible] = useState(false);
  /**
   * Coarse-grained state machine. Replaces the older `saving` / `saved`
   * booleans as the source of truth. We still derive a few `saving`/`saved`
   * booleans below for legibility at render sites.
   */
  const [mode, setMode] = useState<SaveMode>('idle');
  const [reloading, setReloading] = useState(false);
  const [saveError, setSaveError] = useState<ClassifiedSaveError | null>(null);
  /**
   * Live-region announcement copy. Updated on every phase transition so
   * screen readers hear "Saving keys…" → "Verifying with Alpaca…" →
   * "Connected to Alpaca…". The sub-line UI is `aria-hidden` to avoid
   * double-announcing the same content.
   */
  const [liveStatus, setLiveStatus] = useState('');
  const keyIdRef = useRef<HTMLInputElement>(null);
  /** Guard against double-fires while a save is mid-flight. */
  const inFlightRef = useRef(false);
  /**
   * Set to true when the user dismisses the modal (Esc or Cancel) while a
   * probe/reload is in flight. All async branches check this ref before
   * calling `finishSuccess`, `setSaveError`, or `setMode` so we never update
   * state on an unmounted / cancelled modal.
   */
  const cancelledRef = useRef(false);
  const reducedMotion = useReducedMotion();

  const saving = mode === 'saving';
  const probing = mode === 'probing';
  const saved = mode === 'connected';

  // Reset inputs each time the modal opens; mark cancelled on close.
  useEffect(() => {
    if (open) {
      cancelledRef.current = false;
      setKeyId('');
      setSecret('');
      setSecretVisible(false);
      setSaveError(null);
      setMode('idle');
      setReloading(false);
      setLiveStatus('');
      inFlightRef.current = false;
      const id = window.setTimeout(() => keyIdRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    } else {
      // Modal closed (either Esc or onClose) — any in-flight probe/reload
      // should not update state after this point.
      cancelledRef.current = true;
    }
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /**
   * Run the happy-path tail (success flash + dismiss + onSaved + connected
   * pulse). Shared between the initial save and the "Reload provider"
   * retry, so both branches dismiss with identical confirmation motion.
   */
  const finishSuccess = useCallback(() => {
    setEquityCredFailed(false);
    setMode('connected');
    setReloading(false);
    setLiveStatus('Connected to Alpaca. Live prices will load shortly.');
    // Force-refresh the Alpaca symbol catalog now that credentials are saved
    // and the provider has been re-registered. `setEquityCredFailed(false)`
    // above clears the guard in `ensureFreshCatalog` so the fetch proceeds.
    // Fire-and-forget — the catalog populates in the background so the
    // Add-Asset picker shows live NASDAQ/NYSE symbols on next open.
    void ensureFreshCatalog('alpaca', { force: true }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[AlpacaCredentialsModal] alpaca catalog refresh after save failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      useToastStore.getState().push({ kind: 'warn', title: 'Catalog refresh failed', detail });
    });
    const hold = reducedMotion ? 0 : 420;
    window.setTimeout(() => {
      // Fire the one-shot pulse FIRST so the banner is ready to swap into
      // its "Connected" state at the moment the modal unmounts — there's no
      // perceptible gap from the user's perspective.
      setEquityConnected();
      onClose();
      onSaved?.();
    }, hold);
  }, [onClose, onSaved, reducedMotion]);

  /**
   * Phase 2 of the save flow: probe the credentials against Alpaca's
   * market-data API. Called after the credential-file write succeeds; can
   * also be re-invoked alone via the `network`/`no_market_data` recovery
   * buttons (the keys are already persisted in those branches, so re-saving
   * would be a wasted write).
   */
  const runProbe = useCallback(async () => {
    setMode('probing');
    setLiveStatus('Verifying with Alpaca…');
    setSaveError(null);
    try {
      const probe = (await invoke('probe_alpaca_credentials')) as ProbeResponse;
      // Guard: if the modal was dismissed while the probe was in flight, do
      // not update any state (the component may be unmounted / cancelled).
      if (cancelledRef.current) return;
      if (probe.ok) {
        // Probe succeeded — reload the provider so the in-memory adapter
        // picks up the keys, then run the happy-path dismiss.
        try {
          await invoke('reload_provider', { provider: 'alpaca' });
        } catch (reloadErr) {
          if (cancelledRef.current) return;
          setSaveError(classifySaveError(reloadErr));
          setMode('idle');
          setLiveStatus('Reload failed.');
          return;
        }
        if (cancelledRef.current) return;
        finishSuccess();
      } else {
        setSaveError(classifyProbeError(probe));
        setMode('idle');
        setLiveStatus('Verification failed.');
      }
    } catch (err) {
      // The probe command itself threw (e.g. Tauri runtime missing). Treat
      // as `unknown` — the user gets a "Try again" path.
      if (cancelledRef.current) return;
      setSaveError({
        kind: 'unknown',
        title: 'Verification failed',
        detail:
          err instanceof Error ? err.message : 'Probe call rejected by Tauri runtime.',
        recoverable: true,
      });
      setMode('idle');
      setLiveStatus('Verification failed.');
    }
  }, [finishSuccess]);

  const handleSave = useCallback(async () => {
    if (!keyId.trim() || !secret.trim()) return;
    // Double-save guard: a second click while in-flight is a no-op.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setMode('saving');
    setLiveStatus('Saving your keys locally…');
    setSaveError(null);
    try {
      await invoke('set_provider_credentials', {
        provider: 'alpaca',
        keyId: keyId.trim(),
        secret: secret.trim(),
      });
      // Phase 1 OK — hand off to phase 2 (probe). `runProbe` flips the mode
      // to `probing` and takes the live region from there.
      inFlightRef.current = false;
      await runProbe();
    } catch (err) {
      // Branch 1: save itself threw — keep form populated so the user
      // can hit "Try again" without retyping. This covers the
      // `file-write` path (credential-file write/readback failures).
      setSaveError(classifySaveError(err));
      setMode('idle');
      setLiveStatus('Save failed.');
    } finally {
      inFlightRef.current = false;
    }
  }, [keyId, secret, runProbe]);

  /**
   * Reload-only retry. Used when branch-2 hit (save succeeded, reload
   * failed). We do NOT re-save — credentials are already in the
   * credentials file — we just ask the Rust side to re-register the adapter.
   */
  const handleReloadRetry = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setReloading(true);
    setSaveError(null);
    try {
      await invoke('reload_provider', { provider: 'alpaca' });
      finishSuccess();
    } catch (err) {
      setSaveError(classifySaveError(err));
      setReloading(false);
    } finally {
      inFlightRef.current = false;
    }
  }, [finishSuccess]);

  /**
   * Probe-only retry. Used by the `network` and `no_market_data` branches:
   * the keys are already in the credentials file, so re-running the file
   * write is wasteful. Just rerun the probe.
   */
  const handleProbeRetry = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await runProbe();
    } finally {
      inFlightRef.current = false;
    }
  }, [runProbe]);

  /**
   * `auth` branch recovery — go back to the form, focus the Key ID field,
   * and select its current contents so the user can paste a fresh value in
   * one keystroke.
   */
  const handleEditKeys = useCallback(() => {
    setSaveError(null);
    setMode('idle');
    setLiveStatus('');
    window.setTimeout(() => {
      const el = keyIdRef.current;
      if (el) {
        el.focus();
        try {
          el.select();
        } catch {
          // select() is unsupported on type=password in some browsers; fine.
        }
      }
    }, 30);
  }, []);

  if (!open) return null;

  // -------------------------------------------------------------------------
  // Styles — reuse AddAssetModal's proven glass-modal pattern.
  // -------------------------------------------------------------------------
  const scrimStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 'var(--z-modal-scrim)', // above AddAssetModal scrim; stronger fill makes the dim visible
    background: 'var(--scrim-strong)',
    backdropFilter: 'blur(18px) saturate(120%)',
    WebkitBackdropFilter: 'blur(18px) saturate(120%)',
    display: 'grid',
    placeItems: 'start center',
    paddingTop: '18vh',
    animation: 'addmodal-scrim-in var(--t-med) var(--ease)',
  };

  const modalStyle: CSSProperties = {
    width: 'min(460px, 92vw)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface-overlay)',
    borderRadius: 'var(--r-22)',
    overflow: 'hidden',
    boxShadow: saved
      ? '0 1px 0 0 color-mix(in oklab, white 8%, transparent) inset, 0 24px 60px -16px rgba(0,0,0,.6), 0 60px 120px -30px color-mix(in oklab, black 80%, transparent), 0 0 0 1px color-mix(in oklab, var(--emerald) 50%, transparent), 0 0 56px color-mix(in oklab, var(--emerald) 30%, transparent)'
      : '0 1px 0 0 color-mix(in oklab, white 8%, transparent) inset, 0 24px 60px -16px rgba(0,0,0,.6), 0 60px 120px -30px color-mix(in oklab, black 80%, transparent)',
    backdropFilter: 'blur(40px) saturate(180%)',
    WebkitBackdropFilter: 'blur(40px) saturate(180%)',
    animation: 'addmodal-in 360ms var(--ease-spring)',
    transition: 'box-shadow var(--t-med) var(--ease)',
  };

  const fieldStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--sp-6)',
  };

  const labelStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: 'var(--ink-3)',
  };

  const inputBaseStyle: CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 'var(--r-8)',
    background: 'color-mix(in oklab, var(--bg-0) 60%, transparent)',
    border: '1px solid var(--hairline)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    color: 'var(--ink-0)',
    outline: 'none',
    transition: 'border-color var(--t-fast), box-shadow var(--t-fast)',
  };

  const busy = saving || probing || reloading;
  const canSubmit =
    keyId.trim().length > 0 && secret.trim().length > 0 && !busy && !saved;
  /**
   * Lock inputs while a save/reload is in flight — prevents the user from
   * editing the form mid-write, which would otherwise create an ambiguous
   * "what just got persisted?" state if they hit Save twice quickly.
   */
  const inputsReadOnly = busy || saved;

  return (
    <div
      className="addmodal-scrim"
      data-testid="alpaca-creds-modal-scrim"
      onClick={onClose}
      style={scrimStyle}
    >
      <div
        className="glass-strong addmodal"
        data-testid="alpaca-creds-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alpaca-creds-title"
        aria-describedby="alpaca-creds-desc"
        onClick={(e) => e.stopPropagation()}
        style={modalStyle}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--sp-12)',
            padding: 'var(--sp-14) var(--sp-18)',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sp-6)',
              minWidth: 0,
            }}
          >
            {/* Eyebrow */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--sp-6)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-eyebrow)',
                letterSpacing: 'var(--tracking-eyebrow)',
                textTransform: 'uppercase',
                color: 'var(--emerald)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--emerald)',
                  boxShadow:
                    '0 0 10px color-mix(in oklab, var(--emerald) 70%, transparent)',
                }}
              />
              Equity data · Alpaca Markets
            </div>
            <div
              id="alpaca-creds-title"
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 17,
                letterSpacing: '-0.01em',
                color: 'var(--ink-0)',
              }}
            >
              Connect your Alpaca account
            </div>
            <div
              id="alpaca-creds-desc"
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--ink-2)',
                maxWidth: 360,
              }}
            >
              Stream live NASDAQ &amp; NYSE prices. Keys are stored locally on
              your device &mdash; never transmitted to our servers.
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            data-testid="alpaca-creds-modal-close"
            onClick={onClose}
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              color: 'var(--ink-3)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              transition: 'all var(--t-fast)',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2 2l6 6M8 2l-6 6"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Form body */}
        <div
          style={{
            padding: 'var(--sp-18)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sp-16)',
          }}
        >
          {/* Get-a-key hint row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--sp-8)',
              padding: '8px 12px',
              borderRadius: 'var(--r-8)',
              background: 'color-mix(in oklab, var(--accent) 7%, transparent)',
              border:
                '1px solid color-mix(in oklab, var(--accent) 22%, transparent)',
              fontFamily: 'var(--font-sans)',
              fontSize: 11.5,
              color: 'var(--ink-2)',
            }}
          >
            <span>Don&rsquo;t have a key yet?</span>
            <button
              type="button"
              data-testid="alpaca-creds-get-key"
              onClick={() => void openExternal('https://alpaca.markets/')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--sp-6)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                cursor: 'pointer',
                transition: 'all var(--t-fast)',
              }}
            >
              Generate at alpaca.markets
              <svg
                width="9"
                height="9"
                viewBox="0 0 9 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 6L6 3M3 3h3v3" />
              </svg>
            </button>
          </div>

          {/* Key ID field */}
          <div style={fieldStyle}>
            <label htmlFor="alpaca-key-id" style={labelStyle}>
              Key ID
            </label>
            <input
              id="alpaca-key-id"
              ref={keyIdRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              data-testid="alpaca-creds-key-id"
              placeholder="PK… or AK…"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              readOnly={inputsReadOnly}
              style={{
                ...inputBaseStyle,
                opacity: inputsReadOnly ? 0.6 : 1,
                cursor: inputsReadOnly ? 'not-allowed' : 'text',
              }}
              aria-required="true"
              aria-describedby="alpaca-key-id-hint"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void handleSave();
              }}
            />
            <span
              id="alpaca-key-id-hint"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              Usually starts with PK (paper) or AK (live)
            </span>
          </div>

          {/* Secret field with show/hide toggle */}
          <div style={fieldStyle}>
            <label htmlFor="alpaca-secret" style={labelStyle}>
              Secret Key
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="alpaca-secret"
                type={secretVisible ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                data-testid="alpaca-creds-secret"
                placeholder="paste your secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                readOnly={inputsReadOnly}
                style={{
                  ...inputBaseStyle,
                  paddingRight: 38,
                  opacity: inputsReadOnly ? 0.6 : 1,
                  cursor: inputsReadOnly ? 'not-allowed' : 'text',
                }}
                aria-required="true"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) void handleSave();
                }}
              />
              <button
                type="button"
                aria-label={secretVisible ? 'Hide secret' : 'Show secret'}
                aria-pressed={secretVisible}
                data-testid="alpaca-creds-secret-toggle"
                onClick={() => setSecretVisible((v) => !v)}
                style={{
                  position: 'absolute',
                  right: 6,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 26,
                  height: 26,
                  borderRadius: 'var(--r-8)',
                  display: 'grid',
                  placeItems: 'center',
                  color: secretVisible ? 'var(--accent)' : 'var(--ink-3)',
                  transition: 'color var(--t-fast)',
                }}
              >
                {secretVisible ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1.5 7C2.7 4.4 4.7 3 7 3s4.3 1.4 5.5 4c-1.2 2.6-3.2 4-5.5 4S2.7 9.6 1.5 7z" />
                    <circle cx="7" cy="7" r="1.6" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1.5 7C2.7 4.4 4.7 3 7 3c1.1 0 2.1.3 3 .9M12.5 7c-.5 1.1-1.2 2-2 2.6M1 1l12 12" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Error message — title + detail + context-aware action row */}
          {saveError && (
            <div
              role="alert"
              data-testid="alpaca-creds-error"
              data-error-kind={saveError.kind}
              className="alpaca-err-row"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--sp-8)',
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--warn)',
                padding: 'var(--sp-12)',
                borderRadius: 'var(--r-12)',
                background: 'color-mix(in oklab, var(--warn) 10%, transparent)',
                border:
                  '1px solid color-mix(in oklab, var(--warn) 28%, transparent)',
                boxShadow:
                  '0 0 24px color-mix(in oklab, var(--warn) 14%, transparent)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--sp-8)',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    marginTop: 6,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--warn)',
                    boxShadow:
                      '0 0 10px color-mix(in oklab, var(--warn) 70%, transparent)',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--sp-4)',
                    minWidth: 0,
                  }}
                >
                  <span
                    data-testid="alpaca-creds-error-title"
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'var(--warn)',
                      letterSpacing: '-0.005em',
                    }}
                  >
                    {saveError.title}
                  </span>
                  <span
                    data-testid="alpaca-creds-error-detail"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11.5,
                      color: 'var(--ink-2)',
                      lineHeight: 1.5,
                      wordBreak: 'break-word',
                    }}
                  >
                    {saveError.detail}
                  </span>
                </div>
              </div>

              {/* Context-aware action row */}
              {saveError.kind === 'reload-missing' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-8)',
                    paddingLeft: 'var(--sp-16)',
                  }}
                >
                  <button
                    type="button"
                    data-testid="alpaca-creds-reload-retry"
                    onClick={() => void handleReloadRetry()}
                    disabled={busy}
                    style={errorActionButtonStyle(busy)}
                  >
                    {reloading ? (
                      <>
                        <SpinnerGlyph />
                        Reloading…
                      </>
                    ) : (
                      <>
                        Reload provider
                        <ArrowGlyph />
                      </>
                    )}
                  </button>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--ink-3)',
                      letterSpacing: '0.06em',
                    }}
                  >
                    or restart the app
                  </span>
                </div>
              )}

              {(saveError.kind === 'file-write' ||
                saveError.kind === 'unknown') && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 'var(--sp-16)',
                  }}
                >
                  <button
                    type="button"
                    data-testid="alpaca-creds-retry"
                    onClick={() => void handleSave()}
                    disabled={!canSubmit}
                    style={errorActionButtonStyle(!canSubmit)}
                  >
                    {saving ? (
                      <>
                        <SpinnerGlyph />
                        Retrying…
                      </>
                    ) : (
                      <>
                        Try again
                        <ArrowGlyph />
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Probe-derived error branches (2026-05-24). */}

              {saveError.kind === 'auth' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 'var(--sp-16)',
                  }}
                >
                  <button
                    type="button"
                    data-testid="alpaca-creds-edit-keys"
                    onClick={handleEditKeys}
                    disabled={busy}
                    style={errorActionButtonStyle(busy)}
                  >
                    Edit keys
                    <ArrowGlyph />
                  </button>
                </div>
              )}

              {saveError.kind === 'no_market_data' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-8)',
                    paddingLeft: 'var(--sp-16)',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    data-testid="alpaca-creds-open-dashboard"
                    onClick={() =>
                      void openExternal(
                        'https://app.alpaca.markets/account/market-data',
                      )
                    }
                    disabled={busy}
                    style={errorActionButtonStyle(busy)}
                  >
                    Open Alpaca dashboard
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 9 9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6L6 3M3 3h3v3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    data-testid="alpaca-creds-probe-retry"
                    onClick={() => void handleProbeRetry()}
                    disabled={busy}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--ink-3)',
                      letterSpacing: '0.06em',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      textDecoration: 'underline',
                      textUnderlineOffset: 3,
                    }}
                  >
                    I&rsquo;ve enabled it · Retry
                  </button>
                </div>
              )}

              {saveError.kind === 'network' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 'var(--sp-16)',
                  }}
                >
                  <button
                    type="button"
                    data-testid="alpaca-creds-network-retry"
                    onClick={() => void handleProbeRetry()}
                    disabled={busy}
                    style={errorActionButtonStyle(busy)}
                  >
                    {probing ? (
                      <>
                        <SpinnerGlyph />
                        Retrying…
                      </>
                    ) : (
                      <>
                        Retry
                        <ArrowGlyph />
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Live region — announces phase changes to assistive tech.
              The sub-line and chip below are aria-hidden to avoid
              double-announcing the same content. */}
          <div
            aria-live="polite"
            aria-atomic="true"
            data-testid="alpaca-creds-status"
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              margin: -1,
              padding: 0,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            {liveStatus}
          </div>

          {/* Step sub-line — mono caption visible during saving/probing.
              Crossfades on phase transition (var(--t-fast)). */}
          {(saving || probing) && (
            <div
              aria-hidden="true"
              data-testid="alpaca-creds-step"
              key={mode /* re-key triggers the crossfade-in keyframe */}
              className="alpaca-step-line"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--sp-8)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-mono-sm, 10.5px)',
                letterSpacing: 'var(--tracking-mono-sm, 0.06em)',
                color: 'var(--ink-3)',
                marginTop: 'calc(-1 * var(--sp-8))',
              }}
            >
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {saving
                  ? 'Step 1 of 2 · saving locally'
                  : 'Step 2 of 2 · contacting alpaca.markets'}
              </span>
              {probing && (
                <span
                  data-testid="alpaca-creds-saved-chip"
                  className="alpaca-saved-chip"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 'var(--r-pill)',
                    color: 'var(--accent)',
                    background:
                      'color-mix(in oklab, var(--accent) 14%, transparent)',
                    border:
                      '1px solid color-mix(in oklab, var(--accent) 38%, transparent)',
                    fontSize: 9.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 6.5l2.5 2.5L10 3.5" />
                  </svg>
                  Saved
                </span>
              )}
            </div>
          )}

          {/* Actions row */}
          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-8)',
              justifyContent: 'flex-end',
              paddingTop: 'var(--sp-4)',
            }}
          >
            <button
              type="button"
              data-testid="alpaca-creds-cancel"
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: 'var(--r-8)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                color: 'var(--ink-2)',
                background: 'color-mix(in oklab, var(--bg-0) 40%, transparent)',
                border: '1px solid var(--hairline)',
                cursor: 'pointer',
                transition: 'all var(--t-fast)',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="alpaca-creds-save"
              disabled={!canSubmit}
              onClick={() => void handleSave()}
              style={{
                padding: '8px 20px',
                borderRadius: 'var(--r-8)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 500,
                color: saved
                  ? 'var(--emerald)'
                  : canSubmit
                    ? 'var(--ink-0)'
                    : 'var(--ink-3)',
                background: saved
                  ? 'color-mix(in oklab, var(--emerald) 35%, transparent)'
                  : canSubmit
                    ? 'color-mix(in oklab, var(--emerald) 25%, transparent)'
                    : 'color-mix(in oklab, var(--bg-0) 40%, transparent)',
                border: `1px solid ${
                  saved
                    ? 'color-mix(in oklab, var(--emerald) 65%, transparent)'
                    : canSubmit
                      ? 'color-mix(in oklab, var(--emerald) 50%, transparent)'
                      : 'var(--hairline)'
                }`,
                boxShadow: saved
                  ? '0 0 24px color-mix(in oklab, var(--emerald) 40%, transparent)'
                  : 'none',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                transition: 'all var(--t-med) var(--ease)',
                /**
                 * 168px is wide enough to hold the longest label
                 * ("Verifying with Alpaca…") so the button doesn't reflow
                 * mid-animation between phases.
                 */
                minWidth: 168,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--sp-6)',
              }}
            >
              {saved ? (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 6.5l2.5 2.5L10 3.5" />
                  </svg>
                  Connected
                </>
              ) : probing ? (
                <>
                  <SpinnerGlyph />
                  Verifying with Alpaca…
                </>
              ) : saving ? (
                <>
                  <SpinnerGlyph />
                  Saving keys…
                </>
              ) : (
                'Save'
              )}
            </button>
          </div>
        </div>

        {/* Reuse the shared keyframe from AddAssetModal (injected once per
            page; the browser deduplicates identical @keyframes). */}
        <style>{`
          @keyframes addmodal-scrim-in {
            from { opacity: 0; backdrop-filter: blur(0) saturate(100%); -webkit-backdrop-filter: blur(0) saturate(100%); }
            to   { opacity: 1; backdrop-filter: blur(18px) saturate(120%); -webkit-backdrop-filter: blur(18px) saturate(120%); }
          }
          @keyframes addmodal-in {
            from { opacity: 0; transform: translateY(-8px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes alpaca-err-in {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes alpaca-spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          .alpaca-err-row {
            animation: alpaca-err-in var(--t-med) var(--ease-spring) both;
          }
          .alpaca-spin {
            animation: alpaca-spin 900ms linear infinite;
            transform-origin: 50% 50%;
          }
          @keyframes alpaca-step-in {
            from { opacity: 0; }
            to   { opacity: 1; }
          }
          @keyframes alpaca-chip-in {
            from { opacity: 0; transform: translateY(4px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          .alpaca-step-line {
            animation: alpaca-step-in 230ms var(--ease) both;
          }
          .alpaca-saved-chip {
            animation: alpaca-chip-in var(--t-med) var(--ease-spring) both;
          }
          @media (prefers-reduced-motion: reduce) {
            .alpaca-err-row {
              animation: alpaca-err-in var(--t-fast) var(--ease) both;
              transform: none;
            }
            .alpaca-spin { animation: none; }
            .alpaca-step-line { animation: none; }
            .alpaca-saved-chip {
              animation: none;
              transform: none;
              opacity: 1;
            }
          }
        `}</style>
      </div>
    </div>
  );
}

export default AlpacaCredentialsModal;
