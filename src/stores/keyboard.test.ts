/**
 * src/stores/keyboard.test.ts — Vitest unit tests for the unified keyboard dispatcher.
 *
 * Strategy:
 *   1. Render the hook via renderHook (jsdom environment).
 *   2. Fire simulated KeyboardEvent on `window`.
 *   3. Assert the correct Zustand store action was called.
 *
 * The store is reset before each test so state doesn't leak between cases.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardDispatcher, isTextInput } from './keyboard';
import { useAppStore } from './useAppStore';
import { useDockStore } from './useDockStore';

// Step 4 — mock the Tauri db module so the Backspace → dbTrendsDelete path
// runs without needing a real Tauri runtime in jsdom.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return { ...actual, dbTrendsDelete: vi.fn().mockResolvedValue(undefined) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a keydown event on window with given properties. */
function fire(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
  target: EventTarget = window,
): void {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  // Override target for the isTextInput helper tests
  if (target !== window) {
    Object.defineProperty(ev, 'target', { value: target, configurable: true });
    target.dispatchEvent(ev);
  } else {
    window.dispatchEvent(ev);
  }
}

/** Reset the Zustand stores to a predictable baseline before each test. */
function resetStore() {
  useAppStore.setState({
    paletteOpen: false,
    activeTool: 'none',
    rangeScope: null,
    trends: [],
    trendDraft: null,
    selectedTrendId: null,
  });
  // Step 2b — drawer open-state now lives in useDockStore. Reset both sides
  // to closed so the 'indicator' (indicators) assertions start clean (the store
  // defaults openRight to 'terminal').
  useDockStore.setState({ openLeft: null, openRight: null });
}

