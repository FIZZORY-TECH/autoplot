/**
 * src/panels/AddAssetModal.tsx — Add asset modal (Step 6 — dynamic catalog, ADR-0009).
 *
 * Backed by the SQLite-resident symbol catalog (Steps 0–5b). The 19-row
 * hardcoded ASSETS constant is gone; all browse/search routes through the
 * catalog Tauri commands + the FTS5-backed `searchSymbols` helper.
 *
 * Provider chips (Coinbase / Binance / Kraken / NASDAQ / NYSE — all active;
 * NASDAQ + NYSE route to the 'alpaca' provider per ADR-0008).
 *
 * Empty query: paged browse of the active chip's catalog (cap 200).
 * Non-empty query: cross-provider FTS5 search, 150ms debounce, grouped by
 * provider with a section header per group.
 *
 * Refresh button: `data-testid="add-asset-modal-refresh"` (top-right of chip
 * row). Forces `ensureFreshCatalog(provider, { force: true })` + re-fetches
 * the browse list. Shows a spinner pill while the request is in flight.
 *
 * Virtualization: inline windowing — only ~30 rows in the DOM at a time.
 * No new dependency; tracks `scrollTop` on the list container.
 *
 * "Showing N of M" footer for the capped browse list (hidden in search mode).
 *
 * Preserved testids: `add-asset-modal`, `add-asset-modal-search`.
 *
 * Binding visual source: app-design/project/panel.jsx AddAssetModal.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { useToastStore } from '../stores/useToastStore';
import {
  ASSET_COLORS,
  PROVIDER_DISPLAY_NAME,
  hashToOklch,
} from '../data/assets';
import type { Provider } from '../data/MarketDataProvider';
import {
  isEquityCredFailed,
  subscribeEquityCredStatus,
  type EquityCredStatus,
} from '../data/equityCredStatus';
import { AlpacaCredentialsModal } from './AlpacaCredentialsModal';
import { isTauriRuntime } from '../lib/runtime';
import {
  symbolCatalogList,
  symbolCatalogMeta,
} from '../lib/db';
import type { SymbolRow } from '../lib/db';
import { searchSymbols } from '../data/providerRegistry';
import {
  ensureFreshCatalog,
  providerHasCredentials,
  warmEquityCatalogIfConfigured,
} from '../data/symbolCatalog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Row height used by the inline windowing calculation (matches row CSS). */
const ROW_HEIGHT = 48;

/** Number of rows to render before/after the visible window. */
const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 25;

/** Max rows to request in browse mode. */
const BROWSE_LIMIT = 200;

/** Debounce delay for search input (ms). */
const SEARCH_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Provider chip metadata
// ---------------------------------------------------------------------------

interface ProviderChip {
  id: string;
  label: string;
  routesTo: Provider;
  cls: string;
  accent: string;
  enabled: boolean;
}

