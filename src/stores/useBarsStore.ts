/**
 * src/stores/useBarsStore.ts — visible-candle seam store.
 *
 * Mirrors the chart's active `bars` (OHLCV candles currently rendered) so
 * sibling panels — e.g. the Indicators drawer — can read them without prop-
 * drilling through AppShell. AppShell owns the canonical state; this store is
 * a mirror written via a `[bars]`-dep effect.
 *
 * @see src/AppShell.tsx for the sync effect that writes here.
 */

import { create } from 'zustand';
import type { Bar } from '../data/MarketDataProvider';

interface BarsState {
  bars: Bar[];
  setBars: (bars: Bar[]) => void;
}

export const useBarsStore = create<BarsState>((set) => ({
  bars: [],
  setBars: (bars) => set({ bars }),
}));
