/**
 * src/panels/AddHoldingModal.tsx — Add / Edit holding modal.
 *
 * Mirrors AddAssetModal.tsx structure and styling:
 *   - Scrim + centered glass card + entrance spring.
 *   - Esc-to-dismiss.
 *   - Provider chip picker so only provider-tradable symbols are browsable.
 *   - Fields: sym/provider picker, quantity, avg cost per unit, optional note.
 *
 * Two modes:
 *   - Add / Add-to-position: calls `addLot` (weighted-avg blend).
 *   - Edit: calls `upsertHolding` with the full row.
 *
 * On submit: pushes a toast and closes.
 * Validation: qty > 0 and avg_cost >= 0; submit is disabled otherwise.
 *
 * Design tokens: only pre-existing tokens from tokens.css / glass.css.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { usePortfolioStore } from '../stores/usePortfolioStore';
import { defaultQuoteForProvider } from '../stores/useWatchlistStore';
import type { HoldingRow } from '../stores/usePortfolioStore';
import type { Provider } from '../data/MarketDataProvider';
import { ASSET_COLORS, PROVIDER_DISPLAY_NAME, hashToOklch } from '../data/assets';
import { useToastStore } from '../stores/useToastStore';
import { isTauriRuntime } from '../lib/runtime';
import { symbolCatalogList } from '../lib/db';
import type { SymbolRow } from '../lib/db';
import { searchSymbols } from '../data/providerRegistry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 44;
const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 20;
const BROWSE_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Provider chips (same set as AddAssetModal, minus NASDAQ/NYSE when not Tauri)
// ---------------------------------------------------------------------------

interface ProviderChip {
  id: string;
  label: string;
  provider: Provider;
  accent: string;
}

const PROVIDER_CHIPS: ProviderChip[] = [
  { id: 'coinbase', label: 'Coinbase', provider: 'coinbase', accent: 'var(--accent)' },
  { id: 'binance',  label: 'Binance',  provider: 'binance',  accent: 'var(--warn)' },
  { id: 'kraken',   label: 'Kraken',   provider: 'kraken',   accent: 'var(--violet)' },
  { id: 'alpaca',   label: 'Alpaca',   provider: 'alpaca',   accent: 'var(--emerald)' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowDotColor(sym: string, quote: string): string {
  return ASSET_COLORS[sym] ?? hashToOklch(`${sym}/${quote}`);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AddHoldingModalProps {
  open: boolean;
  /** When set, pre-fills form for editing. Otherwise "Add" mode. */
  editHolding: HoldingRow | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddHoldingModal({ open, editHolding, onClose }: AddHoldingModalProps): JSX.Element | null {
  const addLot = usePortfolioStore((s) => s.addLot);
  const upsertHolding = usePortfolioStore((s) => s.upsertHolding);

  const isEdit = editHolding !== null;

  // Provider + symbol picker state. The active chip is derived from
  // `selectedProvider` (chip.id === chip.provider 1:1 in PROVIDER_CHIPS).
  const [selectedProvider, setSelectedProvider] = useState<Provider>('binance');
  const [selectedSym, setSelectedSym] = useState<string>('');
  const [selectedQuote, setSelectedQuote] = useState<string>('');
  const [selectedClass, setSelectedClass] = useState<'crypto' | 'equity'>('crypto');

  // Form fields
  const [qty, setQty] = useState<string>('');
  const [avgCost, setAvgCost] = useState<string>('');
  const [note, setNote] = useState<string>('');

  // Symbol picker state
  const [symQ, setSymQ] = useState('');
  const [browseRows, setBrowseRows] = useState<SymbolRow[]>([]);
  const [browseTotal, setBrowseTotal] = useState(0);
  const [searchRows, setSearchRows] = useState<SymbolRow[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  // Submitting state
  const [submitting, setSubmitting] = useState(false);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const qtyNum = parseFloat(qty);
  const avgCostNum = parseFloat(avgCost);
  const isQtyValid = !isNaN(qtyNum) && qtyNum > 0;
  const isAvgCostValid = !isNaN(avgCostNum) && avgCostNum >= 0;
  const isSymSelected = selectedSym.length > 0 && selectedQuote.length > 0;
  const canSubmit = isQtyValid && isAvgCostValid && isSymSelected && !submitting;

  // ---------------------------------------------------------------------------
  // Pre-fill when editing
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    if (editHolding) {
      setSelectedProvider(editHolding.provider as Provider);
      setSelectedSym(editHolding.sym);
      setSelectedQuote(editHolding.quote);
      setSelectedClass(editHolding.asset_class === 'equity' ? 'equity' : 'crypto');
      setQty(String(editHolding.qty));
      setAvgCost(String(editHolding.avg_cost));
      setNote(editHolding.note ?? '');
    } else {
      // Reset for Add mode
      setSelectedSym('');
      setSelectedQuote('');
      setQty('');
      setAvgCost('');
      setNote('');
      setSymQ('');
    }
  }, [open, editHolding]);

  // ---------------------------------------------------------------------------
  // Browse fetch — fires on modal open and on provider chip switch
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    symbolCatalogList(selectedProvider, BROWSE_LIMIT, 0)
      .then((result) => {
        if (cancelled) return;
        setBrowseRows(result.rows);
        setBrowseTotal(result.total);
      })
      .catch(() => {
        if (cancelled) return;
        setBrowseRows([]);
        setBrowseTotal(0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedProvider]);

  // ---------------------------------------------------------------------------
  // Debounced search
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const trimmed = symQ.trim();
    if (!trimmed) {
      setSearchRows([]);
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    let cancelled = false;
    const id = window.setTimeout(() => {
      searchSymbols(trimmed, { limit: 40 })
        .then((rows) => {
          if (cancelled) return;
          setSearchRows(rows);
          setSearchPending(false);
        })
        .catch(() => {
          if (cancelled) return;
          setSearchRows([]);
          setSearchPending(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [symQ, open]);

  // ---------------------------------------------------------------------------
  // Reset scroll + focus on open
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (open) {
      setScrollTop(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [open, selectedProvider]);

  // ---------------------------------------------------------------------------
  // Esc-to-close
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ---------------------------------------------------------------------------
  // Inline windowing (browse mode)
  // ---------------------------------------------------------------------------
  const isSearchMode = symQ.trim().length > 0;

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
  // Submit
  // ---------------------------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      if (isEdit && editHolding) {
        await upsertHolding({
          ...editHolding,
          sym: selectedSym,
          provider: selectedProvider,
          quote: selectedQuote,
          qty: qtyNum,
          avg_cost: avgCostNum,
          note: note.trim() || null,
          updated_at: Date.now(),
        });
        useToastStore.getState().push({
          kind: 'info',
          title: `${selectedSym} updated`,
          detail: `${selectedSym}/${selectedQuote} holding updated`,
        });
      } else {
        await addLot({
          sym: selectedSym,
          provider: selectedProvider,
          quote: selectedQuote,
          asset_class: selectedClass,
          add_qty: qtyNum,
          add_price: avgCostNum,
          note: note.trim() || null,
        });
        useToastStore.getState().push({
          kind: 'info',
          title: `${selectedSym} added`,
          detail: `${qtyNum} ${selectedSym} at ${avgCostNum} added to portfolio`,
        });
      }
      onClose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[AddHoldingModal] submit failed', err);
      useToastStore.getState().push({
        kind: 'error',
        title: 'Failed to save holding',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit, isEdit, editHolding, upsertHolding, addLot,
    selectedSym, selectedProvider, selectedQuote, selectedClass,
    qtyNum, avgCostNum, note, onClose,
  ]);

  // ---------------------------------------------------------------------------
  // Symbol row renderer
  // ---------------------------------------------------------------------------
  function renderSymRow(row: SymbolRow, style?: CSSProperties): JSX.Element {
    const isSelected = row.sym === selectedSym && row.quote === selectedQuote && row.provider === selectedProvider;
    const dotColor = rowDotColor(row.sym, row.quote);
    const providerLabel = PROVIDER_DISPLAY_NAME[row.provider as Provider] ?? row.provider;
    return (
      <div
        key={`${row.provider}__${row.sym}__${row.quote}`}
        onClick={() => {
          setSelectedSym(row.sym);
          setSelectedQuote(row.quote || defaultQuoteForProvider(row.provider));
          setSelectedProvider(row.provider as Provider);
          setSelectedClass(row.class === 'equity' ? 'equity' : 'crypto');
          // Focus qty next
          window.setTimeout(() => qtyRef.current?.focus(), 50);
        }}
        style={{
          position: style?.position ?? 'relative',
          top: style?.top,
          left: style?.left,
          right: style?.right,
          display: 'grid',
          gridTemplateColumns: '10px 1fr auto 22px',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px',
          height: ROW_HEIGHT,
          borderRadius: 8,
          cursor: 'pointer',
          boxSizing: 'border-box',
          transition: 'background var(--t-fast)',
          background: isSelected
            ? 'color-mix(in oklab, var(--accent) 14%, transparent)'
            : 'transparent',
          boxShadow: isSelected
            ? 'inset 0 0 0 1px color-mix(in oklab, var(--accent) 40%, transparent)'
            : 'none',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: dotColor,
            boxShadow: `0 0 6px ${dotColor}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--ink-0)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <strong>{row.sym}</strong>
          <span style={{ color: 'var(--ink-2)' }}>/{row.quote}</span>
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--ink-3)',
            textTransform: 'uppercase',
            letterSpacing: '0.10em',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-pill)',
            padding: '1px 5px',
            flexShrink: 0,
          }}
        >
          {providerLabel}
        </span>
        {isSelected && (
          <span
            style={{
              color: 'var(--up)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            ✓
          </span>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Early return when closed
  // ---------------------------------------------------------------------------
  if (!open) return null;

  // ---------------------------------------------------------------------------
  // Styles (mirrors AddAssetModal exactly)
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
    paddingTop: '10vh',
    animation: 'addholdingmodal-scrim-in var(--t-med) var(--ease)',
  };

  const modalStyle: CSSProperties = {
    width: 'min(640px, 92vw)',
    maxHeight: '84vh',
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
    animation: 'addholdingmodal-in 360ms var(--ease-spring)',
  };

  return (
    <>
      <style>{`
        @keyframes addholdingmodal-scrim-in {
          from { opacity: 0; backdrop-filter: blur(0); -webkit-backdrop-filter: blur(0); }
          to   { opacity: 1; }
        }
        @keyframes addholdingmodal-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .addholdingmodal-scrim { animation: none !important; }
          .addholdingmodal { animation: none !important; }
        }
      `}</style>
      <div
        className="addholdingmodal-scrim"
        data-testid="add-holding-modal-scrim"
        onClick={onClose}
        style={scrimStyle}
      >
        <div
          className="addholdingmodal"
          data-testid="add-holding-modal"
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? 'Edit holding' : 'Add holding'}
          onClick={(e) => e.stopPropagation()}
          style={modalStyle}
        >
          {/* ---- Header ---- */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 'var(--sp-16) var(--sp-22)',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 15,
                letterSpacing: '-0.01em',
                color: 'var(--ink-0)',
              }}
            >
              {isEdit ? 'Edit holding' : 'Add holding'}
            </span>
            <button
              type="button"
              aria-label="Close"
              data-testid="add-holding-modal-close"
              onClick={onClose}
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
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* ---- Symbol picker section ---- */}
          {!isEdit && (
            <>
              {/* Symbol search input */}
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
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                  <circle cx="5.5" cy="5.5" r="3.5" />
                  <path d="M11 11L8.5 8.5" />
                </svg>
                <input
                  placeholder="Search symbol · BTC · ETH"
                  value={symQ}
                  onChange={(e) => setSymQ(e.target.value)}
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 14,
                    color: 'var(--ink-0)',
                  }}
                />
                {symQ && (
                  <button
                    type="button"
                    onClick={() => setSymQ('')}
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

              {/* Provider chips (browse mode only) */}
              {!symQ.trim() && (
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '10px 22px 10px',
                    borderBottom: '1px solid var(--hairline)',
                    flexWrap: 'wrap',
                  }}
                >
                  {PROVIDER_CHIPS.filter((p) => isTauriRuntime() || p.provider !== 'alpaca').map((chip) => {
                    const active = selectedProvider === chip.provider;
                    return (
                      <button
                        key={chip.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelectedProvider(chip.provider)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 12px',
                          borderRadius: 'var(--r-pill)',
                          background: active
                            ? `color-mix(in oklab, ${chip.accent} 18%, transparent)`
                            : 'color-mix(in oklab, var(--bg-0) 30%, transparent)',
                          border: `1px solid ${active
                            ? `color-mix(in oklab, ${chip.accent} 50%, transparent)`
                            : 'var(--hairline)'}`,
                          color: active ? 'var(--ink-0)' : 'var(--ink-2)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: 12,
                          cursor: 'pointer',
                          transition: 'all var(--t-fast)',
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: chip.accent,
                            boxShadow: `0 0 6px ${chip.accent}`,
                          }}
                        />
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Symbol list */}
              <div
                ref={scrollRef}
                onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
                style={{
                  height: 200,
                  overflowY: 'auto',
                  padding: 6,
                  scrollbarWidth: 'thin',
                  borderBottom: '1px solid var(--hairline)',
                }}
              >
                {isSearchMode ? (
                  <>
                    {searchPending && (
                      <div
                        style={{
                          height: ROW_HEIGHT,
                          borderRadius: 8,
                          background: 'color-mix(in oklab, var(--bg-1) 40%, transparent)',
                          marginBottom: 2,
                        }}
                        aria-hidden="true"
                      />
                    )}
                    {!searchPending && searchRows.length === 0 && (
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--ink-3)',
                          textAlign: 'center',
                          padding: '22px 12px',
                        }}
                      >
                        No matches
                      </div>
                    )}
                    {searchRows.map((row) => renderSymRow(row))}
                  </>
                ) : (
                  <>
                    {browseRows.length === 0 && (
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--ink-3)',
                          textAlign: 'center',
                          padding: '22px 12px',
                        }}
                      >
                        Loading…
                      </div>
                    )}
                    {browseRows.length > 0 && (
                      <div style={{ position: 'relative', height: containerHeight }}>
                        {windowedRows.map(({ row, top }) =>
                          renderSymRow(row, { position: 'absolute', top, left: 0, right: 0 }),
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Browse footer */}
              {!isSearchMode && browseRows.length > 0 && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--ink-3)',
                    letterSpacing: '0.04em',
                    padding: '6px 22px',
                    borderBottom: '1px solid var(--hairline)',
                  }}
                >
                  {browseRows.length} of {browseTotal.toLocaleString()}
                </div>
              )}
            </>
          )}

          {/* ---- Form fields ---- */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sp-12)',
              padding: 'var(--sp-16) var(--sp-22)',
              overflowY: 'auto',
            }}
          >
            {/* Selected symbol readout (Add mode) or locked sym display (Edit) */}
            {isEdit ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-8)',
                  padding: '8px 12px',
                  borderRadius: 'var(--r-8)',
                  background: 'var(--glass)',
                  border: '1px solid var(--hairline)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--ink-0)',
                  }}
                >
                  <strong>{editHolding!.sym}</strong>
                  <span style={{ color: 'var(--ink-2)' }}>/{editHolding!.quote}</span>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--ink-3)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.10em',
                    border: '1px solid var(--hairline)',
                    borderRadius: 'var(--r-pill)',
                    padding: '1px 5px',
                  }}
                >
                  {PROVIDER_DISPLAY_NAME[editHolding!.provider as Provider] ?? editHolding!.provider}
                </span>
              </div>
            ) : selectedSym ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-8)',
                  padding: '6px 12px',
                  borderRadius: 'var(--r-8)',
                  background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--ink-0)',
                  }}
                >
                  <strong>{selectedSym}</strong>
                  <span style={{ color: 'var(--ink-2)' }}>/{selectedQuote}</span>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--ink-3)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.10em',
                  }}
                >
                  {PROVIDER_DISPLAY_NAME[selectedProvider] ?? selectedProvider}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedSym(''); setSelectedQuote(''); }}
                  aria-label="Clear selection"
                  style={{
                    marginLeft: 'auto',
                    color: 'var(--ink-3)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
            ) : (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--ink-3)',
                  textAlign: 'center',
                  padding: '4px 0',
                  letterSpacing: '0.04em',
                }}
              >
                Select a symbol above
              </div>
            )}

            {/* Quantity + Avg Cost row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-12)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                <label
                  htmlFor="holding-qty"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--ink-3)',
                  }}
                >
                  Quantity
                </label>
                <input
                  id="holding-qty"
                  ref={qtyRef}
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  data-testid="holding-qty-input"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--ink-0)',
                    background: 'var(--glass)',
                    border: `1px solid ${isQtyValid || qty === '' ? 'var(--hairline)' : 'color-mix(in oklab, var(--down) 50%, transparent)'}`,
                    borderRadius: 'var(--r-8)',
                    padding: '8px 10px',
                    fontVariantNumeric: 'tabular-nums',
                    outline: 'none',
                    transition: 'border-color var(--t-fast)',
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                <label
                  htmlFor="holding-avgcost"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--ink-3)',
                  }}
                >
                  Avg Cost (per unit)
                </label>
                <input
                  id="holding-avgcost"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={avgCost}
                  onChange={(e) => setAvgCost(e.target.value)}
                  data-testid="holding-avgcost-input"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--ink-0)',
                    background: 'var(--glass)',
                    border: `1px solid ${isAvgCostValid || avgCost === '' ? 'var(--hairline)' : 'color-mix(in oklab, var(--down) 50%, transparent)'}`,
                    borderRadius: 'var(--r-8)',
                    padding: '8px 10px',
                    fontVariantNumeric: 'tabular-nums',
                    outline: 'none',
                    transition: 'border-color var(--t-fast)',
                  }}
                />
              </div>
            </div>

            {/* Note */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
              <label
                htmlFor="holding-note"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--ink-3)',
                }}
              >
                Note (optional)
              </label>
              <input
                id="holding-note"
                type="text"
                placeholder="e.g. DCA entry"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="holding-note-input"
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--ink-0)',
                  background: 'var(--glass)',
                  border: '1px solid var(--hairline)',
                  borderRadius: 'var(--r-8)',
                  padding: '8px 10px',
                  outline: 'none',
                }}
              />
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 'var(--sp-8)', justifyContent: 'flex-end', paddingTop: 'var(--sp-4)' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '8px 16px',
                  borderRadius: 'var(--r-8)',
                  border: '1px solid var(--hairline)',
                  background: 'var(--glass)',
                  color: 'var(--ink-2)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  cursor: 'pointer',
                  transition: 'all var(--t-fast)',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="add-holding-modal-submit"
                disabled={!canSubmit}
                onClick={() => { void handleSubmit(); }}
                style={{
                  padding: '8px 20px',
                  borderRadius: 'var(--r-8)',
                  border: `1px solid ${canSubmit ? 'color-mix(in oklab, var(--accent) 50%, transparent)' : 'var(--hairline)'}`,
                  background: canSubmit
                    ? 'color-mix(in oklab, var(--accent) 20%, transparent)'
                    : 'var(--glass)',
                  color: canSubmit ? 'var(--ink-0)' : 'var(--ink-3)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  letterSpacing: '0.06em',
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                  transition: 'all var(--t-fast)',
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? '…' : isEdit ? 'Save' : 'Add holding'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default AddHoldingModal;
