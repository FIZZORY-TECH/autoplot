/**
 * src/ai/devEventFixtures.ts — DEV-ONLY mock fixture for the on-chart
 * event-hotspot / series feature.
 *
 * ⚠️  PRODUCTION SAFETY ⚠️
 * Nothing in this module may run in a production build. Every call site is
 * gated behind `import.meta.env.DEV`, so under `vite build` the dead-code
 * elimination drops both the call and (because it becomes unreferenced) this
 * entire module. This file itself does NOT read `import.meta.env.DEV` — the
 * GUARD LIVES AT THE CALL SITE so tree-shaking can prove the import is unused.
 *
 * What it does:
 *   `seedDevEventFixtures(bars, sym, tf, opts)` builds — from the CURRENTLY
 *   LOADED bars — one cohesive scenario that exercises every case of the
 *   event/series feature, then applies it through the REAL store mutations:
 *
 *     - `useChartMutationStore.applyResearchOverlay` — one ResearchOverlay
 *       (id `dev-events-fixture`) carrying `event_mark` elements (pin / vline /
 *       range, with/without content, with/without source, a same-ts cluster of
 *       3, a long-content reader case, and varied source sites).
 *     - `useChartMutationStore.applyTimelineLayer` — one TimelineLayer
 *       (id `dev-timeline-fixture`) with bare TimelineEvents (degraded popover).
 *     - `useDatasetStore` + `useAppStore.setAiOverlayDataset` — one
 *       `kind:'series'` dataset (id `dev-rsi-fixture`) that forces the synced
 *       sub-pane below the price chart.
 *
 * The overlay is built with the REAL Zod shapes from `./schemas` and is
 * validated here with `ResearchOverlay.safeParse` before it is applied — so
 * this genuinely exercises the same contract the MCP bridge enforces.
 *
 * Event `ts` values are computed from REAL bar timestamps so the notches land
 * on visible bars. On refresh the spread/cluster jitter a little (seeded by a
 * monotonic nonce) so different placements are visible each reseed.
 */

import { ResearchOverlay, type ResearchOverlay as ResearchOverlayT, type EventMarkElement } from './schemas';
import { useChartMutationStore, type TimelineLayer } from '../stores/useChartMutationStore';
import { useDatasetStore, type PersistedDataset } from '../stores/useDatasetStore';
import { useAppStore } from '../stores/useAppStore';
import type { Bar } from '../data/MarketDataProvider';

/** Stable ids so reseeds replace (never duplicate) the prior fixture. */
export const DEV_OVERLAY_ID = 'dev-events-fixture';
export const DEV_TIMELINE_ID = 'dev-timeline-fixture';
export const DEV_SERIES_ID = 'dev-rsi-fixture';

/** Tf union accepted by the overlay schema. */
type Tf = ResearchOverlayT['tf'];

/** A long, multi-paragraph body to exercise the fullscreen-reader internal scroll. */
const LONG_CONTENT = [
  'The Federal Open Market Committee decided to maintain the target range for the federal funds rate, citing a labor market that remains resilient even as headline inflation has continued its gradual descent toward the two-percent objective. The Committee emphasized that it remains highly attentive to inflation risks and is prepared to adjust the stance of monetary policy as appropriate if risks emerge that could impede the attainment of its goals.',
  'In the accompanying summary of economic projections, participants marked up their expectations for real GDP growth while nudging down the projected path of the policy rate over the coming two years. Several participants noted that the balance of risks had shifted, with tightening financial conditions and persistent geopolitical uncertainty weighing against the still-firm momentum in consumer spending.',
  'Market reaction was swift across risk assets. Crypto markets, which had been consolidating in a tight range, broke decisively on the headline as leveraged positioning unwound. The move underscored how sensitive thin overnight liquidity has become to macro catalysts, with realized volatility spiking to levels not seen since the prior quarter’s drawdown.',
  'Analysts cautioned against reading too much into a single session. Historically, the initial reaction to policy communications has frequently reversed within seventy-two hours as desks digest the full statement and the subsequent press conference. Positioning data suggested that much of the move was mechanical rather than a fundamental repricing of the terminal rate.',
  'For research purposes, this annotation marks the bar on which the decision crossed the wire. The surrounding range annotation captures the elevated-volatility window that followed, during which intraday ranges roughly doubled relative to the trailing twenty-bar average before normalizing.',
].join('\n\n');

/** Pick a bar timestamp at a fractional position in the loaded range. */
function tsAt(bars: Bar[], frac: number): number {
  const i = Math.min(bars.length - 1, Math.max(0, Math.round(frac * (bars.length - 1))));
  return bars[i].ts;
}

