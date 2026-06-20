/**
 * src/chrome/Headline.tsx — Top-of-app chrome readout.
 *
 * Two-line stacked composition inside the existing fixed band:
 *   Row 1 — identity strip: asset-color dot + SYM · NAME · CLASS  ·····  TF · PROVIDER
 *   Row 2 — price strip: animated price + delta pill · range/volume (or OHLCV when hovered)
 *
 * Motion:
 *   - Tick flash: 1px underline pulse under the price on each price change.
 *   - Delta sign-flip pop: brief scale pop when the delta crosses zero.
 *   - OHLCV swap: range/volume ↔ OHLCV crossfade in a position-stable slot.
 *
 * All animations respect `prefers-reduced-motion`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bar } from '../data/MarketDataProvider';
import { AnimNum } from '../components/AnimNum';
import { fmtPrice } from '../engine/indicators';
import { useAppStore } from '../stores/useAppStore';
import { ASSETS, ASSET_COLORS, PROVIDER_DISPLAY_NAME } from '../data/assets';
import type { Provider } from '../data/MarketDataProvider';
import { subscribeEquityCredStatus, type EquityCredStatus } from '../data/equityCredStatus';
import { AlpacaCredentialsModal } from '../panels/AlpacaCredentialsModal';
import { lookupSymbolMeta, peekSymbolMeta, type SymbolMeta } from '../data/symbolCatalog';
import { fmtVol } from '../lib/format';

/** Threshold for the degraded "stale" badge (P4.5). */
const STALE_THRESHOLD_MS = 60_000;

interface HeadlineProps {
  /** Bars for the active symbol — used to derive live price and 24h delta. */
  bars: Bar[];
  /** The active symbol ticker (e.g. "BTC"). */
  activeSym: string;
  /** Active timeframe label for the identity strip (display-only). */
  timeframe?: string;
  /**
   * Active provider — ADR-0009 widens this to the canonical Provider union.
   * Display label is resolved via `PROVIDER_DISPLAY_NAME` (e.g. `Binance`).
   * Legacy callers may still pass an arbitrary string (uppercased provider
   * id from the pre-Step-7 era) — we tolerate that path for one release.
   */
  provider?: Provider | string;
  /**
   * Active quote — ADR-0009 §1 widened the canonical identity to
   * `(provider, sym, quote)`. Rendered after the sym (e.g. `BTC/USDT`).
   */
  quote?: string;
}

/** Soft character cap for the sym/quote span; tooltip carries the full label. */
const SYM_QUOTE_MAXLEN_CH = 14;

/** Compact floating-headline price size — intentionally smaller than the
 *  prototype's hero price (`--fs-headline-price`) per the compact-minimal direction. */
const PRICE_FS = 'clamp(26px, 3vw, 38px)';

