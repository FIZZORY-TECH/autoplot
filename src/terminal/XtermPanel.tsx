/**
 * src/terminal/XtermPanel.tsx
 *
 * React component that mounts an xterm.js terminal wired to a TerminalHandle.
 *
 * Lazy-loads the @xterm/xterm bundle inside a useEffect so it is never
 * included in the first-paint bundle and is completely absent in browser-only
 * mode. When the Tauri runtime is not present (neither `window.__TAURI__` nor
 * `window.__TAURI_INTERNALS__` is defined — Tauri v2 only injects the latter),
 * a static glass-card placeholder is rendered instead — no xterm import
 * occurs.
 *
 * Wiring:
 *   stdin  → term.onData   → handle.write(string)
 *   stdout → handle.on('data')  → term.write(Uint8Array)
 *   exit   → handle.on('exit') → optional onExit callback + "[session ended]"
 *
 * Resize: ResizeObserver on the container div, debounced 50 ms via setTimeout,
 * calls fit.fit() then handle.resize(term.cols, term.rows).
 *
 * Copy:   auto-copy on selection change via navigator.clipboard.writeText.
 * Paste:  Cmd/Ctrl-V intercepted via attachCustomKeyEventHandler;
 *         reads navigator.clipboard.readText() and writes to handle.
 *
 * Cleanup order: handle.dispose() → term.dispose() → ResizeObserver.disconnect().
 */

import { useEffect, useRef, useState } from 'react';
import { openTerminal } from './terminalClient';
import type { TerminalHandle } from './terminalClient';
import { isTauriRuntime } from '../lib/runtime';
import { useReducedMotion } from '../lib/reducedMotion';
import { useToastStore } from '../stores/useToastStore';

// ---------------------------------------------------------------------------
// Token-driven theme
//
// xterm needs concrete color strings, but our design tokens are OKLCH /
// color-mix values that some xterm color parsers reject. We resolve each
// token to a concrete browser-computed string (typically rgb()) once, by
// letting the browser compute `color: var(--token)` on a scratch element,
// then cache the whole theme (single-theme assumption — mirrors the
// getComputedStyle caching precedent in src/chart/axes.ts:getAxisFont).
// ---------------------------------------------------------------------------

interface XtermThemeBundle {
  /** xterm Terminal `theme` object. */
  theme: Record<string, string>;
  /** Container + xterm background. */
  background: string;
  /** Mono font stack from --font-mono. */
  fontFamily: string;
}

let _themeBundle: XtermThemeBundle | null = null;

/**
 * Resolve a `var(--token)` reference (or any CSS color) to a concrete
 * browser-computed color string via a throwaway scratch element. Falls back
 * to `fallback` when no document is available (SSR / tests).
 */
function resolveColor(scratch: HTMLElement | null, value: string, fallback: string): string {
  if (!scratch) return fallback;
  scratch.style.color = '';
  scratch.style.color = value;
  const computed = getComputedStyle(scratch).color;
  return computed && computed !== '' ? computed : fallback;
}

