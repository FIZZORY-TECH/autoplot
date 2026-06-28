/**
 * src/panels/IndicatorPanel.tsx — Docked indicator + custom data panel.
 *
 * P2.4: right-side DockDrawer with:
 *   1. Three indicator toggles: MA20, MA50, Bollinger Bands.
 *   2. Custom series textarea — parse via parseUserSeries, show status inline.
 *   3. Plot / Clear buttons. Close via × button.
 *
 * Binding design source: app-design/project/chrome.jsx OverlaysPanel function
 * (panel renamed to IndicatorPanel in-app).
 * Colors verbatim from prototype: MA20 amber, MA50 indigo, BB blue-gray.
 *
 * Open-state owned by useDockStore — open when openRight === 'indicator'.
 * DockDrawer owns mount-stable motion + framing; no self-animation here.
 * DO NOT add keyboard listener here — P2.7 owns the `D` key shortcut.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useDockStore } from '../stores/useDockStore';
import { useBarsStore } from '../stores/useBarsStore';
import {
  useResearchOverlayLibraryStore,
  type PersistedResearchOverlay,
} from '../stores/useResearchOverlayLibraryStore';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import type { ResearchOverlay } from '../ai/schemas';
import { parseUserSeries } from '../engine/indicators';
import { MA20_COLOR, MA50_COLOR, BB_SWATCH_COLOR } from '../chart/overlays';
import { recomputeRecipe } from './recomputeRecipe';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';

// Indicator items — mirrors chrome.jsx items array verbatim. Swatch colors
// come from the renderer constants in chart/overlays.ts (source of truth).
const INDICATOR_ITEMS = [
  {
    id: 'ma20' as const,
    label: 'Moving avg',
    desc: 'SMA 20',
    color: MA20_COLOR,
  },
  {
    id: 'ma50' as const,
    label: 'Moving avg',
    desc: 'SMA 50',
    color: MA50_COLOR,
  },
  {
    id: 'bollinger' as const,
    label: 'Bollinger',
    desc: '20 · 2σ',
    color: BB_SWATCH_COLOR,
  },
];

// ---------------------------------------------------------------------------
// Saved-indicator card — mirrors ResearchLibrary's OverlayCard layout (.ds-card
// family) but its Apply RECOMPUTES the recipe for the live (sym, tf) via
// recomputeRecipe, falling back to a verbatim re-apply for recipe-less rows.
// Delete (.lib-rm) is two-click, mirroring OverlayCard exactly.
// ---------------------------------------------------------------------------
interface SavedIndicatorCardProps {
  overlay: PersistedResearchOverlay;
  idx: number;
}

function SavedIndicatorCard({ overlay, idx }: SavedIndicatorCardProps): JSX.Element {
  const bars = useBarsStore((s) => s.bars);
  const activeSym = useAppStore((s) => s.activeSym);
  const activeTf = useAppStore((s) => s.tf);
  const removeOverlay = useResearchOverlayLibraryStore((s) => s.removeOverlay);

  const [applied, setApplied] = useState(false);
  const appliedTimer = useRef<number | undefined>(undefined);

  const [arming, setArming] = useState(false);
  const armingTimer = useRef<number | undefined>(undefined);

  // Inline "not enough history" note shown beneath .ds-meta after an Apply that
  // returned notEnoughHistory. Cleared on the next successful Apply.
  const [shortNote, setShortNote] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      window.clearTimeout(appliedTimer.current);
      window.clearTimeout(armingTimer.current);
    };
  }, []);

  // Primary series of the recipe drives the swatch color + meta (kind · pane).
  const primarySpec = overlay.recipe?.series[0];
  const swatchColor =
    primarySpec?.color ?? overlay.color ?? 'var(--accent)';
  const meta = primarySpec
    ? `${primarySpec.kind} · ${primarySpec.pane === 'series' ? 'sub-pane' : 'price'}`
    : `${overlay.sym} · ${overlay.tf}`;

  // Provenance badge — PINE / AI, read from overlay.source (fallback recipe.source).
  const provenance = overlay.source ?? overlay.recipe?.source;

  const barsReady = bars.length > 0;

  const flashApplied = () => {
    setApplied(true);
    window.clearTimeout(appliedTimer.current);
    appliedTimer.current = window.setTimeout(() => setApplied(false), 1200);
  };

  // Strip the persisted `created_at` field — recompute/apply take a clean
  // canonical ResearchOverlay.
  const cleanOverlay = (): ResearchOverlay => {
    const { created_at: _created_at, ...ro } = overlay;
    void _created_at;
    return ro;
  };

  const handleApply = () => {
    if (!barsReady || activeSym === undefined) return;
    if (overlay.recipe) {
      // Recipe present — recompute for the live (sym, tf) so the indicator is
      // reusable across instruments rather than stretching stale values.
      const result = recomputeRecipe(cleanOverlay(), bars, activeSym, activeTf);
      useChartMutationStore.getState().applyResearchOverlay(result.overlay);
      if (result.notEnoughHistory && result.note) {
        setShortNote(result.note);
        console.warn('[TODO P8 toast] ' + result.note);
      } else {
        setShortNote(null);
      }
    } else {
      // Recipe-less (old/manual) rows — re-apply the frozen snapshot verbatim
      // (Decision D: don't regress recipe-less overlays).
      useChartMutationStore.getState().applyResearchOverlay(cleanOverlay());
      setShortNote(null);
    }
    flashApplied();
  };

  const handleDelete = () => {
    if (!arming) {
      setArming(true);
      window.clearTimeout(armingTimer.current);
      armingTimer.current = window.setTimeout(() => setArming(false), 3000);
      return;
    }
    window.clearTimeout(armingTimer.current);
    setArming(false);
    void removeOverlay(overlay.id);
  };

  return (
    <div
      className="ds-card"
      style={{ ['--ds-color' as string]: swatchColor, ['--i' as string]: idx } as React.CSSProperties}
    >
      <span className="ds-swatch" aria-hidden />
      <span className="ds-textcol">
        <span className="ds-label" title={overlay.label}>
          {overlay.label}
        </span>
        <span className="ds-meta">{meta}</span>
        {shortNote !== null && (
          <span style={{ fontSize: 10, color: 'var(--ink-4)', lineHeight: 1.4 }}>
            {shortNote}
          </span>
        )}
      </span>
      {provenance && (
        <span
          className={`legend-hud-badge legend-hud-badge--${provenance === 'pine' ? 'pine' : 'nl'}`}
          aria-hidden
        >
          {provenance === 'pine' ? 'PINE' : 'AI'}
        </span>
      )}
      <button
        type="button"
        className={`ds-toggle${applied ? ' applied' : ''}`}
        onClick={handleApply}
        disabled={!barsReady}
        title={barsReady ? 'Recompute for the current chart and apply' : 'Chart still loading'}
      >
        {applied ? '✓ applied' : 'Apply'}
      </button>
      <button
        type="button"
        className={`lib-rm${arming ? ' arming' : ''}`}
        onClick={handleDelete}
        aria-label={arming ? 'Confirm delete' : `Delete saved indicator ${overlay.label}`}
        title={arming ? 'Click again to confirm delete' : 'Delete saved indicator (keeps any on-chart copy)'}
      >
        {arming ? 'confirm?' : '×'}
      </button>
    </div>
  );
}

export function IndicatorPanel() {
  // Open-state derives from useDockStore ('indicator', right side).
  const open = useDockStore((s) => s.openRight === 'indicator');
  const indicatorFlags = useAppStore((s) => s.indicatorFlags);
  const setIndicatorFlag = useAppStore((s) => s.setIndicatorFlag);
  const setCustomSeries = useAppStore((s) => s.setCustomSeries);
  const customSeriesEnabled = useAppStore((s) => s.customSeriesEnabled);
  const setCustomSeriesEnabled = useAppStore((s) => s.setCustomSeriesEnabled);

  // Saved indicator overlays from the library mirror (same store + order as
  // the Research Library). Newest-last (append order), matching ResearchLibrary.
  const savedOverlays = useResearchOverlayLibraryStore((s) => s.overlays);

  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Parse status derived from current text — live, no submit needed.
  const parseStatus = useMemo(() => {
    if (!text.trim()) return null;
    return parseUserSeries(text);
  }, [text]);

  // Close panel
  const close = useCallback(() => {
    useDockStore.getState().close('right');
  }, []);

  // Plot custom series
  const handlePlot = useCallback(() => {
    const result = parseUserSeries(text);
    if (result.errors.length === 0 && result.series.length > 0) {
      setCustomSeries(result.series);
      setCustomSeriesEnabled(true);
    }
    // If there are errors, do nothing — the inline error display already shows them.
  }, [text, setCustomSeries, setCustomSeriesEnabled]);

  // Clear custom series
  const handleClear = useCallback(() => {
    setCustomSeriesEnabled(false);
    setText('');
  }, [setCustomSeriesEnabled]);

  // Plot is enabled only when the parse yielded series and no errors.
  const isPlottable =
    parseStatus != null && parseStatus.series.length > 0 && parseStatus.errors.length === 0;

  return (
    <DockDrawer
      side="right"
      id="indicator"
      ariaLabel="Indicators"
      open={open}
    >
      {/* ---- Heading ---- */}
      <PanelHeader
        label="Indicators"
        closeLabel="Close indicators panel"
        onClose={close}
      />

      {/* Panel body — scrolls when content overflows */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--sp-16)',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          userSelect: 'none',
        }}
      >
        {/* ---- Indicator toggles ---- */}
        {INDICATOR_ITEMS.map((item) => {
          const on = indicatorFlags[item.id];
          return (
            <div
              key={item.id}
              onClick={() => setIndicatorFlag(item.id, !on)}
              role="switch"
              aria-checked={on}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setIndicatorFlag(item.id, !on);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 0',
                cursor: 'pointer',
                // Principle 04 (glow not stroke): no borderBottom. A faint
                // inset bottom shadow gives row separation without a hairline,
                // matching prototype app.css:775-784 (toggle-row uses no border
                // between stacked rows).
                boxShadow: 'inset 0 -1px 0 0 color-mix(in oklab, var(--ink-3) 8%, transparent)',
                outline: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Color swatch */}
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: item.color,
                    flexShrink: 0,
                  }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span
                    style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-1)' }}
                  >
                    {item.label}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>
                    {item.desc}
                  </span>
                </div>
              </div>

              {/* Toggle pill */}
              <span
                style={{
                  display: 'inline-flex',
                  width: 32,
                  height: 18,
                  borderRadius: 'var(--r-pill)',
                  background: on
                    ? item.color
                    : 'rgba(255,255,255,0.10)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  transition: `background var(--t-fast) var(--ease)`,
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: on ? 14 : 2,
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: on ? '#fff' : 'rgba(255,255,255,0.45)',
                    transition: `left var(--t-fast) var(--ease)`,
                  }}
                />
              </span>
            </div>
          );
        })}

        {/* ---- Saved indicators section ---- */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--ink-3)',
            }}
          >
            Saved indicators
          </span>
          {savedOverlays.length > 0 && (
            <span style={{ color: 'var(--ink-4)', fontSize: 9 }}>
              {savedOverlays.length} saved
            </span>
          )}
        </div>

        {savedOverlays.length === 0 ? (
          <div className="lib-empty" role="status">
            <div className="lib-empty-icon" aria-hidden="true">◈</div>
            <p className="lib-empty-heading">No saved indicators yet</p>
            <p className="lib-empty-helper">
              Create one from the terminal — paste Pine Script or ask for an
              indicator
            </p>
          </div>
        ) : (
          savedOverlays.map((ro, idx) => (
            <SavedIndicatorCard key={ro.id} overlay={ro} idx={idx} />
          ))
        )}

        {/* ---- Custom series section ---- */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--ink-3)',
            }}
          >
            Your data
          </span>
          <span style={{ color: 'var(--ink-4)', fontSize: 9 }}>aligned to right</span>
        </div>

        <textarea
          ref={textareaRef}
          className="csv"
          placeholder={"# paste numbers, comma or newline, aligned to last bars\n108.2, 109.4, 110.1, 109.8, 111.2\n112.6, 114.0, 113.3, 112.7, 113.9"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 11,
            lineHeight: 1.5,
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 'var(--r-8)',
            color: 'var(--ink-1)',
            padding: '8px 10px',
            outline: 'none',
          }}
        />

        {/* Parse status row */}
        {parseStatus !== null && (
          <div style={{ marginTop: 6, fontSize: 10, lineHeight: 1.5, color: 'var(--ink-3)' }}>
            <span>
              {parseStatus.series.length} values ·{' '}
              <span style={{ color: parseStatus.errors.length > 0 ? 'oklch(0.70 0.20 25)' : 'oklch(0.78 0.16 150)' }}>
                {parseStatus.errors.length} errors
              </span>
            </span>
            {parseStatus.errors.length > 0 && (
              <ul
                style={{
                  margin: '4px 0 0',
                  padding: '0 0 0 14px',
                  color: 'oklch(0.70 0.20 25)',
                  fontSize: 10,
                  listStyle: 'disc',
                }}
              >
                {parseStatus.errors.slice(0, 5).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
                {parseStatus.errors.length > 5 && (
                  <li style={{ color: 'var(--ink-4)' }}>
                    +{parseStatus.errors.length - 5} more
                  </li>
                )}
              </ul>
            )}
          </div>
        )}

        {/* Plot / Clear buttons */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 10,
          }}
        >
          <button
            onClick={handlePlot}
            disabled={!isPlottable}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 'var(--r-8)',
              border: '1px solid rgba(255,255,255,0.14)',
              background: isPlottable ? 'rgba(0,230,255,0.18)' : 'rgba(255,255,255,0.06)',
              color: isPlottable ? 'oklch(0.85 0.14 200)' : 'var(--ink-4)',
              cursor: isPlottable ? 'pointer' : 'not-allowed',
              transition: `background var(--t-fast) var(--ease), color var(--t-fast) var(--ease)`,
            }}
          >
            Plot ↵
          </button>
          <button
            onClick={handleClear}
            disabled={!customSeriesEnabled && !text.trim()}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 'var(--r-8)',
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(255,255,255,0.06)',
              color: 'var(--ink-3)',
              cursor: 'pointer',
              transition: `background var(--t-fast) var(--ease)`,
            }}
          >
            Clear
          </button>
        </div>
      </div>
    </DockDrawer>
  );
}
