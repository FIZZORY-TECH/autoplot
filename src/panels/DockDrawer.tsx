/**
 * src/panels/DockDrawer.tsx — Step 3 reusable docked-drawer shell.
 *
 * The single glass container the six dock panels (watchlist, strategy,
 * terminal, portfolio, indicator, settings) will be wrapped in by later steps.
 * This step builds ONLY the shell — no panel is wrapped here, and the activity
 * rails (Step 4) are not built here.
 *
 * Open-state is owned by `useDockStore` (the `open` prop is derived there). The
 * drawer sits `position: fixed`, flush against the activity rail on its side,
 * filling the reserved inset between the top/bottom chrome strips.
 *
 * No-overlap invariant: the drawer's rendered width is bound DIRECTLY to its
 * side's reserve var (`--reserve-left` / `--reserve-right`, written jointly by
 * useDockStore.jointReserve), so it always equals the chart's inset on its side
 * and never overlaps the chart OR the other-side drawer at any window width —
 * including when both a left and a right drawer are open at a narrow window
 * (where the store shrinks the two reserves proportionally). The design widths
 * themselves live in useDockStore's WIDTH map (which feeds the reserve vars);
 * DockDrawer takes no width prop — the rendered box width tracks the reserve
 * var. A width transition (reduced-motion gated)
 * animates the proportional re-shrink. Enter/exit motion is a pure `translateX`
 * transform, independent of the reserve var, so the close animation is
 * unaffected by the chart re-expanding behind it.
 *
 * Motion: mount-stable pattern — a `hasInteracted` gate + a `phase`
 * ('idle' | 'opening' | 'closing') + `animation-fill-mode: both`, so the
 * closed resting state is the off-screen transform and the first render never
 * flashes a close animation. Keyframes (`drawer-{in,out}-{left,right}`) and
 * the reduced-motion cap live in src/styles/motion.css.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../lib/reducedMotion';
import { RESERVE_TOP, RESERVE_BOTTOM } from '../lib/layout';

// Drawer tier: above the chart, below modals. IndicatorPanel uses 35/34; the
// dock-panel tier lives just under that at 34 so wrapped panels sit beside the
// chart without covering modals (MarkComposer z=50, AddAsset scrim z=60).
const DRAWER_Z = 'var(--z-drawer)';

// Slightly > the 220ms exit keyframe so children always eventually unmount even
// if `animationend` never fires (reduced motion / display quirks).
const EXIT_FALLBACK_MS = 260;

// Spring-settle delay before moving focus inside — matches IndicatorPanel.tsx's
// 180ms focus timing so focus lands after the entrance settles.
const FOCUS_DELAY_MS = 180;

export interface DockDrawerProps {
  side: 'left' | 'right';
  open: boolean;
  /** Stable DOM id / test hook. */
  id: string;
  ariaLabel: string;
  /**
   * `false` (default) = mount-stable: children always rendered; closed = the
   * off-screen resting transform; never unmounted (stable DOM for a11y /
   * Playwright). `true` = mount only while open: children unmount on the
   * closing animation's end (or the fallback timeout) so unmount-keyed cleanup
   * effects fire (Terminal PTY, CodeMirror editor teardown).
   */
  mountOnOpen?: boolean;
  children: React.ReactNode;
}

type Phase = 'idle' | 'opening' | 'closing';

const hasDom = typeof document !== 'undefined';

/** First focusable element inside `root`: an explicit [autofocus], else the
 *  first tabbable element. SSR/jsdom-guarded by callers. */
function firstFocusable(root: HTMLElement): HTMLElement | null {
  const explicit = root.querySelector<HTMLElement>('[autofocus]');
  if (explicit) return explicit;
  return root.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
}

