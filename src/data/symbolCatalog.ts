/**
 * src/data/symbolCatalog.ts — TTL-gated catalog refresh with in-flight dedupe.
 *
 * ADR-0009 §6: The catalog is SQLite-resident. Refresh policy is:
 *   - Lazy first-fetch on first use.
 *   - 24h TTL; stale-or-empty triggers a re-fetch.
 *   - `force: true` bypasses TTL and re-fetches unconditionally.
 *   - An in-flight `Map<Provider, Promise<...>>` dedupes concurrent calls so a
 *     rapid chip-switch storm fires at most one `symbol_catalog_fetch` per
 *     provider at a time.
 *   - Alpaca is short-circuited when `isEquityCredFailed()` returns true.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Provider } from './MarketDataProvider';
import { symbolCatalogFetch, symbolCatalogMeta } from '../lib/db';
import type { CatalogFetchResult, SymbolsMeta, SymbolRow } from '../lib/db';
import { isEquityCredFailed } from './equityCredStatus';
import { searchSymbols } from './providerRegistry';
import { isTauriRuntime } from '../lib/runtime';
import { useToastStore } from '../stores/useToastStore';

/** TTL after which a cached catalog is considered stale. 24 hours. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Return type of `ensureFreshCatalog` — mirrors `CatalogFetchResult`. */
export type CatalogMeta = Pick<CatalogFetchResult, 'provider' | 'fetched_at' | 'row_count'>;

/**
 * Module-scoped in-flight deduplication map.
 *
 * Each key is a `Provider` string. While a fetch is active, its Promise sits
 * here so subsequent callers for the same provider share the same resolution
 * rather than spawning a parallel network call.
 *
 * The `.finally` on each fetch removes the entry so the next TTL-expired call
 * spawns a fresh one.
 */
const inFlight = new Map<Provider, Promise<CatalogMeta>>();

/**
 * Ensure the SQLite catalog for `provider` is fresh.
 *
 * - First call for a provider with empty cache: fetches the full catalog.
 * - Within `CATALOG_TTL_MS` of last fetch: no-op (returns the cached meta).
 * - Older than TTL OR `opts.force === true`: re-fetches.
 *
 * **In-flight dedupe**: concurrent calls for the same provider share a single
 * in-flight Promise. A rapid chip-switch storm only fires one network call
 * per provider, not four.
 *
 * **Alpaca guard**: when `isEquityCredFailed()` is true, this call is a no-op
 * (returns a synthetic stale-or-missing meta). The user-facing fix is to go
 * through `AlpacaCredentialsModal` first.
 *
 * Errors are surfaced via a toast (useToastStore) and re-thrown
 * so callers can surface them in their own loading UI.
 */
