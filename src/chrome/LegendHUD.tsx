/**
 * src/chrome/LegendHUD.tsx — Step 8 — Chart Legend HUD.
 *
 * TradingView-style transparent legend rendered top-left UNDER the Headline,
 * directly over the chart surface with NO panel chrome (no border, no blur,
 * no background, no box-shadow). One row per active overlay across every family:
 *   - indicators ON via `indicatorFlags` (MA20 / MA50 / Bollinger) + custom series
 *   - the active AI dataset overlay
 *   - strategy overlays   (useChartMutationStore.strategyOverlays)
 *   - timeline layers      (useChartMutationStore.timelineLayers)
 *   - research overlays    (useChartMutationStore.researchOverlays)
 *
 * Each row: color dash + label + eye toggle (visibility, `aria-pressed`) + × clear.
 * Controls (eye, ×) are opacity-0 at rest and revealed on row hover / focus-within
 * so the legend reads cleanly at a glance (TradingView idiom). They stay in the
 * layout (not display:none) so keyboard Tab still reaches them.
 *
 *   - Visibility (D12) is CLIENT-SIDE ONLY. The id-keyed `hiddenOverlayIds`
 *     Set lives in AppShell local state and is threaded down here. Toggling the
 *     eye flips membership; AppShell's renderer closures filter hidden ids out
 *     each frame. Indicator/custom rows are flag-based — their eye toggles the
 *     existing `indicatorFlags` / `customSeriesEnabled` flag (their natural
 *     visibility path); they are NEVER added to `hiddenOverlayIds`.
 *   - × clear calls the REAL remove paths: store remove actions for
 *     dataset/strategy/timeline/research overlays (the same paths the MCP
 *     bridge `remove_*` methods use); for indicator/custom rows × turns the
 *     flag off.
 *
 * The strip collapses to an "Indicators" chip (via the chevron) that opens the
 * IndicatorPanel exactly as before (`useDockStore.toggle('indicator')`).
 *
 * Binding design: reuses the prototype legend/chip vocabulary — the
 * `.indicator-panel .toggle-row .swatch` dot, the `.ds-label`/`.ds-meta` text
 * ramp — via the dedicated `.legend-hud*` classes in panels.css.
 * No new tokens / hex / OKLCH literals.
 */

import { useMemo, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useDockStore } from '../stores/useDockStore';
import { useChartMutationStore, overlayKey } from '../stores/useChartMutationStore';
import { useDatasetStore, colorForIndex } from '../stores/useDatasetStore';
// Indicator swatch colors come from the renderer (the source of truth) so the
// legend dot matches the chart line + the panel toggle dot.
import {
  MA20_COLOR,
  MA50_COLOR,
  BB_SWATCH_COLOR,
  CUSTOM_SERIES_COLOR,
} from '../chart/overlays';
import { strategyOverlayDisplayName, timelineLayerColor } from './overlayDisplay';

/** A single legend row's resolved data + action wiring. */
interface LegendRow {
  /** Stable id (matches the renderer's overlay id for store-backed families;
   *  synthetic `flag:*` ids for the flag-based indicator/custom rows). */
  id: string;
  label: string;
  /** Optional small mono detail (e.g. "SMA 20"). */
  desc?: string;
  /** Render color of the overlay (the dot). */
  color: string;
  /** Whether the row is currently visible. */
  visible: boolean;
  /** Flip visibility (eye toggle). */
  onToggle: () => void;
  /** Remove / clear the overlay (× button). */
  onClear: () => void;
}

interface LegendHUDProps {
  /** Client-side hidden-overlay id set (lives in AppShell local UI state). */
  hiddenOverlayIds: Set<string>;
  /** Replace the hidden-overlay id set. */
  setHiddenOverlayIds: (next: Set<string>) => void;
}

