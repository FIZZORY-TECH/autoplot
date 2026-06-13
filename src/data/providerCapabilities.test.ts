/**
 * src/data/providerCapabilities.test.ts
 *
 * Unit tests for providerCapabilities.ts:
 *   - pickCapableProvider routes coinbase-incapable (tf, quote) to binance
 *   - isCapable reflects the static CAP table correctly
 *   - Exhausted-fallback path warns and pushes a toast
 *   - resolveEffectiveProvider returns the provider that ACTUALLY serves
 *     (sym, tf, quote) — the routing root-cause-A relies on for WS targeting
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  CAP,
  CRYPTO_FALLBACK_CHAIN,
  isCapable,
  pickCapableProvider,
  resolveEffectiveProvider,
} from './providerCapabilities';
import { useToastStore } from '../stores/useToastStore';
import type { Provider, Tf } from './MarketDataProvider';

// ---------------------------------------------------------------------------
// isCapable — unit-level assertions against the static table
// ---------------------------------------------------------------------------

describe('isCapable', () => {
  it('coinbase: supports 1h + USD', () => {
    expect(isCapable('coinbase', '1h', 'USD')).toBe(true);
  });

  it('coinbase: supports 1h + USDC', () => {
    expect(isCapable('coinbase', '1h', 'USDC')).toBe(true);
  });

  it('coinbase: does NOT support 4h (unsupported by map_interval)', () => {
    expect(isCapable('coinbase', '4h', 'USD')).toBe(false);
  });

  it('coinbase: does NOT support 1w (unsupported by map_interval)', () => {
    expect(isCapable('coinbase', '1w', 'USD')).toBe(false);
  });

  it('coinbase: does NOT support USDT', () => {
    expect(isCapable('coinbase', '1h', 'USDT')).toBe(false);
  });

  it('binance: supports all four tiers + USDT', () => {
    const tfs: Tf[] = ['1h', '4h', '1d', '1w'];
    for (const tf of tfs) {
      expect(isCapable('binance', tf, 'USDT')).toBe(true);
    }
  });

  it('binance: supports USDC', () => {
    expect(isCapable('binance', '4h', 'USDC')).toBe(true);
  });

  it('kraken: supports all four tiers + USD', () => {
    const tfs: Tf[] = ['1h', '4h', '1d', '1w'];
    for (const tf of tfs) {
      expect(isCapable('kraken', tf, 'USD')).toBe(true);
    }
  });

  it('kraken: supports USDT and USDC', () => {
    expect(isCapable('kraken', '1w', 'USDT')).toBe(true);
    expect(isCapable('kraken', '4h', 'USDC')).toBe(true);
  });

  it('alpaca: supports all four tiers + USD', () => {
    const tfs: Tf[] = ['1h', '4h', '1d', '1w'];
    for (const tf of tfs) {
      expect(isCapable('alpaca', tf, 'USD')).toBe(true);
    }
  });

  it('quote comparison is case-insensitive', () => {
    expect(isCapable('binance', '1w', 'usdt')).toBe(true);
    expect(isCapable('coinbase', '1h', 'usd')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CAP — sanity-check the static table shape
// ---------------------------------------------------------------------------

describe('CAP shape', () => {
  it('all four providers are present', () => {
    const providers: Provider[] = ['coinbase', 'binance', 'kraken', 'alpaca'];
    for (const p of providers) {
      expect(CAP).toHaveProperty(p);
    }
  });

  it('coinbase tfs are exactly 1h and 1d (no 4h, no 1w)', () => {
    expect(CAP.coinbase.tfs).toContain('1h');
    expect(CAP.coinbase.tfs).toContain('1d');
    expect(CAP.coinbase.tfs).not.toContain('4h');
    expect(CAP.coinbase.tfs).not.toContain('1w');
  });

  it('binance tfs include all four tiers', () => {
    const tfs: Tf[] = ['1h', '4h', '1d', '1w'];
    for (const tf of tfs) {
      expect(CAP.binance.tfs).toContain(tf);
    }
  });
});

// ---------------------------------------------------------------------------
// pickCapableProvider — BTC/USDT and BTC/USDC routing
// ---------------------------------------------------------------------------

describe('pickCapableProvider — routing to binance for coinbase-incapable pairs', () => {
  // Core requirement: BTC@1w/USDT must never route to coinbase
  it('routes (BTC, 1w, USDT) from coinbase → binance', () => {
    const result = pickCapableProvider('BTC', '1w', 'USDT', 'coinbase');
    expect(result).toBe('binance');
    expect(result).not.toBe('coinbase');
  });

  // Core requirement: BTC@4h/USDT must never route to coinbase
  it('routes (BTC, 4h, USDT) from coinbase → binance', () => {
    const result = pickCapableProvider('BTC', '4h', 'USDT', 'coinbase');
    expect(result).toBe('binance');
    expect(result).not.toBe('coinbase');
  });

  // Core requirement: BTC@1w/USDC — coinbase cannot serve (missing 1w)
  it('routes (BTC, 1w, USDC) from coinbase → binance', () => {
    const result = pickCapableProvider('BTC', '1w', 'USDC', 'coinbase');
    expect(result).toBe('binance');
    expect(result).not.toBe('coinbase');
  });

  // When coinbase IS capable, it should be preferred
  it('keeps coinbase for (BTC, 1h, USD) — coinbase is capable', () => {
    expect(pickCapableProvider('BTC', '1h', 'USD', 'coinbase')).toBe('coinbase');
  });

  it('keeps coinbase for (BTC, 1d, USDC) — coinbase is capable', () => {
    expect(pickCapableProvider('BTC', '1d', 'USDC', 'coinbase')).toBe('coinbase');
  });

  // Binance preferred → stays binance for all tfs
  it('keeps binance when binance is already preferred and capable', () => {
    const tfs: Tf[] = ['1h', '4h', '1d', '1w'];
    for (const tf of tfs) {
      expect(pickCapableProvider('BTC', tf, 'USDT', 'binance')).toBe('binance');
    }
  });

  // Alpaca bypass — equity provider is never rerouted
  it('returns alpaca as-is regardless of tf/quote (equity bypass)', () => {
    expect(pickCapableProvider('TSLA', '4h', 'USD', 'alpaca')).toBe('alpaca');
    expect(pickCapableProvider('TSLA', '1w', 'USDT', 'alpaca')).toBe('alpaca');
  });

  // Kraken as preferred, USDT 1w — kraken IS capable
  it('keeps kraken for (BTC, 1w, USDT) — kraken is capable', () => {
    expect(pickCapableProvider('BTC', '1w', 'USDT', 'kraken')).toBe('kraken');
  });

  // Kraken as preferred but requested quote not supported → falls to binance
  it('routes from kraken to binance for (BTC, 1w, USDC) when kraken IS capable', () => {
    // Kraken supports USDC, so it stays kraken
    expect(pickCapableProvider('BTC', '1w', 'USDC', 'kraken')).toBe('kraken');
  });
});

// ---------------------------------------------------------------------------
// pickCapableProvider — exhausted-fallback warns and pushes a toast
// ---------------------------------------------------------------------------

describe('pickCapableProvider — warn when no capable provider exists', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits warn and pushes an error toast, returns preferred when all providers fail', () => {
    // Manufacture an impossible scenario by overriding isCapable via module
    // substitution is not easily done here; instead we test via a deliberately
    // unrecognized quote that no crypto provider supports (EUR is not in any
    // capability table), exercising the exhaustion branch.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // EUR is not in any provider's quotes array → exhaustion path
    const result = pickCapableProvider('BTC', '1w', 'EUR', 'coinbase');

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg: string = (warnSpy.mock.calls[0] as string[])[0];
    expect(warnMsg).toMatch(/\[providerCapabilities\]/);
    expect(warnMsg).toMatch(/no capable provider/);

    // A toast must have been pushed.
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('error');
    expect(toasts[0].detail).toMatch(/1w.*EUR|EUR.*1w/);

    // Returns the preferred provider so callers propagate the error normally
    expect(result).toBe('coinbase');
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveProvider — the WS-routing resolver (root-cause-A fix).
//
// Must agree with where the history fetch path ends up caching, so that
// realtime ticks target the SAME provider that served the bars. Order of
// the reroute chain is anchored to CRYPTO_FALLBACK_CHAIN.
// ---------------------------------------------------------------------------

describe('resolveEffectiveProvider', () => {
  it('returns the pinned provider unchanged when it supports the tf', () => {
    // coinbase serves 1h/USD natively — no reroute.
    expect(resolveEffectiveProvider('coinbase', 'BTC', '1h', 'USD')).toBe('coinbase');
    // coinbase serves 1d/USDC natively.
    expect(resolveEffectiveProvider('coinbase', 'ETH', '1d', 'USDC')).toBe('coinbase');
    // binance serves all four tiers on USDT — pinned stays.
    const tfs: Tf[] = ['1h', '4h', '1d', '1w'];
    for (const tf of tfs) {
      expect(resolveEffectiveProvider('binance', 'BTC', tf, 'USDT')).toBe('binance');
    }
    // kraken serves 1w/USD natively.
    expect(resolveEffectiveProvider('kraken', 'BTC', '1w', 'USD')).toBe('kraken');
  });

  it('reroutes to the first CAPABLE chain provider when the pinned provider lacks the tf', () => {
    // coinbase has no 1w on USD. binance is first in the chain but does NOT
    // serve USD (only USDT/USDC), so the resolver must skip it and land on
    // kraken — the first chain provider that serves (1w, USD). This guards the
    // bug where realtime would target binance for a stream it can't serve.
    expect(resolveEffectiveProvider('coinbase', 'BTC', '1w', 'USD')).toBe('kraken');
    expect(resolveEffectiveProvider('coinbase', 'BTC', '4h', 'USD')).toBe('kraken');
    // On USDT, binance IS capable and is first in CRYPTO_FALLBACK_CHAIN.
    expect(resolveEffectiveProvider('coinbase', 'BTC', '1w', 'USDT')).toBe(CRYPTO_FALLBACK_CHAIN[0]);
    expect(resolveEffectiveProvider('coinbase', 'BTC', '1w', 'USDT')).toBe('binance');
  });

  it('reroutes when the pinned provider lacks the quote', () => {
    // coinbase cannot serve USDT at all → binance (first capable for USDT).
    expect(resolveEffectiveProvider('coinbase', 'BTC', '1h', 'USDT')).toBe('binance');
  });

  it('alpaca / equities never reroute, regardless of tf or quote', () => {
    expect(resolveEffectiveProvider('alpaca', 'TSLA', '1h', 'USD')).toBe('alpaca');
    expect(resolveEffectiveProvider('alpaca', 'TSLA', '4h', 'USD')).toBe('alpaca');
    expect(resolveEffectiveProvider('alpaca', 'TSLA', '1w', 'USD')).toBe('alpaca');
    // Even with a quote alpaca's CAP table doesn't list, it stays pinned (it
    // hard-fails downstream rather than silently rerouting to a crypto venue).
    expect(resolveEffectiveProvider('alpaca', 'TSLA', '1w', 'USDT')).toBe('alpaca');
  });

  it('respects quote variants when choosing the effective provider', () => {
    // USDC @1w: coinbase lacks 1w → binance (binance supports USDC).
    expect(resolveEffectiveProvider('coinbase', 'BTC', '1w', 'USDC')).toBe('binance');
    // kraken supports USDC @1w natively → stays kraken (no reroute).
    expect(resolveEffectiveProvider('kraken', 'BTC', '1w', 'USDC')).toBe('kraken');
    // Case-insensitive quote handling (delegates to isCapable).
    expect(resolveEffectiveProvider('binance', 'BTC', '1w', 'usdt')).toBe('binance');
  });

  it('agrees with pickCapableProvider (same chain, pinned-first arg order)', () => {
    const cases: Array<[Provider, Tf, string]> = [
      ['coinbase', '1w', 'USD'],
      ['coinbase', '1h', 'USD'],
      ['binance', '4h', 'USDC'],
      ['kraken', '1w', 'USDT'],
      ['alpaca', '1d', 'USD'],
    ];
    for (const [pinned, tf, quote] of cases) {
      expect(resolveEffectiveProvider(pinned, 'BTC', tf, quote)).toBe(
        pickCapableProvider('BTC', tf, quote, pinned),
      );
    }
  });
});
