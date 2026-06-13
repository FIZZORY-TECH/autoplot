/**
 * Tests for StrategyArtifactPanel (Step 11b).
 *
 * CodeMirror 6 uses imperative DOM APIs that jsdom doesn't support well, so we
 * mock the `@codemirror/*` modules and focus on the panel's React behavior:
 *   - renders nothing when store is closed
 *   - renders panel when opened with a selectedId
 *   - calls db_ai_strategy_get on mount
 *   - Re-validate click calls validateStrategy
 *   - Re-backtest click calls backtestStrategy
 *   - close button calls store.close()
 *   - Apply to chart calls applyStrategyOverlay
 *   - Save button disabled when no unsaved edits
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useStrategyArtifactStore } from '../../stores/useStrategyArtifactStore';
import { useDockStore } from '../../stores/useDockStore';
import { useChartMutationStore } from '../../stores/useChartMutationStore';

// ---------------------------------------------------------------------------
// Mock CodeMirror packages BEFORE any imports that trigger them.
// Use inline factories (no top-level variable access to avoid hoisting issues).
// ---------------------------------------------------------------------------

vi.mock('@codemirror/view', () => ({
  EditorView: class MockEditorView {
    dispatch = vi.fn();
    destroy = vi.fn();
    state = { doc: { toString: () => '{"id":"strat-abc","name":"RSI Revert","version":1}', length: 50 } };
    static lineWrapping = 'lineWrapping-ext';
    static updateListener = { of: vi.fn(() => 'updateListener-ext') };
    constructor() { /* no-op */ }
  },
  lineNumbers: vi.fn(() => 'lineNumbers-ext'),
  keymap: { of: vi.fn(() => 'keymap-ext') },
}));

vi.mock('@codemirror/state', () => ({
  EditorState: {
    create: vi.fn(() => ({
      doc: { toString: () => '{"id":"strat-abc","name":"RSI Revert","version":1}', length: 50 },
    })),
    tabSize: { of: vi.fn(() => 'tabSize-ext') },
  },
}));

vi.mock('@codemirror/lang-json', () => ({ json: vi.fn(() => 'json-ext') }));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: 'oneDark-ext' }));
vi.mock('@codemirror/commands', () => ({
  defaultKeymap: [],
  history: vi.fn(() => 'history-ext'),
  historyKeymap: [],
}));

// ---------------------------------------------------------------------------
// Mock Tauri invoke (no top-level variable — access via vi.mocked)
// ---------------------------------------------------------------------------

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock tools
// ---------------------------------------------------------------------------

vi.mock('../../ai/tools/validateStrategy', () => ({
  validateStrategy: vi.fn(async () => ({ ok: true, strategy: {} })),
}));

vi.mock('../../ai/tools/backtestStrategy', () => ({
  backtestStrategy: vi.fn(async () => ({
    ok: true,
    perf: { winRate: 0.56, sharpe: 1.2, maxDrawdown: -0.08 },
    trades: [],
    equityCurve: [],
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { invoke } from '@tauri-apps/api/core';
import { StrategyArtifactPanel } from '../StrategyArtifactPanel';
import { validateStrategy } from '../../ai/tools/validateStrategy';
import { backtestStrategy } from '../../ai/tools/backtestStrategy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_ROW = {
  id: 'strat-abc',
  name: 'RSI Revert',
  body_json: '{"id":"strat-abc","name":"RSI Revert","version":1}',
  current_revision: 2,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_001_000_000,
};

// open-state lives in useDockStore ('strategy', right side); the selected
// id lives in useStrategyArtifactStore. The helpers drive both, mirroring the
// bridge (open) and the close button (clear + close dock).
function openPanel(id = 'strat-abc') {
  useStrategyArtifactStore.getState().set(id);
  useDockStore.getState().openDrawer('strategy');
}

function closePanel() {
  useStrategyArtifactStore.getState().close();
  useDockStore.getState().close('right');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StrategyArtifactPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closePanel();

    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'db_ai_strategy_get') return Promise.resolve(SAMPLE_ROW);
      if (cmd === 'db_ai_strategy_update_body')
        return Promise.resolve({ ...SAMPLE_ROW, current_revision: 3 });
      return Promise.resolve(null);
    });
  });

  it('renders nothing when store is closed', () => {
    render(<StrategyArtifactPanel />);
    expect(screen.queryByTestId('artifact-panel')).toBeNull();
  });

  it('renders the panel when opened with a selectedId', () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    expect(screen.getByTestId('artifact-panel')).toBeInTheDocument();
  });

  it('calls db_ai_strategy_get with the selectedId on mount', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('db_ai_strategy_get', { id: 'strat-abc' });
    });
  });

  it('shows the strategy name and rev badge after loading', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => {
      expect(screen.getByText('RSI Revert')).toBeInTheDocument();
      expect(screen.getByTestId('rev-badge')).toHaveTextContent('rev 2');
    });
  });

  it('Save button is disabled initially (no unsaved edits)', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => screen.getByTestId('btn-save'));
    expect(screen.getByTestId('btn-save')).toBeDisabled();
  });

  it('calls validateStrategy on Re-validate click', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => screen.getByTestId('btn-validate'));

    fireEvent.click(screen.getByTestId('btn-validate'));
    await waitFor(() => {
      expect(validateStrategy).toHaveBeenCalled();
    });
  });

  it('shows validate result in status row after re-validate', async () => {
    vi.mocked(validateStrategy).mockResolvedValueOnce({ ok: true, strategy: {} as never });
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => screen.getByTestId('btn-validate'));

    fireEvent.click(screen.getByTestId('btn-validate'));
    await waitFor(() => {
      expect(screen.getByTestId('validate-result')).toHaveTextContent('Valid');
    });
  });

  it('calls backtestStrategy on Re-backtest click', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => screen.getByTestId('btn-backtest'));

    fireEvent.click(screen.getByTestId('btn-backtest'));
    await waitFor(() => {
      expect(backtestStrategy).toHaveBeenCalled();
    });
  });

  it('close button closes the dock drawer and clears the selection', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => screen.getByTestId('artifact-close'));

    fireEvent.click(screen.getByTestId('artifact-close'));
    expect(useDockStore.getState().openRight).toBeNull();
    expect(useStrategyArtifactStore.getState().selectedId).toBeNull();
  });

  it('Apply to chart calls applyStrategyOverlay with selectedId', async () => {
    openPanel('strat-abc');
    render(<StrategyArtifactPanel />);
    await waitFor(() => screen.getByTestId('btn-apply'));

    const spy = vi.spyOn(useChartMutationStore.getState(), 'applyStrategyOverlay');
    fireEvent.click(screen.getByTestId('btn-apply'));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'strat-abc' }),
    );
  });
});
