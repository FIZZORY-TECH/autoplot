/**
 * src/ai/seedStrategies.ts — first-run Library seed for P7 (W5-C3).
 *
 * On first launch we populate the user's Library with two preset strategies so
 * the Strategy panel doesn't open onto an empty surface. Both are real DSL
 * objects that Zod-validate against the W5-A `Strategy` schema and can be
 * passed through `backtest()` without throwing.
 *
 * Idempotency:
 *   Gated by `app_state['library.strategies_seeded']` (string `'1'` once done).
 *   Outside Tauri (vite dev) the DB calls reject silently; the gate remains
 *   unset so the next Tauri-backed run will complete the seed.
 *
 * Pattern: mirrors `src/ai/seedDatasets.ts` exactly.
 */

import { dbAppStateGet, dbAppStateSet } from '../lib/db';
import {
  useStrategyStore,
  type PersistedStrategy,
} from '../stores/useStrategyStore';

const SEED_GATE_KEY = 'library.strategies_seeded';

/**
 * Two real DSL strategies. Both Zod-parse against `Strategy` (W5-A) and run
 * through `backtest()` without throwing.
 *
 * We pin stable ids so re-seeding on a fresh install is idempotent: if the
 * user deletes these rows, they won't come back on the next launch (the gate
 * is already set). The `createdAt` is supplied at seed time (not baked in as a
 * constant) so the field reflects real creation time.
 */
export const SEED_STRATEGY_DEFS: ReadonlyArray<
  Omit<PersistedStrategy, 'createdAt'>
> = [
  {
    id: 'seed-rsi-revert-v1',
    name: 'RSI(14) Mean Reversion',
    thesis:
      'Buy when RSI(14) is oversold (< 30) and sell when overbought (> 70). Classic mean-reversion on daily timeframe.',
    rules: {
      entry: [
        {
          indicator: 'rsi',
          op: '<',
          value: 30,
          params: { period: 14 },
        },
      ],
      exit: [
        {
          indicator: 'rsi',
          op: '>',
          value: 70,
          params: { period: 14 },
        },
      ],
    },
    perf: undefined,
    version: 1 as const,
  },
  {
    id: 'seed-donchian-breakout-v1',
    name: 'Donchian 20/10 Breakout',
    thesis:
      'Enter long on a close breakout above the prior bar\'s Donchian high channel (20 periods). Exit when close falls below the 10-period Donchian low.',
    rules: {
      entry: [
        {
          indicator: 'close',
          op: 'crossesAbove',
          value: {
            ref: 'donchian_high' as const,
            params: { period: 20 },
          },
        },
      ],
      exit: [
        {
          indicator: 'close',
          op: 'crossesBelow',
          value: {
            ref: 'donchian_low' as const,
            params: { period: 10 },
          },
        },
      ],
    },
    perf: undefined,
    version: 1 as const,
  },
];

/**
 * Idempotently seed the two preset strategies if `library.strategies_seeded`
 * is unset. Safe to call multiple times. Outside Tauri (dev-server), the
 * underlying DB calls reject and we log + early-return so dev iteration
 * doesn't error out.
 */
export async function seedDefaultStrategiesIfNeeded(): Promise<void> {
  let alreadySeeded = false;
  try {
    const flag = await dbAppStateGet(SEED_GATE_KEY);
    alreadySeeded = flag === '1';
  } catch (err) {
    // No Tauri runtime — dev fallback. Skip silently.
    console.warn(
      '[seedStrategies] dbAppStateGet failed (no Tauri?), skipping seed',
      err,
    );
    return;
  }
  if (alreadySeeded) return;

  const now = Date.now();
  const store = useStrategyStore.getState();

  for (let i = 0; i < SEED_STRATEGY_DEFS.length; i++) {
    const def = SEED_STRATEGY_DEFS[i];
    const full: PersistedStrategy = { ...def, createdAt: now + i };
    try {
      await store.addStrategy(full);
    } catch (err) {
      console.warn('[seed-strategies] seed strategy failed', def.id, err);
    }
  }

  try {
    await dbAppStateSet(SEED_GATE_KEY, '1');
  } catch (err) {
    console.warn('[seed-strategies] could not flip strategies_seeded gate', err);
  }
}

/** Test-only helper: clear the seed gate so a fresh run reseeds. NOT exported
 *  in production usage — referenced by vitest only. */
export async function _resetStrategySeedGateForTests(): Promise<void> {
  try {
    await dbAppStateSet(SEED_GATE_KEY, '0');
  } catch {
    /* dev fallback */
  }
}
