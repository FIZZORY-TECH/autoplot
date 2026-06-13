/**
 * src/data/adapters/kraken.ts — Kraken WebSocket adapter (P4.4).
 *
 * Subscribes to the Kraken WebSocket v1 `ohlc` channel for a given asset and
 * timeframe, and forwards completed/updating OHLC bars to the caller via a
 * callback.
 *
 * Architecture (A2): REST history lives in Rust; WS live deltas live here in TS
 * so ticks stream directly into the chart layer without an IPC hop.
 *
 * ## Feed URL
 *
 *   wss://ws.kraken.com
 *
 * ## Subscription message
 *
 * ```json
 * {
 *   "event": "subscribe",
 *   "pair": ["XBT/USD"],
 *   "subscription": { "name": "ohlc", "interval": 60 }
 * }
 * ```
 *
 * ## Pair naming convention
 *
 * Kraken WS uses pair names with `/` separators (e.g. `XBT/USD`, `ETH/USD`).
 * Additionally, Kraken uses `XBT` instead of `BTC` for Bitcoin.
 * This adapter converts the canonical symbol (e.g. `"BTC"`) to the WS pair
 * format before subscribing. See `mapSymbolToWsPair` below.
 *
 * ## OHLC channel message format
 *
 * Unlike Coinbase's tick stream, the Kraken `ohlc` channel emits actual OHLC
 * bars directly. Each message after the subscription confirmation is:
 *
 * ```json
 * [channelID, [time, etime, open, high, low, close, vwap, volume, count], "ohlc-60", "XBT/USD"]
 * ```
 *
 * Field mapping:
 *   - `ts: parseFloat(time) * 1000`     (time = unix seconds with decimal)
 *   - `o: parseFloat(open)`
 *   - `h: parseFloat(high)`
 *   - `l: parseFloat(low)`
 *   - `c: parseFloat(close)`
 *   - `v: parseFloat(volume)`
 *
 * ## Reconnect strategy
 *
 * Exponential backoff with random ±500 ms jitter, capped at 30 s — same
 * pattern as the Binance and Coinbase adapters.
 */

import type { Bar, Tf } from '../MarketDataProvider';

export interface KrakenWsConnection {
  /** Stop the subscription and close the underlying WebSocket. */
  unsubscribe: () => void;
}

const WS_URL = 'wss://ws.kraken.com';

/**
 * Map a canonical symbol to the Kraken WS pair format.
 *
 * Kraken WS pairs use `/` separators and `XBT` for Bitcoin:
 *   "BTC" → "XBT/USD"
 *   "ETH" → "ETH/USD"
 *   "SOL" → "SOL/USD"
 *   etc.
 *
 * The 13-token mapping table mirrors the Rust `kraken_pair()` function,
 * adapted to the WS `/`-separated format. Default fallback: `{SYM}/USD`.
 */
// ADR-0009: quote now passed in; no behavior change beyond literal substitution.
// When `quote === 'USD'` (the pre-ADR-0009 default) the original lookup table
// resolves the BTC→XBT base alias exactly as before. For non-USD quotes (e.g.
// USDT) we still apply the base alias but substitute the requested quote on
// the right-hand side so SOL/USDT and SOL/USD route to distinct pairs.
export function mapSymbolToWsPair(sym: string, quote: string = 'USD'): string {
  const upper = sym.toUpperCase();
  const upperQuote = quote.toUpperCase();
  // Kraken aliases: BTC trades as XBT on the wire. All other tickers are
  // identity-mapped — the table previously hardcoded /USD; we now build the
  // pair from `(base, quote)` so any quote works.
  const base = upper === 'BTC' ? 'XBT' : upper;
  return `${base}/${upperQuote}`;
}

/**
 * Map the 4-tier app timeframe label to Kraken's interval integer (minutes).
 *
 * All four tiers are natively supported by Kraken:
 *   "1h" → 60, "4h" → 240, "1d" → 1440, "1w" → 10080.
 */
export function mapTfToInterval(tf: Tf): number {
  switch (tf) {
    case '1h': return 60;
    case '4h': return 240;
    case '1d': return 1440;
    case '1w': return 10080;
  }
}

/**
 * Subscribe to Kraken OHLC updates for `sym` at timeframe `tf`.
 *
 * `cb` is called for every incoming OHLC bar (which may be an in-progress bar
 * for the current interval — the chart layer decides whether to treat it as
 * final or live).
 *
 * Returns a `KrakenWsConnection` with an `unsubscribe` method; MUST be called
 * on cleanup to prevent reconnect loops.
 */
// ADR-0009: quote now passed in; no behavior change beyond literal substitution.
// `quote` defaults to 'USD' so pre-ADR-0009 callers (e.g. the test suite)
// resolve to the original XBT/USD / FOO/USD pairs; Step 7 widens the
// providerRegistry to thread an explicit quote through every callsite.
export function subscribeKraken(
  sym: string,
  tf: Tf,
  cb: (bar: Bar) => void,
  quote: string = 'USD',
): KrakenWsConnection {
  const pair = mapSymbolToWsPair(sym, quote);
  const interval = mapTfToInterval(tf);

  const subscribeMsg = JSON.stringify({
    event: 'subscribe',
    pair: [pair],
    subscription: { name: 'ohlc', interval },
  });

  let ws: WebSocket | null = null;
  let reconnectDelay = 1_000; // ms; doubles on each disconnect
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      // Reset backoff on successful connect.
      reconnectDelay = 1_000;
      // Send subscription after handshake.
      ws?.send(subscribeMsg);
    };

    ws.onmessage = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data as string) as unknown;

        // OHLC data messages are arrays: [channelID, [ohlc...], "ohlc-60", "XBT/USD"]
        // Non-array messages (events: heartbeat, subscriptionStatus, etc.) are ignored.
        if (!Array.isArray(msg) || msg.length < 4) return;

        const payload = msg[1];
        if (!Array.isArray(payload) || payload.length < 8) return;

        // payload: [time, etime, open, high, low, close, vwap, volume, count]
        // Indices:   0     1      2     3     4    5      6     7       8
        const [time, , open, high, low, close, , volume] = payload as string[];

        const ts = parseFloat(time) * 1_000; // seconds → ms
        const o = parseFloat(open);
        const h = parseFloat(high);
        const l = parseFloat(low);
        const c = parseFloat(close);
        const v = parseFloat(volume);

        if (isNaN(ts) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || isNaN(v)) return;

        cb({ ts, o, h, l, c, v });
      } catch {
        // Malformed frame — log and continue; do not close the connection.
        console.warn('[kraken-ws] failed to parse message', evt.data);
      }
    };

    ws.onclose = () => {
      ws = null;
      if (stopped) return;

      // Exponential backoff with ±500 ms jitter, capped at 30 s.
      const jitter = Math.random() * 500;
      const delay = Math.min(reconnectDelay + jitter, 30_000);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);

      reconnectTimer = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onerror always precedes onclose; close triggers the reconnect path.
      ws?.close();
    };
  };

  connect();

  return {
    unsubscribe: () => {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      ws = null;
    },
  };
}