/** Deterministic-ish jitter on the fraction so reseeds vary placement a little
 *  but stay inside the loaded range. `nonce` advances each manual refresh. */
function jitter(frac: number, nonce: number, spread = 0.05): number {
  // cheap LCG-ish hash → [-1, 1)
  const x = Math.sin(nonce * 12.9898 + frac * 78.233) * 43758.5453;
  const r = (x - Math.floor(x)) * 2 - 1;
  return Math.min(0.99, Math.max(0.01, frac + r * spread));
}

/** Build (but do not apply) the dev ResearchOverlay from the given bars. */
export function buildDevOverlay(bars: Bar[], sym: string, tf: Tf, nonce = 0): ResearchOverlayT {
  // Anchor positions across the loaded range; jitter on reseed.
  const fPin = jitter(0.1, nonce);
  const fCluster = jitter(0.35, nonce); // three events share this exact ts
  const fNoContent = jitter(0.55, nonce);
  const fNoSource = jitter(0.62, nonce);
  const fVline = jitter(0.7, nonce);
  const fRangeStart = jitter(0.8, nonce, 0.02);
  const fLong = jitter(0.95, nonce, 0.02);

  const tsCluster = tsAt(bars, fCluster);
  const tsRangeStart = tsAt(bars, fRangeStart);
  // Range end ~8% further along the loaded window (clamped to last bar).
  const tsRangeEnd = tsAt(bars, Math.min(0.88, fRangeStart + 0.08));

  const elements: EventMarkElement[] = [
    // (1) Single pin, FULL data.
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsAt(bars, fPin),
      label: 'FOMC holds rates steady',
      color: 'oklch(0.78 0.18 320)',
      content:
        'The committee voted unanimously to hold the policy rate. Forward guidance was unchanged but the dot plot shifted lower. Markets priced a modestly more dovish path into year-end.',
      source_url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary.htm',
      source_name: 'federalreserve.gov',
    },
    // (2) Cluster of 3 events at the SAME ts → one notch, count badge "3", 3-row popover.
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsCluster,
      label: 'CPI print comes in hot',
      content: 'Core CPI surprised to the upside at 0.4% m/m versus 0.3% expected, reviving sticky-inflation concerns.',
      source_url: 'https://www.reuters.com/markets/us/',
      source_name: 'reuters.com',
    },
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsCluster,
      label: 'Exchange reports record volume',
      content: 'A major venue reported its highest 24h spot volume of the quarter as the print hit the tape.',
      source_url: 'https://www.bloomberg.com/markets',
      source_name: 'bloomberg.com',
    },
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsCluster,
      label: 'Regulator opens comment window',
      content: 'A securities regulator opened a public comment period on spot-product custody rules.',
      source_url: 'https://www.sec.gov/news/pressreleases',
      source_name: 'sec.gov',
    },
    // (3) Event with NO content — title + source_url only → no expand control.
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsAt(bars, fNoContent),
      label: 'Headline with no body',
      source_url: 'https://www.bloomberg.com/news',
      source_name: 'bloomberg.com',
    },
    // (4) Event with NO source_url — content present (expand available), no badge.
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsAt(bars, fNoSource),
      label: 'Desk note (no source link)',
      content:
        'Internal desk colour: flows skewed toward dip-buying overnight; funding stayed positive but compressed. No external citation attached to this annotation.',
    },
    // (5) vline event — full data.
    {
      type: 'event_mark',
      kind: 'vline',
      ts: tsAt(bars, fVline),
      label: 'Quarterly options expiry',
      color: 'oklch(0.85 0.16 80)',
      content: 'Large notional of dated options rolled off at this expiry, removing a band of dealer gamma and widening the realized range into the following session.',
      source_url: 'https://www.reuters.com/markets/',
      source_name: 'reuters.com',
    },
    // (6) range event — ts + ts_end span, with content + source.
    {
      type: 'event_mark',
      kind: 'range',
      ts: tsRangeStart,
      ts_end: tsRangeEnd,
      label: 'Elevated-volatility window',
      color: 'oklch(0.78 0.20 25)',
      content: 'Intraday ranges roughly doubled versus the trailing 20-bar average across this span before normalizing.',
      source_url: 'https://www.bloomberg.com/markets/volatility',
      source_name: 'bloomberg.com',
    },
    // (7) Long-content event — multi-paragraph body for the reader scroll test.
    {
      type: 'event_mark',
      kind: 'pin',
      ts: tsAt(bars, fLong),
      label: 'Full FOMC statement & market reaction (long read)',
      color: 'oklch(0.82 0.14 215)',
      content: LONG_CONTENT,
      source_url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      source_name: 'federalreserve.gov',
    },
  ];

  return {
    id: DEV_OVERLAY_ID,
    sym,
    tf,
    label: 'Dev event fixture',
    elements,
  };
}

