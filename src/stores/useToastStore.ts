/**
 * Toast queue (in-session only; never persisted). Provides:
 *   - `push({kind, title, detail?})` — appends a toast (with dedupe + cap-3),
 *     auto-dismisses after 4s (info/warn) or 8s (error).
 *   - `dismiss(id)` — flags a toast as dismissed (presentational fade-out
 *     should call `remove(id)` once its exit animation finishes).
 *   - `remove(id)` — splice from the array.
 *
 * Dedupe: a `push` with the same kind+title+detail as an active (non-dismissed)
 * toast refreshes that toast's `createdAt` instead of creating a duplicate.
 *
 * Cap: at most 3 active toasts visible at once — the oldest is auto-dismissed
 * when a fourth lands.
 */

import { create } from 'zustand';

export type ToastKind = 'info' | 'warn' | 'error';

/** Optional inline action button rendered inside the toast card. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Optional inline action (e.g. "Undo"). Clicking it dismisses the toast. */
  action?: ToastAction;
  createdAt: number;
  dismissedAt?: number;
}

export interface ToastInput {
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Optional inline action (e.g. "Undo"). */
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  remove: (id: string) => void;
}

const VISIBLE_CAP = 3;
export const DURATION_MS: Record<ToastKind, number> = {
  info: 4000,
  warn: 4000,
  error: 8000,
};

/** Map of toast id → setTimeout handle for auto-dismiss. */
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(id: string): void {
  const t = autoDismissTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    autoDismissTimers.delete(id);
  }
}

function scheduleAutoDismiss(id: string, durationMs: number): void {
  clearTimer(id);
  const handle = setTimeout(() => {
    autoDismissTimers.delete(id);
    useToastStore.getState().dismiss(id);
  }, durationMs);
  autoDismissTimers.set(id, handle);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (input) => {
    const now = Date.now();
    const existing = get().toasts.find(
      (t) =>
        t.dismissedAt === undefined &&
        t.kind === input.kind &&
        t.title === input.title &&
        (t.detail ?? '') === (input.detail ?? ''),
    );
    if (existing) {
      // Dedupe: refresh createdAt + reschedule timer.
      set((s) => ({
        toasts: s.toasts.map((t) =>
          t.id === existing.id ? { ...t, createdAt: now } : t,
        ),
      }));
      scheduleAutoDismiss(existing.id, DURATION_MS[existing.kind]);
      return existing.id;
    }
    const id = `toast-${now}-${Math.floor(Math.random() * 100000)}`;
    const toast: Toast = {
      id,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      action: input.action,
      createdAt: now,
    };
    set((s) => {
      const next = [...s.toasts, toast];
      // Cap visible toasts to 3 — auto-dismiss the oldest active ones.
      const active = next.filter((t) => t.dismissedAt === undefined);
      if (active.length > VISIBLE_CAP) {
        const overflow = active.length - VISIBLE_CAP;
        const overflowIds = active.slice(0, overflow).map((t) => t.id);
        for (const oid of overflowIds) clearTimer(oid);
        return {
          toasts: next.map((t) =>
            overflowIds.includes(t.id) && t.dismissedAt === undefined
              ? { ...t, dismissedAt: now }
              : t,
          ),
        };
      }
      return { toasts: next };
    });
    scheduleAutoDismiss(id, DURATION_MS[toast.kind]);
    return id;
  },
  dismiss: (id) => {
    clearTimer(id);
    set((s) => ({
      toasts: s.toasts.map((t) =>
        t.id === id && t.dismissedAt === undefined
          ? { ...t, dismissedAt: Date.now() }
          : t,
      ),
    }));
  },
  remove: (id) => {
    clearTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
