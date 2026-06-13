/**
 * src/stores/keyboard.ts — Unified keyboard dispatcher (P2.7)
 *
 * Mounts ONE global `keydown` listener via `useKeyboardDispatcher()`.
 * Mount this hook exactly once in AppShell.tsx. All keyboard shortcuts for
 * the app flow through here — no other components should attach global
 * keydown listeners (local React onKeyDown on focused elements is fine).
 *
 * Key table:
 *   ⌘K / Ctrl+K  → open command palette
 *   ⌘, / Ctrl+,  → toggle Settings panel (W2-A; routes via opts.onToggleSettings)
 *   ⌘P / Ctrl+P  → toggle Portfolio panel (routes via opts.onTogglePortfolio)
 *   ⌘` / Ctrl+`  → toggle Terminal drawer (routes via opts.onToggleTerminal)
 *   /            → open command palette (when not in input/textarea)
 *   D            → toggle indicators panel
 *   M            → toggle mark tool (mark ↔ none)
 *   C            → toggle comment tool (comment ↔ none)
 *   S            → toggle Range Scope tool (rangeScope ↔ none)
 *   T            → toggle Trend Line tool (trend ↔ none)
 *   R            → reset chart view to last 200 bars
 *   Backspace    → delete the currently-selected trend (when one is selected)
 *   Esc          → precedence chain (see below)
 *
 * Esc precedence (each step only runs if the previous condition is NOT met):
 *   1. Close Inspect-payload modal if open  (W2-G — onCloseInspectModal)
 *   2. Close composer if open  (composer state passed via resetComposer callback)
 *   3. Close palette if open
 *   4. Close the open dock drawer containing focus (else right, else left)
 *   5. Drop in-progress trend draft if drawing (trendDraft != null)
 *   6. Clear rangeScope if non-null
 *   7. Set activeTool = 'none' if not already 'none'
 *
 * Shift-held keys are NOT handled — the chart's interaction module detects
 * shift on mousedown for range-select.
 *
 * macOS Tauri note: ⌘K may be eaten by the OS/webview. We listen for both
 * `metaKey+k` AND `ctrlKey+k` so Ctrl+K always works cross-platform.
 * If ⌘K does not fire in Tauri's webview, Ctrl+K is the reliable fallback.
 */

import { useEffect } from 'react';
import { useAppStore } from './useAppStore';
import { useDockStore } from './useDockStore';
import type { DrawerId } from './useDockStore';
import { dbTrendsDelete } from '../lib/db';

// ---------------------------------------------------------------------------
// Helper — is the event target a text entry element?
// ---------------------------------------------------------------------------

