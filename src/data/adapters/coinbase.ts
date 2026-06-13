/**
 * src/data/adapters/coinbase.ts — Coinbase WebSocket adapter (P4.3).
 *
 * Subscribes to the Coinbase Exchange WebSocket feed's `ticker` channel for a
 * given product (e.g. "BTC-USD") and forwards synthetic bars to the caller.
 *
 * Architecture (A2): REST history lives in Rust; WS live deltas live here in TS
 * so ticks stream directly into the chart layer without an IPC hop.
 *
 * Feed URL: wss://ws-feed.exchange.coinbase.com
 *
 * Subscription message:
 *   { "type": "subscribe", "product_ids": ["BTC-USD"], "channels": ["ticker"] }
 *
 * ## Ticker → running aggregated Bar
 *
 * The Coinbase `ticker` channel emits live trade updates, not OHLC bars. The
 * adapter keeps an in-progress aggregation per timeframe bucket: the first
 * tick in a `floor(ts / tfMs) * tfMs` bucket opens the bar, subsequent ticks
 * update high/low/close, and the next bucket flushes a fresh bar. Volume
 * remains 0 since `ticker` payloads do not include trade size.
 *
 * ## Reconnect strategy
 *
 * Exponential backoff with random ±500 ms jitter, capped at 30 s — same
 * pattern as the Binance adapter.
 */

import type { Bar, Tf } from '../MarketDataProvider';
import { tfToMs } from '../tf';

export interface CoinbaseWsConnection {
  /** Stop the subscription and close the underlying WebSocket. */
  unsubscribe: () => void;
}

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';

/**
 * Map canonical symbol to Coinbase product ID: "BTC" → "BTC-USD".
 * Mirrors the symbol mapping in the Rust CoinbaseProvider.
 *
 * ADR-0009: `quote` defaults to 'USD' (the only quote shipping pre-ADR-0009);
 * Step 7 will widen real callsites to pass it explicitly.
 */
export function mapSymbol(sym: string, quote: string = 'USD'): string {
  return `${sym.toUpperCase()}-${quote.toUpperCase()}`;
}

/**
 * Subscribe to Coinbase ticker updates for `sym` at timeframe `tf`.
 *
 * `cb` is called on every incoming ticker message with a Bar that represents
 * the running aggregation for the current `tf`-sized bucket: open is the first
 * tick's price, high/low track running extremes, close is the latest tick.
 * When a tick crosses into the next bucket, a fresh bar is opened and emitted.
 *
 * Returns a `CoinbaseWsConnection` with an `unsubscribe` method; MUST be called
 * on cleanup to prevent reconnect loops.
 */
// ADR-0009: quote now passed in; no behavior change beyond literal substitution.
// `quote` defaults to 'USD' so pre-ADR-0009 callers keep working during the
// transitional release; Step 7 widens the providerRegistry to thread an
// explicit quote through every callsite.
export function subscribeCoinbase(
  sym: string,
  tf: Tf,
  cb: (bar: Bar) => void,
  quote: string = 'USD',
): CoinbaseWsConnection {
  const productId = mapSymbol(sym, quote);
  const subscribeMsg = JSON.stringify({
    type: 'subscribe',
    product_ids: [productId],
    channels: ['ticker'],
  });
  const tfMs = tfToMs(tf);

  // Running aggregation: the in-progress bar for the current tf-bucket. Reset
  // when the next tick crosses into a new bucket, or when the WS reconnects
  // (a gap in the stream means we shouldn't extend a stale bar across it).
  let runningBar: Bar | null = null;

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
        const msg = JSON.parse(evt.data as string) as CoinbaseWsMessage;

        if (msg.type === 'ticker' && msg.price != null && msg.time != null) {
          const price = parseFloat(msg.price);
          const ts = Date.parse(msg.time);

          if (isNaN(price) || isNaN(ts)) return;

          // Bucket the tick to the current tf grid and either open a fresh
          // running bar or update the existing one's h/l/c.
          const bucketStart = Math.floor(ts / tfMs) * tfMs;
          if (runningBar === null || bucketStart !== runningBar.ts) {
            runningBar = {
              ts: bucketStart,
              o: price,
              h: price,
              l: price,
              c: price,
              v: 0,
            };
          } else {
            if (price > runningBar.h) runningBar.h = price;
            if (price < runningBar.l) runningBar.l = price;
            runningBar.c = price;
          }

          // Emit a clone so downstream mutations don't bleed back into our
          // in-progress aggregation.
          cb({ ...runningBar });
        }
        // Ignore non-ticker messages (subscriptions, heartbeats, errors).
      } catch {
        // Malformed frame — log and continue; do not close the connection.
        console.warn('[coinbase-ws] failed to parse message', evt.data);
      }
    };

    ws.onclose = () => {
      ws = null;
      // A reconnect introduces a gap in the tick stream; drop the in-progress
      // bar so the next tick opens a fresh aggregation rather than extending
      // a stale one across the disconnect.
      runningBar = null;
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

// ---------------------------------------------------------------------------
// Internal wire types (not exported — Coinbase-specific)
// ---------------------------------------------------------------------------

interface CoinbaseWsMessage {
  type: string;
  /** Present on ticker messages: current trade price as a decimal string. */
  price?: string;
  /** Present on ticker messages: ISO 8601 UTC timestamp of the trade. */
  time?: string;
  /** Present on ticker messages: product identifier, e.g. "BTC-USD". */
  product_id?: string;
}