/** Default hook options with spy callbacks. */
function makeOpts(overrides: Partial<Parameters<typeof useKeyboardDispatcher>[0]> = {}) {
  return {
    composerOpen: false,
    resetComposer: vi.fn(),
    resetView: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isTextInput helper
// ---------------------------------------------------------------------------

describe('isTextInput', () => {
  it('returns false for null', () => {
    expect(isTextInput(null)).toBe(false);
  });

  it('returns true for INPUT', () => {
    const el = document.createElement('input');
    expect(isTextInput(el)).toBe(true);
  });

  it('returns true for TEXTAREA', () => {
    const el = document.createElement('textarea');
    expect(isTextInput(el)).toBe(true);
  });

  it('returns true for contenteditable div', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    expect(isTextInput(el)).toBe(true);
  });

  it('returns false for a regular div', () => {
    const el = document.createElement('div');
    expect(isTextInput(el)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keyboard dispatcher
// ---------------------------------------------------------------------------

describe('useKeyboardDispatcher', () => {
  beforeEach(() => {
    resetStore();
  });

  // ── ⌘K / Ctrl+K ────────────────────────────────────────────────────────

  it('Ctrl+K opens palette', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('k', { ctrlKey: true });

    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it('⌘K (metaKey) opens palette', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('k', { metaKey: true });

    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it('⌘K works even when focused in an input', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    // Simulate event with target = input element
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    // Dispatch via window (target will be the input since it's focused)
    fire('k', { ctrlKey: true });

    expect(useAppStore.getState().paletteOpen).toBe(true);
    document.body.removeChild(input);
  });

  // ── / opens palette ─────────────────────────────────────────────────────

  it('/ opens palette when not in text input', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('/');

    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it('/ does NOT open palette when focused in input', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    // focus an input so e.target is the input element
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    // Fire on the input directly so the event's target is the input
    const ev = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);

    expect(useAppStore.getState().paletteOpen).toBe(false);
    document.body.removeChild(input);
  });

  // ── D — indicators panel ─────────────────────────────────────────────────

  it('D toggles indicators panel on', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('D');

    expect(useDockStore.getState().openRight).toBe('indicator');
  });

  it('D toggles indicators panel off when already open', () => {
    useDockStore.setState({ openRight: 'indicator' });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('D');

    expect(useDockStore.getState().openRight).toBeNull();
  });

  it('lowercase d also toggles indicators panel', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('d');

    expect(useDockStore.getState().openRight).toBe('indicator');
  });

  // ── M — mark tool ────────────────────────────────────────────────────────

  it('M activates mark tool when tool is none', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('M');

    expect(useAppStore.getState().activeTool).toBe('mark');
  });

  it('M deactivates mark tool when tool is already mark', () => {
    useAppStore.setState({ activeTool: 'mark' });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('M');

    expect(useAppStore.getState().activeTool).toBe('none');
  });

  it('lowercase m also toggles mark tool', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('m');

    expect(useAppStore.getState().activeTool).toBe('mark');
  });

  // ── C — comment tool ─────────────────────────────────────────────────────

  it('C activates comment tool when tool is none', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('C');

    expect(useAppStore.getState().activeTool).toBe('comment');
  });

  it('C deactivates comment tool when tool is already comment', () => {
    useAppStore.setState({ activeTool: 'comment' });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('C');

    expect(useAppStore.getState().activeTool).toBe('none');
  });

  it('lowercase c also toggles comment tool', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('c');

    expect(useAppStore.getState().activeTool).toBe('comment');
  });

  // ── S — Range Scope tool (Step 4) ────────────────────────────────────────

  it('S activates rangeScope tool when tool is none', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('S');

    expect(useAppStore.getState().activeTool).toBe('rangeScope');
  });

  it('S deactivates rangeScope tool when already active', () => {
    useAppStore.setState({ activeTool: 'rangeScope' });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('s');

    expect(useAppStore.getState().activeTool).toBe('none');
  });

  // ── T — Trend Line tool (Step 4) ─────────────────────────────────────────

  it('T activates trend tool when tool is none', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('T');

    expect(useAppStore.getState().activeTool).toBe('trend');
  });

  it('T deactivates trend tool when already active', () => {
    useAppStore.setState({ activeTool: 'trend' });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('t');

    expect(useAppStore.getState().activeTool).toBe('none');
  });

  // ── Backspace — delete selected trend (Step 4) ───────────────────────────

  it('Backspace deletes the selected trend optimistically', async () => {
    const trend = {
      id: 'tx',
      sym: 'BTC',
      provider: 'coinbase',
      quote: 'USD',
      tf: '1h',
      x1_ts: 1, y1_price: 1, x2_ts: 2, y2_price: 2,
      color: 'accent', created_at: 0,
    };
    useAppStore.setState({ trends: [trend], selectedTrendId: 'tx' });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Backspace');

    expect(useAppStore.getState().trends).toEqual([]);
    expect(useAppStore.getState().selectedTrendId).toBeNull();
  });

  it('Backspace is a no-op when no trend is selected', () => {
    useAppStore.setState({ trends: [], selectedTrendId: null });
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    // Should not throw and store stays empty.
    fire('Backspace');

    expect(useAppStore.getState().trends).toEqual([]);
  });

  // ── Esc precedence: trendDraft (Step 4 — between indicators panel + range) ─

  it('Esc drops in-progress trend draft (step 4) before clearing rangeScope', () => {
    useAppStore.setState({
      paletteOpen: false,
      trendDraft: { x1_ts: 1, y1_price: 1, x2_ts: 2, y2_price: 2 },
      rangeScope: { start: 0, end: 5 },
      activeTool: 'trend',
    });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    expect(useAppStore.getState().trendDraft).toBeNull();
    // Trend tool stays active; rangeScope untouched (would only clear on
    // the *next* Esc when no draft exists).
    expect(useAppStore.getState().activeTool).toBe('trend');
    expect(useAppStore.getState().rangeScope).not.toBeNull();
  });

  // ── R — reset view ───────────────────────────────────────────────────────

  it('R calls resetView callback', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('R');

    expect(opts.resetView).toHaveBeenCalledOnce();
  });

  it('lowercase r also calls resetView', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    fire('r');

    expect(opts.resetView).toHaveBeenCalledOnce();
  });

  it('R does not fire when focused in textarea', () => {
    const opts = makeOpts();
    renderHook(() => useKeyboardDispatcher(opts));

    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);

    expect(opts.resetView).not.toHaveBeenCalled();
    document.body.removeChild(ta);
  });

  // ── Esc precedence chain ─────────────────────────────────────────────────

  it('Esc closes composer first (step 1)', () => {
    useAppStore.setState({ paletteOpen: true, activeTool: 'mark', rangeScope: { start: 0, end: 10 } });
    useDockStore.setState({ openRight: 'indicator' });
    const opts = makeOpts({ composerOpen: true });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    expect(opts.resetComposer).toHaveBeenCalledOnce();
    // Other states untouched (composer closed first)
    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it('Esc closes palette when composer not open (step 2)', () => {
    useAppStore.setState({ paletteOpen: true, activeTool: 'mark' });
    useDockStore.setState({ openRight: 'indicator' });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    expect(opts.resetComposer).not.toHaveBeenCalled();
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(useDockStore.getState().openRight).toBe('indicator'); // untouched
  });

  it('Esc closes indicators panel when palette is closed (step 3)', () => {
    useAppStore.setState({ paletteOpen: false, activeTool: 'mark' });
    useDockStore.setState({ openRight: 'indicator' });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    expect(useDockStore.getState().openRight).toBeNull();
    expect(useAppStore.getState().activeTool).toBe('mark'); // untouched
  });

  it('Esc clears rangeScope when indicators panel is closed (step 4)', () => {
    useAppStore.setState({ paletteOpen: false, rangeScope: { start: 5, end: 20 }, activeTool: 'mark' });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    expect(useAppStore.getState().rangeScope).toBeNull();
    expect(useAppStore.getState().activeTool).toBe('mark'); // untouched
  });

  it('Esc sets activeTool to none when no other surface is open (step 5)', () => {
    useAppStore.setState({ paletteOpen: false, rangeScope: null, activeTool: 'mark' });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    expect(useAppStore.getState().activeTool).toBe('none');
  });

  it('Esc fires even when focused in textarea', () => {
    useAppStore.setState({ paletteOpen: true });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);

    // Esc should close palette even though we're in a textarea
    expect(useAppStore.getState().paletteOpen).toBe(false);
    document.body.removeChild(ta);
  });

  it('Esc does nothing when all surfaces are already closed/none', () => {
    useAppStore.setState({ paletteOpen: false, rangeScope: null, activeTool: 'none' });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('Escape');

    // Should not throw; state remains the same
    expect(useAppStore.getState().activeTool).toBe('none');
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  // ── ⌘` / Ctrl+` — toggle Terminal drawer ─────────────────────────────────

  it('Ctrl+` toggles the terminal drawer via onToggleTerminal', () => {
    const onToggleTerminal = vi.fn();
    const opts = makeOpts({ onToggleTerminal });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('`', { ctrlKey: true });

    expect(onToggleTerminal).toHaveBeenCalledOnce();
  });

  it('Meta+` toggles the terminal drawer even when focused in an input', () => {
    const onToggleTerminal = vi.fn();
    const opts = makeOpts({ onToggleTerminal });
    renderHook(() => useKeyboardDispatcher(opts));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fire('`', { metaKey: true }, input);

    expect(onToggleTerminal).toHaveBeenCalledOnce();
    document.body.removeChild(input);
  });

  it('bare ` (no modifier) does NOT toggle the terminal drawer', () => {
    const onToggleTerminal = vi.fn();
    const opts = makeOpts({ onToggleTerminal });
    renderHook(() => useKeyboardDispatcher(opts));

    fire('`');

    expect(onToggleTerminal).not.toHaveBeenCalled();
  });

  // ── Esc — generalized dock-drawer close (focus-aware) ─────────────────────

  it('Esc closes the LEFT drawer when focus is inside its DOM', () => {
    useDockStore.setState({ openLeft: 'strategy', openRight: 'terminal' });
    // Build a DOM element with id === the drawer id and put focus inside it.
    const drawer = document.createElement('div');
    drawer.id = 'strategy';
    const focusable = document.createElement('button');
    drawer.appendChild(focusable);
    document.body.appendChild(drawer);
    focusable.focus();

    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));
    fire('Escape');

    expect(useDockStore.getState().openLeft).toBeNull();
    expect(useDockStore.getState().openRight).toBe('terminal'); // untouched
    document.body.removeChild(drawer);
  });

  it('Esc falls back to closing the RIGHT drawer when focus is outside both', () => {
    useDockStore.setState({ openLeft: 'strategy', openRight: 'terminal' });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));
    fire('Escape');

    // Focus isn't inside either drawer → close right first.
    expect(useDockStore.getState().openRight).toBeNull();
    expect(useDockStore.getState().openLeft).toBe('strategy'); // untouched
  });

  it('Esc closes the LEFT drawer when only the left is open', () => {
    useDockStore.setState({ openLeft: 'watchlist', openRight: null });
    const opts = makeOpts({ composerOpen: false });
    renderHook(() => useKeyboardDispatcher(opts));
    fire('Escape');

    expect(useDockStore.getState().openLeft).toBeNull();
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────

  it('removes the listener on unmount (no double-fire after unmount)', () => {
    const opts = makeOpts();
    const { unmount } = renderHook(() => useKeyboardDispatcher(opts));
    unmount();

    fire('D');

    // D was fired after unmount — store should remain untouched
    expect(useDockStore.getState().openRight).toBeNull();
  });
});