export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  // Check both the property and the attribute — jsdom returns '' for disconnected
  // elements, so we also check the attribute for robustness.
  const ce = (target as HTMLElement).contentEditable;
  if (ce === 'true' || ce === 'plaintext-only') return true;
  if ((target as HTMLElement).isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Hook — mount once in AppShell
// ---------------------------------------------------------------------------

/**
 * Options passed from AppShell so the dispatcher can reach state that lives
 * in AppShell-local state (composer) and the resetView callback.
 */
export interface KeyboardDispatcherOptions {
  /** True when a MarkComposer is currently open. */
  composerOpen: boolean;
  /** Callback to close the composer (sets composer=null + activeTool='none'). */
  resetComposer: () => void;
  /** Callback to reset the chart view to last VISIBLE_BARS bars. */
  resetView: () => void;
  /**
   * W2-A — toggle the Settings panel (⌘, / Ctrl+,). Opt-in so tests that
   * build options without it still compile; routed through here so we never
   * add a competing window keydown listener.
   */
  onToggleSettings?: () => void;
  /**
   * W2-G — close the Inspect-payload modal on Esc. Inserted ABOVE the
   * "Close composer" rung in the precedence chain so that Esc dismisses the
   * modal first (when open) without falling through to the composer reset.
   *
   * Returns `true` if the modal was open and was closed (consuming the Esc),
   * `false` otherwise so the dispatcher falls through to the next rung.
   * Optional so tests that build options without it still compile.
   */
  onCloseInspectModal?: () => boolean;
  /**
   * ⌘P / Ctrl+P — toggle the Portfolio panel. Optional so existing tests
   * that build options without it still compile.
   */
  onTogglePortfolio?: () => void;
  /**
   * ⌘` / Ctrl+` — toggle the Terminal drawer. Optional so existing tests
   * that build options without it still compile.
   */
  onToggleTerminal?: () => void;
  /**
   * Step 9 — Backspace-delete the pinned mark/comment when the info panel is
   * pinned on one. Called only when no trend is selected (trend-delete takes
   * priority). Optional so existing tests still compile.
   * Returns `true` if a mark was deleted (key consumed), `false` to fall through.
   */
  onDeletePinnedMark?: () => boolean;
}

export function useKeyboardDispatcher(opts: KeyboardDispatcherOptions): void {
  const {
    composerOpen,
    resetComposer,
    resetView,
    onToggleSettings,
    onCloseInspectModal,
    onTogglePortfolio,
    onToggleTerminal,
    onDeletePinnedMark,
  } = opts;

  // Stable store selectors — reading these inside the effect is fine because
  // we re-attach whenever any of the opts change (composer open state).
  // Store actions are stable references (Zustand guarantees).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = isTextInput(e.target);

      // ---- ⌘K / Ctrl+K — open palette (always, even in inputs) -------------
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useAppStore.getState().setPaletteOpen(true);
        return;
      }

      // ---- ⌘, / Ctrl+, — toggle Settings panel (always, even in inputs) ---
      if (
        onToggleSettings &&
        (e.metaKey || e.ctrlKey) &&
        e.key === ','
      ) {
        e.preventDefault();
        onToggleSettings();
        return;
      }

      // ---- ⌘P / Ctrl+P — toggle Portfolio panel (always, even in inputs) ---
      if (
        onTogglePortfolio &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'p'
      ) {
        e.preventDefault();
        onTogglePortfolio();
        return;
      }

      // ---- ⌘` / Ctrl+` — toggle Terminal drawer (always, even in inputs) ---
      if (
        onToggleTerminal &&
        (e.metaKey || e.ctrlKey) &&
        e.key === '`'
      ) {
        e.preventDefault();
        onToggleTerminal();
        return;
      }

      // Everything below: skip when focused in a text field.
      // Exception: Esc runs regardless.

      // ---- Esc — precedence chain -------------------------------------------
      if (e.key === 'Escape') {
        e.preventDefault();
        const s = useAppStore.getState();
        // W2-G — Inspect-payload modal closes ahead of the composer reset so
        // that Esc dismisses the modal without also collapsing an open
        // composer in the background.
        if (onCloseInspectModal && onCloseInspectModal()) {
          return;
        }
        if (composerOpen) {
          resetComposer();
          return;
        }
        if (s.paletteOpen) {
          s.setPaletteOpen(false);
          return;
        }
        // Close the dock drawer that currently contains focus. If focus is
        // inside an open drawer's DOM (its container id === the DrawerId), close
        // that side. Otherwise fall back to the right drawer if open, else the
        // left. Generalizes the Step 2b interim rung (which only closed
        // 'indicator').
        const dock = useDockStore.getState();
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        const focusInDrawer = (id: DrawerId | null): boolean => {
          if (id === null || !active) return false;
          const el = document.getElementById(id);
          return el !== null && el.contains(active);
        };
        if (dock.openLeft !== null || dock.openRight !== null) {
          if (focusInDrawer(dock.openLeft)) {
            dock.close('left');
            return;
          }
          if (focusInDrawer(dock.openRight)) {
            dock.close('right');
            return;
          }
          // Focus isn't inside either drawer — close right first, else left.
          if (dock.openRight !== null) {
            dock.close('right');
            return;
          }
          dock.close('left');
          return;
        }
        // Drop an in-progress trend draft before clearing the range/tool —
        // the user stays in trend mode so they can start another draw, and
        // a second Esc exits the tool entirely.
        if (s.trendDraft !== null) {
          s.setTrendDraft(null);
          return;
        }
        if (s.rangeScope !== null) {
          s.setRangeScope(null);
          return;
        }
        if (s.activeTool !== 'none') {
          s.setActiveTool('none');
          return;
        }
        return;
      }

      // ---- Backspace — delete selected trend (only when one is selected) ----
      // Routed through the dispatcher (not a per-component listener) so it
      // never collides with text-field backspace — `inText` short-circuits
      // below for keys other than Esc/⌘K, but Backspace must check there
      // first before we even read the selected trend.
      if (e.key === 'Backspace' && !inText) {
        const s = useAppStore.getState();
        const id = s.selectedTrendId;
        if (id !== null) {
          e.preventDefault();
          // Optimistic local removal — fire-and-forget the SQLite delete.
          // If running outside Tauri the invoke rejects; surface a toast.
          s.setTrends(s.trends.filter((t) => t.id !== id));
          s.setSelectedTrendId(null);
          dbTrendsDelete(id).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[keyboard] dbTrendsDelete failed', err);
            void import('./useToastStore').then((m) =>
              m.useToastStore.getState().push({
                kind: 'warn',
                title: 'Trend not deleted',
                detail: 'Removed from view but the row is still on disk',
              }),
            );
          });
          return;
        }
        // Step 9 — fallback: delete the pinned mark/comment if the info panel
        // has one pinned and no trend was selected above.
        if (onDeletePinnedMark) {
          if (onDeletePinnedMark()) {
            e.preventDefault();
            return;
          }
        }
      }

      // Skip all remaining shortcuts when typing in a field.
      if (inText) return;

      const key = e.key;

      // ---- / — open palette (not in input) ----------------------------------
      if (key === '/') {
        e.preventDefault();
        useAppStore.getState().setPaletteOpen(true);
        return;
      }

      // ---- D — toggle indicators panel ----------------------------------------
      if (key === 'd' || key === 'D') {
        e.preventDefault();
        useDockStore.getState().toggle('indicator');
        return;
      }

      // ---- M — toggle mark tool ---------------------------------------------
      if (key === 'm' || key === 'M') {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setActiveTool(s.activeTool === 'mark' ? 'none' : 'mark');
        return;
      }

      // ---- C — toggle comment tool ------------------------------------------
      if (key === 'c' || key === 'C') {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setActiveTool(s.activeTool === 'comment' ? 'none' : 'comment');
        return;
      }

      // ---- S — toggle Range Scope tool --------------------------------------
      // Mirrors the M/C handlers. Reads the live action from the same Dock
      // toggle path: if rangeScope is already the active tool, deactivate;
      // otherwise activate it. The chart's interaction module reads
      // activeTool via a live ref so the next plain drag triggers a
      // range-select (no recreate of the controller needed).
      if (key === 's' || key === 'S') {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setActiveTool(s.activeTool === 'rangeScope' ? 'none' : 'rangeScope');
        return;
      }

      // ---- T — toggle Trend Line tool ---------------------------------------
      if (key === 't' || key === 'T') {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setActiveTool(s.activeTool === 'trend' ? 'none' : 'trend');
        return;
      }

      // ---- R — reset view to last 200 bars ----------------------------------
      if (key === 'r' || key === 'R') {
        e.preventDefault();
        resetView();
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    composerOpen,
    resetComposer,
    resetView,
    onToggleSettings,
    onCloseInspectModal,
    onTogglePortfolio,
    onToggleTerminal,
  ]);
}
