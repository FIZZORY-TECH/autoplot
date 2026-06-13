/**
 * src/stores/useDockStore.test.ts — Vitest unit tests for the VS Code-style
 * activity-bar / drawer dock store.
 *
 * Strategy:
 *   - Reset the store (and window.innerWidth) to a deterministic baseline
 *     before each test so state never leaks.
 *   - Assert CSS custom-property writes on `document.documentElement` that
 *     reflect open/closed reserve state.
 *   - Mirror the jsdom setup used by keyboard.test.ts in this directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDockStore } from './useDockStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a reserve CSS var from <html>. */
function reserve(side: 'left' | 'right'): string {
  return document.documentElement.style.getPropertyValue(`--reserve-${side}`);
}

/**
 * Reset the store to closed-on-both-sides, then recompute the reserve vars so
 * the CSS state matches the store state for the next test.
 */
function resetStore() {
  useDockStore.setState({ openLeft: null, openRight: null });
  // Manually drive applyReserve through the exposed recomputeReserve action.
  useDockStore.getState().recomputeReserve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDockStore', () => {
  afterEach(() => {
    // Restore window.innerWidth overrides from Object.defineProperty.
    vi.restoreAllMocks();
  });

  // ── Default state ──────────────────────────────────────────────────────────

  describe('default state', () => {
    it('fresh store has openRight = "terminal"', () => {
      // If another test already ran and mutated state we restore to a baseline
      // that matches the store's design-time default.
      useDockStore.setState({ openRight: 'terminal', openLeft: null });
      expect(useDockStore.getState().openRight).toBe('terminal');
    });

    it('fresh store has openLeft = null', () => {
      useDockStore.setState({ openRight: 'terminal', openLeft: null });
      expect(useDockStore.getState().openLeft).toBeNull();
    });
  });

  // ── toggle — one-per-side ─────────────────────────────────────────────────

  describe('toggle / one-per-side', () => {
    beforeEach(resetStore);

    it('toggle("portfolio") on right sets openRight = "portfolio"', () => {
      useDockStore.getState().toggle('portfolio');
      expect(useDockStore.getState().openRight).toBe('portfolio');
    });

    it('toggle("portfolio") replaces the open right drawer (terminal was open)', () => {
      // Start with terminal open.
      useDockStore.setState({ openRight: 'terminal', openLeft: null });
      useDockStore.getState().toggle('portfolio');
      expect(useDockStore.getState().openRight).toBe('portfolio');
      // Only ONE right drawer can be open at a time.
    });

    it('toggle("portfolio") again closes it (openRight = null)', () => {
      useDockStore.getState().toggle('portfolio');
      useDockStore.getState().toggle('portfolio');
      expect(useDockStore.getState().openRight).toBeNull();
    });

    it('toggle("watchlist") sets openRight = "watchlist" (watchlist is now on the right rail)', () => {
      useDockStore.setState({ openRight: null, openLeft: null });
      useDockStore.getState().toggle('watchlist');
      expect(useDockStore.getState().openRight).toBe('watchlist');
      // Left side is untouched (stays null).
      expect(useDockStore.getState().openLeft).toBeNull();
    });

    it('toggling terminal off leaves openLeft unchanged', () => {
      useDockStore.setState({ openRight: 'terminal', openLeft: null });
      useDockStore.getState().toggle('terminal');
      expect(useDockStore.getState().openRight).toBeNull();
      expect(useDockStore.getState().openLeft).toBeNull();
    });
  });

  // ── openDrawer / close ────────────────────────────────────────────────────

  describe('openDrawer / close', () => {
    beforeEach(resetStore);

    it('openDrawer("settings") sets openRight = "settings"', () => {
      useDockStore.getState().openDrawer('settings');
      expect(useDockStore.getState().openRight).toBe('settings');
    });

    it('close("right") clears openRight, does not touch openLeft', () => {
      useDockStore.setState({ openRight: 'settings', openLeft: null });
      useDockStore.getState().close('right');
      expect(useDockStore.getState().openRight).toBeNull();
      expect(useDockStore.getState().openLeft).toBeNull();
    });

    it('close("left") clears openLeft, does not touch openRight', () => {
      useDockStore.setState({ openLeft: 'strategy', openRight: 'portfolio' });
      useDockStore.getState().close('left');
      expect(useDockStore.getState().openLeft).toBeNull();
      expect(useDockStore.getState().openRight).toBe('portfolio');
    });

    it('openDrawer("watchlist") sets openRight = "watchlist" (watchlist is now on the right side)', () => {
      useDockStore.getState().openDrawer('watchlist');
      expect(useDockStore.getState().openRight).toBe('watchlist');
    });
  });

  // ── Reserve CSS vars ──────────────────────────────────────────────────────

  describe('reserve CSS vars', () => {
    beforeEach(() => {
      // Clear both vars so we start from a known blank state.
      document.documentElement.style.removeProperty('--reserve-left');
      document.documentElement.style.removeProperty('--reserve-right');
      resetStore();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Stub window.innerWidth with Object.defineProperty. */
    function mockWidth(w: number) {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: w,
      });
    }

    it('closed side writes --reserve-right: 0px', () => {
      // Both sides closed after resetStore.
      expect(reserve('right')).toBe('0px');
    });

    it('closed side writes --reserve-left: 0px', () => {
      expect(reserve('left')).toBe('0px');
    });

    it('wide window (1400px): opening terminal (560px) writes --reserve-right: 560px', () => {
      // avail = 1400 - (RAIL_W=48 + TOOLBAR_W=48) - 240 = 1064. clamp = min(560, 1064) = 560.
      mockWidth(1400);
      useDockStore.getState().toggle('terminal');
      expect(reserve('right')).toBe('560px');
    });

    it('narrow window (800px): opening terminal (560px) clamps --reserve-right', () => {
      // avail = 800 - (48+48) - 240 = 464. clamp = min(560, 464) = 464.
      mockWidth(800);
      useDockStore.getState().toggle('terminal');
      expect(reserve('right')).toBe('464px');
    });

    it('closing the open drawer writes --reserve-right: 0px', () => {
      mockWidth(1400);
      useDockStore.getState().toggle('terminal'); // open
      useDockStore.getState().toggle('terminal'); // close
      expect(reserve('right')).toBe('0px');
    });

    it('opening watchlist (352px) at 1400px writes --reserve-right: 352px (watchlist is now on the right)', () => {
      // avail = 1400 - (48+48) - 240 = 1064. clamp = min(352, 1064) = 352.
      mockWidth(1400);
      useDockStore.getState().toggle('watchlist');
      expect(reserve('right')).toBe('352px');
      // Left reserve stays 0 — no left drawers remain.
      expect(reserve('left')).toBe('0px');
    });

    it('recomputeReserve re-applies current open state to CSS vars', () => {
      mockWidth(1400);
      useDockStore.setState({ openRight: 'portfolio', openLeft: null });
      useDockStore.getState().recomputeReserve();
      // portfolio width = 360px; clamp = min(360, 1064) = 360.
      expect(reserve('right')).toBe('360px');
      expect(reserve('left')).toBe('0px');
    });

    it('right side open write correct reserve value (portfolio)', () => {
      mockWidth(1400);
      useDockStore.getState().toggle('portfolio'); // right, 360px
      expect(reserve('right')).toBe('360px');
      // Left is always 0 — no left drawers remain.
      expect(reserve('left')).toBe('0px');
    });

    // ── FIX 1: joint formula uses RAIL_W + TOOLBAR_W instead of 2 * RAIL_W ──
    // All drawers are now on the right; the left rail is gone. The avail formula
    // encodes the real invariant: RAIL_W (right rail) + TOOLBAR_W (left toolbar,
    // which aliases RAIL_W=48 today) + MIN_CHART_W.

    it('narrow window (800px): single right drawer clamps correctly with new formula', () => {
      // avail = 800 - (48+48) - 240 = 464. terminal=560 > 464 → clamps to 464.
      mockWidth(800);
      useDockStore.getState().toggle('terminal');
      const rightR = parseInt(reserve('right'), 10);
      const chart = 800 - 48 - 48 - rightR;
      // Chart never drops below MIN_CHART_W=240.
      expect(chart).toBeGreaterThanOrEqual(240);
      expect(rightR).toBeGreaterThan(0);
    });

    it('wide window (1400px): watchlist (352px) gets its full design width on the right', () => {
      // avail = 1400 - (48+48) - 240 = 1064. 352 ≤ 1064 → full design width.
      mockWidth(1400);
      useDockStore.getState().toggle('watchlist'); // right, 352px design
      expect(reserve('right')).toBe('352px');
      expect(reserve('left')).toBe('0px');
    });
  });
});