/** Format percent change with sign — e.g. "+1.23%" or "-0.82%". */
function fmtPct(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(2)}%`;
}

/** Local mirror of the AnimNum reduced-motion hook (not exported yet). */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fn = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, []);
  return reduced;
}

export function Headline({
  bars,
  activeSym,
  timeframe = '1H',
  provider = 'COINBASE',
  quote = 'USD',
}: HeadlineProps): JSX.Element {
  // ADR-0009 — display label and lowercase id derived once.
  const providerId = String(provider).toLowerCase();
  const providerDisplay =
    (providerId in PROVIDER_DISPLAY_NAME
      ? PROVIDER_DISPLAY_NAME[providerId as Provider]
      : String(provider).toUpperCase());
  const pairLabel = `${activeSym}/${quote}`;
  const hoveredBarIdx = useAppStore((s) => s.hoveredBarIdx);
  const lastTickAt = useAppStore((s) => s.lastTickAt);
  const loadingPhase = useAppStore((s) => s.loadingPhase);
  const reducedMotion = useReducedMotion();

  // Equity hard-fail state — show ghosted price and a clickable CTA when Alpaca has no credentials.
  const [equityCreds, setEquityCreds] = useState<EquityCredStatus>({ failed: false });
  useEffect(() => subscribeEquityCredStatus(setEquityCreds), []);
  const [credModalOpen, setCredModalOpen] = useState(false);

  // True when the active provider is alpaca AND credentials are missing.
  const isEquityNoData = equityCreds.failed && providerId === 'alpaca';

  // Tick a re-render every 5s so the stale badge appears/disappears as the
  // gap-since-last-tick crosses the 60s threshold without a new event landing.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  // Show the stale badge when we have a known last-tick AND it's older than 60s.
  const isStale = lastTickAt !== null && now - lastTickAt > STALE_THRESHOLD_MS;

  // Asset metadata — resolved through the shared catalog helper so equities
  // (which are NOT in the crypto-only ASSETS table) also display a name/class.
  // Crypto resolves synchronously from ASSETS; the catalog meta (warmed by the
  // effect below) takes precedence once it lands, covering catalog-added
  // equities. `peekSymbolMeta` gives an instant value on re-renders after the
  // first async resolve so there's no flash of missing metadata on chip switch.
  const cryptoAsset = useMemo(
    () => ASSETS.find((a) => a.sym === activeSym),
    [activeSym],
  );
  const [catalogMeta, setCatalogMeta] = useState<SymbolMeta>(() =>
    peekSymbolMeta(activeSym, providerId) ?? {},
  );
  useEffect(() => {
    let cancelled = false;
    // Seed from any cached value immediately (covers re-mounts), then warm.
    setCatalogMeta(peekSymbolMeta(activeSym, providerId) ?? {});
    void lookupSymbolMeta(activeSym, providerId).then((meta) => {
      if (!cancelled) setCatalogMeta(meta);
    });
    return () => { cancelled = true; };
  }, [activeSym, providerId]);

  // Prefer the catalog meta (covers equities) and fall back to the crypto
  // ASSETS row for name/class so existing crypto behavior is unchanged.
  const displayName = catalogMeta.name ?? cryptoAsset?.name;
  const displayClass = catalogMeta.class ?? cryptoAsset?.class;
  const assetColor = ASSET_COLORS[activeSym] ?? 'var(--accent)';

  // Last bar for live price + 24h delta.
  const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
  const refBar = bars.length > 24 ? bars[bars.length - 25] : bars[0] ?? null;

  const livePrice = lastBar?.c ?? 0;
  const delta24h =
    lastBar && refBar && refBar.c !== 0
      ? (lastBar.c - refBar.c) / refBar.c
      : 0;
  const deltaPositive = delta24h >= 0;

  // 24h range + volume derivation — over last 24 bars (or all bars if fewer).
  const { low24, high24, vol24 } = useMemo(() => {
    const slice = bars.length > 24 ? bars.slice(-24) : bars;
    if (slice.length === 0) {
      return { low24: NaN, high24: NaN, vol24: NaN };
    }
    let lo = Infinity;
    let hi = -Infinity;
    let vSum = 0;
    for (const b of slice) {
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
      vSum += b.v;
    }
    return { low24: lo, high24: hi, vol24: vSum };
  }, [bars]);

  // Hovered bar (crosshair active) — OHLCV readout.
  const hoveredBar =
    hoveredBarIdx !== null && hoveredBarIdx >= 0 && hoveredBarIdx < bars.length
      ? bars[hoveredBarIdx]
      : null;

  // -------- Tick flash --------
  const prevCloseRef = useRef<number>(livePrice);
  const [flashKey, setFlashKey] = useState<number>(0);
  const [flashDir, setFlashDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const prev = prevCloseRef.current;
    if (
      Number.isFinite(prev) &&
      Number.isFinite(livePrice) &&
      livePrice !== prev
    ) {
      setFlashDir(livePrice > prev ? 'up' : 'down');
      setFlashKey((k) => k + 1);
    }
    prevCloseRef.current = livePrice;
  }, [livePrice]);

  // -------- Delta sign-flip pop --------
  const prevDeltaPositiveRef = useRef<boolean>(deltaPositive);
  const [deltaFlipped, setDeltaFlipped] = useState<boolean>(false);
  useEffect(() => {
    if (prevDeltaPositiveRef.current !== deltaPositive) {
      prevDeltaPositiveRef.current = deltaPositive;
      if (reducedMotion) return;
      setDeltaFlipped(true);
      const t = window.setTimeout(() => setDeltaFlipped(false), 220);
      return () => window.clearTimeout(t);
    }
    return;
  }, [deltaPositive, reducedMotion]);

  // -------- Integer-mirror for aria-live (changes only when integer changes) --------
  const livePriceInt = Math.round(livePrice);

  // Style fragments
  const monoBase: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
  };

  const deltaBg = deltaPositive
    ? 'color-mix(in oklab, var(--up) 14%, transparent)'
    : 'color-mix(in oklab, var(--down) 14%, transparent)';
  const deltaBorder = deltaPositive
    ? 'color-mix(in oklab, var(--up) 28%, transparent)'
    : 'color-mix(in oklab, var(--down) 28%, transparent)';
  const deltaColor = deltaPositive ? 'var(--up)' : 'var(--down)';

  const haveRange = Number.isFinite(low24) && Number.isFinite(high24);

  return (
    <div
      className="headline"
      aria-label={`${activeSym} price headline`}
      style={{
        position: 'fixed',
        top: 'var(--sp-22)',
        // Track the chart's left edge so the headline never drifts off-chart if
        // the left inset changes (shared with AppShell's chart wrapper).
        left: 'calc(var(--chart-left-edge) + var(--sp-22))',
        maxWidth: 'min(560px, 48vw)',
        // Chart-overlay tier: above the chart canvas, below the rails/drawers/actions
        // so the floating headline can never overlap the side chrome.
        zIndex: 'var(--z-chrome)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-4)',
        pointerEvents: 'none',
      }}
    >
      {/* Integer-mirror for screen readers — diffs only when integer changes. */}
      <span
        aria-live="polite"
        style={{
          position: 'absolute',
          clip: 'rect(0 0 0 0)',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
      >
        {livePriceInt}
      </span>

      {/* Headline keyframe styles */}
      <style>{`
        @keyframes identity-crossfade {
          from { opacity: 0.5; }
          to   { opacity: 1; }
        }
        @keyframes equity-error-crossfade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .headline-identity-strip { animation: none !important; }
        }
        @keyframes skel-breathe {
          0%, 100% { opacity: 0.45; }
          50%      { opacity: 0.75; }
        }
        .headline-skel {
          animation: skel-breathe var(--t-slow) var(--ease) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .headline-skel { animation: none; opacity: 0.55; }
        }
      `}</style>

      {/* ============ Row 1 — identity strip ============ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-8)',
          pointerEvents: 'auto',
          cursor: 'default',
          flexWrap: 'wrap',
        }}
      >
        {/* Left: dot + sym + name + class — keyed on activeSym for instant identity swap */}
        <span
          key={activeSym}
          className="headline-identity-strip sym"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--sp-8)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-mono-sm)',
            letterSpacing: 'var(--tracking-eyebrow)',
            textTransform: 'uppercase',
            color: 'var(--ink-2)',
            animation: 'identity-crossfade var(--t-fast) var(--ease)',
          }}
        >
          <span
            className="dot"
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: assetColor,
              boxShadow: `0 0 14px 2px ${assetColor}`,
              transition:
                'background-color var(--t-med) var(--ease), box-shadow var(--t-med) var(--ease)',
              flexShrink: 0,
            }}
          />
          {/* ADR-0009 — render the canonical pair label (SYM/QUOTE).
              Capped at ~14ch with ellipsis; the full label lives in `title`
              so users with long instruments (e.g. `1000PEPE/USDT`) get the
              full text on hover without breaking the strip width. */}
          <span
            style={{
              color: 'var(--ink-0)',
              maxWidth: `${SYM_QUOTE_MAXLEN_CH}ch`,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'inline-block',
              verticalAlign: 'bottom',
            }}
            title={pairLabel}
          >
            {pairLabel}
          </span>
          {(displayName || displayClass) && (
            <>
              {displayName && (
                <>
                  <span style={{ color: 'var(--ink-3)' }}>·</span>
                  <span style={{ color: 'var(--ink-2)' }}>{displayName}</span>
                </>
              )}
              {displayClass && (
                <>
                  <span style={{ color: 'var(--ink-3)' }}>·</span>
                  <span style={{ color: 'var(--ink-3)' }}>
                    {displayClass.toUpperCase()}
                  </span>
                </>
              )}
            </>
          )}
        </span>

        {/* Right: timeframe + provider chip (display name, e.g. `Binance`). */}
        <div
          className="t-eyebrow"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-8)',
            color: 'var(--ink-3)',
            fontSize: 'var(--fs-eyebrow)',
            letterSpacing: 'var(--tracking-eyebrow)',
            textTransform: 'uppercase',
          }}
        >
          <span>{timeframe}</span>
          <span aria-hidden="true">·</span>
          <span>{providerDisplay}</span>
        </div>
      </div>

      {/* ============ Row 2 — price strip ============ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--sp-16)',
          pointerEvents: 'auto',
        }}
      >
        {/* Equity no-data state — ghosted skeleton price + clickable warn chip
            that opens the Alpaca credentials modal directly. Mono-numerals are
            preserved so the layout doesn't shift when prices arrive.
            Gated on idle phase — never shown during exit/loading/reveal. */}
        {isEquityNoData && loadingPhase === 'idle' && (
          <span
            data-testid="headline-equity-no-data"
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 'var(--sp-16)',
              lineHeight: 1,
            }}
          >
            <span
              aria-label="No live price"
              className="headline-empty-price"
              style={{
                ...monoBase,
                fontSize: PRICE_FS,
                letterSpacing: 'var(--tracking-display)',
                fontWeight: 400,
                color: 'var(--ink-3)',
                lineHeight: 1,
                opacity: 0.55,
              }}
            >
              ——
            </span>
            <button
              type="button"
              data-testid="headline-equity-connect"
              onClick={() => setCredModalOpen(true)}
              className="headline-empty-cta"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--sp-8)',
                padding: '5px 12px 5px 10px',
                borderRadius: 'var(--r-pill)',
                background:
                  'color-mix(in oklab, var(--warn) 12%, transparent)',
                border:
                  '1px solid color-mix(in oklab, var(--warn) 38%, transparent)',
                color: 'var(--warn)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-mono-sm)',
                letterSpacing: 'var(--tracking-mono-md)',
                cursor: 'pointer',
                transition: 'all var(--t-fast) var(--ease)',
                pointerEvents: 'auto',
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
              }}
            >
              <span
                aria-hidden="true"
                className="headline-empty-dot"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: 'var(--warn)',
                  flexShrink: 0,
                  boxShadow:
                    '0 0 10px color-mix(in oklab, var(--warn) 60%, transparent)',
                }}
              />
              Connect Alpaca
              <svg
                width="9"
                height="9"
                viewBox="0 0 9 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                aria-hidden="true"
                style={{ opacity: 0.7 }}
              >
                <path d="M2 4.5h5M5 2l2 2.5L5 7" />
              </svg>
            </button>
            <AlpacaCredentialsModal
              open={credModalOpen}
              onClose={() => setCredModalOpen(false)}
              onSaved={() => setCredModalOpen(false)}
            />
            <style>{`
              @keyframes headline-empty-pulse {
                0%   { box-shadow: 0 0 0 0   color-mix(in oklab, var(--warn) 55%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 60%, transparent); }
                70%  { box-shadow: 0 0 0 6px color-mix(in oklab, var(--warn)  0%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 60%, transparent); }
                100% { box-shadow: 0 0 0 0   color-mix(in oklab, var(--warn)  0%, transparent), 0 0 10px color-mix(in oklab, var(--warn) 60%, transparent); }
              }
              .headline-empty-dot {
                animation: headline-empty-pulse 2.2s var(--ease) infinite;
              }
              .headline-empty-cta:hover {
                background: color-mix(in oklab, var(--warn) 22%, transparent);
                box-shadow: 0 0 22px color-mix(in oklab, var(--warn) 38%, transparent);
              }
              @media (prefers-reduced-motion: reduce) {
                .headline-empty-dot { animation: none; }
              }
            `}</style>
          </span>
        )}

        {/* Price strip — varies by loadingPhase and equity state. */}
        {!isEquityNoData && loadingPhase === 'loading' && (
          /* Skeleton placeholders — price block + pill-shaped element. */
          <>
            <span
              aria-label="Loading price"
              className="headline-skel"
              data-testid="headline-skel-price"
              style={{
                display: 'inline-block',
                width: 'clamp(120px, 12vw, 180px)',
                height: `calc(${PRICE_FS} * 0.62)`,
                borderRadius: 'var(--r-8)',
                background: 'color-mix(in oklab, var(--ink-3) 22%, transparent)',
                alignSelf: 'center',
              }}
            />
            <span
              aria-hidden="true"
              className="headline-skel"
              data-testid="headline-skel-pill"
              style={{
                display: 'inline-block',
                width: 'var(--sp-56)',
                height: 'var(--sp-16)',
                borderRadius: 'var(--r-pill)',
                background: 'color-mix(in oklab, var(--ink-3) 18%, transparent)',
                alignSelf: 'center',
              }}
            />
          </>
        )}

        {/* Price (animated) + tick-flash underline sibling */}
        {!isEquityNoData && loadingPhase !== 'loading' && <span
          style={{
            position: 'relative',
            display: 'inline-block',
            lineHeight: 1,
            opacity: loadingPhase === 'exit' ? 0.35 : 1,
            transition: loadingPhase === 'exit'
              ? 'opacity var(--t-fast) var(--ease), color var(--t-fast) var(--ease)'
              : undefined,
          }}
        >
          <AnimNum
            key={loadingPhase === 'reveal' || loadingPhase === 'idle' ? activeSym : undefined}
            value={livePrice}
            style={{
              ...monoBase,
              fontSize: PRICE_FS,
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 400,
              color: loadingPhase === 'exit' ? 'var(--ink-3)' : 'var(--ink-0)',
              lineHeight: 1,
              display: 'inline-block',
              transition: 'color var(--t-fast) var(--ease)',
            }}
          />
          {!reducedMotion && flashDir !== null && loadingPhase === 'idle' && (
            <span
              key={flashKey}
              aria-hidden="true"
              className={`tick-flash tick-flash--${flashDir}`}
            />
          )}
        </span>}

        {/* 24h delta pill — hidden when equity has no data OR during exit/loading */}
        {!isEquityNoData && loadingPhase !== 'loading' && <span
          className="delta-pill"
          data-flipped={deltaFlipped ? 'true' : undefined}
          style={{
            ...monoBase,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '3px 7px',
            borderRadius: 'var(--r-pill)',
            background: deltaBg,
            border: `1px solid ${deltaBorder}`,
            color: deltaColor,
            fontSize: 'var(--fs-mono-sm)',
            letterSpacing: 'var(--tracking-mono-md)',
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
            flexShrink: 0,
            transition:
              'color 180ms var(--ease), background-color 180ms var(--ease), border-color 180ms var(--ease), opacity var(--t-fast) var(--ease)',
            // Exit: suppress delta pill; reveal: delayed fade back in.
            opacity: loadingPhase === 'exit' ? 0 : 1,
          }}
        >
          {fmtPct(delta24h)}
        </span>}

        {/* Hairline separator — hidden when equity has no data or during loading */}
        {!isEquityNoData && loadingPhase === 'idle' && <span
          aria-hidden="true"
          style={{ color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}
        >
          ·
        </span>}

        {/* Swap slot — OHLCV drives layout width (wider); range/volume overlays.
            Hidden during loading (display:none so layout collapses). */}
        {!isEquityNoData && loadingPhase === 'idle' &&
        <div
          style={{
            position: 'relative',
            display: 'inline-block',
            minHeight: 18,
          }}
        >
          {/* Layout driver: OHLCV (always rendered, opacity gates visibility). */}
          <div
            aria-hidden={hoveredBar ? undefined : 'true'}
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 'var(--sp-12)',
              ...monoBase,
              fontSize: 'var(--fs-mono-sm)',
              letterSpacing: 'var(--tracking-mono-sm)',
              color: 'var(--ink-1)',
              opacity: hoveredBar ? 1 : 0,
              pointerEvents: hoveredBar ? 'auto' : 'none',
              transition: 'opacity var(--t-fast) var(--ease)',
            }}
          >
            {(
              [
                ['O', hoveredBar?.o ?? lastBar?.o ?? 0],
                ['H', hoveredBar?.h ?? lastBar?.h ?? 0],
                ['L', hoveredBar?.l ?? lastBar?.l ?? 0],
                ['C', hoveredBar?.c ?? lastBar?.c ?? 0],
              ] as [string, number][]
            ).map(([label, val]) => (
              <span
                key={label}
                style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}
              >
                <span style={{ color: 'var(--ink-3)' }}>{label}</span>
                <span>{fmtPrice(val)}</span>
              </span>
            ))}
            <span
              style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}
            >
              <span style={{ color: 'var(--ink-3)' }}>V</span>
              <span>{fmtVol(hoveredBar?.v ?? lastBar?.v ?? 0)}</span>
            </span>
          </div>

          {/* Overlay: range + volume (absolute, shown when not hovered). */}
          <div
            aria-hidden={hoveredBar ? 'true' : undefined}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 'var(--sp-12)',
              whiteSpace: 'nowrap',
              ...monoBase,
              fontSize: 'var(--fs-mono-sm)',
              letterSpacing: 'var(--tracking-mono-sm)',
              color: 'var(--ink-2)',
              opacity: hoveredBar ? 0 : 1,
              pointerEvents: hoveredBar ? 'none' : 'auto',
              transition: 'opacity var(--t-fast) var(--ease)',
            }}
          >
            <span
              style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}
            >
              <span style={{ color: 'var(--ink-3)' }}>L</span>
              <span>{haveRange ? fmtPrice(low24) : '—'}</span>
            </span>
            <span
              style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}
            >
              <span style={{ color: 'var(--ink-3)' }}>H</span>
              <span>{haveRange ? fmtPrice(high24) : '—'}</span>
            </span>
            <span
              style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}
            >
              <span style={{ color: 'var(--ink-3)' }}>Vol</span>
              <span>{Number.isFinite(vol24) ? fmtVol(vol24) : '—'}</span>
            </span>
          </div>
        </div>}

        {/* P4.5 — stale badge */}
        {isStale && (
          <span
            data-testid="headline-stale-badge"
            role="status"
            aria-live="polite"
            aria-label="Realtime data stale"
            className="glass"
            style={{
              ...monoBase,
              display: 'inline-flex',
              alignItems: 'center',
              padding: '3px 8px',
              borderRadius: 'var(--r-pill)',
              color: 'var(--warn)',
              fontSize: 'var(--fs-mono-sm)',
              letterSpacing: 'var(--tracking-mono-md)',
              lineHeight: 1.4,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              textTransform: 'lowercase',
              animation: 'crosshair-readout-in var(--t-fast) var(--ease)',
            }}
          >
            stale
          </span>
        )}
      </div>
    </div>
  );
}

export default Headline;
