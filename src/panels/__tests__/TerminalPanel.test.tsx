/**
 * src/panels/__tests__/TerminalPanel.test.tsx — Step 12 vitest cases.
 *
 * Step 2b: open-state migrated from the deleted `useTerminalStore` to
 * `useDockStore` (the 'terminal' drawer on the right side). The close button
 * now closes the right dock side.
 *
 * Post-dock-port: TerminalPanel wraps XtermPanel in DockDrawer(mountOnOpen).
 * AppShell mounts TerminalPanel unconditionally; DockDrawer gates child
 * mounting via the `open` prop (derived from useDockStore openRight).
 *
 * Covers:
 *   1. Drawer closed → DockDrawer children (XtermPanel) not mounted.
 *   2. Drawer open → header text "Terminal" appears.
 *   3. Drawer open → subtitle "(Claude CLI)" appears.
 *   4. Close button click → the right dock drawer closes.
 *
 * XtermPanel is mocked at the module level so the test doesn't load xterm
 * or try to connect to the Tauri runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDockStore } from '../../stores/useDockStore';

// ---------------------------------------------------------------------------
// Mock XtermPanel — prevents xterm.js / Tauri import in jsdom.
// ---------------------------------------------------------------------------

vi.mock('../../terminal/XtermPanel', () => ({
  XtermPanel: () => <div data-testid="xterm-panel-mock" />,
}));

// ---------------------------------------------------------------------------
// Component under test (imported after mock is set up).
// ---------------------------------------------------------------------------

import { TerminalPanel } from '../TerminalPanel';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalPanel', () => {
  beforeEach(() => {
    useDockStore.setState({ openLeft: null, openRight: null });
  });

  it('1. does not render XtermPanel when drawer is closed', () => {
    // TerminalPanel is always mounted (AppShell mounts it unconditionally).
    // DockDrawer(mountOnOpen) only mounts children while the drawer is open.
    render(<TerminalPanel />);
    expect(screen.queryByTestId('xterm-panel-mock')).toBeNull();
  });

  it('2. renders "Terminal" heading when drawer is open', () => {
    useDockStore.setState({ openRight: 'terminal' });
    render(<TerminalPanel />);
    expect(screen.getByText('Terminal')).toBeDefined();
  });

  it('3. renders "(Claude CLI)" subtitle when drawer is open', () => {
    useDockStore.setState({ openRight: 'terminal' });
    render(<TerminalPanel />);
    expect(screen.getByText('(Claude CLI)')).toBeDefined();
  });

  it('4. close button click closes the right dock drawer', () => {
    useDockStore.setState({ openRight: 'terminal' });
    render(<TerminalPanel />);
    const closeBtn = screen.getByRole('button', { name: /close terminal panel/i });
    fireEvent.click(closeBtn);
    expect(useDockStore.getState().openRight).toBeNull();
  });
});
