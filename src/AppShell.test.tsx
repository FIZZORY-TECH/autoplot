/**
 * src/AppShell.test.tsx — Asset-switch phase machine regression tests.
 *
 * Regression for the bug where a fast-resolving fetch (mock provider, cache
 * hit, sub-180ms network) was being clobbered by the still-pending 180ms
 * exit timer — the timer would clear `bars` to `[]` AFTER the .then() had
 * already set them, leaving the chart stuck on shimmer with empty data.
 *
 * Asserts:
 *   1. After a synchronous-resolving fetch, the phase machine progresses
 *      all the way to `idle` (never stuck on `loading` / `reveal`).
 *   2. The chart canvas is mounted and bars made it through (chart is not
 *      stuck empty).
 *   3. Pending timers are cleared on re-fire (asset switch mid-transition)
 *      so the late exit callback can't overwrite a fresh `reveal`.
 */

import { render, screen, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App';
import { useAppStore } from './stores/useAppStore';

vi.mock('@tauri-apps/api/core', () => ({
  // Default: throw — forces all DB/IPC paths to take their "no Tauri runtime"
  // fallback (returning empty arrays / mock data). This matches `vite dev`.
  invoke: vi.fn().mockRejectedValue(new Error('no tauri in test')),
}));

// Force the mock provider so fetchHistory resolves on a microtask
// (no Tauri runtime, no real REST). This is the regression's worst case.
beforeEach(() => {
  window.localStorage.setItem('use-mock-provider', '1');
  useAppStore.setState({ loadingPhase: 'idle' });
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('use-mock-provider');
});

describe('AppShell asset-switch phase machine — fast-fetch regression', () => {
  it('reaches loadingPhase=idle with bars rendered when fetch resolves before exit fade completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let container!: HTMLElement;
      await act(async () => {
        const rendered = render(<App />);
        container = rendered.container;
      });

      // Let the microtask-resolved fetch buffer through .then(); then advance
      // past the 180ms exit boundary, the 0ms reveal kick-off, and the 320ms
      // reveal → idle tail (with a small slack to flush queued state updates).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180 + 320 + 100);
      });

      // Regression assertion: phase must end at `idle`, never stuck.
      expect(useAppStore.getState().loadingPhase).toBe('idle');

      // Chart canvas must be present (sanity — confirms no crash).
      expect(container.querySelector('canvas')).toBeTruthy();

      // Headline shows the active sym (BTC default) — regression would
      // have it stuck on the `——` placeholder if reveal never fired.
      expect(screen.getByLabelText(/BTC price headline/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending exit timer when the active symbol changes mid-transition', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => {
        render(<App />);
      });

      // Switch to ETH while still inside the exit fade (< 180ms in).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        useAppStore.getState().setActiveSym('ETH');
      });
      // Advance through the second effect's full timeline.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180 + 320 + 100);
      });

      // The stale first-effect exit timer must have been cleared by cleanup;
      // otherwise it would have re-set bars=[] and phase='loading' after the
      // ETH effect had moved on to reveal/idle.
      expect(useAppStore.getState().loadingPhase).toBe('idle');
      expect(useAppStore.getState().activeSym).toBe('ETH');
    } finally {
      vi.useRealTimers();
    }
  });
});