const PROVIDER_CHIPS: ProviderChip[] = [
  { id: 'coinbase',      label: 'Coinbase', routesTo: 'coinbase', cls: 'CRYPTO', accent: 'var(--accent)',  enabled: true },
  { id: 'binance',       label: 'Binance',  routesTo: 'binance',  cls: 'CRYPTO', accent: 'var(--warn)',    enabled: true },
  { id: 'kraken',        label: 'Kraken',   routesTo: 'kraken',   cls: 'CRYPTO', accent: 'var(--violet)',  enabled: true },
  { id: 'alpaca-nasdaq', label: 'NASDAQ',   routesTo: 'alpaca',   cls: 'STOCK',  accent: 'var(--emerald)', enabled: true },
  { id: 'alpaca-nyse',   label: 'NYSE',     routesTo: 'alpaca',   cls: 'STOCK',  accent: 'var(--emerald)', enabled: true },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a unix-ms timestamp as "X ago" relative to now. */
function formatAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'just now';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/** Return the color dot color for a row. */
function rowDotColor(sym: string, quote: string): string {
  return ASSET_COLORS[sym] ?? hashToOklch(`${sym}/${quote}`);
}

// ---------------------------------------------------------------------------
// Grouped search result type
// ---------------------------------------------------------------------------

interface SearchGroup {
  provider: string;
  rows: SymbolRow[];
}

function groupByProvider(rows: SymbolRow[]): SearchGroup[] {
  const map = new Map<string, SymbolRow[]>();
  for (const row of rows) {
    const list = map.get(row.provider);
    if (list) {
      list.push(row);
    } else {
      map.set(row.provider, [row]);
    }
  }
  return Array.from(map.entries()).map(([provider, r]) => ({ provider, rows: r }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddAssetModal(): JSX.Element | null {
  const open = useAppStore((s) => s.addAssetModalOpen);
  const setOpen = useAppStore((s) => s.setAddAssetModalOpen);
  const watchlist = useWatchlistStore((s) => s.assets);
  const addAsset = useWatchlistStore((s) => s.addAsset);

  // Provider chip state
  const [provider, setProvider] = useState<Provider>('binance');
  const [activeChipId, setActiveChipId] = useState<string>('binance');

  // Search query
  const [q, setQ] = useState('');

  // Browse cache — per-provider, each entry holds {rows, total}.
  const [browseCache, setBrowseCache] = useState<
    Partial<Record<Provider, { rows: SymbolRow[]; total: number }>>
  >({});

  // Search results (non-empty query)
  const [searchRows, setSearchRows] = useState<SymbolRow[]>([]);
  const [searchPending, setSearchPending] = useState(false);

  // Freshness text per provider
  const [freshnessText, setFreshnessText] = useState<string>('');

  // Refresh state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Credentials modal
  const [credModalOpen, setCredModalOpen] = useState(false);

  // Equity credential status — subscribed so the "Connect Alpaca" gate in the
  // equity browse section appears/clears reactively when the user connects.
  const [equityCreds, setEquityCreds] = useState<EquityCredStatus>({ failed: false });
  useEffect(() => subscribeEquityCredStatus(setEquityCreds), []);

  // Whether Alpaca credentials are configured (env override or credentials.json).
  // `null` = not yet checked (avoid flashing the gate during the initial probe).
  // Unlike `equityCreds.failed`, this is a POSITIVE signal that does not require
  // a prior failed price fetch — so it works the moment the picker opens, in
  // both search and browse modes. Re-checked on open and after a successful
  // save (the `connectedAt` pulse from `setEquityConnected`).
  const [alpacaConfigured, setAlpacaConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) return;
    // `providerHasCredentials` returns false outside Tauri; the gate is also
    // `isTauriRuntime()`-gated, so browser-mode never shows it regardless.
    let cancelled = false;
    void providerHasCredentials('alpaca').then((has) => {
      if (!cancelled) setAlpacaConfigured(has);
    });
    return () => { cancelled = true; };
  }, [open, equityCreds.connectedAt]);

  // Hover tracking for add buttons (keyed by `${provider}__${sym}__${quote}`)
  const [hoveredAddKey, setHoveredAddKey] = useState<string | null>(null);

  // Scroll tracking for inline windowing
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------------
  // Freshness display
  // ---------------------------------------------------------------------------

  /** Re-read freshness metadata for the active provider. */
  const refreshFreshnessText = useCallback(async () => {
    try {
      const meta = await symbolCatalogMeta();
      const entry = meta.find((m) => m.provider === provider);
      if (entry && entry.fetched_at > 0) {
        setFreshnessText(`Updated ${formatAgo(entry.fetched_at)}`);
      } else {
        setFreshnessText('');
      }
    } catch {
      setFreshnessText('');
    }
  }, [provider]);

  // Re-read freshness when the modal gains focus
  useEffect(() => {
    if (!open) return;
    void refreshFreshnessText();
    const onFocus = () => { void refreshFreshnessText(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, refreshFreshnessText]);

  // ---------------------------------------------------------------------------
  // Browse fetch — on mount + chip switch
  // ---------------------------------------------------------------------------

  const fetchBrowse = useCallback(
    async (p: Provider) => {
      try {
        const result = await symbolCatalogList(p, BROWSE_LIMIT, 0);
        setBrowseCache((prev) => ({ ...prev, [p]: result }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[AddAssetModal] symbolCatalogList failed', err);
      }
    },
    [],
  );

  /** Run ensureFreshCatalog + re-fetch browse for current provider. */
  const ensureAndFetch = useCallback(
    async (p: Provider, force?: boolean) => {
      try {
        await ensureFreshCatalog(p, force ? { force: true } : undefined);
      } catch {
        // ensureFreshCatalog already logs; browse fetch below will return empty.
      }
      await fetchBrowse(p);
      await refreshFreshnessText();
    },
    [fetchBrowse, refreshFreshnessText],
  );

  // Trigger on modal open and on chip switch.
  useEffect(() => {
    if (!open) return;
    void ensureAndFetch(provider);
  }, [open, provider, ensureAndFetch]);

  // On open, also warm the Alpaca equity catalog (if creds are configured), even
  // when the active chip is crypto — so a stock search inside the modal finds
  // results without first clicking the NASDAQ/NYSE browse chip. Idempotent /
  // TTL-gated; no-op without creds or outside Tauri.
  useEffect(() => {
    if (!open) return;
    void warmEquityCatalogIfConfigured();
  }, [open]);

  // ---------------------------------------------------------------------------
  // Reset on modal open
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (open) {
      setQ('');
      setSearchRows([]);
      setRefreshError(null);
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // ---------------------------------------------------------------------------
  // Esc-to-close
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // ---------------------------------------------------------------------------
  // Debounced cross-provider search (150ms)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setSearchRows([]);
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    let cancelled = false;
    const id = window.setTimeout(() => {
      searchSymbols(trimmed, { limit: 50 })
        .then((rows) => {
          if (cancelled) return;
          setSearchRows(rows);
          setSearchPending(false);
        })
        .catch((err) => {
          if (cancelled) return;
          // eslint-disable-next-line no-console
          console.warn('[AddAssetModal] searchSymbols failed', err);
          setSearchRows([]);
          setSearchPending(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [q, open]);

  // ---------------------------------------------------------------------------
  // Watchlist lookup set (triple-keyed)
  // ---------------------------------------------------------------------------

  const watchlistSet = useMemo(
    () => new Set(watchlist.map((a) => `${a.provider}__${a.sym}__${a.quote}`)),
    [watchlist],
  );

  const isInWatchlist = useCallback(
    (row: SymbolRow) => watchlistSet.has(`${row.provider}__${row.sym}__${row.quote}`),
    [watchlistSet],
  );

  const onAdd = useCallback(
    (row: SymbolRow) => {
      void addAsset(row.sym, row.provider, row.quote);
    },
    [addAsset],
  );

  // ---------------------------------------------------------------------------
  // Chip switch handler
  // ---------------------------------------------------------------------------

  const onChipClick = useCallback(
    (chip: ProviderChip) => {
      if (!chip.enabled) return;
      // Always switch to the chip; if Alpaca creds are missing the in-list
      // "Connect Alpaca" gate (showEquityGate) guides the user from here, which
      // keeps browse and search behaviour consistent.
      setActiveChipId(chip.id);
      setProvider(chip.routesTo);
      setRefreshError(null);
      // Reset scroll synchronously
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
      setScrollTop(0);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Refresh button handler
  // ---------------------------------------------------------------------------

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await ensureAndFetch(provider, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn('[AddAssetModal] refresh failed:', err);
      useToastStore.getState().push({ kind: 'warn', title: 'Catalog refresh failed', detail: msg });
      setRefreshError(msg);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, ensureAndFetch, provider]);

  // ---------------------------------------------------------------------------
  // Browse list for active provider
  // ---------------------------------------------------------------------------

  const browseEntry = browseCache[provider];
  const browseRows: SymbolRow[] = browseEntry?.rows ?? [];
  const browseTotal: number = browseEntry?.total ?? 0;

  // ---------------------------------------------------------------------------
  // Search grouping
  // ---------------------------------------------------------------------------

  const searchGroups = useMemo(() => groupByProvider(searchRows), [searchRows]);

  // ---------------------------------------------------------------------------
  // Inline windowing (browse mode only)
  // ---------------------------------------------------------------------------

  const isSearchMode = q.trim().length > 0;

  // Alpaca creds absent — positive signal (Tauri-only). `=== false` so the
  // brief unknown (null) state during the initial probe doesn't flash the gate.
  // `equityCreds.failed` / `isEquityCredFailed()` are kept as an OR so a prior
  // price-fetch failure also surfaces the CTA even if the probe is mid-flight.
  const equityNotConfigured =
    isTauriRuntime() &&
    (alpacaConfigured === false || equityCreds.failed || isEquityCredFailed());

  // Equity gate (browse mode, Alpaca-backed NASDAQ/NYSE chips): show a clear
  // "Connect Alpaca" CTA instead of a misleading "No assets in catalog" line.
  const showEquityGate = !isSearchMode && provider === 'alpaca' && equityNotConfigured;

  // Search mode: equities can't appear in results without creds, so surface the
  // same CTA whenever the user searches and Alpaca isn't connected — this is the
  // path a user hits typing "IONQ" before connecting.
  const showSearchEquityHint = isSearchMode && !searchPending && equityNotConfigured;

  // Shared "Connect Alpaca" CTA — rendered in browse mode (Alpaca chip, no
  // creds) AND in search mode (any stock search before connecting). The two
  // call sites are mutually exclusive (browse vs search), so the button testid
  // is never duplicated in the DOM.
  const renderEquityConnectCTA = (opts: { subtitle: string; testid: string }) => (
    <div
      data-testid={opts.testid}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--sp-16)',
        textAlign: 'center',
        padding: 'var(--sp-32) var(--sp-22)',
      }}
    >
      {/* Concentric pulsing rings — mirrors EquityChartEmpty. */}
      <div
        aria-hidden="true"
        style={{ position: 'relative', width: 44, height: 44, display: 'grid', placeItems: 'center' }}
      >
        <span
          className="addmodal-equity-ring addmodal-equity-ring--1"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '1px solid color-mix(in oklab, var(--warn) 30%, transparent)',
          }}
        />
        <span
          className="addmodal-equity-ring addmodal-equity-ring--2"
          style={{
            position: 'absolute',
            inset: 7,
            borderRadius: '50%',
            border: '1px solid color-mix(in oklab, var(--warn) 45%, transparent)',
          }}
        />
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: 'var(--warn)',
            boxShadow: '0 0 13px color-mix(in oklab, var(--warn) 70%, transparent)',
          }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-6)' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-eyebrow)',
            letterSpacing: 'var(--tracking-eyebrow)',
            textTransform: 'uppercase',
            color: 'var(--warn)',
          }}
        >
          Alpaca · No credentials
        </span>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--ink-2)',
            maxWidth: 320,
          }}
        >
          {opts.subtitle}
        </span>
      </div>
      <button
        type="button"
        data-testid="add-asset-equity-connect"
        onClick={() => setCredModalOpen(true)}
        className="chart-empty-cta"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--sp-8)',
          padding: '9px 18px',
          borderRadius: 'var(--r-pill)',
          background: 'color-mix(in oklab, var(--emerald) 22%, transparent)',
          border: '1px solid color-mix(in oklab, var(--emerald) 55%, transparent)',
          color: 'var(--ink-0)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          transition: 'all var(--t-fast) var(--ease)',
        }}
      >
        Connect Alpaca
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2 5h6M6 2l3 3-3 3" />
        </svg>
      </button>
    </div>
  );

  const windowedRows = useMemo((): Array<{ row: SymbolRow; top: number }> => {
    if (isSearchMode || browseRows.length === 0) return [];
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - WINDOW_BEFORE);
    const end = Math.min(browseRows.length, start + WINDOW_BEFORE + WINDOW_AFTER);
    return browseRows.slice(start, end).map((row, i) => ({
      row,
      top: (start + i) * ROW_HEIGHT,
    }));
  }, [isSearchMode, browseRows, scrollTop]);

  const containerHeight = isSearchMode ? 'auto' : browseRows.length * ROW_HEIGHT;

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  /** Renders a single catalog row. */
  function renderRow(row: SymbolRow, style?: CSSProperties): JSX.Element {
    const added = isInWatchlist(row);
    const addKey = `${row.provider}__${row.sym}__${row.quote}`;
    const isHovered = !added && hoveredAddKey === addKey;
    const dotColor = rowDotColor(row.sym, row.quote);
    const displayName = row.name ?? row.sym;
    const providerLabel =
      PROVIDER_DISPLAY_NAME[row.provider as Provider] ?? row.provider;

    return (
      <div
        key={addKey}
        data-testid={`add-asset-row-${row.provider}-${row.sym}-${row.quote}`}
        style={{
          position: style?.position ?? 'relative',
          top: style?.top,
          left: style?.left,
          right: style?.right,
          display: 'grid',
          gridTemplateColumns: '14px minmax(0,14ch) 1fr 76px 28px',
          alignItems: 'center',
          gap: 12,
          padding: '0 14px',
          height: ROW_HEIGHT,
          borderRadius: 10,
          transition: 'background var(--t-fast)',
          boxSizing: 'border-box',
        }}
      >
        {/* Colored dot */}
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
            boxShadow: `0 0 8px ${dotColor}`,
            flexShrink: 0,
          }}
        />

        {/* Sym/quote pair with ellipsis */}
        <span
          title={`${row.sym}/${row.quote}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--ink-0)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '14ch',
            display: 'block',
          }}
        >
          <strong>{row.sym}</strong>
          <span style={{ color: 'var(--ink-2)' }}>/{row.quote}</span>
        </span>

        {/* Name + provider badge */}
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            color: 'var(--ink-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              padding: '3px 7px',
              border: '1px solid var(--hairline)',
              borderRadius: 999,
              flexShrink: 0,
            }}
          >
            {providerLabel}
          </span>
        </span>

        {/* Spacer */}
        <span />

        {/* Add button */}
        <button
          type="button"
          data-testid={`add-asset-row-${row.provider}-${row.sym}-${row.quote}`}
          aria-label={added ? `${row.sym}/${row.quote} already in watchlist` : `Add ${row.sym}/${row.quote}`}
          disabled={added}
          onClick={() => { if (!added) onAdd(row); }}
          onMouseEnter={() => { if (!added) setHoveredAddKey(addKey); }}
          onMouseLeave={() => setHoveredAddKey((k) => (k === addKey ? null : k))}
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            background: added
              ? 'transparent'
              : isHovered
                ? 'color-mix(in oklab, var(--accent) 35%, transparent)'
                : 'color-mix(in oklab, var(--accent) 20%, transparent)',
            border: `1px solid ${added
              ? 'color-mix(in oklab, var(--up) 30%, transparent)'
              : 'color-mix(in oklab, var(--accent) 35%, transparent)'}`,
            color: added ? 'var(--up)' : 'var(--ink-0)',
            fontSize: 14,
            display: 'grid',
            placeItems: 'center',
            cursor: added ? 'default' : 'pointer',
            transform: isHovered ? 'scale(1.08)' : 'scale(1)',
            transition: 'all var(--t-fast)',
          }}
        >
          {added ? '✓' : '+'}
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Early return when closed
  // ---------------------------------------------------------------------------

  if (!open) return null;

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const scrimStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    background: 'color-mix(in oklab, black 30%, transparent)',
    backdropFilter: 'blur(18px) saturate(120%)',
    WebkitBackdropFilter: 'blur(18px) saturate(120%)',
    display: 'grid',
    placeItems: 'start center',
    paddingTop: '14vh',
    animation: 'addmodal-scrim-in var(--t-med) var(--ease)',
  };

  const modalStyle: CSSProperties = {
    width: 'min(720px, 92vw)',
    maxHeight: '78vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'color-mix(in oklab, var(--bg-1) 72%, transparent)',
    border: '1px solid var(--hairline-2)',
    borderRadius: 'var(--r-22)',
    overflow: 'hidden',
    boxShadow:
      '0 1px 0 0 color-mix(in oklab, white 8%, transparent) inset, 0 60px 120px -30px color-mix(in oklab, black 80%, transparent)',
    backdropFilter: 'blur(40px) saturate(180%)',
    WebkitBackdropFilter: 'blur(40px) saturate(180%)',
    animation: 'addmodal-in 360ms var(--ease-spring)',
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <AlpacaCredentialsModal
        open={credModalOpen}
        onClose={() => setCredModalOpen(false)}
        onSaved={() => setCredModalOpen(false)}
      />
      <div
        className="addmodal-scrim"
        data-testid="add-asset-modal-scrim"
        onClick={() => setOpen(false)}
        style={scrimStyle}
      >
        <div
          className="glass-strong addmodal"
          data-testid="add-asset-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Add asset"
          onClick={(e) => e.stopPropagation()}
          style={modalStyle}
        >
          {/* ----------------------------------------------------------------
            Header
          ---------------------------------------------------------------- */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 'var(--sp-16) var(--sp-22)',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 15,
                letterSpacing: '-0.01em',
                color: 'var(--ink-0)',
              }}
            >
              Add asset
            </div>
            <button
              type="button"
              aria-label="Close"
              data-testid="add-asset-modal-close"
              onClick={() => setOpen(false)}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                color: 'var(--ink-3)',
                display: 'grid',
                placeItems: 'center',
                transition: 'all var(--t-fast)',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M2 2l6 6M8 2l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* ----------------------------------------------------------------
            Search row
          ---------------------------------------------------------------- */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sp-12)',
              padding: 'var(--sp-12) var(--sp-22)',
              borderBottom: '1px solid var(--hairline)',
              color: 'var(--ink-3)',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="3.6" />
              <path d="M12 12L9 9" />
            </svg>
            <input
              ref={inputRef}
              data-testid="add-asset-modal-search"
              placeholder="Search · BTC · ETH · AAPL · MSFT"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{
                flex: 1,
                fontFamily: 'var(--font-sans)',
                fontSize: 14,
                color: 'var(--ink-0)',
              }}
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="Clear search"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.1em',
                  color: 'var(--ink-3)',
                  textTransform: 'uppercase',
                }}
              >
                clear
              </button>
            )}
          </div>

          {/* ----------------------------------------------------------------
            Provider chips + refresh button — only when not searching
          ---------------------------------------------------------------- */}
          {!q.trim() && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '14px 22px',
                flexWrap: 'wrap',
                borderBottom: '1px solid var(--hairline)',
              }}
            >
              {/* Chips */}
              <div style={{ display: 'flex', gap: 8, flex: 1, flexWrap: 'wrap' }}>
                {PROVIDER_CHIPS.map((p) => {
                  const active = p.enabled && activeChipId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`add-asset-provider-${p.label.toLowerCase()}`}
                      data-active={active ? 'true' : 'false'}
                      aria-pressed={active}
                      title={`Show ${p.label} assets`}
                      onClick={() => onChipClick(p)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 12px 7px 10px',
                        borderRadius: 999,
                        background: active
                          ? `color-mix(in oklab, ${p.accent} 18%, transparent)`
                          : 'color-mix(in oklab, var(--bg-0) 30%, transparent)',
                        border: `1px solid ${active
                          ? `color-mix(in oklab, ${p.accent} 50%, transparent)`
                          : 'var(--hairline)'}`,
                        color: active ? 'var(--ink-0)' : 'var(--ink-2)',
                        cursor: 'pointer',
                        transition: 'all var(--t-fast)',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: p.accent,
                          boxShadow: `0 0 8px ${p.accent}`,
                        }}
                      />
                      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12 }}>
                        {p.label}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9,
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase',
                          color: 'var(--ink-3)',
                        }}
                      >
                        {p.cls}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Refresh button */}
              <button
                type="button"
                data-testid="add-asset-modal-refresh"
                aria-label="Refresh catalog"
                onClick={() => { void onRefresh(); }}
                disabled={refreshing}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--hairline)',
                  background: 'color-mix(in oklab, var(--bg-0) 30%, transparent)',
                  color: refreshing ? 'var(--ink-3)' : 'var(--ink-2)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  cursor: refreshing ? 'not-allowed' : 'pointer',
                  transition: 'all var(--t-fast)',
                  flexShrink: 0,
                }}
              >
                {refreshing ? (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      border: '1.5px solid var(--ink-3)',
                      borderTopColor: 'var(--accent)',
                      animation: 'catalog-spin 0.7s linear infinite',
                      display: 'inline-block',
                    }}
                  />
                ) : (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M9 5a4 4 0 1 1-1.5-3.1" />
                    <path d="M9 1v3H6" />
                  </svg>
                )}
                {freshnessText || 'Refresh'}
              </button>
            </div>
          )}

          {/* Error banner */}
          {refreshError && !q.trim() && (
            <div
              style={{
                padding: '6px 22px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--down)',
                borderBottom: '1px solid var(--hairline)',
              }}
            >
              <span data-testid="catalog-error">{refreshError}</span>
            </div>
          )}

          {/* ----------------------------------------------------------------
            Result list
          ---------------------------------------------------------------- */}
          <div
            ref={scrollRef}
            data-testid="add-asset-modal-list"
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 6,
              scrollbarWidth: 'thin',
            }}
          >
            {/* ----- SEARCH MODE ----- */}
            {isSearchMode && (
              <>
                {/* Skeleton row while search is in flight */}
                {searchPending && (
                  <div
                    style={{
                      height: ROW_HEIGHT,
                      borderRadius: 10,
                      background: 'color-mix(in oklab, var(--bg-1) 40%, transparent)',
                      animation: 'catalog-pulse 1.2s ease-in-out infinite',
                      marginBottom: 2,
                    }}
                    aria-hidden="true"
                  />
                )}

                {!searchPending && searchRows.length === 0 && !showSearchEquityHint && (
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
                    No matches
                  </div>
                )}

                {searchGroups.map((group) => (
                  <div key={group.provider}>
                    {/* Group header */}
                    <div
                      data-testid={`add-asset-group-${group.provider}`}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        color: 'var(--ink-3)',
                        padding: '8px 14px 4px',
                      }}
                    >
                      {PROVIDER_DISPLAY_NAME[group.provider as Provider] ?? group.provider}
                    </div>
                    {group.rows.map((row) => renderRow(row))}
                  </div>
                ))}

                {/* Stocks need Alpaca — surface the Connect CTA when searching
                    before credentials are connected (the "IONQ" path). */}
                {showSearchEquityHint &&
                  renderEquityConnectCTA({
                    subtitle:
                      'Stocks (NASDAQ & NYSE) need Alpaca. Connect your account to search and add them.',
                    testid: 'add-asset-equity-gate-search',
                  })}
              </>
            )}

            {/* ----- BROWSE MODE (inline windowing) ----- */}
            {!isSearchMode && (
              <>
                {/* Equity gate — Connect Alpaca CTA in place of an empty list. */}
                {showEquityGate &&
                  renderEquityConnectCTA({
                    subtitle:
                      'Connect your Alpaca account to browse and add live NASDAQ & NYSE symbols.',
                    testid: 'add-asset-equity-gate',
                  })}

                {!showEquityGate && browseRows.length === 0 && (
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
                    {browseEntry === undefined ? 'Loading…' : 'No assets in catalog'}
                  </div>
                )}

                {!showEquityGate && browseRows.length > 0 && (
                  <div
                    style={{
                      position: 'relative',
                      height: containerHeight,
                    }}
                  >
                    {windowedRows.map(({ row, top }) =>
                      renderRow(row, { position: 'absolute', top, left: 0, right: 0 }),
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ----------------------------------------------------------------
            "Showing N of M" footer (browse mode only, when list is capped)
          ---------------------------------------------------------------- */}
          {!isSearchMode && !showEquityGate && browseRows.length > 0 && (
            <div
              data-testid="add-asset-list-footer"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--ink-3)',
                letterSpacing: '0.04em',
                padding: '8px 22px',
                borderTop: '1px solid var(--hairline)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Showing {browseRows.length} of {browseTotal.toLocaleString()}{' '}
              <span title="catalog pagination is TODO P8">…</span>
            </div>
          )}

          {/* ----------------------------------------------------------------
            Inline keyframes
          ---------------------------------------------------------------- */}
          <style>{`
            @keyframes addmodal-scrim-in {
              from {
                opacity: 0;
                backdrop-filter: blur(0) saturate(100%);
                -webkit-backdrop-filter: blur(0) saturate(100%);
              }
              to {
                opacity: 1;
                backdrop-filter: blur(18px) saturate(120%);
                -webkit-backdrop-filter: blur(18px) saturate(120%);
              }
            }
            @keyframes addmodal-in {
              from { opacity: 0; transform: translateY(-8px) scale(0.98); }
              to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes catalog-spin {
              to { transform: rotate(360deg); }
            }
            @keyframes catalog-pulse {
              0%, 100% { opacity: 0.4; }
              50%       { opacity: 0.7; }
            }
            @keyframes addmodal-equity-ring-pulse {
              0%   { transform: scale(1);    opacity: 0.9; }
              70%  { transform: scale(1.35); opacity: 0;   }
              100% { transform: scale(1.35); opacity: 0;   }
            }
            .addmodal-equity-ring {
              animation: addmodal-equity-ring-pulse 2.4s var(--ease) infinite;
            }
            .addmodal-equity-ring--2 { animation-delay: 0.6s; }
            .chart-empty-cta:hover {
              background: color-mix(in oklab, var(--emerald) 32%, transparent);
              box-shadow: 0 0 28px color-mix(in oklab, var(--emerald) 45%, transparent);
            }
            @media (prefers-reduced-motion: reduce) {
              .addmodal-equity-ring { animation: none; opacity: 0.55; }
            }
          `}</style>
        </div>
      </div>
    </>
  );
}

export default AddAssetModal;
