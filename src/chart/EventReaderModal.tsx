/**
 * src/chart/EventReaderModal.tsx — Step S8
 *
 * The fullscreen reading surface for a single research event. Opened from the
 * EventListPopover (S6) via its `onExpand` seam, which only ever passes a
 * research event that HAS content (the popover gates the expand control on it).
 *
 * Layering (ADR-0012): a scrim at --z-modal-scrim (700) over --scrim-strong,
 * and a centered reading card at --z-modal (800) on --surface-overlay-strong.
 * Flat tokens only — no glow. Mirrors AddAssetModal's scrim/card/Esc/outside-
 * click idiom (scrim click closes; card click is stopped).
 *
 * Spatial continuity: the card scales+fades FROM the popover row that opened it
 * (the `originRect` captured by AppShell at open time) toward screen centre, so
 * the reader feels like a zoom of the row rather than a context switch. Under
 * prefers-reduced-motion the transform collapses to a plain fade.
 *
 * A11y: role="dialog" + aria-modal + aria-labelledby (the title). Focus is
 * trapped inside while open (Tab cycles); focus moves to the close button on
 * open and is RETURNED to the trigger on close (AppShell hands back the focus-
 * restore element; the popover stays mounted behind the scrim so its row can
 * receive focus, falling back to the chart canvas if it has unmounted).
 *
 * Reuses: SourceBadge (S7), useReducedMotion, and the popover's `fmtTs`-style
 * timestamp formatter (kept in sync below).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useReducedMotion } from '../lib/reducedMotion';
import { SourceBadge } from './SourceBadge';
import type { ExpandableEvent } from './EventListPopover';
import { fmtTs } from './chartTimeFormat';

interface EventReaderModalProps {
  /** The event to read, or null when closed (render nothing). */
  event: ExpandableEvent | null;
  /** Close the reader. AppShell clears its reader state + returns focus. */
  onClose: () => void;
  /**
   * Screen rect (CSS px) of the popover row/control that opened the reader, used
   * as the scale+fade origin for spatial continuity. Optional — without it the
   * card simply scales from its own centre.
   */
  originRect?: { x: number; y: number; w: number; h: number } | null;
  /**
   * Element to restore focus to on close (the popover row / expand control). May
   * be null when the trigger has unmounted; AppShell falls back to the canvas.
   */
  restoreFocusEl?: HTMLElement | null;
}

/** Title id — referenced by aria-labelledby. Stable so SR announces the title. */
const TITLE_ID = 'event-reader-title';

/** Focusable descendants of the dialog, in document order (for the focus trap). */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function EventReaderModal({
  event,
  onClose,
  originRect,
  restoreFocusEl,
}: EventReaderModalProps): JSX.Element | null {
  const reduced = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // `phase` drives the scale+fade: 'open' applies the in-transform from the row.
  const [phase, setPhase] = useState<'enter' | 'open'>('enter');

  const open = event !== null;

  // Reset to the entering phase whenever a new event opens, then flip to 'open'
  // on the next frame so the CSS transition runs from origin → centre.
  useLayoutEffect(() => {
    if (!open) {
      setPhase('enter');
      return;
    }
    setPhase('enter');
    const raf = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(raf);
  }, [open, event?.id]);

  // Move focus into the dialog on open; return it to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      // On unmount/close, restore focus to the originating popover row (or the
      // chart canvas fallback supplied by AppShell).
      restoreFocusEl?.focus();
    };
  }, [open, restoreFocusEl]);

  // Esc closes; Tab is trapped within the dialog (cycles, never escapes).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const items = focusableWithin(card);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !card.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !card.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!event) return null;

  // ---------------------------------------------------------------------------
  // Spatial-continuity transform — scale+fade FROM the row toward centre.
  // We compute a transform that places the card visually AT the originRect in
  // the 'enter' phase, then relax to identity in 'open'. Under reduced motion we
  // skip the translate/scale and fade only.
  // ---------------------------------------------------------------------------

  let enterTransform = 'scale(0.96)';
  if (!reduced && originRect && typeof window !== 'undefined') {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const originCx = originRect.x + originRect.w / 2;
    const originCy = originRect.y + originRect.h / 2;
    const dx = originCx - vw / 2;
    const dy = originCy - vh / 2;
    enterTransform = `translate(${dx}px, ${dy}px) scale(0.28)`;
  }

  const entering = phase === 'enter';

  const scrimStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 'var(--z-modal-scrim)',
    background: 'var(--scrim-strong)',
    backdropFilter: 'blur(18px) saturate(120%)',
    WebkitBackdropFilter: 'blur(18px) saturate(120%)',
    display: 'grid',
    placeItems: 'center',
    padding: '6vh 24px',
    opacity: entering ? 0 : 1,
    transition: reduced
      ? 'opacity 200ms var(--ease)'
      : 'opacity var(--t-med) var(--ease)',
  };

  const cardStyle: CSSProperties = {
    width: 'min(760px, 92vw)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface-overlay-strong)',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--r-22)',
    overflow: 'hidden',
    backdropFilter: 'blur(40px) saturate(180%)',
    WebkitBackdropFilter: 'blur(40px) saturate(180%)',
    // Flat elevation — depth shadow only, NO accent glow (ADR-0012, glow retired).
    boxShadow: '0 24px 60px -16px var(--scrim-strong)',
    transformOrigin: 'center center',
    opacity: entering ? 0 : 1,
    transform: entering ? enterTransform : 'translate(0,0) scale(1)',
    // Enter ~340ms (spatial spring); exit handled by the scrim/card opacity
    // collapsing — the conditional unmount removes it after AppShell clears
    // state, so we keep a single transition and lean on the enter spring.
    transition: reduced
      ? 'opacity 200ms var(--ease)'
      : 'opacity 340ms var(--ease), transform 340ms var(--ease-spring)',
  };

  return (
    <div
      className="event-reader-scrim"
      data-testid="event-reader-scrim"
      style={scrimStyle}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        className="event-reader-card"
        data-testid="event-reader-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — title + source badge + close. */}
        <div className="event-reader-header">
          <h2 id={TITLE_ID} className="event-reader-title">
            {event.label || '(unlabeled)'}
          </h2>
          <div className="event-reader-header-aside">
            {event.sourceUrl && (
              <SourceBadge
                sourceUrl={event.sourceUrl}
                sourceName={event.sourceName ?? event.sourceUrl}
              />
            )}
            <button
              ref={closeBtnRef}
              type="button"
              className="event-reader-close"
              aria-label="Close reader"
              data-testid="event-reader-close"
              onClick={onClose}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body — full content at reading measure, scrolls internally if long. */}
        <div className="event-reader-body" data-testid="event-reader-content">
          <p className="event-reader-content">{event.content}</p>
        </div>

        {/* Footer — timestamp, mono tabular. */}
        <div className="event-reader-footer">
          <span className="event-reader-ts" data-testid="event-reader-ts">
            {fmtTs(event.ts)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default EventReaderModal;
