/**
 * src/chrome/Palette.tsx — Command Palette (P2.3 + Step 7 ADR-0009)
 *
 * A centered glass-heavy modal that opens when `useAppStore.paletteOpen === true`.
 *
 * Search is now powered by the SQLite FTS5 symbol catalog (`searchSymbols`)
 * rather than a Fuse.js scan of the 19-row `ASSETS` constant. Typing is
 * debounced 150ms (Step 6 alignment) and cursor index is held stable across
 * async result swaps so the highlight never jumps after a fetch.
 *
 * Empty-query browse uses the legacy `ASSETS` table as the curated featured
 * list (a single fetch round-trip per palette open isn't worth it for the
 * empty case). Step 10's `ensureFreshCatalog` keeps the cache warm so the
 * first typed character resolves against fresh data.
 *
 * Keyboard:
 *   - ArrowUp / ArrowDown  → move highlighted row
 *   - Enter                → select highlighted asset (sets activeAsset, closes)
 *   - Escape               → close without selecting (handled globally)
 *   - Mouse click on row   → select
 *   - Backdrop click       → close without selecting
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { ASSETS } from '../data/assets';
import { getProvider, searchSymbols } from '../data/providerRegistry';
import { defaultQuoteForProvider } from '../stores/useWatchlistStore';
import type { Bar, Provider } from '../data/MarketDataProvider';
import type { SymbolRow } from '../lib/db';
import { fmtPrice, fmtPct } from '../engine/indicators';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PreviewCache = Map<string, Bar[]>;

/**
 * Row shape after merging the FTS5 search result (`SymbolRow`) and the legacy
 * curated `ASSETS` entries used for the empty-query browse list. Carries the
 * canonical `(provider, sym, quote)` tuple plus a best-effort display name.
 */
interface PaletteRow {
  provider: Provider;
  sym: string;
  quote: string;
  name: string | null;
}

const DEBOUNCE_MS = 150;

function legacyAssetsToRows(): PaletteRow[] {
  return ASSETS.map((a) => ({
    provider: a.provider,
    sym: a.sym,
    quote: defaultQuoteForProvider(a.provider),
    name: a.name,
  }));
}

function catalogRowsToPaletteRows(rows: SymbolRow[]): PaletteRow[] {
  return rows.map((r) => ({
    provider: r.provider as Provider,
    sym: r.sym,
    quote: r.quote,
    name: r.name,
  }));
}

// ---------------------------------------------------------------------------
// Mini spark chart — 24-bar SVG polyline
// ---------------------------------------------------------------------------

function MiniSparkInline({ bars }: { bars: Bar[] }): JSX.Element {
  if (bars.length < 2) {
    return <svg width="56" height="20" />;
  }

  const closes = bars.map((b) => b.c);
  const mn = Math.min(...closes);
  const mx = Math.max(...closes);
  const range = mx - mn || mn * 0.001 || 1;

  const W = 56;
  const H = 20;
  const pts = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * W;
      const y = H - ((c - mn) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const lastClose = closes[closes.length - 1];
  const firstClose = closes[0];
  const color = lastClose >= firstClose ? 'var(--up)' : 'var(--down)';

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

function StatusDot({ up }: { up: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: up ? 'var(--up)' : 'var(--down)',
        flexShrink: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Asset row
// ---------------------------------------------------------------------------

interface RowProps {
  row: PaletteRow;
  bars24: Bar[];
  highlighted: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}

function AssetRow({
  row,
  bars24,
  highlighted,
  onMouseEnter,
  onClick,
}: RowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [highlighted]);

  const lastBar = bars24[bars24.length - 1];
  const firstBar = bars24[0];
  const price = lastBar?.c ?? 0;
  const chg =
    lastBar && firstBar && firstBar.c !== 0
      ? (lastBar.c - firstBar.c) / firstBar.c
      : 0;
  const up = chg >= 0;
  const pair = `${row.sym}/${row.quote}`;

  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={highlighted}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-8)',
        padding: 'var(--sp-8) var(--sp-12)',
        cursor: 'pointer',
        borderRadius: 'var(--r-8)',
        background: highlighted ? 'var(--glass-strong)' : 'transparent',
        transition: 'background var(--t-fast) var(--ease)',
      }}
    >
      <StatusDot up={up} />
      <span
        title={pair}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-body)',
          fontWeight: 500,
          color: 'var(--ink-0)',
          minWidth: 72,
          maxWidth: 120,
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {pair}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-body)',
          color: 'var(--ink-2)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.name ?? ''}
      </span>
      <MiniSparkInline bars={bars24} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-mono-sm)',
          color: 'var(--ink-1)',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 72,
          textAlign: 'right',
        }}
      >
        {bars24.length > 0 ? fmtPrice(price) : '—'}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
          color: up ? 'var(--up)' : 'var(--down)',
          background: up
            ? 'color-mix(in oklab, var(--up) 12%, transparent)'
            : 'color-mix(in oklab, var(--down) 12%, transparent)',
          borderRadius: 'var(--r-4)',
          padding: '1px 6px',
          minWidth: 56,
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {bars24.length > 0 ? fmtPct(chg) : ''}
      </span>
    </div>
  );
}

