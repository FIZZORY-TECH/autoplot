/**
 * src/panels/StrategyArtifactPanel.tsx — Step 11b
 *
 * Floating Claude-Artifacts-style editor for the Strategy DSL.
 * Opened by Claude via `open_strategy_artifact(id)` MCP call
 * or programmatically via `useStrategyArtifactStore.set(id)`.
 *
 * Position: bottom-left (18px from left, 18px from bottom).
 * TerminalPanel occupies bottom-center; AgentsPanel/SettingsPanel right-edge;
 * AssetPanel is a draggable left-side card anchored near the top-left — the
 * bottom-left slot is free for this panel.
 *
 * Default size: 720 × 520px (min 480 × 360).
 *
 * CodeMirror 6 extensions used:
 *   - json() language
 *   - oneDark theme
 *   - lineNumbers()
 *   - EditorView.lineWrapping
 *   - history() + historyKeymap
 *   - defaultKeymap (movement, selection, etc.)
 *
 * The editor is mounted imperatively in a useEffect that reads `editorRef`.
 * On unmount the view is destroyed. On `selectedId` change the content is
 * replaced by dispatching a full-document replacement transaction.
 *
 * Strategy storage:
 *   The `selectedId` refers to a row in the `ai_strategies` table (managed by
 *   `ai_workspace.rs`), exposed via the new Tauri commands
 *   `db_ai_strategy_get` and `db_ai_strategy_update_body`.
 *   In browser-only dev (no Tauri runtime) these calls reject gracefully.
 *
 * Toolbar actions:
 *   Save          — validate JSON, call db_ai_strategy_update_body, bump rev badge.
 *   Re-validate   — parse JSON, run validateStrategy, show result.
 *   Re-backtest   — parse JSON, run backtestStrategy, show perf summary.
 *   Apply to chart — call useChartMutationStore.applyStrategyOverlay().
 *   Discard       — revert editor to last saved body.
 *
 * ADR-0004: glass tokens only. ADR-0005: save writes a new revision row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useStrategyArtifactStore } from '../stores/useStrategyArtifactStore';
import { useDockStore } from '../stores/useDockStore';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import { validateStrategy } from '../ai/tools/validateStrategy';
import { backtestStrategy } from '../ai/tools/backtestStrategy';
import { useAppStore } from '../stores/useAppStore';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

interface AiStrategyRow {
  id: string;
  name: string;
  body_json: string;
  current_revision: number;
  created_at: number;
  updated_at: number;
}

async function dbAiStrategyGet(id: string): Promise<AiStrategyRow | null> {
  return invoke<AiStrategyRow | null>('db_ai_strategy_get', { id });
}

async function dbAiStrategyUpdateBody(
  id: string,
  newBodyJson: string,
): Promise<AiStrategyRow> {
  return invoke<AiStrategyRow>('db_ai_strategy_update_body', { id, newBodyJson });
}

// ---------------------------------------------------------------------------
// Busy state — which operation is in-flight
// ---------------------------------------------------------------------------

type BusyOp = 'save' | 'validate' | 'backtest' | null;

// ---------------------------------------------------------------------------
// StrategyArtifactPanel
// ---------------------------------------------------------------------------

export function StrategyArtifactPanel(): JSX.Element {
  // Open-state derives from useDockStore ('strategy', right side); the selected
  // id still lives in this panel's own store. DockDrawer gates mount on both.
  const openRight = useDockStore((s) => s.openRight);
  const selectedId = useStrategyArtifactStore((s) => s.selectedId);
  // Close clears the selection AND closes the dock drawer.
  const close = useCallback(() => {
    useStrategyArtifactStore.getState().close();
    useDockStore.getState().close('right');
  }, []);

  const activeSym = useAppStore((s) => s.activeSym ?? 'BTC');
  const tf = useAppStore((s) => s.tf ?? '1h');

  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const [strategyName, setStrategyName] = useState<string>('');
  const [revision, setRevision] = useState<number>(0);
  const [lastSaved, setLastSaved] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<string | null>(null);
  const [backtestSummary, setBacktestSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyOp>(null);
  const [isDirty, setIsDirty] = useState(false);

  // ------------------------------------------------------------------
  // Build and mount the CodeMirror editor once
  // ------------------------------------------------------------------
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        setIsDirty(true);
        setParseError(null);
      }
    });

    const state = EditorState.create({
      doc: '',
      extensions: [
        json(),
        oneDark,
        lineNumbers(),
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorState.tabSize.of(2),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: el });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // ------------------------------------------------------------------
  // Load strategy when selectedId changes
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!selectedId) {
      setStrategyName('');
      setRevision(0);
      setLastSaved('');
      setIsDirty(false);
      setParseError(null);
      setValidateResult(null);
      setBacktestSummary(null);
      replaceContent('');
      return;
    }

    let cancelled = false;
    dbAiStrategyGet(selectedId)
      .then((row) => {
        if (cancelled) return;
        if (!row) {
          setStrategyName('[not found]');
          setRevision(0);
          setLastSaved('{}');
          replaceContent('{}');
          return;
        }
        setStrategyName(row.name);
        setRevision(row.current_revision);
        setLastSaved(row.body_json);
        setIsDirty(false);
        setParseError(null);
        setValidateResult(null);
        setBacktestSummary(null);
        replaceContent(row.body_json);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('[StrategyArtifactPanel] db_ai_strategy_get failed', err);
        // Fall back gracefully in browser-only dev mode.
        setStrategyName('[dev mode]');
        setRevision(0);
        setLastSaved('{}');
        replaceContent('{}');
      });

    return () => { cancelled = true; };
  }, [selectedId]);

  // Helper — replace full editor content.
  function replaceContent(text: string) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
    setIsDirty(false);
  }

  // Helper — get current editor content.
  function currentContent(): string {
    const view = viewRef.current;
    if (!view) return '';
    return view.state.doc.toString();
  }

  // Helper — try to parse current content as JSON. Sets parseError on failure.
  function tryParse(): unknown | undefined {
    const text = currentContent();
    try {
      const parsed: unknown = JSON.parse(text);
      setParseError(null);
      return parsed;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  // ------------------------------------------------------------------
  // Toolbar handlers
  // ------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!selectedId || busy) return;
    const parsed = tryParse();
    if (parsed === undefined) return;
    const text = currentContent();
    setBusy('save');
    try {
      const updated = await dbAiStrategyUpdateBody(selectedId, text);
      setRevision(updated.current_revision);
      setLastSaved(text);
      setIsDirty(false);
      setParseError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[StrategyArtifactPanel] save failed', err);
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [selectedId, busy]);

  const handleValidate = useCallback(async () => {
    if (busy) return;
    const parsed = tryParse();
    if (parsed === undefined) return;
    setBusy('validate');
    try {
      const result = await validateStrategy(parsed);
      if (result.ok) {
        setValidateResult('Valid');
      } else {
        setValidateResult(result.error);
      }
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const handleBacktest = useCallback(async () => {
    if (busy) return;
    const parsed = tryParse();
    if (parsed === undefined) return;
    setBusy('backtest');
    try {
      const result = await backtestStrategy({
        strategy: parsed,
        sym: activeSym,
        tf,
      });
      if (result.ok) {
        const p = result.perf;
        if (p) {
          setBacktestSummary(
            `win rate ${(p.winRate * 100).toFixed(0)}% / Sharpe ${p.sharpe.toFixed(2)} / max DD ${(p.maxDrawdown * 100).toFixed(1)}%`,
          );
        } else {
          setBacktestSummary('no trades in window');
        }
      } else {
        setBacktestSummary(`Error: ${result.error}`);
      }
    } finally {
      setBusy(null);
    }
  }, [busy, activeSym, tf]);

  const handleApply = useCallback(() => {
    if (!selectedId || busy) return;
    useChartMutationStore.getState().applyStrategyOverlay({
      id: selectedId,
      bodyJson: currentContent(),
    });
  }, [selectedId, busy]);

  const handleDiscard = useCallback(() => {
    replaceContent(lastSaved);
    setParseError(null);
    setIsDirty(false);
  }, [lastSaved]);

  const isLoading = (op: BusyOp) => busy === op;

  return (
    <DockDrawer
      side="right"
      id="strategy"
      ariaLabel="Strategy editor"
      mountOnOpen
      open={openRight === 'strategy' && !!selectedId}
    >
      <div
        className="artifact-panel-inner"
        role="region"
        aria-label="Strategy Artifact panel"
        data-testid="artifact-panel"
      >
      {/* Header */}
      <PanelHeader
        label="Strategy Artifact"
        closeLabel="Close Strategy Artifact panel"
        closeTestId="artifact-close"
        onClose={close}
      >
        {strategyName && (
          <span className="artifact-panel-strategy">{strategyName}</span>
        )}
        {revision > 0 && (
          <span className="artifact-panel-rev" data-testid="rev-badge">
            rev {revision}
          </span>
        )}
      </PanelHeader>

      {/* Toolbar */}
      <div className="artifact-panel-toolbar" role="toolbar" aria-label="Strategy actions">
        <button
          type="button"
          className="artifact-btn primary"
          disabled={!isDirty || busy !== null}
          onClick={() => void handleSave()}
          data-testid="btn-save"
        >
          {isLoading('save') ? <span className="artifact-spinner" /> : null}
          Save
        </button>
        <button
          type="button"
          className="artifact-btn"
          disabled={busy !== null}
          onClick={() => void handleValidate()}
          data-testid="btn-validate"
        >
          {isLoading('validate') ? <span className="artifact-spinner" /> : null}
          Re-validate
        </button>
        <button
          type="button"
          className="artifact-btn"
          disabled={busy !== null}
          onClick={() => void handleBacktest()}
          data-testid="btn-backtest"
        >
          {isLoading('backtest') ? <span className="artifact-spinner" /> : null}
          Re-backtest
        </button>
        <button
          type="button"
          className="artifact-btn"
          disabled={busy !== null}
          onClick={handleApply}
          data-testid="btn-apply"
        >
          Apply to chart
        </button>
        <button
          type="button"
          className="artifact-btn"
          disabled={!isDirty || busy !== null}
          onClick={handleDiscard}
          data-testid="btn-discard"
        >
          Discard
        </button>
      </div>

      {/* Inline parse error */}
      {parseError !== null && (
        <div className="artifact-panel-error" role="alert" data-testid="parse-error">
          {parseError}
        </div>
      )}

      {/* Editor */}
      <div className="artifact-panel-body">
        <div
          ref={editorRef}
          className="artifact-editor-wrap"
          data-testid="editor-wrap"
        />
      </div>

      {/* Status row */}
      <div className="artifact-panel-status">
        {validateResult !== null && (
          <span
            className={`artifact-status-item ${validateResult === 'Valid' ? 'artifact-status-ok' : 'artifact-status-err'}`}
            data-testid="validate-result"
          >
            {validateResult === 'Valid' ? '✓' : '✗'} {validateResult}
          </span>
        )}
        {backtestSummary !== null && (
          <span className="artifact-status-item" data-testid="backtest-summary">
            {backtestSummary}
          </span>
        )}
      </div>
      </div>
    </DockDrawer>
  );
}