export async function ensureFreshCatalog(
  provider: Provider,
  opts?: { force?: boolean },
): Promise<CatalogMeta> {
  // --- Alpaca guard ---------------------------------------------------------
  // If the equity credentials are known-failed, skip the fetch entirely.
  // Callers treat row_count === 0 as "show the connect-credentials affordance".
  if (provider === 'alpaca' && isEquityCredFailed()) {
    return { provider, fetched_at: 0, row_count: 0 };
  }

  // --- TTL check (performed before entering the in-flight map) --------------
  // We read `symbolCatalogMeta` once here. On failure (e.g. vite dev without
  // Tauri) we treat the result as "no cache yet" and fall through to fetch.
  let existingMeta: SymbolsMeta | undefined;
  try {
    const all = await symbolCatalogMeta();
    existingMeta = all.find((m) => m.provider === provider);
  } catch {
    // No Tauri runtime or DB not ready — treat as cache miss so we attempt fetch.
    existingMeta = undefined;
  }

  const now = Date.now();
  const isFresh =
    existingMeta !== undefined &&
    now - existingMeta.fetched_at < CATALOG_TTL_MS;

  if (isFresh && !opts?.force) {
    // Cache is fresh — return the existing meta without touching the network.
    return {
      provider: existingMeta!.provider,
      fetched_at: existingMeta!.fetched_at,
      row_count: existingMeta!.row_count,
    };
  }

  // --- In-flight dedupe -----------------------------------------------------
  // When `force: true` we bypass the in-flight key so the new request
  // supersedes the previously-cached promise. This matters when a user
  // explicitly hits the refresh button while a background fetch is already
  // in progress — we want them to get a fresh network call, not the one that
  // started with stale data.
  if (!opts?.force) {
    const pending = inFlight.get(provider);
    if (pending !== undefined) {
      return pending;
    }
  }

  // --- Kick off the fetch ---------------------------------------------------
  const fetchPromise: Promise<CatalogMeta> = symbolCatalogFetch(provider)
    .then((result) => ({
      provider: result.provider,
      fetched_at: result.fetched_at,
      row_count: result.row_count,
    }))
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[symbolCatalog] catalog refresh failed for ${provider}:`, err);
      useToastStore.getState().push({ kind: 'warn', title: 'Symbol search unavailable', detail: `Catalog refresh failed for ${provider}` });
      throw err;
    })
    .finally(() => {
      // Remove ourselves from the in-flight map so the next call after TTL
      // expires spawns a new fetch.
      inFlight.delete(provider);
    });

  // Only register in the dedupe map when NOT force-refreshing. A force-refresh
  // does not stomp the in-flight entry for ordinary callers either — it runs
  // independently and lets the existing in-flight promise complete on its own.
  if (!opts?.force) {
    inFlight.set(provider, fetchPromise);
  }

  return fetchPromise;
}

/**
 * Proactively warm the Alpaca equity catalog **when credentials are configured**.
 *
 * The equity catalog is fetched lazily and only on demand from the NASDAQ/NYSE
 * browse chip. That left a gap: a stock *search* (e.g. "IONQ") never triggers a
 * fetch, so with valid creds but the alpaca chip never browsed, search returns
 * nothing. Calling this at app startup and on Add-Asset open closes that gap so
 * equities are searchable everywhere without a manual browse.
 *
 * No-op outside Tauri or when no Alpaca credentials exist (checked via the
 * `provider_has_credentials` command — no network probe). TTL-gated and
 * in-flight-deduped by `ensureFreshCatalog`, so calling it repeatedly is cheap
 * and idempotent. Never throws — fetch failures are logged by `ensureFreshCatalog`.
 */
export async function warmEquityCatalogIfConfigured(): Promise<void> {
  if (!(await providerHasCredentials('alpaca'))) return;
  await ensureFreshCatalog('alpaca').catch(() => {
    // ensureFreshCatalog already logs fetch errors; nothing to surface here.
  });
}

/**
 * Whether `provider` has credentials configured (env override or credentials.json),
 * via the `provider_has_credentials` command — a cheap boolean check with no
 * network probe. Returns `false` outside Tauri or if the command/read fails.
 * Single source of truth so callers don't each hand-roll the invoke + guard.
 */
export async function providerHasCredentials(provider: Provider): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    return await invoke<boolean>('provider_has_credentials', { provider });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared symbol-meta resolver
// ---------------------------------------------------------------------------

/**
 * Subset of a catalog row exposed to UI metadata consumers. All fields are
 * optional — they resolve to `undefined` when the symbol is not in the catalog
 * (e.g. no Tauri runtime, or an equity symbol before Alpaca credentials are
 * connected).
 */
export interface SymbolMeta {
  /** Human-readable display name (e.g. `Apple Inc.`). */
  name?: string;
  /** Asset class — `'crypto'` or `'equity'`. */
  class?: SymbolRow['class'];
  /** Canonical provider id (e.g. `'alpaca'`, `'binance'`). */
  provider?: string;
}

/**
 * Module-scoped best-effort cache keyed by `${provider}:${sym}` (or `sym` when
 * no provider hint is given). A `null` entry memoizes a known miss so we don't
 * re-hit the catalog for every render of an unknown symbol.
 */
const metaCache = new Map<string, SymbolMeta | null>();

/**
 * In-flight dedupe for `lookupSymbolMeta`. Two components (e.g. AppShell +
 * Headline) often resolve the same `(sym, provider)` on one asset switch before
 * the first catalog search returns — share the single Promise instead of firing
 * duplicate `symbolCatalogSearch` IPC calls. Mirrors `inFlight` for fetches.
 */
const metaInFlight = new Map<string, Promise<SymbolMeta>>();

function metaCacheKey(sym: string, provider?: string): string {
  return provider ? `${provider}:${sym}` : sym;
}

/**
 * Resolve display metadata for a catalog symbol from the SQLite FTS5 catalog.
 *
 * Best-effort + cached: the first call for a `(sym, provider)` pair fires a
 * catalog search and memoizes the result (including a known-miss as `null`).
 * Subsequent calls return the cached value synchronously via the resolved
 * Promise. Returns an object with `undefined` fields when the symbol is not in
 * the catalog (no Tauri runtime, equity before Alpaca creds, etc.).
 *
 * When `provider` is supplied we prefer the row that matches both the symbol
 * and the provider; otherwise the first exact-symbol match wins. The crypto
 * curated `ASSETS` table remains a separate, synchronous fallback at the
 * callsites — this helper is the catalog-backed path that also covers equities.
 */
export async function lookupSymbolMeta(
  sym: string,
  provider?: string,
): Promise<SymbolMeta> {
  const key = metaCacheKey(sym, provider);
  const cached = metaCache.get(key);
  if (cached !== undefined) return cached ?? {};

  const pending = metaInFlight.get(key);
  if (pending !== undefined) return pending;

  const promise = (async (): Promise<SymbolMeta> => {
    let resolved: SymbolMeta | null = null;
    try {
      const rows = await searchSymbols(sym, {
        providers: provider ? [provider as Provider] : undefined,
        limit: 25,
      });
      // Exact (case-insensitive) symbol match, preferring the requested provider.
      const symUpper = sym.toUpperCase();
      const exact = rows.filter((r) => r.sym.toUpperCase() === symUpper);
      const pick =
        (provider ? exact.find((r) => r.provider === provider) : undefined) ?? exact[0];
      if (pick) {
        resolved = {
          name: pick.name ?? undefined,
          class: pick.class,
          provider: pick.provider,
        };
      }
    } catch {
      // No Tauri runtime / catalog unavailable — treat as a miss.
      resolved = null;
    }
    metaCache.set(key, resolved);
    return resolved ?? {};
  })().finally(() => {
    metaInFlight.delete(key);
  });

  metaInFlight.set(key, promise);
  return promise;
}

/**
 * Synchronous read of the cached symbol meta, if any. Returns `undefined` when
 * the `(sym, provider)` pair hasn't been resolved yet (or was a known miss).
 * Components use this for the first synchronous render and call
 * `lookupSymbolMeta` to warm the cache.
 */
export function peekSymbolMeta(sym: string, provider?: string): SymbolMeta | undefined {
  const cached = metaCache.get(metaCacheKey(sym, provider));
  return cached ? cached : undefined;
}

/**
 * Reset the in-flight dedupe map.
 *
 * **Test-only** — exported solely for vitest `afterEach` / `beforeEach` cleanup
 * so that one test's pending promise does not bleed into the next.
 */
export function __resetInFlightForTest(): void {
  inFlight.clear();
  metaInFlight.clear();
  metaCache.clear();
}
