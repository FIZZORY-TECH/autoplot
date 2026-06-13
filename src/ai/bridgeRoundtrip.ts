/**
 * src/ai/bridgeRoundtrip.ts — Step 6 frontend round-trip dispatcher.
 *
 * ## Purpose
 *
 * Listens for `bridge:request` Tauri events emitted by the IPC bridge
 * (`ipc_bridge.rs::fe_roundtrip`) and dispatches each request to the
 * appropriate TS handler or Zustand store mutation.  After handling, calls
 * `bridge_reply` to return the result (or error) to the bridge.
 *
 * ## Method registry
 *
 * | Method                   | Implementation                                                |
 * |--------------------------|---------------------------------------------------------------|
 * | compute_indicator        | existing `computeIndicator.ts` handler                       |
 * | validate_strategy        | existing `validateStrategy.ts` handler                       |
 * | backtest_strategy        | existing `backtestStrategy.ts` handler                       |
 * | get_current_symbol       | reads `useAppStore.activeSym`                                 |
 * | get_visible_range        | reads `useAppStore.viewport`                                  |
 * | list_overlays            | snapshot of all four `useChartMutationStore` slices           |
 * | list_assets              | maps `ASSETS` to ADR-0008 `{ provider, sym, class, name? }[]` |
 * | apply_dataset            | mutates `useChartMutationStore.applyDataset`                  |
 * | remove_dataset           | mutates `useChartMutationStore.removeDataset`                 |
 * | apply_timeline_events    | mutates `useChartMutationStore.applyTimelineLayer`            |
 * | remove_timeline_layer    | mutates `useChartMutationStore.removeTimelineLayer`           |
 * | apply_strategy           | mutates `useChartMutationStore.applyStrategyOverlay`          |
 * | remove_strategy_overlay  | mutates `useChartMutationStore.removeStrategyOverlay`         |
 * | apply_research_overlay   | Zod-validates then `useChartMutationStore.applyResearchOverlay`|
 * | remove_research_overlay  | mutates `useChartMutationStore.removeResearchOverlay`         |
 * | save_research_overlay    | Zod-validates then `useResearchOverlayLibraryStore.addOverlay`|
 * | list_research_overlays   | reads `useResearchOverlayLibraryStore.overlays` (metadata)    |
 * | load_research_overlay    | finds full overlay by id in the library store                 |
 * | delete_research_overlay  | `useResearchOverlayLibraryStore.removeOverlay(id)`            |
 * | open_strategy_artifact   | sets `useStrategyArtifactStore.set(id)` + opens dock 'strategy'|
 *
 * ## Usage
 *
 * Call `mountBridgeRoundtrip()` once at app startup (in AppShell.tsx useEffect).
 * It returns an unsubscribe function.
 *
 * ## Single source of truth
 *
 * Compute operations (`compute_indicator`, `validate_strategy`, `backtest_strategy`)
 * forward to the EXISTING TS tool handlers so the math is never duplicated in Rust.
 */

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { computeIndicator } from './tools/computeIndicator';
import { validateStrategy } from './tools/validateStrategy';
import { backtestStrategy } from './tools/backtestStrategy';
import { useAppStore } from '../stores/useAppStore';
import { useChartMutationStore } from '../stores/useChartMutationStore';
import type { TimelineLayer } from '../stores/useChartMutationStore';
import { useStrategyArtifactStore } from '../stores/useStrategyArtifactStore';
import { useResearchOverlayLibraryStore } from '../stores/useResearchOverlayLibraryStore';
import { useDockStore } from '../stores/useDockStore';
import type { Dataset } from './schemas';
import { ResearchOverlay } from './schemas';
import { ASSETS } from '../data/assets';
import { symbolCatalogList, type SymbolRow } from '../lib/db';
import { mockSymbolCatalogList } from '../data/mockProvider';
import { isMockForced } from '../data/providerRegistry';
import { isTauriRuntime } from '../lib/runtime';
import { defaultQuoteForProvider } from '../stores/useWatchlistStore';

// ---------------------------------------------------------------------------
// Bridge request envelope (from ipc_bridge.rs::fe_roundtrip)
// ---------------------------------------------------------------------------

interface BridgeRequestEnvelope {
  id: string;
  method: string;
  params: unknown;
}