function buildThemeBundle(): XtermThemeBundle {
  if (_themeBundle !== null) return _themeBundle;

  // SSR / test fallback — concrete strings so xterm never sees a var().
  if (typeof document === 'undefined') {
    const fg = '#d4d8e0';
    _themeBundle = {
      theme: { background: '#0b0d12', foreground: fg, cursor: fg },
      background: '#0b0d12',
      fontFamily:
        '"Geist Mono", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace',
    };
    return _themeBundle;
  }

  const rootStyle = getComputedStyle(document.documentElement);
  const fontFamily =
    rootStyle.getPropertyValue('--font-mono').trim() ||
    '"Geist Mono", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace';

  // Scratch element to coerce token values into concrete computed colors.
  const scratch = document.createElement('span');
  scratch.style.position = 'absolute';
  scratch.style.visibility = 'hidden';
  scratch.style.pointerEvents = 'none';
  document.body.appendChild(scratch);

  const c = (token: string, fallback: string) =>
    resolveColor(scratch, `var(${token})`, fallback);
  // Selection wants alpha — mix the accent into transparent at the
  // computed-color stage so xterm receives an rgba() string.
  const selection = resolveColor(
    scratch,
    'color-mix(in oklab, var(--accent) 25%, transparent)',
    'rgba(130, 200, 228, 0.25)',
  );

  // Token palette → ANSI 16. red→--down, green→--up, yellow→--warn,
  // blue/cyan→--accent, magenta→--violet; black/white from the bg/ink
  // ramps. Brights reuse the same token family (single-source palette;
  // no invented hex).
  const background = c('--bg-0', '#0b0d12');
  const foreground = c('--ink-1', '#d4d8e0');
  const accent = c('--accent', '#82c8e4');
  const down = c('--down', '#ff6b6b');
  const up = c('--up', '#6bcb77');
  const warn = c('--warn', '#ffd93d');
  const violet = c('--violet', '#c678dd');
  const ink0 = c('--ink-0', '#f0f2f6');
  const ink3 = c('--ink-3', '#3a3f4a');

  _themeBundle = {
    theme: {
      background,
      foreground,
      cursor: accent,
      cursorAccent: background,
      selectionBackground: selection,
      black: background,
      brightBlack: ink3,
      red: down,
      brightRed: down,
      green: up,
      brightGreen: up,
      yellow: warn,
      brightYellow: warn,
      blue: accent,
      brightBlue: accent,
      magenta: violet,
      brightMagenta: violet,
      cyan: accent,
      brightCyan: accent,
      white: foreground,
      brightWhite: ink0,
    },
    background,
    fontFamily,
  };

  document.body.removeChild(scratch);
  return _themeBundle;
}

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface XtermPanelProps {
  /** Default 80 */
  cols?: number;
  /** Default 24 */
  rows?: number;
  cwd?: string;
  cliPath?: string;
  className?: string;
  /**
   * Caller-supplied RFC-4122 UUID for this PTY (multi-session host). Forwarded
   * to `openTerminal` so the PTY key == CLI session id. Omit for the legacy
   * single-session path (backend mints a random id).
   */
  sessionId?: string;
  /** Resume the prior CLI conversation for `sessionId` (emits `--resume`). */
  resume?: boolean;
  /**
   * Fired on EVERY PTY data frame, even for hidden/background mounts. The
   * multi-session host wires this to `useAiSessionStore.markActivity(id)` so
   * background sessions still flip busy. Carries the session id for routing.
   */
  onData?: (sessionId: string) => void;
  onExit?: (code: number) => void;
  /**
   * Fired once when `openTerminal` resolves (the PTY is live). The host uses
   * this to commit the session row (`recordSpawn`) only on spawn success and to
   * settle the in-flight spawn guard. `sessionId` is the resolved PTY id.
   */
  onSpawned?: (sessionId: string) => void;
  /**
   * Fired once when `openTerminal` rejects (e.g. the backend `MAX_SESSIONS`
   * cap → message contains `max_sessions_reached`). The host rolls back any
   * optimistic state and surfaces the cap to the caller. The in-panel toast
   * still fires; the host decides whether to also unmount this xterm.
   */
  onSpawnError?: (sessionId: string | undefined, error: Error) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function XtermPanel(props: XtermPanelProps): JSX.Element {
  const {
    cols = 80,
    rows = 24,
    cwd,
    cliPath,
    className,
    sessionId,
    resume,
    onData,
    onExit,
    onSpawned,
    onSpawnError,
  } = props;

  // --- Browser-mode fallback (no xterm import) ---
  if (!isTauriRuntime()) {
    return (
      <div
        className={['glass-card', className].filter(Boolean).join(' ')}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '32px 24px',
          minHeight: '200px',
          borderRadius: '10px',
          color: 'var(--text-2, oklch(0.55 0.01 260))',
          textAlign: 'center',
        }}
        role="status"
        aria-label="Terminal unavailable in browser mode"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ opacity: 0.4, flexShrink: 0 }}
          aria-hidden="true"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, opacity: 0.7 }}>
          Terminal mode requires the desktop runtime.
          <br />
          Launch the Tauri app to use the Claude TUI.
        </p>
      </div>
    );
  }

  // --- Tauri mode ---
  return (
    <TauriTerminal
      cols={cols}
      rows={rows}
      cwd={cwd}
      cliPath={cliPath}
      className={className}
      sessionId={sessionId}
      resume={resume}
      onData={onData}
      onExit={onExit}
      onSpawned={onSpawned}
      onSpawnError={onSpawnError}
    />
  );
}

