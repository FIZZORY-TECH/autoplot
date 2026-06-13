/**
 * src/panels/AssetPanel.tsx — Docked watchlist drawer (dock refactor).
 *
 * Wrapped in DockDrawer (right side, id='watchlist', width=352). Open-state
 * is owned by useDockStore — the watchlist is open when openRight === 'watchlist'.
 * The old floating/draggable/collapsible mechanics are removed:
 *   - No panelPos / setPanelPos (removed from useAppStore too)
 *   - No collapse/expand toggle; closed drawer = the hidden state
 *   - No drag grip machinery
 *   - No --reserve-left writes here; useDockStore owns reserve vars
 *
 * Binding visual source: app-design/project/panel.jsx (full file).
 *
 * State sources:
 *   - Watchlist rows:        useWatchlistStore.assets
 *   - Active sym highlight:  useAppStore.activeSym (setter switches active row)
 *   - Modal visibility:      useAppStore.addAssetModalOpen
 *
 * Sparkline data:
 *   - Each row fetches `MockMarketDataProvider.fetchHistory(sym, '1h', 64)`
 *     once on mount or when the asset list changes. Cache lives in component
 *     state (NOT in useAppStore) per spec. P4 will replace the provider.
 *
 * NOTE: NASDAQ/NYSE chips are owned by AddAssetModal (not this file).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useDockStore } from '../stores/useDockStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { ASSETS, ASSET_COLORS, PROVIDER_DISPLAY_NAME, hashToOklch } from '../data/assets';
import { getProvider } from '../data/providerRegistry';
import { startSparklinePolling } from '../data/sparklinePoller';
import type { Bar, AssetMeta, Provider } from '../data/MarketDataProvider';
import { fmtPrice, fmtPct } from '../engine/indicators';
import { MiniSpark } from '../components/MiniSpark';
import { subscribeEquityCredStatus, type EquityCredStatus } from '../data/equityCredStatus';
import { AlpacaCredentialsModal } from './AlpacaCredentialsModal';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';

// History bar count for each row's sparkline (32) — fetched at 1h tf.
// We grab a few extra (64) so 24h delta = last vs ~24 bars ago has data.
const SPARK_BARS = 32;
const HISTORY_FETCH = 64;

// ---------------------------------------------------------------------------
// P4.5 — Each row fetches via the provider registry (real Rust REST or mock
// fallback transparent to the row code). Watchlist sparklines are refreshed
// every 30s by `startSparklinePolling`; row mount handles the t=0 fetch.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-row derived market state (price, 24h pct, spark values, direction)
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AssetPanel(): JSX.Element {
  // Store wiring -----------------------------------------------------------
  const assets = useWatchlistStore((s) => s.assets);
  const removeAsset = useWatchlistStore((s) => s.removeAsset);
  // ADR-0009 — read the canonical active-asset tuple; legacy `activeSym` is
  // a derived mirror in the store and still safe to consult.
  const activeAsset = useAppStore((s) => s.activeAsset);
  const setActiveAsset = useAppStore((s) => s.setActiveAsset);
  const loadingPhase = useAppStore((s) => s.loadingPhase);
  const setAddAssetModalOpen = useAppStore((s) => s.setAddAssetModalOpen);

  // Dock open-state — drawer is open when openRight === 'watchlist'.
  const open = useDockStore((s) => s.openRight === 'watchlist');

  // Equity credential status — for showing warning dots on equity rows.
  const [equityCreds, setEquityCreds] = useState<EquityCredStatus>({ failed: false });
  useEffect(() => subscribeEquityCredStatus(setEquityCreds), []);
  // Clicking the warning dot opens the Alpaca credentials modal directly —
  // one-click recovery from the watchlist row.
  const [credModalOpen, setCredModalOpen] = useState(false);

  // Local state ------------------------------------------------------------
  const [searchQ, setSearchQ] = useState('');
  /**
   * Per-(sym, provider, quote) bars cache — ADR-0009 / Step 7. Keyed by the
   * canonical triple so BTC/USDT and BTC/USDC have independent cache slots.
   */
  const [marketByKey, setMarketByKey] = useState<Record<string, RowMarket>>({});
  /** Which row is currently hovered — used to reveal the × remove button. */
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  /** Canonical row id used as React key + as the marketByKey cache key. */
  const rowKey = useCallback(
    (a: { sym: string; provider: string; quote: string }) =>
      `${a.provider}:${a.sym}/${a.quote}`,
    [],
  );

  // Build a quick lookup from symbol to AssetMeta (for name + provider chip).
  const assetMetaMap = useMemo(() => {
    const m: Record<string, AssetMeta> = {};
    for (const a of ASSETS) m[a.sym] = a;
    return m;
  }, []);

  // -----------------------------------------------------------------------
  // Bar fetch — once-on-mount per asset entry. We don't refetch on watchlist
  // mutation for assets we already have; only for newly-added ones.
  // -----------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const missing = assets.filter((a) => !marketByKey[rowKey(a)]);
    if (missing.length === 0) return;
    Promise.all(
      missing.map((a) =>
        getProvider(a.provider as Provider, a.quote)
          .fetchHistory(a.sym, '1h', HISTORY_FETCH)
          .then((bars) => [rowKey(a), deriveMarket(bars)] as const),
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
        console.warn('[AssetPanel] history fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [assets, marketByKey, rowKey]);

  // P4.5 — Throttled sparkline polling. Refreshes 24h history for every row
  // every 30s so the sparkline + price + 24h pct stay live without any one
  // row triggering its own timer. The row's own initial fetch (above) covers
  // t=0; this just keeps the stream warm thereafter.
  //
  // Gated on `open`: the watchlist drawer is mount-stable, so without this gate
  // the 30s poller keeps hitting live providers (REST/IPC + rate-limit churn)
  // even while the drawer is CLOSED. We only poll while open; the once-on-mount
  // fetch above (which is NOT gated) keeps tiles populated, and re-opening
  // refetches on the next 30s tick. The chart's own selected-asset data is
  // separate (AppShell) and unaffected.
  useEffect(() => {
    if (!open) return;
    if (assets.length === 0) return;
    // Build a quick `sym → key` map so the poller's per-sym callback can write
    // back into the keyed cache. When the same sym lives on multiple
    // (provider, quote) tuples we only update the first match — the
    // multi-quote case will be resolved when Step 11 widens the poller to
    // pass the full key. (Hot path is single-quote-per-symbol in practice.)
    const symToKey = new Map<string, string>();
    for (const a of assets) {
      if (!symToKey.has(a.sym)) symToKey.set(a.sym, rowKey(a));
    }
    const stop = startSparklinePolling(assets, (sym, bars) => {
      const key = symToKey.get(sym);
      if (!key) return;
      setMarketByKey((prev) => ({ ...prev, [key]: deriveMarket(bars) }));
    });
    return () => stop();
  }, [open, assets, rowKey]);

  // Drop cached entries for assets that have been removed.
  useEffect(() => {
    setMarketByKey((prev) => {
      const keys = new Set(assets.map((a) => rowKey(a)));
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
  }, [assets, rowKey]);

  // -----------------------------------------------------------------------
  // Watchlist filtering by search query (P3-6).
  // -----------------------------------------------------------------------
  const filteredAssets = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => {
      const meta = assetMetaMap[a.sym];
      const name = meta?.name?.toLowerCase() ?? '';
      return (
        a.sym.toLowerCase().includes(q) ||
        a.quote.toLowerCase().includes(q) ||
        name.includes(q) ||
        a.provider.toLowerCase().includes(q)
      );
    });
  }, [assets, searchQ, assetMetaMap]);

  /** Stable id string for the active asset (matches `rowKey`). */
  const activeKey = activeAsset
    ? `${activeAsset.provider}:${activeAsset.sym}/${activeAsset.quote}`
    : null;

  return (
    <>
      <style>{`
        @keyframes row-active-pulse {
          0%   { transform: scale(1.0); }
          50%  { transform: scale(1.01); }
          100% { transform: scale(1.0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .asset-panel [data-active='true'] { animation: none !important; }
        }
      `}</style>
      <AlpacaCredentialsModal
        open={credModalOpen}
        onClose={() => setCredModalOpen(false)}
        onSaved={() => setCredModalOpen(false)}
      />
      <DockDrawer
        side="right"
        id="watchlist"
        ariaLabel="Watchlist"
        open={open}
      >
        {/* In-drawer header with title + close affordance */}
        <PanelHeader
          label="Watchlist"
          closeLabel="Close watchlist"
          closeTestId="asset-panel-close"
          onClose={() => useDockStore.getState().close('right')}
        />

        {/* Watchlist body — the same inner content as the old expanded section */}
        <div
          className="asset-panel"
          data-testid="asset-panel"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        >
          {/* Search bar (P3-6) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sp-8)',
              padding: 'var(--sp-8) var(--sp-12)',
              borderBottom: '1px solid var(--hairline)',
              color: 'var(--ink-3)',
              flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
              <circle cx="5" cy="5" r="3" />
              <path d="M10 10L7.5 7.5" />
            </svg>
            <input
              data-testid="asset-panel-search"
              placeholder="Search watchlist"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              style={{
                flex: 1,
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                color: 'var(--ink-0)',
              }}
            />
            {searchQ && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQ('')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--ink-3)',
                  fontSize: 14,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                ×
              </button>
            )}
          </div>

          {/* List rows (P3-7) */}
          <div
            data-testid="asset-panel-list"
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 4,
              scrollbarWidth: 'thin',
            }}
          >
            {filteredAssets.length === 0 && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--ink-3)',
                  letterSpacing: '0.04em',
                  textAlign: 'center',
                  padding: '22px 12px',
                }}
              >
                {searchQ
                  ? 'No match in watchlist'
                  : 'No assets — add one'}
              </div>
            )}
            {filteredAssets.map((a) => {
              const key = rowKey(a);
              const market = marketByKey[key];
              const isActive = activeKey === key;
              const isHover = hoverKey === key;
              // Direction-driven status dot keeps semantic meaning (up/down/flat);
              // brand color is reserved for the active-row pulse accent (existing
              // behavior). ADR-0009 (Step 8/11) — deterministic fallback tone for
              // catalog-added symbols that lack a curated ASSET_COLORS entry via
              // `hashToOklch`. The resolved color is held for future row-accent
              // tweaks; the dot itself stays direction-driven below.
              void (ASSET_COLORS[a.sym] ?? hashToOklch(`${a.sym}/${a.quote}`));
              const dotColor =
                market?.direction === 'up'
                  ? 'var(--up)'
                  : market?.direction === 'down'
                    ? 'var(--down)'
                    : 'var(--ink-2)';
              const chgColor =
                market && market.pct24h >= 0 ? 'var(--up)' : 'var(--down)';
              // TODO: per-asset accent. AssetMeta is frozen (A3) — no .color
              // field yet, so every active row resolves to var(--accent).
              const isTransitioning = loadingPhase === 'exit' || loadingPhase === 'loading';
              const rowStyle: React.CSSProperties = {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-8)',
                padding: '8px 8px 8px 10px',
                borderRadius: 10,
                cursor: 'pointer',
                transition: isTransitioning
                  ? 'background var(--t-fast), opacity var(--t-fast) var(--ease)'
                  : 'background var(--t-fast)',
                position: 'relative',
                background: isActive
                  ? 'color-mix(in oklab, var(--accent) 10%, transparent)'
                  : isHover ? 'var(--glass)' : 'transparent',
                // Active row during transition: glow ring instead of plain inset border.
                boxShadow: isActive && isTransitioning
                  ? [
                      '0 0 0 1px color-mix(in oklab, var(--accent) 60%, transparent)',
                      '0 0 22px color-mix(in oklab, var(--accent) 35%, transparent)',
                    ].join(', ')
                  : isActive
                  ? 'inset 0 0 0 1px color-mix(in oklab, var(--accent) 40%, transparent)'
                  : 'none',
                // Active row during transition: scale pop (CSS animation class).
                animation: isActive && isTransitioning
                  ? 'row-active-pulse 180ms var(--ease-spring)'
                  : undefined,
                // Inactive rows during transition: dim to 0.7.
                opacity: !isActive && isTransitioning ? 0.7 : 1,
              };
              const onActivate = (): void => {
                setActiveAsset({ sym: a.sym, provider: a.provider, quote: a.quote });
              };
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  // Step 7 testid scheme — collision-safe across providers + quotes.
                  data-testid={`watchlist-row-${a.provider}-${a.sym}-${a.quote}`}
                  data-active={isActive ? 'true' : 'false'}
                  onClick={onActivate}
                  onMouseEnter={() => setHoverKey(key)}
                  onMouseLeave={() => setHoverKey((s) => (s === key ? null : s))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onActivate();
                    }
                  }}
                  style={rowStyle}
                >
                  {/* L: dot + sym/provider */}
                  <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Warning dot for equity rows with missing credentials —
                        clickable shortcut to the credentials modal. */}
                    {a.provider === 'alpaca' && equityCreds.failed ? (
                      <button
                        type="button"
                        aria-label={`${a.sym}/${a.quote}: Alpaca credentials missing — click to configure`}
                        data-testid={`asset-row-warn-${a.provider}-${a.sym}-${a.quote}`}
                        title="Alpaca credentials missing — click to configure"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCredModalOpen(true);
                        }}
                        style={{
                          width: 12,
                          height: 12,
                          padding: 0,
                          display: 'grid',
                          placeItems: 'center',
                          flexShrink: 0,
                          borderRadius: '50%',
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--warn)',
                            boxShadow:
                              '0 0 8px color-mix(in oklab, var(--warn) 70%, transparent)',
                          }}
                        />
                      </button>
                    ) : (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: dotColor,
                        boxShadow: `0 0 8px ${dotColor}`,
                      }}
                    />
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05, minWidth: 0, overflow: 'hidden' }}>
                      <span
                        title={`${a.sym}/${a.quote}`}
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
                        {`${a.sym}/${a.quote}`}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9,
                          color: 'var(--ink-3)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.1em',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {PROVIDER_DISPLAY_NAME[a.provider as keyof typeof PROVIDER_DISPLAY_NAME] ?? a.provider}
                      </span>
                    </div>
                  </div>

                  {/* MID: sparkline */}
                  <MiniSpark
                    values={market?.spark ?? []}
                    width={56}
                    height={18}
                    direction={market?.direction ?? 'flat'}
                    strokeWidth={1.2}
                    opacity={0.85}
                  />

                  {/* R: price + 24h pct */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.15, flex: '0 0 90px', minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--ink-1)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {market ? fmtPrice(market.price) : '—'}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: chgColor,
                        whiteSpace: 'nowrap',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {market ? fmtPct(market.pct24h) : ''}
                    </span>
                  </div>

                  {/* Hover-reveal × button — visibility driven by row hover state. */}
                  <button
                    type="button"
                    aria-label={`Remove ${a.sym}/${a.quote}`}
                    data-testid={`asset-row-remove-${a.provider}-${a.sym}-${a.quote}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeAsset(a.sym, a.provider, a.quote);
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      color: 'var(--ink-3)',
                      fontSize: 14,
                      lineHeight: 1,
                      display: 'grid',
                      placeItems: 'center',
                      flex: '0 0 18px',
                      opacity: isHover ? 1 : 0,
                      transition: 'opacity var(--t-fast)',
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          {/* Add asset button (P3-8) */}
          <button
            type="button"
            data-testid="asset-panel-add-btn"
            onClick={() => setAddAssetModalOpen(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              margin: 4,
              padding: 9,
              borderRadius: 10,
              background: 'color-mix(in oklab, var(--accent) 15%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
              color: 'var(--ink-0)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.08em',
              whiteSpace: 'nowrap',
              transition: 'all var(--t-fast)',
              flexShrink: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>Add asset</span>
          </button>
        </div>
      </DockDrawer>
    </>
  );
}

export default AssetPanel;