export function DockDrawer({
  side,
  open,
  id,
  ariaLabel,
  mountOnOpen = false,
  children,
}: DockDrawerProps): React.ReactElement | null {
  // The rendered box width tracks the side's reserve var — see the file
  // header's no-overlap invariant. Design widths live in useDockStore's WIDTH
  // map, which feeds the reserve vars.

  const rootRef = useRef<HTMLDivElement>(null);
  // Captured `document.activeElement` at open time — the generic "return
  // target" so focus goes back to whatever opened the drawer without DockDrawer
  // knowing the trigger.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Mount-stable pattern: only animate after the first open so the closing
  // keyframe never plays on first render (which would flash the drawer in).
  const [hasInteracted, setHasInteracted] = useState(false);
  useEffect(() => {
    if (open && !hasInteracted) setHasInteracted(true);
  }, [open, hasInteracted]);

  // mountOnOpen: whether children are currently mounted. While open → mounted;
  // when `open` flips false, stay mounted to play the closing animation, then
  // unmount on animationend / fallback timeout.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (!mountOnOpen) return;
    if (open) {
      setMounted(true);
      return;
    }
    // Closing: schedule a robust fallback unmount in case animationend doesn't
    // fire (reduced motion, hidden tab, display quirks). The animationend
    // handler below also unmounts; whichever fires first wins (idempotent).
    const t = setTimeout(() => setMounted(false), EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [open, mountOnOpen]);

  // Focus management. On open: capture the return target, then move focus
  // inside after the spring settles. On close: restore focus to the captured
  // target. SSR/jsdom-guarded.
  useEffect(() => {
    if (!hasDom) return;
    if (open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      const t = setTimeout(() => {
        const root = rootRef.current;
        if (!root) return;
        firstFocusable(root)?.focus();
      }, FOCUS_DELAY_MS);
      return () => clearTimeout(t);
    }
    // Closing — restore focus to the element that was active when we opened.
    const target = returnFocusRef.current;
    if (target && typeof target.focus === 'function') target.focus();
    returnFocusRef.current = null;
    return undefined;
  }, [open]);

  // Reactive reduced-motion flag — the width transition is an inline style the
  // global reduced-motion CSS block can't reach (inline > stylesheet), so gate
  // it here. Tracks live OS toggles via the shared hook's `change` listener.
  const reducedMotion = useReducedMotion();
  // Animate the proportional re-shrink when both drawers fight for width at a
  // narrow window. translateX (enter/exit) stays in `animation`, untouched.
  const widthTransition = reducedMotion
    ? undefined
    : 'width var(--t-med) var(--ease-spring)';

  const phase: Phase = !hasInteracted ? 'idle' : open ? 'opening' : 'closing';

  // Side-aware keyframe selection. `both` fill-mode holds the end-state so the
  // closed resting state stays off-screen and the opening state holds at rest.
  const animation =
    phase === 'idle'
      ? 'none'
      : phase === 'opening'
        ? `drawer-in-${side} 380ms var(--ease-spring) both`
        : `drawer-out-${side} 220ms var(--ease) both`;

  // Resting (idle/closed) style = the off-screen transform + opacity 0, so the
  // pre-interaction frame matches the closed keyframe end-state (no flash).
  const offscreenX = side === 'left' ? '-20px' : '20px';
  const resting =
    phase === 'idle'
      ? { transform: `translateX(${offscreenX}) scale(0.95)`, opacity: 0 }
      : undefined;

  // mountOnOpen=true and fully closed (children torn down) → render nothing.
  if (mountOnOpen && !mounted) return null;

  const edge = side === 'left' ? { left: 'var(--rail-w)' } : { right: 'var(--rail-w)' };

  return (
    <div
      ref={rootRef}
      id={id}
      data-testid={id}
      role="dialog"
      aria-label={ariaLabel}
      aria-modal="false"
      className={`dock-drawer dock-drawer--${side} glass-strong`}
      onAnimationEnd={(e) => {
        // Ignore animationend events bubbling up from child elements — only the
        // drawer's OWN closing animation should trigger the mountOnOpen unmount.
        if (e.target !== e.currentTarget) return;
        // Unmount mountOnOpen children once the closing animation finishes.
        if (mountOnOpen && !open) setMounted(false);
      }}
      style={{
        position: 'fixed',
        top: RESERVE_TOP,
        bottom: RESERVE_BOTTOM,
        ...edge,
        // Bind the rendered width DIRECTLY to this side's reserve var (written
        // jointly by useDockStore.jointReserve). The drawer is thus always
        // exactly the chart's inset on its side — never overlapping the chart
        // OR the other-side drawer, even when both are open at a narrow window.
        width: side === 'left' ? 'var(--reserve-left)' : 'var(--reserve-right)',
        maxHeight: '100%',
        zIndex: DRAWER_Z,
        display: 'flex',
        flexDirection: 'column',
        // Body region scrolls when a panel's content is taller than the inset.
        overflowY: 'auto',
        animation,
        // Spring the width when the reserve var changes (proportional reshrink
        // when both drawers compete). Reduced-motion gated (inline style).
        transition: widthTransition,
        // Closed/idle drawer is inert; only the open drawer takes pointer input.
        // The chart beside the drawer stays interactive (no backdrop scrim).
        pointerEvents: open ? 'auto' : 'none',
        ...resting,
      }}
    >
      {children}
    </div>
  );
}