// ---------------------------------------------------------------------------
// Session-start overlay
//
// Glass scrim over the terminal from spawn until the PTY's first data frame,
// then dissolves over 240ms (spec). Carries an aurora avatar, a trace-shimmer
// "Starting Claude session…" line, and a dismissible "Try asking" hint card.
//
// Hint dismissal is sticky for the app session — a module-level flag (NOT
// localStorage; no persistence precedent for terminal chrome). Mirrors the
// in-session sticky-dismiss pattern without writing to disk.
// ---------------------------------------------------------------------------

let _hintDismissed = false;

const HINT_PROMPTS = [
  'Backtest a 20/50 MA crossover on this symbol',
  'Plot RSI divergence over the last 90 days',
  "Compare this asset's drawdown vs SPY",
] as const;

interface StartOverlayProps {
  /** True once the first PTY data frame arrives — triggers the dissolve. */
  dissolving: boolean;
  reduced: boolean;
}

function StartOverlay({ dissolving, reduced }: StartOverlayProps): JSX.Element {
  // Local mirror of the module flag so dismissing re-renders this instance;
  // the module flag keeps it dismissed across remounts within the session.
  const [hintHidden, setHintHidden] = useState(_hintDismissed);

  const dismissHint = (): void => {
    _hintDismissed = true;
    setHintHidden(true);
  };

  return (
    <div
      className="terminal-start-overlay"
      data-dissolving={dissolving ? 'true' : 'false'}
      role="status"
      aria-label="Starting Claude session"
    >
      <span className="aurora-shell size-large terminal-start-avatar" aria-hidden>
        <span className="aurora" data-anim={reduced ? undefined : 'aurora'} />
      </span>

      <span className="terminal-start-status" data-anim={reduced ? undefined : 'shimmer'}>
        Starting Claude session…
      </span>

      {!hintHidden && (
        <div className="glass-card terminal-start-hint">
          <div className="terminal-start-hint-head">
            <span className="terminal-start-hint-title">Try asking</span>
            <button
              type="button"
              className="terminal-start-hint-dismiss"
              aria-label="Dismiss suggestions"
              onClick={dismissHint}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
          <ul className="terminal-start-hint-list">
            {HINT_PROMPTS.map((p) => (
              <li key={p} className="terminal-start-hint-item">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TauriTerminal — only rendered when the Tauri runtime is present.
// Extracted so React's rules-of-hooks lint can see the early return above
// is not a conditional hook — the conditional is at the component boundary.
// ---------------------------------------------------------------------------

interface TauriTerminalProps {
  cols: number;
  rows: number;
  cwd?: string;
  cliPath?: string;
  className?: string;
  sessionId?: string;
  resume?: boolean;
  onData?: (sessionId: string) => void;
  onExit?: (code: number) => void;
  onSpawned?: (sessionId: string) => void;
  onSpawnError?: (sessionId: string | undefined, error: Error) => void;
}

function TauriTerminal({
  cols,
  rows,
  cwd,
  cliPath,
  className,
  sessionId,
  resume,
  onData,
  onExit,
  onSpawned,
  onSpawnError,
}: TauriTerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  // The setup effect runs once on mount (deps: []), so capture the latest
  // callbacks in refs. The host may pass fresh `onData` / `onExit` closures on
  // every render (it reads store state); without refs the effect would call the
  // stale mount-time closure. Refs let the live PTY handlers always reach the
  // current callbacks without re-running setup (which would re-spawn the PTY).
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;
  const onSpawnErrorRef = useRef(onSpawnError);
  onSpawnErrorRef.current = onSpawnError;

  // Session-start overlay lifecycle:
  //   overlayMounted — overlay is in the DOM (true from mount; false once the
  //     dissolve completes / instantly under reduced-motion).
  //   dissolving — first PTY frame arrived; drives the 240ms fade-out.
  // On a parent remount (restartKey bump in TerminalPanel) this whole
  // component re-mounts, so the overlay naturally reappears.
  const [overlayMounted, setOverlayMounted] = useState(true);
  const [dissolving, setDissolving] = useState(false);
  // Latch so the first-frame transition runs exactly once.
  const firstFrameSeen = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Captured so the data handler can flip the overlay off on the first frame
    // without re-subscribing the effect to React state.
    let dissolveTimer: ReturnType<typeof setTimeout> | null = null;

    // Refs for cleanup
    let handle: TerminalHandle | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    // Track whether this effect has been cancelled (unmounted before async work completes)
    let cancelled = false;

    // Capture the narrowed non-null container for use inside setup().
    // TypeScript cannot narrow through async closures so we store separately.
    const el: HTMLElement = container;

    // Cleanup function — called on unmount or if the effect re-runs.
    // We return a synchronous cleanup that sets cancelled and delegates the
    // async teardown to a local async function so the effect cleanup itself
    // stays synchronous (required by React).
    let asyncCleanup: (() => Promise<void>) | null = null;
    const cleanup = () => {
      cancelled = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (dissolveTimer !== null) clearTimeout(dissolveTimer);
      if (observer) observer.disconnect();
      if (asyncCleanup) void asyncCleanup();
    };

    async function setup() {
      // -----------------------------------------------------------------------
      // 1. Lazy-load xterm + addons
      // -----------------------------------------------------------------------
      const { Terminal } = await import('@xterm/xterm');
      // Side-effect CSS import — Vite handles this as a stylesheet in dev and
      // inlines / chunks it for production. If this causes issues in the Vite
      // config, move the import to index.html.
      await import('@xterm/xterm/css/xterm.css');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      if (cancelled) return;

      // -----------------------------------------------------------------------
      // 2. Construct the terminal with cinematic-dark-glass theme
      // -----------------------------------------------------------------------
      const themeBundle = buildThemeBundle();
      const term = new Terminal({
        cursorBlink: true,
        scrollback: 5_000,
        fontFamily: themeBundle.fontFamily,
        fontSize: 13,
        theme: themeBundle.theme,
      });

      const fit = new FitAddon();
      const webLinks = new WebLinksAddon();

      term.loadAddon(fit);
      term.loadAddon(webLinks);
      term.open(el);
      fit.fit();

      // Override initial cols/rows from props if they differ from the fitted result
      const initialCols = term.cols || cols;
      const initialRows = term.rows || rows;

      if (cancelled) {
        term.dispose();
        return;
      }

      // -----------------------------------------------------------------------
      // 3. Open the PTY session
      // -----------------------------------------------------------------------
      try {
        handle = await openTerminal({
          cols: initialCols,
          rows: initialRows,
          cwd,
          cliPath,
          sessionId,
          resume,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          term.write(`\r\n\x1b[31m[terminal error: ${msg}]\x1b[0m\r\n`);
        }
        // Surface the failure as a toast. The Rust spawn path rejects with
        // "max_sessions_reached" once the concurrent-session cap (4) is hit —
        // distinguish that as a warn, everything else as a hard error.
        if (msg.includes('max_sessions_reached')) {
          useToastStore.getState().push({
            kind: 'warn',
            title: 'Too many Claude sessions',
            detail: 'You can run at most 4 terminal sessions at once. Close one and try again.',
          });
        } else {
          useToastStore.getState().push({
            kind: 'error',
            title: 'Failed to start Claude session',
            detail: msg,
          });
        }
        // Tell the host the spawn failed so it can roll back the optimistic row
        // / settle the in-flight guard / unmount this xterm. Fires even when the
        // effect was cancelled (an unmount mid-spawn is itself a "no PTY" outcome).
        onSpawnErrorRef.current?.(sessionId, err instanceof Error ? err : new Error(msg));
        term.dispose();
        return;
      }

      if (cancelled) {
        // Unmounted mid-spawn: the PTY came up but we're tearing it right back
        // down. Tell the host this mount aborted so the in-flight guard can
        // never deadlock. The host settles the pending-spawn promise in a
        // StrictMode-safe way (a deferred reject the immediate remount preempts)
        // — see rejectSpawn's `aborted` path.
        onSpawnErrorRef.current?.(handle.sessionId, new Error('spawn_aborted'));
        await handle.dispose();
        term.dispose();
        return;
      }

      // PTY is live — let the host commit the session row (recordSpawn) and
      // settle the in-flight guard. Use the resolved id (== sessionId when the
      // host supplied one).
      onSpawnedRef.current?.(handle.sessionId);

      // -----------------------------------------------------------------------
      // 4. Wire stdin — term → handle
      // -----------------------------------------------------------------------
      term.onData((data) => {
        void handle!.write(data);
      });

      // -----------------------------------------------------------------------
      // 5. Wire stdout — handle → term
      // -----------------------------------------------------------------------
      handle.on('data', (e) => {
        term.write(e.bytes);
        // Notify host on EVERY frame (incl. while hidden/background) so the
        // session store can flip busy for any session — not just the visible
        // one. The listener stays live because the host keeps hidden xterms
        // mounted (display:none), never unmounted.
        onDataRef.current?.(e.sessionId);
        // First PTY data frame → dissolve the session-start overlay. Latch so
        // this fires once. Reduced-motion: hide instantly (no fade). Otherwise
        // flip data-dissolving (240ms CSS transition) then unmount on a timer.
        if (!firstFrameSeen.current) {
          firstFrameSeen.current = true;
          if (reduced) {
            setOverlayMounted(false);
          } else {
            setDissolving(true);
            dissolveTimer = setTimeout(() => {
              if (!cancelled) setOverlayMounted(false);
            }, 240);
          }
        }
      });

      // -----------------------------------------------------------------------
      // 6. Wire exit
      // -----------------------------------------------------------------------
      handle.on('exit', (e) => {
        onExitRef.current?.(e.code);
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      });

      // -----------------------------------------------------------------------
      // 7. Copy on selection
      // -----------------------------------------------------------------------
      term.onSelectionChange(() => {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {
            // Clipboard API may be denied — silent fail.
          });
        }
      });

      // -----------------------------------------------------------------------
      // 8. Paste via Cmd/Ctrl-V
      // -----------------------------------------------------------------------
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        const isPasteShortcut =
          ev.type === 'keydown' &&
          ev.key === 'v' &&
          (ev.metaKey || ev.ctrlKey);

        if (isPasteShortcut) {
          navigator.clipboard.readText().then((text) => {
            void handle!.write(text);
          }).catch(() => {
            // Clipboard read denied — silent fail.
          });
          return false; // prevent xterm default
        }
        return true;
      });

      // -----------------------------------------------------------------------
      // 9. ResizeObserver — debounced fit + resize
      // -----------------------------------------------------------------------
      observer = new ResizeObserver(() => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fit.fit();
          void handle!.resize(term.cols, term.rows);
        }, 50);
      });
      observer.observe(el);

      // -----------------------------------------------------------------------
      // Register async cleanup
      // -----------------------------------------------------------------------
      asyncCleanup = async () => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        observer?.disconnect();
        // Order: dispose handle first so pending writes don't crash xterm.
        if (handle) {
          await handle.dispose().catch(() => { /* best-effort */ });
          handle = null;
        }
        term.dispose();
      };
    }

    void setup();
    return cleanup;
    // Intentional: only run once on mount. Props changes don't re-spawn the PTY.
  }, []);

  return (
    <div className="terminal-start-host">
      <div
        ref={containerRef}
        className={className}
        style={{
          width: '100%',
          height: '100%',
          background: 'var(--bg-0)',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
      />
      {overlayMounted && <StartOverlay dissolving={dissolving} reduced={reduced} />}
    </div>
  );
}
