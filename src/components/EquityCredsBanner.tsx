/**
 * src/components/EquityCredsBanner.tsx — Dismissible banner for missing
 * Alpaca credentials.
 *
 * Renders at the top of the app (zIndex 25, above chart, below modals) when
 * `equityCredStatus` reports a failure. Contains a "Configure" CTA that opens
 * `AlpacaCredentialsModal`.
 *
 * Composition (P-UX wave):
 *   - 2-line layout: eyebrow ("ALPACA · NO CREDENTIALS") above body line.
 *   - Soft --warn box-shadow glow (Principle 04 — glow not stroke).
 *   - Spring entrance via --ease-spring + --t-med duration.
 *   - Dismiss reveals a sticky reopen handle in AssetPanel + Headline; the
 *     banner re-emerges automatically on the next failure event.
 *
 * Design tokens only — no new colors introduced.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  subscribeEquityCredStatus,
  type EquityCredStatus,
} from '../data/equityCredStatus';
import { AlpacaCredentialsModal } from '../panels/AlpacaCredentialsModal';
import { isTauriRuntime } from '../lib/runtime';
import { useAppStore } from '../stores/useAppStore';

/**
 * ConnectedToast — ephemeral emerald banner swap shown for ~3s after a
 * successful Alpaca save + reload. Sits in the same fixed-top location as
 * the warn banner so the user's eye is already trained there. Auto-dismisses
 * via the parent's timer; respects prefers-reduced-motion (parent skips the
 * timer, so the toast persists until the user clicks ×).
 */
interface ConnectedToastProps {
  onDismiss: () => void;
  /** Modal node carried through so it can stay mounted across the swap. */
  modalNode: ReactNode;
}

function ConnectedToast({
  onDismiss,
  modalNode,
}: ConnectedToastProps): JSX.Element {
  const bannerStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 'var(--z-banner)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--sp-16)',
    padding: '8px var(--sp-22)',
    background:
      'linear-gradient(180deg, color-mix(in oklab, var(--emerald) 10%, var(--bg-1)) 0%, color-mix(in oklab, var(--bg-1) 88%, transparent) 100%)',
    backdropFilter: 'blur(22px) saturate(160%)',
    WebkitBackdropFilter: 'blur(22px) saturate(160%)',
    boxShadow:
      '0 1px 0 0 color-mix(in oklab, white 6%, transparent) inset, 0 8px 32px -12px color-mix(in oklab, var(--emerald) 28%, transparent)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    color: 'var(--ink-1)',
    animation: 'equity-banner-in var(--t-med) var(--ease-spring) both',
  };

  return (
    <>
      <div
        data-testid="equity-creds-connected-toast"
        role="status"
        aria-live="polite"
        style={bannerStyle}
        className="equity-connected-toast"
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--emerald)',
            boxShadow:
              '0 0 10px color-mix(in oklab, var(--emerald) 70%, transparent)',
            flexShrink: 0,
          }}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            lineHeight: 1.25,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-eyebrow)',
              letterSpacing: 'var(--tracking-eyebrow)',
              textTransform: 'uppercase',
              color: 'var(--emerald)',
            }}
          >
            Alpaca · Connected
          </span>
          <span style={{ color: 'var(--ink-1)' }}>
            Equity prices are streaming.{' '}
            <span style={{ color: 'var(--ink-2)' }}>
              Live NASDAQ &amp; NYSE data is on.
            </span>
          </span>
        </div>
        <button
          type="button"
          aria-label="Dismiss connected notice"
          data-testid="equity-creds-connected-dismiss"
          onClick={onDismiss}
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            color: 'var(--ink-3)',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            transition: 'all var(--t-fast)',
            marginLeft: 'var(--sp-4)',
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path
              d="M1.5 1.5l5 5M6.5 1.5l-5 5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {modalNode}
    </>
  );
}