export function LegendHUD({ hiddenOverlayIds, setHiddenOverlayIds }: LegendHUDProps): JSX.Element {
  // Flag-based indicator state.
  const indicatorFlags = useAppStore((s) => s.indicatorFlags);
  const setIndicatorFlag = useAppStore((s) => s.setIndicatorFlag);
  const customSeriesEnabled = useAppStore((s) => s.customSeriesEnabled);
  const setCustomSeriesEnabled = useAppStore((s) => s.setCustomSeriesEnabled);
  const customSeries = useAppStore((s) => s.customSeries);

  // AI dataset overlay (active id + persisted list for label/color).
  const aiOverlayDatasetId = useAppStore((s) => s.aiOverlayDatasetId);
  const setAiOverlayDataset = useAppStore((s) => s.setAiOverlayDataset);
  const datasets = useDatasetStore((s) => s.datasets);

  // Store-backed overlay families (reactive — rows must react to slice changes).
  const strategyOverlays = useChartMutationStore((s) => s.strategyOverlays);
  const timelineLayers = useChartMutationStore((s) => s.timelineLayers);
  const researchOverlays = useChartMutationStore((s) => s.researchOverlays);
  const removeStrategyOverlay = useChartMutationStore((s) => s.removeStrategyOverlay);
  const removeTimelineLayer = useChartMutationStore((s) => s.removeTimelineLayer);
  const removeResearchOverlay = useChartMutationStore((s) => s.removeResearchOverlay);

  // Legend-local collapse flag — collapses the strip to the Indicators chip.
  // Session-only UI state, read/written ONLY here, so it lives in local state.
  const [collapsed, setCollapsed] = useState(false);

  // Toggle membership of an id-keyed overlay in the client-side hidden set.
  const toggleHidden = (id: string): void => {
    const next = new Set(hiddenOverlayIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHiddenOverlayIds(next);
  };
  // Drop an id from the hidden set (used when an overlay is removed entirely so
  // a re-added overlay with the same id never starts hidden).
  const dropHidden = (id: string): void => {
    if (!hiddenOverlayIds.has(id)) return;
    const next = new Set(hiddenOverlayIds);
    next.delete(id);
    setHiddenOverlayIds(next);
  };

  const rows = useMemo<LegendRow[]>(() => {
    const out: LegendRow[] = [];

    // ── Flag-based indicators ────────────────────────────────────────────────
    // Eye toggles the flag (their natural visibility path); × also turns it off.
    if (indicatorFlags.ma20) {
      out.push({
        id: overlayKey('flag', 'ma20'),
        label: 'Moving avg',
        desc: 'SMA 20',
        color: MA20_COLOR,
        visible: true,
        onToggle: () => setIndicatorFlag('ma20', false),
        onClear: () => setIndicatorFlag('ma20', false),
      });
    }
    if (indicatorFlags.ma50) {
      out.push({
        id: overlayKey('flag', 'ma50'),
        label: 'Moving avg',
        desc: 'SMA 50',
        color: MA50_COLOR,
        visible: true,
        onToggle: () => setIndicatorFlag('ma50', false),
        onClear: () => setIndicatorFlag('ma50', false),
      });
    }
    if (indicatorFlags.bollinger) {
      out.push({
        id: overlayKey('flag', 'bollinger'),
        label: 'Bollinger',
        desc: '20 · 2σ',
        color: BB_SWATCH_COLOR,
        visible: true,
        onToggle: () => setIndicatorFlag('bollinger', false),
        onClear: () => setIndicatorFlag('bollinger', false),
      });
    }
    if (customSeriesEnabled && customSeries.length > 0) {
      out.push({
        id: overlayKey('flag', 'custom'),
        label: 'Your data',
        desc: `${customSeries.length} pts`,
        color: CUSTOM_SERIES_COLOR,
        visible: true,
        onToggle: () => setCustomSeriesEnabled(false),
        onClear: () => setCustomSeriesEnabled(false),
      });
    }

    // ── AI dataset overlay (id-based: eye → hidden set; × → clear active id) ──
    if (aiOverlayDatasetId !== null) {
      const idx = datasets.findIndex((d) => d.id === aiOverlayDatasetId);
      if (idx >= 0) {
        const ds = datasets[idx];
        const id = overlayKey('dataset', ds.id);
        out.push({
          id,
          label: ds.label,
          desc: 'AI overlay',
          color: colorForIndex(idx),
          visible: !hiddenOverlayIds.has(id),
          onToggle: () => toggleHidden(id),
          onClear: () => {
            dropHidden(id);
            setAiOverlayDataset(null);
          },
        });
      }
    }

    // ── Strategy overlays (id-based) ─────────────────────────────────────────
    for (const ov of Object.values(strategyOverlays)) {
      const id = overlayKey('strategy', ov.id);
      out.push({
        id,
        label: strategyOverlayDisplayName(ov),
        desc: 'Strategy',
        color: colorForIndex(0),
        visible: !hiddenOverlayIds.has(id),
        onToggle: () => toggleHidden(id),
        onClear: () => {
          dropHidden(id);
          removeStrategyOverlay(ov.id);
        },
      });
    }

    // ── Timeline layers (id-based) ───────────────────────────────────────────
    for (const layer of Object.values(timelineLayers)) {
      const id = overlayKey('timeline', layer.id);
      out.push({
        id,
        label: layer.name,
        desc: `${layer.events.length} events`,
        color: timelineLayerColor(layer, colorForIndex(2)),
        visible: !hiddenOverlayIds.has(id),
        onToggle: () => toggleHidden(id),
        onClear: () => {
          dropHidden(id);
          removeTimelineLayer(layer.id);
        },
      });
    }

    // ── Research overlays (id-based) ─────────────────────────────────────────
    let researchIdx = 0;
    for (const ro of Object.values(researchOverlays)) {
      const id = overlayKey('research', ro.id);
      const colorIdx = researchIdx++;
      out.push({
        id,
        label: ro.label || ro.id,
        desc: 'Research',
        // The renderer derives element colors via validateResearchColor →
        // colorForIndex(overlayIdx); the overlay's default color (if any) is the
        // closest legend-dot proxy, else the same index fallback.
        color: ro.color ?? colorForIndex(colorIdx),
        visible: !hiddenOverlayIds.has(id),
        onToggle: () => toggleHidden(id),
        onClear: () => {
          dropHidden(id);
          removeResearchOverlay(ro.id);
        },
      });
    }

    return out;
    // toggleHidden/dropHidden close over hiddenOverlayIds; depending on it keeps
    // the `visible` flags + handlers fresh. (The setter/store actions are stable
    // zustand selectors so they need not be listed.)
  }, [
    indicatorFlags,
    customSeriesEnabled,
    customSeries,
    aiOverlayDatasetId,
    datasets,
    strategyOverlays,
    timelineLayers,
    researchOverlays,
    hiddenOverlayIds,
  ]);

  // Open the IndicatorPanel (same path the v1 Actions pill used).
  const openIndicatorPanel = (): void => {
    useDockStore.getState().toggle('indicator');
  };

  // Collapsed, OR nothing active → render the "Indicators" chip only.
  if (collapsed || rows.length === 0) {
    return (
      <div className="legend-hud-pill-wrap" role="region" aria-label="Chart overlays" data-testid="legend-hud">
        <button
          type="button"
          className="legend-hud-pill"
          onClick={openIndicatorPanel}
          aria-label="Open indicators panel"
          title="Indicators (D)"
        >
          <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
            <path d="M2 12c2-4 4-4 6 0s4 4 6-2" />
          </svg>
          <span>Indicators</span>
          {rows.length > 0 && <span className="legend-hud-count">{rows.length}</span>}
        </button>
        {rows.length > 0 && (
          <button
            type="button"
            className="legend-hud-collapse"
            onClick={() => setCollapsed(false)}
            aria-label="Expand overlay legend"
            aria-expanded={false}
            title="Expand legend"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
              <path d="M3 4.5L6 7.5L9 4.5" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="legend-hud" role="region" aria-label="Chart overlays" data-testid="legend-hud">
      <div className="legend-hud-head">
        <span className="legend-hud-title">Overlays</span>
        <button
          type="button"
          className="legend-hud-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse overlay legend"
          aria-expanded={true}
          title="Collapse legend"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
            <path d="M3 7.5L6 4.5L9 7.5" />
          </svg>
        </button>
      </div>
      {rows.map((row) => (
        <div key={row.id} className="legend-hud-row" data-hidden={!row.visible}>
          <span
            className="legend-hud-dot"
            aria-hidden
            style={{ ['--ov-color' as string]: row.color } as React.CSSProperties}
          />
          <span className="legend-hud-label">{row.label}</span>
          {row.desc && <span className="legend-hud-desc">{row.desc}</span>}
          <button
            type="button"
            className="legend-hud-eye"
            onClick={row.onToggle}
            aria-pressed={row.visible}
            aria-label={`${row.visible ? 'Hide' : 'Show'} ${row.label}`}
            title={row.visible ? 'Hide overlay' : 'Show overlay'}
          >
            {row.visible ? (
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                <path d="M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" />
                <circle cx="9" cy="9" r="2" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                <path d="M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" />
                <path d="M2 2l14 14" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="legend-hud-rm"
            onClick={row.onClear}
            aria-label={`Clear ${row.label}`}
            title="Clear overlay"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default LegendHUD;
