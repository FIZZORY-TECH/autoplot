/**
 * src/panels/PortfolioPanel.tsx — Docked paper-trading portfolio panel.
 *
 * Wrapped in DockDrawer (right side, id='portfolio', width=360). Open-state
 * is owned by useDockStore — the portfolio is open when openRight === 'portfolio'.
 * DockDrawer owns mount-stable motion + framing; no self-animation here.
 *
 * Data:
 *   - Holdings from usePortfolioStore.
 *   - Live market via same provider-registry approach as AssetPanel.
 *   - P&L math: client-side USD base.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useDockStore } from '../stores/useDockStore';
import { usePortfolioStore } from '../stores/usePortfolioStore';
import type { HoldingRow } from '../stores/usePortfolioStore';
import { getProvider } from '../data/providerRegistry';
import { startSparklinePolling } from '../data/sparklinePoller';
import type { Bar, Provider } from '../data/MarketDataProvider';
import { fmtPrice, fmtPct, fmtUsd } from '../engine/indicators';
import { MiniSpark } from '../components/MiniSpark';
import { AnimNum } from '../components/AnimNum';
import { useToastStore } from '../stores/useToastStore';
import { holdingPnl, portfolioSummary } from '../lib/portfolioMath';
import { AddHoldingModal } from './AddHoldingModal';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPARK_BARS = 32;
const HISTORY_FETCH = 64;

// ---------------------------------------------------------------------------
// Per-holding derived market state (mirrors AssetPanel's RowMarket)
// ---------------------------------------------------------------------------

interface RowMarket {
  bars: Bar[];
  price: number;
  pct24h: number;
  spark: number[];
  direction: 'up' | 'down' | 'flat';
}

function deriveMarket(bars: Bar[]): RowMarket {
  if (bars.length === 0) {
    return { bars, price: 0, pct24h: 0, spark: [], direction: 'flat' };
  }
  const last = bars[bars.length - 1];
  const ref = bars[Math.max(0, bars.length - 25)] ?? bars[0];
  const pct = ref.c !== 0 ? (last.c - ref.c) / ref.c : 0;
  const direction: 'up' | 'down' | 'flat' =
    pct > 0.0005 ? 'up' : pct < -0.0005 ? 'down' : 'flat';
  const spark = bars.slice(-SPARK_BARS).map((b) => b.c);
  return { bars, price: last.c, pct24h: pct, spark, direction };
}

/** Canonical row id: `${provider}:${sym}/${quote}` */
function rowKey(h: { sym: string; provider: string; quote: string }): string {
  return `${h.provider}:${h.sym}/${h.quote}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PortfolioPanel(): JSX.Element {
  // Open-state derives from useDockStore ('portfolio', right side).
  const open = useDockStore((s) => s.openRight === 'portfolio');
  const holdings = usePortfolioStore((s) => s.holdings);
  const removeHolding = usePortfolioStore((s) => s.removeHolding);

  // Market data cache
  const [marketByKey, setMarketByKey] = useState<Record<string, RowMarket>>({});
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  // Add/Edit modal state
  const [holdingModalOpen, setHoldingModalOpen] = useState(false);
  const [editHolding, setEditHolding] = useState<HoldingRow | null>(null);

  // -------------------------------------------------------------------------
  // Bar fetch — same pattern as AssetPanel
  // -------------------------------------------------------------------------
  const marketByKeyRef = useRef(marketByKey);
  marketByKeyRef.current = marketByKey;

  useEffect(() => {
    let cancelled = false;
    const missing = holdings.filter((h) => !marketByKeyRef.current[rowKey(h)]);
    if (missing.length === 0) return;
    Promise.all(
      missing.map((h) =>
        getProvider(h.provider as Provider, h.quote)
          .fetchHistory(h.sym, '1h', HISTORY_FETCH)
          .then((bars) => [rowKey(h), deriveMarket(bars)] as const),
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        setMarketByKey((prev) => {
          const next = { ...prev };
          for (const [key, m] of entries) next[key] = m;
          return next;
        });
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[PortfolioPanel] history fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [holdings]);

  // Sparkline polling — 30s refresh.
  //
  // Gated on `open`: the portfolio drawer is mount-stable, so without this gate
  // the 30s poller keeps hitting live providers (REST/IPC + rate-limit churn)
  // even while the drawer is CLOSED. We only poll while open; the once-on-mount
  // fetch above (NOT gated) keeps rows populated, and re-opening refetches on
  // the next 30s tick. The chart's own selected-asset data (AppShell) is
  // separate and unaffected.
  useEffect(() => {
    if (!open) return;
    if (holdings.length === 0) return;
    const symToKey = new Map<string, string>();
    for (const h of holdings) {
      if (!symToKey.has(h.sym)) symToKey.set(h.sym, rowKey(h));
    }
    const stop = startSparklinePolling(
      holdings.map((h) => ({ sym: h.sym, provider: h.provider, quote: h.quote })),
      (sym, bars) => {
        const key = symToKey.get(sym);
        if (!key) return;
        setMarketByKey((prev) => ({ ...prev, [key]: deriveMarket(bars) }));
      },
    );
    return () => stop();
  }, [open, holdings]);

  // Drop stale cache entries
  useEffect(() => {
    setMarketByKey((prev) => {
      const keys = new Set(holdings.map((h) => rowKey(h)));
      const next: Record<string, RowMarket> = {};
      let changed = false;
      for (const k of Object.keys(prev)) {
        if (keys.has(k)) {
          next[k] = prev[k];
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [holdings]);

  // -------------------------------------------------------------------------
  // Portfolio summary math
  // -------------------------------------------------------------------------
  const summary = useMemo(() => {
    const holdingsWithPrice = holdings.map((h) => ({
      qty: h.qty,
      avg_cost: h.avg_cost,
      asset_class: h.asset_class,
      price: marketByKey[rowKey(h)]?.price ?? 0,
    }));
    return portfolioSummary(holdingsWithPrice);
  }, [holdings, marketByKey]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const onRemove = useCallback(
    async (h: HoldingRow) => {
      await removeHolding({ sym: h.sym, provider: h.provider, quote: h.quote });
      useToastStore.getState().push({
        kind: 'info',
        title: `${h.sym} removed`,
        detail: `${h.sym}/${h.quote} removed from portfolio`,
      });
    },
    [removeHolding],
  );

  const onEdit = useCallback((h: HoldingRow) => {
    setEditHolding(h);
    setHoldingModalOpen(true);
  }, []);

  const onAddNew = useCallback(() => {
    setEditHolding(null);
    setHoldingModalOpen(true);
  }, []);

  const plColor = summary.unrealized >= 0 ? 'var(--up)' : 'var(--down)';

  return (
    <>
      <AddHoldingModal
        open={holdingModalOpen}
        editHolding={editHolding}
        onClose={() => {
          setHoldingModalOpen(false);
          setEditHolding(null);
        }}
      />

      <DockDrawer
        side="right"
        id="portfolio"
        ariaLabel="Portfolio"
        open={open}
      >
        <PanelHeader
          label="Portfolio"
          closeLabel="Close portfolio panel"
          closeTestId="portfolio-panel-close"
          onClose={() => useDockStore.getState().close('right')}
        />

        {/* Body — always rendered (DockDrawer owns the mount-stable pattern) */}
        <div
          data-testid="portfolio-panel"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
          }}
        >
          {/* Summary header */}
          <div
            style={{
              padding: 'var(--sp-12) var(--sp-16)',
              borderBottom: '1px solid var(--hairline)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sp-6)',
              flexShrink: 0,
            }}
          >
            {/* Total value row */}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  color: 'var(--ink-3)',
                }}
              >
                Total Value
              </span>
              <AnimNum
                value={summary.totalValue}
                format={fmtUsd}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 18,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.01em',
                  color: 'var(--ink-0)',
                }}
              />
            </div>

            {/* Unrealized P&L row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  color: 'var(--ink-3)',
                }}
              >
                Unrealized P&L
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-6)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                    color: plColor,
                  }}
                >
                  {fmtUsd(summary.unrealized)}
                </span>
                {/* P&L % badge — mirrors AssetPanel/Headline delta-pill pattern */}
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontVariantNumeric: 'tabular-nums',
                    color: plColor,
                    background: `color-mix(in oklab, ${plColor} 12%, transparent)`,
                    border: `1px solid color-mix(in oklab, ${plColor} 30%, transparent)`,
                    borderRadius: 'var(--r-pill)',
                    padding: '2px 7px',
                  }}
                >
                  {fmtPct(summary.unrealizedPct)}
                </span>
              </div>
            </div>

            {/* Asset-class allocation readout */}
            {holdings.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-8)',
                  marginTop: 'var(--sp-4)',
                }}
              >
                {/* Stacked bar */}
                <div
                  aria-hidden="true"
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 'var(--r-pill)',
                    background: 'var(--hairline)',
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${summary.cryptoPct * 100}%`,
                      background: 'var(--accent)',
                      borderRadius: 'var(--r-pill)',
                    }}
                  />
                </div>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--accent)',
                    letterSpacing: '0.06em',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {(summary.cryptoPct * 100).toFixed(0)}% Crypto
                </span>
                {summary.equityPct > 0 && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--emerald)',
                      letterSpacing: '0.06em',
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {(summary.equityPct * 100).toFixed(0)}% Equity
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Holdings list */}
          <div
            data-testid="portfolio-panel-list"
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 'var(--sp-4)',
              scrollbarWidth: 'thin',
            }}
          >
            {holdings.length === 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 'var(--sp-12)',
                  padding: '22px var(--sp-12)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--ink-3)',
                    letterSpacing: '0.04em',
                    textAlign: 'center',
                  }}
                >
                  No holdings — add your first position
                </span>
                <button
                  type="button"
                  data-testid="portfolio-panel-add-empty"
                  onClick={onAddNew}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-6)',
                    padding: '7px 14px',
                    borderRadius: 'var(--r-pill)',
                    background: 'color-mix(in oklab, var(--accent) 15%, transparent)',
                    border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                    color: 'var(--ink-0)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    letterSpacing: '0.08em',
                    cursor: 'pointer',
                    transition: 'all var(--t-fast)',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                  Add holding
                </button>
              </div>
            )}

            {holdings.map((h) => {
              const key = rowKey(h);
              const market = marketByKey[key];
              const price = market?.price ?? 0;
              const pnl = holdingPnl(price, h.qty, h.avg_cost, summary.totalValue);
              const { value, unrealized: unrealizedH, unrealizedPct: unrealizedPctH, weightPct } = pnl;
              const plColorH = unrealizedH >= 0 ? 'var(--up)' : 'var(--down)';
              const isHover = hoverKey === key;

              const rowStyle: CSSProperties = {
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                alignItems: 'center',
                gap: 'var(--sp-8)',
                padding: '8px 8px 8px 10px',
                borderRadius: 10,
                cursor: 'default',
                position: 'relative',
                transition: 'background var(--t-fast)',
                background: isHover
                  ? 'color-mix(in oklab, var(--accent) 10%, transparent)'
                  : 'transparent',
                boxShadow: isHover
                  ? 'inset 0 0 0 1px color-mix(in oklab, var(--accent) 40%, transparent)'
                  : 'none',
              };

              return (
                <div
                  key={key}
                  data-testid={`portfolio-row-${h.provider}-${h.sym}-${h.quote}`}
                  onMouseEnter={() => setHoverKey(key)}
                  onMouseLeave={() => setHoverKey((s) => (s === key ? null : s))}
                  style={rowStyle}
                >
                  {/* Left: sym info + metrics */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    {/* Row 1: sym/quote + provider chip + weight */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-6)', minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          letterSpacing: '0.04em',
                          color: 'var(--ink-0)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {h.sym}
                        <span style={{ color: 'var(--ink-3)' }}>/{h.quote}</span>
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 8,
                          letterSpacing: '0.10em',
                          textTransform: 'uppercase',
                          color: 'var(--ink-3)',
                          border: '1px solid var(--hairline)',
                          borderRadius: 'var(--r-pill)',
                          padding: '1px 5px',
                          flexShrink: 0,
                        }}
                      >
                        {h.provider}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9,
                          letterSpacing: '0.04em',
                          color: 'var(--ink-3)',
                          fontVariantNumeric: 'tabular-nums',
                          flexShrink: 0,
                        }}
                      >
                        {(weightPct * 100).toFixed(1)}%
                      </span>
                    </div>

                    {/* Row 2: qty × avg_cost → current price */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto auto auto 1fr',
                        gap: 'var(--sp-6)',
                        alignItems: 'center',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: 'var(--ink-2)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {h.qty % 1 === 0 ? h.qty.toFixed(0) : h.qty.toFixed(4)}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--ink-4)' }}>×</span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: 'var(--ink-2)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {fmtPrice(h.avg_cost)}
                      </span>
                      <MiniSpark
                        values={market?.spark ?? []}
                        width={42}
                        height={14}
                        direction={market?.direction ?? 'flat'}
                        strokeWidth={1.1}
                        opacity={0.8}
                      />
                    </div>

                    {/* Row 3: current value + unrealized P&L */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-8)' }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--ink-1)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {market ? fmtUsd(value) : '—'}
                      </span>
                      {market && h.avg_cost > 0 && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10,
                            fontVariantNumeric: 'tabular-nums',
                            color: plColorH,
                            background: `color-mix(in oklab, ${plColorH} 12%, transparent)`,
                            border: `1px solid color-mix(in oklab, ${plColorH} 30%, transparent)`,
                            borderRadius: 'var(--r-pill)',
                            padding: '1px 5px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {fmtPct(unrealizedPctH)} / {fmtUsd(unrealizedH)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right: current price + hover actions */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 'var(--sp-4)',
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--ink-1)',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {market ? fmtPrice(price) : '—'}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: market && market.pct24h >= 0 ? 'var(--up)' : 'var(--down)',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {market ? fmtPct(market.pct24h) : ''}
                    </span>

                    {/* Hover-reveal edit + remove */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 'var(--sp-4)',
                        opacity: isHover ? 1 : 0,
                        transition: 'opacity var(--t-fast)',
                      }}
                    >
                      <button
                        type="button"
                        aria-label={`Edit ${h.sym}/${h.quote}`}
                        data-testid={`portfolio-row-edit-${h.provider}-${h.sym}-${h.quote}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(h);
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 'var(--r-8)',
                          background: 'var(--glass)',
                          border: '1px solid var(--hairline)',
                          color: 'var(--ink-2)',
                          fontSize: 10,
                          display: 'grid',
                          placeItems: 'center',
                          cursor: 'pointer',
                          transition: 'all var(--t-fast)',
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                          <path d="M7 1.5l1.5 1.5L3 8.5H1.5V7z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${h.sym}/${h.quote}`}
                        data-testid={`portfolio-row-remove-${h.provider}-${h.sym}-${h.quote}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRemove(h);
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 'var(--r-8)',
                          background: 'var(--glass)',
                          border: '1px solid var(--hairline)',
                          color: 'var(--ink-2)',
                          fontSize: 13,
                          display: 'grid',
                          placeItems: 'center',
                          cursor: 'pointer',
                          transition: 'all var(--t-fast)',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add holding button (footer) */}
          {holdings.length > 0 && (
            <button
              type="button"
              data-testid="portfolio-panel-add-btn"
              onClick={onAddNew}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--sp-8)',
                margin: 'var(--sp-4)',
                padding: 9,
                borderRadius: 10,
                background: 'color-mix(in oklab, var(--accent) 15%, transparent)',
                border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                color: 'var(--ink-0)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.08em',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                transition: 'all var(--t-fast)',
                flexShrink: 0,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span>Add holding</span>
            </button>
          )}
        </div>
      </DockDrawer>
    </>
  );
}

export default PortfolioPanel;