export function EquityCredsBanner(): JSX.Element | null {
  const [status, setStatus] = useState<EquityCredStatus>({
    failed: false,
    connectedAt: 0,
  });
  const [dismissed, setDismissed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const loadingPhase = useAppStore((s) => s.loadingPhase);
  /**
   * One-shot "connected" toast state. Bumps each time `status.connectedAt`
   * increments — the banner swaps from warn to emerald for ~3s outside the
   * (now-dismissed) modal so the user sees confirmation on the asset
   * surface, not just in the modal that just unmounted.
   */
  const [showConnected, setShowConnected] = useState(false);
  const lastConnectedSeen = useRef(0);
  const reducedMotion = useRef(
    typeof window !== 'undefined' && !!window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => subscribeEquityCredStatus(setStatus), []);

  // Re-show the banner if the status changes back to failed (e.g. app picks
  // up a new error after a partial save).
  useEffect(() => {
    if (status.failed) setDismissed(false);
  }, [status.failed]);

  // Detect the "connected" pulse and show the success toast for 3s.
  useEffect(() => {
    const tick = status.connectedAt ?? 0;
    if (tick > lastConnectedSeen.current) {
      lastConnectedSeen.current = tick;
      setShowConnected(true);
      setDismissed(false);
      // Reduced-motion: persist until user dismisses (no auto-hide).
      if (reducedMotion.current) return;
      const id = window.setTimeout(() => setShowConnected(false), 3000);
      return () => window.clearTimeout(id);
    }
  }, [status.connectedAt]);

  const handleConfigure = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleModalSaved = useCallback(() => {
    setModalOpen(false);
  }, []);

  // Only render inside the Tauri runtime — vite dev with mock is fine.
  if (!isTauriRuntime()) {
    return null;
  }

  // Success toast takes precedence over the failure banner. Render-order
  // matters: if a save just landed, the warn banner must not be visible.
  if (showConnected) {
    return (
      <ConnectedToast
        onDismiss={() => setShowConnected(false)}
        modalNode={
          <AlpacaCredentialsModal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            onSaved={handleModalSaved}
          />
        }
      />
    );
  }

  // Gate visibility: NEVER show during exit/loading/reveal. Only idle + failed.
  if (!status.failed) return null;
  if (dismissed) return null;
  if (loadingPhase !== 'idle') return null;

  const bannerStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 'var(--z-banner)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--sp-16)',
    padding: '8px var(--sp-22)',
    background:
      'linear-gradient(180deg, color-mix(in oklab, var(--warn) 8%, var(--bg-1)) 0%, color-mix(in oklab, var(--bg-1) 88%, transparent) 100%)',
    backdropFilter: 'blur(22px) saturate(160%)',
    WebkitBackdropFilter: 'blur(22px) saturate(160%)',
    boxShadow:
      '0 1px 0 0 color-mix(in oklab, white 6%, transparent) inset, 0 8px 32px -12px color-mix(in oklab, var(--warn) 22%, transparent)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    color: 'var(--ink-1)',
    // Crossfade in when transitioning to idle+failed.
    animation: 'equity-error-crossfade var(--t-med) var(--ease)',
  };

  return (
    <>
      <div
        data-testid="equity-creds-banner"
        role="alert"
        aria-live="assertive"
        style={bannerStyle}
      >
        {/* Pulsing warn dot */}
        <span
          aria-hidden="true"
          className="equity-banner-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--warn)',
            boxShadow:
              '0 0 0 0 color-mix(in oklab, var(--warn) 60%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 70%, transparent)',
            flexShrink: 0,
          }}
        />

        {/* Two-line text block — copy varies by failure reason */}
        {(() => {
          const reason = status.reason ?? 'no_credentials';
          let eyebrow: string;
          let body: string;
          let dim: string;
          let ctaLabel: string;
          if (reason === 'auth_failed') {
            eyebrow = 'Alpaca · Auth rejected';
            body = 'Your Alpaca keys were rejected.';
            dim =
              "Check the keys haven't been rotated, and that Market Data is enabled for this account in the Alpaca dashboard.";
            ctaLabel = 'Reconfigure';
          } else if (reason === 'fetch_failed') {
            eyebrow = 'Alpaca · Connection issue';
            body = 'Equity prices are paused.';
            dim = "Couldn't reach Alpaca — check your internet, then try again.";
            ctaLabel = 'Retry';
          } else {
            eyebrow = 'Alpaca · No credentials';
            body = 'Equity prices are paused.';
            dim = 'Connect your Alpaca account to stream live NASDAQ & NYSE data.';
            ctaLabel = 'Configure';
          }
          return (
            <>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  lineHeight: 1.25,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-eyebrow)',
                    letterSpacing: 'var(--tracking-eyebrow)',
                    textTransform: 'uppercase',
                    color: 'var(--warn)',
                  }}
                >
                  {eyebrow}
                </span>
                <span style={{ color: 'var(--ink-1)' }}>
                  {body}{' '}
                  <span style={{ color: 'var(--ink-2)' }}>{dim}</span>
                </span>
              </div>

              <button
                type="button"
                data-testid="equity-creds-banner-configure"
                onClick={handleConfigure}
                className="equity-banner-cta"
                style={{
                  padding: '6px 14px',
                  borderRadius: 'var(--r-pill)',
                  background: 'color-mix(in oklab, var(--warn) 18%, transparent)',
                  border:
                    '1px solid color-mix(in oklab, var(--warn) 45%, transparent)',
                  color: 'var(--warn)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  transition: 'all var(--t-fast) var(--ease)',
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--sp-6)',
                }}
              >
                {ctaLabel}
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
              </button>
            </>
          );
        })()}

        {/* Dismiss × */}
        <button
          type="button"
          aria-label="Dismiss Alpaca credentials notice"
          data-testid="equity-creds-banner-dismiss"
          onClick={() => setDismissed(true)}
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            color: 'var(--ink-3)',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            transition: 'all var(--t-fast)',
            marginLeft: 'var(--sp-4)',
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path
              d="M1.5 1.5l5 5M6.5 1.5l-5 5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <AlpacaCredentialsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={handleModalSaved}
      />

      <style>{`
        @keyframes equity-banner-in {
          from { opacity: 0; transform: translateY(-100%); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes equity-error-crossfade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes equity-banner-pulse {
          0%   { box-shadow: 0 0 0 0   color-mix(in oklab, var(--warn) 55%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 70%, transparent); }
          70%  { box-shadow: 0 0 0 7px color-mix(in oklab, var(--warn)  0%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 70%, transparent); }
          100% { box-shadow: 0 0 0 0   color-mix(in oklab, var(--warn)  0%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 70%, transparent); }
        }
        .equity-banner-dot {
          animation: equity-banner-pulse 2.2s var(--ease) infinite;
        }
        .equity-banner-cta:hover {
          background: color-mix(in oklab, var(--warn) 28%, transparent);
          box-shadow: 0 0 18px color-mix(in oklab, var(--warn) 40%, transparent);
        }
        @media (prefers-reduced-motion: reduce) {
          .equity-banner-dot { animation: none; }
        }
      `}</style>
    </>
  );
}

