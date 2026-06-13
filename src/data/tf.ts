import type { Tf } from './MarketDataProvider';

const TF_MS: Record<Tf, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

// Mirrors `tf_ms` in src-tauri/src/commands/market.rs.
export function tfToMs(tf: Tf): number {
  return TF_MS[tf];
}
