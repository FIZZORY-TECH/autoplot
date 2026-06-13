/**
 * Presentational toast card.
 *
 * Renders a single glassy toast with kind-rail accent, title, optional truncated
 * detail (≤80 chars / 2-line clamp), and a thin auto-dismiss progress bar that
 * scales linearly from 1→0 over the toast's duration.
 *
 * Pointer-drag past 80px (translateX) → calls `onDismiss(id)`. While dragging
 * the card opacity follows distance / 200px. Esc on a focused toast dismisses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DURATION_MS, type Toast as ToastT } from '../stores/useToastStore';

const DRAG_DISMISS_PX = 80;

interface ToastProps {
  toast: ToastT;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps): JSX.Element {
  const [dragX, setDragX] = useState(0);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    startXRef.current = e.clientX;
    cardRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setDragX(e.clientX - startXRef.current);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        cardRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture may already be released — ignore.
      }
      // Prefer the latest known dragX (set on every pointermove) over the
      // synthetic pointerup's clientX — the latter can be missing in test
      // environments where jsdom doesn't expose the field on the synthetic.
      const moveDelta = e.clientX - startXRef.current;
      const distance = Math.abs(
        Number.isFinite(moveDelta) && moveDelta !== 0 ? moveDelta : dragX,
      );
      if (distance >= DRAG_DISMISS_PX) {
        onDismiss(toast.id);
      } else {
        setDragX(0);
      }
    },
    [onDismiss, toast.id, dragX],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss(toast.id);
      }
    },
    [onDismiss, toast.id],
  );

  // Truncate detail at 80 chars (2-line clamp also applied via CSS).
  const detail = toast.detail
    ? toast.detail.length > 80
      ? toast.detail.slice(0, 79) + '…'
      : toast.detail
    : undefined;

  const opacity = Math.max(0.2, 1 - Math.abs(dragX) / 200);

  // Progress bar scaleX runs from 1 → 0 over duration. Mount-time scaleX(1);
  // a useEffect kicks the scaleX(0) transition on next frame so CSS transition
  // animates linearly across the duration.
  const progressRef = useRef<HTMLDivElement>(null);
  const duration = DURATION_MS[toast.kind];
  useEffect(() => {
    const el = progressRef.current;
    if (!el) return;
    el.style.transform = 'scaleX(1)';
    el.style.transition = 'none';
    // Force reflow so the next style write animates.
    void el.offsetHeight;
    el.style.transition = `transform ${duration}ms linear`;
    el.style.transform = 'scaleX(0)';
  }, [duration, toast.createdAt]);

  return (
    <div
      ref={cardRef}
      className={`toast ${toast.kind}`}
      role="status"
      tabIndex={0}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      style={{
        transform: dragX !== 0 ? `translateX(${dragX}px)` : undefined,
        opacity,
      }}
    >
      <div className="toast-title">{toast.title}</div>
      {detail && <div className="toast-detail">{detail}</div>}
      {toast.action && (
        <button
          type="button"
          aria-label={toast.action.label}
          className="toast-action"
          onClick={() => {
            toast.action!.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <div className="toast-progress" ref={progressRef} />
    </div>
  );
}