/**
 * EquityChartEmpty — centered "Awaiting Alpaca data" overlay shown over the
 * chart area when an equity asset is active, credentials are missing, and
 * the bars array is empty. Self-contained: subscribes to equityCredStatus,
 * opens the credentials modal directly via Configure.
 *
 * Mounted as a sibling inside the chart wrapper in AppShell.tsx.
 */
export interface EquityChartEmptyProps {
  /** Provider id for the currently-active symbol (e.g. 'alpaca' / 'binance'). */
  provider: string;
  /** True when the loaded bars array is empty for the active symbol. */
  noBars: boolean;
}

export function EquityChartEmpty({
  provider,
  noBars,
}: EquityChartEmptyProps): JSX.Element | null {
  const [status, setStatus] = useState<EquityCredStatus>({ failed: false });
  const [modalOpen, setModalOpen] = useState(false);
  const loadingPhase = useAppStore((s) => s.loadingPhase);

  useEffect(() => subscribeEquityCredStatus(setStatus), []);

  if (!isTauriRuntime()) return null;
  if (!status.failed) return null;
  if (provider.toLowerCase() !== 'alpaca') return null;
  if (!noBars) return null;
  // Gate on idle — never show during exit/loading/reveal.
  if (loadingPhase !== 'idle') return null;

  return (
    <>
      <div
        data-testid="chart-equity-empty"
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--sp-16)',
            padding: 'var(--sp-22) var(--sp-32)',
            borderRadius: 'var(--r-22)',
            background: 'color-mix(in oklab, var(--bg-1) 50%, transparent)',
            border: '1px solid var(--hairline)',
            backdropFilter: 'blur(28px) saturate(160%)',
            WebkitBackdropFilter: 'blur(28px) saturate(160%)',
            boxShadow:
              '0 1px 0 0 color-mix(in oklab, white 6%, transparent) inset, 0 40px 80px -28px color-mix(in oklab, black 70%, transparent)',
            animation: 'chart-empty-in var(--t-med) var(--ease-spring) both',
            maxWidth: 360,
            textAlign: 'center',
          }}
        >
          {/* Concentric pulsing rings */}
          <div
            aria-hidden="true"
            className="chart-empty-orb"
            style={{
              position: 'relative',
              width: 48,
              height: 48,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <span
              className="chart-empty-ring chart-empty-ring--1"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border:
                  '1px solid color-mix(in oklab, var(--warn) 30%, transparent)',
              }}
            />
            <span
              className="chart-empty-ring chart-empty-ring--2"
              style={{
                position: 'absolute',
                inset: 8,
                borderRadius: '50%',
                border:
                  '1px solid color-mix(in oklab, var(--warn) 45%, transparent)',
              }}
            />
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'var(--warn)',
                boxShadow:
                  '0 0 14px color-mix(in oklab, var(--warn) 70%, transparent)',
              }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--sp-6)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-eyebrow)',
                letterSpacing: 'var(--tracking-eyebrow)',
                textTransform: 'uppercase',
                color: 'var(--warn)',
              }}
            >
              Awaiting Alpaca data
            </span>
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--ink-2)',
                maxWidth: 280,
              }}
            >
              Live equity prices need an Alpaca Markets API key. Connect now
              and we&rsquo;ll start streaming.
            </span>
          </div>

          <button
            type="button"
            data-testid="chart-equity-empty-configure"
            onClick={() => setModalOpen(true)}
            className="chart-empty-cta"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--sp-8)',
              padding: '9px 18px',
              borderRadius: 'var(--r-pill)',
              background: 'color-mix(in oklab, var(--emerald) 22%, transparent)',
              border:
                '1px solid color-mix(in oklab, var(--emerald) 55%, transparent)',
              color: 'var(--ink-0)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              transition: 'all var(--t-fast) var(--ease)',
            }}
          >
            Connect Alpaca
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M2 5h6M6 2l3 3-3 3" />
            </svg>
          </button>
        </div>

        <style>{`
          @keyframes chart-empty-in {
            from { opacity: 0; transform: translateY(8px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0)   scale(1); }
          }
          @keyframes chart-empty-ring-pulse {
            0%   { transform: scale(1);    opacity: 0.9; }
            70%  { transform: scale(1.35); opacity: 0;   }
            100% { transform: scale(1.35); opacity: 0;   }
          }
          .chart-empty-ring {
            animation: chart-empty-ring-pulse 2.4s var(--ease) infinite;
          }
          .chart-empty-ring--2 { animation-delay: 0.6s; }
          .chart-empty-cta:hover {
            background: color-mix(in oklab, var(--emerald) 32%, transparent);
            box-shadow: 0 0 28px color-mix(in oklab, var(--emerald) 45%, transparent);
          }
          @media (prefers-reduced-motion: reduce) {
            .chart-empty-ring { animation: none; opacity: 0.55; }
          }
        `}</style>
      </div>

      <AlpacaCredentialsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => setModalOpen(false)}
      />
    </>
  );
}

export default EquityCredsBanner;