/** Build (but do not apply) the dev TimelineLayer (bare events → degraded popover). */
export function buildDevTimeline(bars: Bar[], nonce = 0): TimelineLayer {
  return {
    id: DEV_TIMELINE_ID,
    name: 'Dev timeline (degraded)',
    events: [
      { ts: tsAt(bars, jitter(0.25, nonce)), label: 'Network upgrade activated', kind: 'pin' },
      { ts: tsAt(bars, jitter(0.45, nonce)), label: 'Funding flip positive', kind: 'vline' },
    ],
  };
}

/** Build (but do not apply) the dev RSI(14)-style series dataset.
 *  `align: 'index'` → one value per visible bar; `values[i]` maps to bar i. */
export function buildDevSeries(bars: Bar[], sym: string, tf: Tf, nonce = 0): PersistedDataset {
  // A bounded 0–100 oscillator derived from close-to-close momentum so the
  // shape tracks the loaded bars and varies as the window/symbol changes.
  const values: Array<number | null> = bars.map((b, i) => {
    if (i < 14) return null; // cold-start gap (exercises null handling)
    const prev = bars[i - 14].c;
    const ratio = prev === 0 ? 0 : (b.c - prev) / prev;
    // squash to 0..100 around 50, add a small nonce-driven phase wobble
    const wobble = Math.sin(i * 0.3 + nonce) * 4;
    return Math.min(100, Math.max(0, 50 + ratio * 600 + wobble));
  });
  return {
    id: DEV_SERIES_ID,
    label: 'RSI(14) · dev mock',
    kind: 'series',
    align: 'index',
    sym,
    tf,
    values,
    notes: 'DEV-only mock oscillator forcing the synced sub-pane.',
    createdAt: Date.now(),
  };
}

let devSeedNonce = 0;

/**
 * Seed (or reseed) the full dev fixture against the CURRENTLY LOADED bars.
 *
 * @param bars   the live bar series (from AppShell state) — events anchor here.
 * @param sym    canonical symbol the bars belong to.
 * @param tf     timeframe the bars belong to (FROZEN 4-tier).
 * @param opts.bumpNonce  when true (manual refresh), advance the jitter nonce so
 *                        placements/clusters vary visibly between reseeds.
 * @returns the applied overlay, or `null` if there were no bars to anchor to.
 */
export function seedDevEventFixtures(
  bars: Bar[],
  sym: string,
  tf: Tf,
  opts: { bumpNonce?: boolean } = {},
): ResearchOverlayT | null {
  if (!bars || bars.length < 16) return null; // need enough bars to anchor + cold-start RSI
  if (opts.bumpNonce) devSeedNonce += 1;
  const nonce = devSeedNonce;

  const overlay = buildDevOverlay(bars, sym, tf, nonce);
  // Validate through the SAME contract the MCP bridge enforces.
  const parsed = ResearchOverlay.safeParse(overlay);
  if (!parsed.success) {
    console.warn('[devEventFixtures] overlay failed safeParse — not applying', parsed.error.issues);
    return null;
  }

  const cm = useChartMutationStore.getState();
  cm.applyResearchOverlay(parsed.data);
  cm.applyTimelineLayer(buildDevTimeline(bars, nonce));

  // Series dataset: add to in-memory store (no DB write) + select as active overlay.
  const series = buildDevSeries(bars, sym, tf, nonce);
  useDatasetStore.setState((s) => ({
    datasets: [...s.datasets.filter((d) => d.id !== series.id), series],
  }));
  useAppStore.getState().setAiOverlayDataset(series.id);

  return parsed.data;
}

/** Remove the dev fixture (overlay + timeline + series). DEV use / console. */
export function clearDevEventFixtures(): void {
  const cm = useChartMutationStore.getState();
  cm.removeResearchOverlay(DEV_OVERLAY_ID);
  cm.removeTimelineLayer(DEV_TIMELINE_ID);
  useDatasetStore.setState((s) => ({ datasets: s.datasets.filter((d) => d.id !== DEV_SERIES_ID) }));
  const app = useAppStore.getState();
  if (app.aiOverlayDatasetId === DEV_SERIES_ID) app.setAiOverlayDataset(null);
}