// ---------------------------------------------------------------------------
// bridge_reply — sends result or error back to the Rust bridge
// ---------------------------------------------------------------------------

async function replyOk(id: string, result: unknown): Promise<void> {
  await invoke('bridge_reply', { id, result, error: null });
}

async function replyError(id: string, code: number, message: string): Promise<void> {
  await invoke('bridge_reply', {
    id,
    result: null,
    error: { code, message },
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function handleRequest(envelope: BridgeRequestEnvelope): Promise<void> {
  const { id, method, params } = envelope;

  try {
    switch (method) {
      // ------------------------------------------------------------------
      // Compute — forward to existing TS handlers (single source of truth)
      // ------------------------------------------------------------------
      case 'compute_indicator': {
        const result = await computeIndicator(params);
        await replyOk(id, result);
        break;
      }

      case 'validate_strategy': {
        const result = await validateStrategy(params);
        await replyOk(id, result);
        break;
      }

      case 'backtest_strategy': {
        const result = await backtestStrategy(params);
        await replyOk(id, result);
        break;
      }

      // ------------------------------------------------------------------
      // Read-only chart state
      // ------------------------------------------------------------------
      case 'get_current_symbol': {
        const sym = useAppStore.getState().activeSym ?? null;
        await replyOk(id, sym);
        break;
      }

      case 'get_visible_range': {
        const viewport = useAppStore.getState().viewport;
        await replyOk(id, viewport ?? null);
        break;
      }

      case 'list_overlays': {
        // D4 — return ALL FOUR mutation-store slices so the agent can audit the
        // full chart overlay state. Additive, backward-compatible: the legacy
        // dataset overlays remain at the top-level `overlays` key.
        const st = useChartMutationStore.getState();
        await replyOk(id, {
          overlays: Object.values(st.overlays),
          timelineLayers: Object.values(st.timelineLayers),
          strategyOverlays: Object.values(st.strategyOverlays),
          researchOverlays: Object.values(st.researchOverlays),
        });
        break;
      }

      // ------------------------------------------------------------------
      // Chart mutations (already consent-gated on the Rust side)
      // ------------------------------------------------------------------
      case 'apply_dataset': {
        const dataset = params as Dataset;
        if (!dataset?.id) {
          await replyError(id, -32005, 'apply_dataset: missing id');
          break;
        }
        useChartMutationStore.getState().applyDataset(dataset);
        await replyOk(id, { applied: dataset.id });
        break;
      }

      case 'remove_dataset': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'remove_dataset: missing id');
          break;
        }
        useChartMutationStore.getState().removeDataset(p.id);
        await replyOk(id, { removed: p.id });
        break;
      }

      case 'apply_timeline_events': {
        const p = params as {
          id?: string;
          name?: string;
          events?: unknown[];
        };
        if (!p?.name || !Array.isArray(p?.events)) {
          await replyError(id, -32005, 'apply_timeline_events: missing name or events');
          break;
        }
        const layerId = p.id ?? crypto.randomUUID();
        const layer: TimelineLayer = {
          id: layerId,
          name: p.name,
          events: (p.events as TimelineLayer['events']).map((e) => {
            const ev = e as unknown as Record<string, unknown>;
            return {
              ts: (ev.ts as number) ?? 0,
              label: (ev.label as string) ?? '',
              color: ev.color as string | undefined,
              kind: ((ev.kind as string) ?? 'pin') as TimelineLayer['events'][0]['kind'],
            };
          }),
        };
        useChartMutationStore.getState().applyTimelineLayer(layer);
        await replyOk(id, { applied: layerId });
        break;
      }

      case 'remove_timeline_layer': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'remove_timeline_layer: missing id');
          break;
        }
        useChartMutationStore.getState().removeTimelineLayer(p.id);
        await replyOk(id, { removed: p.id });
        break;
      }

      case 'apply_strategy': {
        const p = params as { id?: string; body_json?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'apply_strategy: missing id');
          break;
        }
        useChartMutationStore.getState().applyStrategyOverlay({
          id: p.id,
          bodyJson: p.body_json ?? '{}',
        });
        await replyOk(id, { applied: p.id });
        break;
      }

      case 'remove_strategy_overlay': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'remove_strategy_overlay: missing id');
          break;
        }
        useChartMutationStore.getState().removeStrategyOverlay(p.id);
        await replyOk(id, { removed: p.id });
        break;
      }

      case 'apply_research_overlay': {
        // Unlike the shallow `apply_dataset` guard, validate the FULL shape
        // with Zod at dispatch. On failure, surface field-level diagnostics so
        // the agent can self-correct: each issue → { path, message }.
        const parsed = ResearchOverlay.safeParse(params);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }));
          await invoke('bridge_reply', {
            id,
            result: null,
            error: {
              code: -32602,
              message: 'apply_research_overlay: invalid payload',
              data: { issues },
            },
          });
          break;
        }
        useChartMutationStore.getState().applyResearchOverlay(parsed.data);
        await replyOk(id, { applied: parsed.data.id });
        break;
      }

      case 'remove_research_overlay': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'remove_research_overlay: missing id');
          break;
        }
        useChartMutationStore.getState().removeResearchOverlay(p.id);
        await replyOk(id, { removed: p.id });
        break;
      }

      // ------------------------------------------------------------------
      // Research-overlay library (persisted to SQLite via the library store).
      // Distinct from the apply/remove pair above, which mutate the live chart
      // overlay slice; these manage the saved-overlay library.
      // ------------------------------------------------------------------
      case 'save_research_overlay': {
        // Validate the FULL shape with Zod at dispatch (mirrors
        // apply_research_overlay). On failure, surface field-level diagnostics
        // so the agent can self-correct: each issue → { path, message }.
        const parsed = ResearchOverlay.safeParse(params);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }));
          await invoke('bridge_reply', {
            id,
            result: null,
            error: {
              code: -32602,
              message: 'save_research_overlay: invalid payload',
              data: { issues },
            },
          });
          break;
        }
        // addOverlay persists via dbResearchOverlaysUpsert internally.
        await useResearchOverlayLibraryStore.getState().addOverlay(parsed.data);
        await replyOk(id, { id: parsed.data.id });
        break;
      }

      case 'list_research_overlays': {
        const p = (params ?? {}) as { filter?: { sym?: string; tf?: string } };
        const symFilter = p.filter?.sym?.toLowerCase();
        const tfFilter = p.filter?.tf;
        const overlays = useResearchOverlayLibraryStore
          .getState()
          .overlays.filter((o) => {
            // Case-insensitive sym match (matches pruneResearchOverlays), exact tf.
            if (symFilter && o.sym.toLowerCase() !== symFilter) return false;
            if (tfFilter && o.tf !== tfFilter) return false;
            return true;
          })
          .map((o) => ({
            id: o.id,
            sym: o.sym,
            tf: o.tf,
            label: o.label,
            created_at: o.created_at,
          }));
        await replyOk(id, { overlays });
        break;
      }

      case 'load_research_overlay': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'load_research_overlay: missing id');
          break;
        }
        const found = useResearchOverlayLibraryStore
          .getState()
          .overlays.find((o) => o.id === p.id);
        if (!found) {
          await replyError(id, -32602, `research overlay not found: ${p.id}`);
          break;
        }
        await replyOk(id, found);
        break;
      }

      case 'delete_research_overlay': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'delete_research_overlay: missing id');
          break;
        }
        await useResearchOverlayLibraryStore.getState().removeOverlay(p.id);
        await replyOk(id, { id: p.id });
        break;
      }

      case 'open_strategy_artifact': {
        const p = params as { id?: string };
        if (!p?.id) {
          await replyError(id, -32005, 'open_strategy_artifact: missing id');
          break;
        }
        useStrategyArtifactStore.getState().set(p.id);
        useDockStore.getState().openDrawer('strategy');
        await replyOk(id, { opened: p.id });
        break;
      }

      // ------------------------------------------------------------------
      // list_assets — ADR-0009 (Step 7).
      //
      // Returns up to 50 catalog rows shaped as `{provider, sym, quote, class, name?}`.
      // Accepts an optional `sym_prefix` filter (case-insensitive prefix match
      // against `sym` OR `name`) so the LLM can narrow the response without
      // paging — keeps token budget bounded.
      //
      // Provider resolution order:
      //   1. `mockSymbolCatalogList` per provider when mock mode is forced or
      //      no Tauri runtime is available (`vite dev`).
      //   2. `symbolCatalogList` (FTS-backed cache) under Tauri — falls back
      //      to the legacy curated ASSETS for that provider when the table is
      //      empty (no `symbol_catalog_fetch` has run yet).
      // ------------------------------------------------------------------
      case 'list_assets': {
        const p = (params ?? {}) as { sym_prefix?: string };
        const symPrefix = (p.sym_prefix ?? '').toLowerCase().trim();
        const LIMIT = 50;

        const providers: Array<'binance' | 'coinbase' | 'kraken' | 'alpaca'> = [
          'binance',
          'coinbase',
          'kraken',
          'alpaca',
        ];

        const aggregate: SymbolRow[] = [];

        // Helper: pad each provider's quota proportionally so a single provider
        // can't crowd out the rest. Floor to at least 12 rows each.
        const perProvider = Math.max(12, Math.floor(LIMIT / providers.length));

        if (isMockForced() || !isTauriRuntime()) {
          for (const prov of providers) {
            const { rows } = mockSymbolCatalogList(prov, perProvider, 0);
            aggregate.push(...rows);
          }
        } else {
          // Tauri path — read from the SQLite cache.
          for (const prov of providers) {
            try {
              const { rows } = await symbolCatalogList(prov, perProvider, 0);
              if (rows.length === 0) {
                // Cache empty for this provider — fall back to legacy ASSETS.
                for (const a of ASSETS) {
                  if (a.provider !== prov) continue;
                  aggregate.push({
                    provider: a.provider,
                    sym: a.sym,
                    quote: defaultQuoteForProvider(a.provider),
                    name: a.name,
                    class: a.class,
                    status: 'active',
                    native_sym: a.sym,
                  });
                }
              } else {
                aggregate.push(...rows);
              }
            } catch (err) {
              // Catalog list failed (e.g. Alpaca AuthFailed) — fall through
              // to the legacy curated ASSETS for that provider so the tool
              // doesn't return an empty slice on cred trouble.
              // eslint-disable-next-line no-console
              console.warn(`[bridgeRoundtrip] list_assets ${prov} failed:`, err);
              for (const a of ASSETS) {
                if (a.provider !== prov) continue;
                aggregate.push({
                  provider: a.provider,
                  sym: a.sym,
                  quote: defaultQuoteForProvider(a.provider),
                  name: a.name,
                  class: a.class,
                  status: 'active',
                  native_sym: a.sym,
                });
              }
            }
          }
        }

        // Apply optional prefix filter (sym OR name).
        const filtered = symPrefix
          ? aggregate.filter((r) => {
              const symHit = r.sym.toLowerCase().startsWith(symPrefix);
              const nameHit =
                typeof r.name === 'string' &&
                r.name.toLowerCase().startsWith(symPrefix);
              return symHit || nameHit;
            })
          : aggregate;

        const capped = filtered.slice(0, LIMIT).map((r) => ({
          provider: r.provider,
          sym: r.sym,
          quote: r.quote,
          class: r.class,
          ...(r.name ? { name: r.name } : {}),
        }));
        await replyOk(id, capped);
        break;
      }

      // ------------------------------------------------------------------
      // Unknown method
      // ------------------------------------------------------------------
      default: {
        await replyError(id, -32002, `unknown bridge method: ${method}`);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[bridgeRoundtrip] handler threw:', method, err);
    await replyError(id, -32005, `handler error: ${message}`).catch(() => {
      // Ignore errors replying to the bridge — the Rust side will timeout.
    });
  }
}

// ---------------------------------------------------------------------------
// Mount — call once at app startup
// ---------------------------------------------------------------------------

/**
 * Subscribe to `bridge:request` events from the IPC bridge.
 *
 * Returns an unsubscribe function — call it on component unmount to avoid
 * duplicate listeners if the component remounts (should only happen in dev HMR).
 */
export async function mountBridgeRoundtrip(): Promise<() => void> {
  const unlisten = await listen<BridgeRequestEnvelope>(
    'bridge:request',
    (event) => {
      void handleRequest(event.payload);
    },
  );
  return unlisten;
}