/** Skeleton placeholder used while in-flight search results haven't resolved
 *  — keeps the cursor index stable across async swaps (no row jump). */
function SkeletonRow(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-8)',
        padding: 'var(--sp-8) var(--sp-12)',
        opacity: 0.55,
      }}
      aria-hidden
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--ink-3)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          width: 110,
          height: 14,
          borderRadius: 'var(--r-4)',
          background: 'color-mix(in oklab, var(--ink-3) 22%, transparent)',
        }}
      />
      <span
        style={{
          flex: 1,
          height: 14,
          borderRadius: 'var(--r-4)',
          background: 'color-mix(in oklab, var(--ink-3) 14%, transparent)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export function Palette(): JSX.Element | null {
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setActiveAsset = useAppStore((s) => s.setActiveAsset);

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  // Featured (empty-query) browse list — fixed snapshot of curated assets.
  const featured = useMemo(legacyAssetsToRows, []);

  // Live search results (catalog-backed). `null` while loading; `[]` for
  // explicit empty match.
  const [searchResults, setSearchResults] = useState<PaletteRow[] | null>(null);
  const [searchInFlight, setSearchInFlight] = useState(false);

  // Preview bar cache keyed by `${provider}:${sym}/${quote}`.
  const [previewCache, setPreviewCache] = useState<PreviewCache>(new Map());

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus + reset on open.
  useEffect(() => {
    if (paletteOpen) {
      inputRef.current?.focus();
      setQuery('');
      setDebouncedQuery('');
      setCursor(0);
      setSearchResults(null);
    }
  }, [paletteOpen]);

  // 150ms debounce — sets `debouncedQuery` after the user pauses typing.
  useEffect(() => {
    if (!paletteOpen) return;
    const id = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, paletteOpen]);

  // Live catalog search — fires once `debouncedQuery` lands. Cursor index
  // is HELD STABLE across the async swap (the result-length clamp below is
  // the only sanitiser).
  useEffect(() => {
    if (!paletteOpen) return;
    const q = debouncedQuery;
    if (!q) {
      // Empty query → fall back to the curated featured list.
      setSearchResults(null);
      setSearchInFlight(false);
      return;
    }
    let cancelled = false;
    setSearchInFlight(true);
    searchSymbols(q, { limit: 30 })
      .then((rows) => {
        if (cancelled) return;
        setSearchResults(catalogRowsToPaletteRows(rows));
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('[Palette] searchSymbols failed', err);
        setSearchResults([]);
      })
      .finally(() => {
        if (cancelled) return;
        setSearchInFlight(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, paletteOpen]);

  // Active visible row list. While a search is in flight on a non-empty
  // query we keep the OLD rows on screen so the cursor never jumps — the
  // skeleton row at the tail signals "more arriving". When `debouncedQuery`
  // is empty, render the curated featured list.
  const filtered: PaletteRow[] = useMemo(() => {
    if (!debouncedQuery) return featured;
    return searchResults ?? [];
  }, [debouncedQuery, searchResults, featured]);

  // Clamp cursor inside the visible window when the list shrinks (e.g. a
  // narrower follow-up query). Do NOT reset to 0 on every swap.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, Math.max(0, filtered.length - 1))));
  }, [filtered.length]);

  // Preview-bar prefetch — load 24-bar 1h history for each visible row, once
  // per (provider, sym, quote). Mock-aware via providerRegistry.
  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    const rows = filtered;
    const missing = rows.filter(
      (r) => !previewCache.has(`${r.provider}:${r.sym}/${r.quote}`),
    );
    if (missing.length === 0) return;
    Promise.all(
      missing.map(async (r) => {
        try {
          const bars = await getProvider(r.provider, r.quote).fetchHistory(
            r.sym,
            '1h',
            24,
          );
          return [r, bars] as const;
        } catch {
          return [r, [] as Bar[]] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setPreviewCache((prev) => {
        const next = new Map(prev);
        for (const [r, bars] of pairs) {
          next.set(`${r.provider}:${r.sym}/${r.quote}`, bars);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [filtered, paletteOpen, previewCache]);

  const close = useCallback(() => {
    setPaletteOpen(false);
  }, [setPaletteOpen]);

  const pick = useCallback(
    (row: PaletteRow) => {
      setActiveAsset({ sym: row.sym, provider: row.provider, quote: row.quote });
      close();
    },
    [setActiveAsset, close],
  );

  if (!paletteOpen) return null;

  const handleInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = filtered[cursor];
      if (row) pick(row);
    }
    // Esc is handled by the global keyboard dispatcher.
  };

  return (
    <div
      role="presentation"
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-popover)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '14vh',
        background: 'var(--scrim)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      }}
    >
      <div
        role="dialog"
        aria-label="Asset search"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="glass-heavy overlay-enter"
        style={{
          width: 'min(540px, 90vw)',
          maxHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--surface-overlay)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-8)',
            padding: 'var(--sp-8) var(--sp-12)',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <svg
            aria-hidden
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            style={{ color: 'var(--ink-3)', flexShrink: 0 }}
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M14 14l-3.5-3.5" />
          </svg>

          <input
            ref={inputRef}
            type="text"
            placeholder="Search assets…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            aria-autocomplete="list"
            aria-controls="palette-results"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-body)',
              color: 'var(--ink-0)',
              caretColor: 'var(--accent)',
            }}
          />

          <span
            aria-hidden
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--ink-3)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-4)',
              padding: '1px 5px',
              flexShrink: 0,
            }}
          >
            ESC
          </span>
        </div>

        <div
          id="palette-results"
          role="listbox"
          aria-label="Assets"
          style={{
            overflowY: 'auto',
            padding: '4px 2px',
            flex: 1,
          }}
        >
          {filtered.length === 0 && !searchInFlight ? (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-body)',
                color: 'var(--ink-3)',
              }}
            >
              No assets match &ldquo;{debouncedQuery || query}&rdquo;
            </div>
          ) : (
            filtered.map((row, i) => {
              const cacheKey = `${row.provider}:${row.sym}/${row.quote}`;
              return (
                <AssetRow
                  key={cacheKey}
                  row={row}
                  bars24={previewCache.get(cacheKey) ?? []}
                  highlighted={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(row)}
                />
              );
            })
          )}
          {/* Skeleton row while a search is in flight — preserves cursor
              stability and signals more rows are arriving without forcing
              the highlight to jump. */}
          {searchInFlight && <SkeletonRow />}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-16)',
            padding: 'var(--sp-8) var(--sp-16)',
            borderTop: '1px solid var(--hairline)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--ink-3)',
          }}
        >
          <span><KbdKey>↑↓</KbdKey> navigate</span>
          <span><KbdKey>↵</KbdKey> open</span>
          <span><KbdKey>ESC</KbdKey> close</span>
        </div>
      </div>
    </div>
  );
}

function KbdKey({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--ink-2)',
        background: 'var(--glass)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-4)',
        padding: '0 4px',
        marginRight: 4,
      }}
    >
      {children}
    </span>
  );
}

export default Palette;
