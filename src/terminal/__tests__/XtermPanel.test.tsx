/**
 * src/terminal/__tests__/XtermPanel.test.tsx
 *
 * Vitest + @testing-library/react tests for XtermPanel.tsx.
 *
 * Test strategy:
 *   - Browser-mode (no __TAURI__): placeholder is rendered; dynamic
 *     import('@xterm/xterm') is NEVER called.
 *   - Tauri-mode mount: xterm Terminal.open and openTerminal are called;
 *     handle.on is wired for 'data' and 'exit'.
 *   - Cleanup: unmount triggers handle.dispose() before term.dispose().
 *   - Paste shortcut: Cmd/Ctrl-V calls clipboard.readText() + handle.write().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock openTerminal
// ---------------------------------------------------------------------------

const mockHandleDispose = vi.fn().mockResolvedValue(undefined);
const mockHandleWrite = vi.fn().mockResolvedValue(undefined);
const mockHandleResize = vi.fn().mockResolvedValue(undefined);
const mockHandleOn = vi.fn().mockReturnValue(() => undefined);

const mockHandle = {
  sessionId: 'test-session',
  write: mockHandleWrite,
  resize: mockHandleResize,
  kill: vi.fn().mockResolvedValue(undefined),
  on: mockHandleOn,
  dispose: mockHandleDispose,
};

const mockOpenTerminal = vi.fn().mockResolvedValue(mockHandle);

vi.mock('../terminalClient', () => ({
  openTerminal: (...args: unknown[]) => mockOpenTerminal(...args),
}));

// ---------------------------------------------------------------------------
// Stub xterm classes (shared across dynamic import mocks)
// ---------------------------------------------------------------------------

const mockTermDispose = vi.fn();
const mockTermOpen = vi.fn();
const mockTermWrite = vi.fn();
const mockTermLoadAddon = vi.fn();
const mockTermOnData = vi.fn();
const mockTermOnSelectionChange = vi.fn();
const mockTermAttachCustomKeyEventHandler = vi.fn();
const mockTermHasSelection = vi.fn().mockReturnValue(false);
const mockTermGetSelection = vi.fn().mockReturnValue('');
const mockFitFit = vi.fn();

class StubTerminal {
  cols = 80;
  rows = 24;
  open = mockTermOpen;
  dispose = mockTermDispose;
  write = mockTermWrite;
  loadAddon = mockTermLoadAddon;
  onData = mockTermOnData;
  onSelectionChange = mockTermOnSelectionChange;
  attachCustomKeyEventHandler = mockTermAttachCustomKeyEventHandler;
  hasSelection = mockTermHasSelection;
  getSelection = mockTermGetSelection;
}

class StubFitAddon {
  fit = mockFitFit;
}

class StubWebLinksAddon {}

// ---------------------------------------------------------------------------
// Mock dynamic imports (must be done via vi.mock at module scope)
// ---------------------------------------------------------------------------

vi.mock('@xterm/xterm', () => {
  return { Terminal: StubTerminal };
});

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: StubFitAddon,
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: StubWebLinksAddon,
}));

// ---------------------------------------------------------------------------
// Mock ResizeObserver (jsdom doesn't implement it)
// ---------------------------------------------------------------------------

const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

class MockResizeObserver {
  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = vi.fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setTauriPresent(present: boolean) {
  // The runtime check accepts either marker; install both for the positive
  // case and clear both for the negative case so the test can't drift past
  // a future v1/v2 detection refactor.
  const keys = ['__TAURI__', '__TAURI_INTERNALS__'] as const;
  if (present) {
    for (const k of keys) {
      Object.defineProperty(window, k, {
        value: {},
        configurable: true,
        writable: true,
      });
    }
  } else {
    for (const k of keys) {
      try {
        // @ts-expect-error -- intentional deletion for testing
        delete window[k];
      } catch (_) {
        Object.defineProperty(window, k, {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('XtermPanel — browser-mode (no __TAURI__)', () => {
  beforeEach(() => {
    setTauriPresent(false);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setTauriPresent(false);
  });

  it('renders placeholder text when __TAURI__ is absent', async () => {
    const { XtermPanel } = await import('../XtermPanel');
    render(<XtermPanel />);
    expect(
      screen.getByText(/Terminal mode requires the desktop runtime/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Launch the Tauri app to use the Claude TUI/i),
    ).toBeTruthy();
  });

  it('does NOT call openTerminal in browser mode', async () => {
    const { XtermPanel } = await import('../XtermPanel');
    render(<XtermPanel />);
    // Wait a tick in case anything async fires
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(mockOpenTerminal).not.toHaveBeenCalled();
  });
});

describe('XtermPanel — Tauri mode (mount + wiring)', () => {
  beforeEach(() => {
    setTauriPresent(true);
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = MockResizeObserver;
    mockFitFit.mockReset();
    mockTermOpen.mockReset();
    mockHandleOn.mockReturnValue(() => undefined);
    mockHandleDispose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setTauriPresent(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  });

  it('calls Terminal.open and openTerminal on mount', async () => {
    const { XtermPanel } = await import('../XtermPanel');

    await act(async () => {
      render(<XtermPanel cwd="/tmp" />);
      // Let async setup() settle
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mockTermOpen).toHaveBeenCalledTimes(1);
    expect(mockOpenTerminal).toHaveBeenCalledTimes(1);
    expect(mockOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('wires handle.on for data and exit events', async () => {
    const { XtermPanel } = await import('../XtermPanel');

    await act(async () => {
      render(<XtermPanel />);
      await new Promise((r) => setTimeout(r, 20));
    });

    const onCalls = mockHandleOn.mock.calls.map((c) => c[0] as string);
    expect(onCalls).toContain('data');
    expect(onCalls).toContain('exit');
  });

  it('calls handle.dispose() before term.dispose() on unmount', async () => {
    const { XtermPanel } = await import('../XtermPanel');
    const callOrder: string[] = [];

    mockHandleDispose.mockImplementation(async () => {
      callOrder.push('handle.dispose');
    });
    mockTermDispose.mockImplementation(() => {
      callOrder.push('term.dispose');
    });

    let unmount: () => void;
    await act(async () => {
      const result = render(<XtermPanel />);
      unmount = result.unmount;
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      unmount!();
      // Allow async handle.dispose() to settle
      await new Promise((r) => setTimeout(r, 20));
    });

    // Both should have been called
    expect(callOrder).toContain('handle.dispose');
    expect(callOrder).toContain('term.dispose');
    // handle.dispose comes first
    expect(callOrder.indexOf('handle.dispose')).toBeLessThan(
      callOrder.indexOf('term.dispose'),
    );
  });

  it('calls onExit callback when exit event fires', async () => {
    const { XtermPanel } = await import('../XtermPanel');
    const onExitSpy = vi.fn();

    // Capture the exit handler so we can call it manually
    let exitHandler: ((e: { sessionId: string; code: number }) => void) | null = null;
    mockHandleOn.mockImplementation((event: string, cb: (e: unknown) => void) => {
      if (event === 'exit') exitHandler = cb as typeof exitHandler;
      return () => undefined;
    });

    await act(async () => {
      render(<XtermPanel onExit={onExitSpy} />);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(exitHandler).not.toBeNull();

    await act(async () => {
      exitHandler!({ sessionId: 'test-session', code: 0 });
    });

    expect(onExitSpy).toHaveBeenCalledWith(0);
  });
});
