/**
 * src/ai/seedDatasets.ts — first-run Library seed for P6 (W4-B).
 *
 * On first launch we populate the user's Library with five preset datasets so
 * the Research panel doesn't open onto an empty surface. Each preset is a
 * fixed prompt template + an expected dataset shape (a stub Dataset JSON to
 * populate the card before the user actually asks AI to compute it).
 *
 * Idempotency:
 *   Gated by `app_state['library.datasets_seeded']` (string `'1'` once seeded).
 *   The check + the writes are wrapped in try/catch so a missing Tauri runtime
 *   (vite dev) silently no-ops; on the next Tauri-backed run the seed will
 *   complete because the gate is still unset.
 *
 * Pattern: mirrors the existing settings-tools default seeding in
 * `src/lib/hydrate.ts:seedToolDefaultsIfEmpty()` — additive-only, never
 * overwrites a user-edited row.
 */

import { dbAppStateGet, dbAppStateSet } from '../lib/db';
import { useDatasetStore, type PersistedDataset } from '../stores/useDatasetStore';

const SEED_GATE_KEY = 'library.datasets_seeded';

/** Five preset datasets using the canonical W4-A Dataset field names.
 *
 *  The numeric series are short illustrative stubs — W4-A's `compute_indicator`
 *  tool will overwrite them when the user actually runs the preset prompt. We
 *  use deterministic seeded values (no randomness) so the card preview is
 *  stable across runs and visual-diff captures stay byte-identical.
 *
 *  `kind` maps to Dataset.kind (`'overlay' | 'series'`); all presets are
 *  sub-panel series renderings. `notes` carries the prompt for display.
 */
export const DEFAULT_DATASET_PRESETS: ReadonlyArray<{
  dataset: Omit<PersistedDataset, 'createdAt'>;
  prompt: string;
}> = [
  {
    prompt: 'Plot the 30-day realized volatility of BTC.',
    dataset: {
      id: 'preset-realized-vol-30d',
      label: '30d realized vol',
      kind: 'series',
      sym: 'BTC',
      tf: '1d',
      values: [0.42, 0.41, 0.39, 0.40, 0.43, 0.45, 0.47, 0.46, 0.44, 0.42, 0.41, 0.40, 0.39, 0.38, 0.40, 0.42, 0.45, 0.48, 0.51, 0.52],
      align: 'right',
      notes: 'Plot the 30-day realized volatility of BTC.',
    },
  },
  {
    prompt: 'Show BTC correlation with ETH over the last 60 bars.',
    dataset: {
      id: 'preset-correlation-eth',
      label: 'Correlation w/ ETH',
      kind: 'series',
      sym: 'BTC',
      tf: '1h',
      values: [0.71, 0.73, 0.75, 0.78, 0.80, 0.82, 0.81, 0.79, 0.77, 0.75, 0.74, 0.76, 0.78, 0.81, 0.83, 0.84, 0.82, 0.80, 0.78, 0.77],
      align: 'right',
      notes: 'Show BTC correlation with ETH over the last 60 bars.',
    },
  },
  {
    prompt: 'Compute the momentum z-score of close prices.',
    dataset: {
      id: 'preset-momentum-z',
      label: 'Momentum z-score',
      kind: 'series',
      sym: 'BTC',
      tf: '1h',
      values: [-0.4, -0.2, 0.1, 0.4, 0.7, 1.0, 1.2, 1.1, 0.8, 0.5, 0.2, -0.1, -0.4, -0.6, -0.5, -0.3, 0.0, 0.3, 0.6, 0.8],
      align: 'right',
      notes: 'Compute the momentum z-score of close prices.',
    },
  },
  {
    prompt: 'Plot a liquidity pressure indicator (volume-weighted spread proxy).',
    dataset: {
      id: 'preset-liquidity-pressure',
      label: 'Liquidity pressure',
      kind: 'series',
      sym: 'BTC',
      tf: '1h',
      values: [0.18, 0.22, 0.26, 0.32, 0.38, 0.41, 0.39, 0.34, 0.29, 0.25, 0.23, 0.21, 0.20, 0.22, 0.27, 0.33, 0.38, 0.41, 0.40, 0.35],
      align: 'right',
      notes: 'Plot a liquidity pressure indicator (volume-weighted spread proxy).',
    },
  },
  {
    prompt: 'Approximate the funding rate via the perp/spot basis.',
    dataset: {
      id: 'preset-funding-rate-proxy',
      label: 'Funding rate proxy',
      kind: 'series',
      sym: 'BTC',
      tf: '1h',
      values: [0.012, 0.014, 0.018, 0.022, 0.025, 0.024, 0.021, 0.018, 0.016, 0.015, 0.014, 0.013, 0.012, 0.011, 0.013, 0.016, 0.019, 0.022, 0.024, 0.023],
      align: 'right',
      notes: 'Approximate the funding rate via the perp/spot basis.',
    },
  },
];

/**
 * Idempotently seed the five preset datasets if `library.datasets_seeded` is
 * unset. Safe to call multiple times. Outside Tauri (dev-server), the
 * underlying DB calls reject and we log + early-return so dev iteration
 * doesn't error out.
 */
export async function seedDefaultDatasetsIfNeeded(): Promise<void> {
  let alreadySeeded = false;
  try {
    const flag = await dbAppStateGet(SEED_GATE_KEY);
    alreadySeeded = flag === '1';
  } catch (err) {
    // No Tauri runtime — dev fallback. Skip silently.
    console.warn('[seedDatasets] dbAppStateGet failed (no Tauri?), skipping seed', err);
    return;
  }
  if (alreadySeeded) return;

  const now = Date.now();
  const store = useDatasetStore.getState();

  // Insert each preset. `addDataset` upserts by id, so even if a partial seed
  // ran on a prior crash, retrying is safe (no duplicate rows).
  for (let i = 0; i < DEFAULT_DATASET_PRESETS.length; i++) {
    const { dataset } = DEFAULT_DATASET_PRESETS[i];
    const full: PersistedDataset = { ...dataset, createdAt: now + i };
    try {
      await store.addDataset(full);
    } catch (err) {
      console.warn('[seed-datasets] preset failed', dataset.id, err);
    }
  }

  // Flip the gate so subsequent runs are no-ops.
  try {
    await dbAppStateSet(SEED_GATE_KEY, '1');
  } catch (err) {
    console.warn('[seed-datasets] could not flip datasets_seeded gate', err);
  }
}

/** Test-only helper: clear the seed gate so a fresh run reseeds. NOT exported
 *  in production usage — referenced by vitest only. */
export async function _resetSeedGateForTests(): Promise<void> {
  try {
    await dbAppStateSet(SEED_GATE_KEY, '0');
  } catch {
    /* dev fallback */
  }
}
