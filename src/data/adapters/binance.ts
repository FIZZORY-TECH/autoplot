/**
 * src/data/adapters/binance.ts — Binance WebSocket adapter (P4.2).
 *
 * Subscribes to a single Binance kline stream for (sym, tf) and forwards
 * completed/updating bars to the caller via a callback.
 *
 * Architecture (A2): REST history lives in Rust; WS live deltas live here in TS
 * so ticks stream directly into the chart layer without an IPC hop.
 *
 * Stream URL: wss://stream.binance.com:9443/ws/{symbol}@kline_{interval}
 *   symbol   = sym.toLowerCase() + 'usdt'   (e.g. 'btcusdt')
 *   interval = tf passed through directly    (e.g. '1h', '4h', '1d', '1w')
 *
 * Reconnect: exponential backoff with random jitter, capped at 30 s.
 */

import type { Bar, Tf } from '../MarketDataProvider';

export interface BinanceWsConnection {
  /** Stop the subscription and close the underlying WebSocket. */
  unsubscribe: () => void;
}

/**
 * Subscribe to Binance kline updates for `sym` at timeframe `tf`.
 *
 * `cb` is called for every incoming kline event (including in-progress bars —
 * the chart layer decides whether to treat them as final or live).
 *
 * Returns a `BinanceWsConnection` with an `unsubscribe` method; MUST be called
 * on cleanup to prevent reconnect loops.
 */
// ADR-0009: quote now passed in; no behavior change beyond literal substitution.
// `quote` defaults to 'USDT' so pre-ADR-0009 callers keep working during the
// transitional release; Step 7 widens the providerRegistry to thread an
// explicit quote through every callsite.
export function subscribeBinance(
  sym: string,
  tf: Tf,
  cb: (bar: Bar) => void,
  quote: string = 'USDT',
): BinanceWsConnection {
  const symbol = sym.toLowerCase() + quote.toLowerCase(); // 'btcusdt' / 'btcusdc'
  const interval = tf;                        // pass-through: '1h' / '4h' / '1d' / '1w'
  const url = `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`;

  let ws: WebSocket | null = null;
  let reconnectDelay = 1_000; // milliseconds; doubles on each disconnect
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;

    ws = new WebSocket(url);

    ws.onopen = () => {
      // Connection established — reset backoff.
      reconnectDelay = 1_000;
    };

    ws.onmessage = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data as string) as BinanceKlineMessage;
        if (msg?.k) {
          const k = msg.k;
          const bar: Bar = {
            ts: k.t,
            o: parseFloat(k.o),
            h: parseFloat(k.h),
            l: parseFloat(k.l),
            c: parseFloat(k.c),
            v: parseFloat(k.v),
          };
          cb(bar);
        }
      } catch {
        // Malformed frame — log and continue; do not close the connection.
        console.warn('[binance-ws] failed to parse message', evt.data);
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

// ---------------------------------------------------------------------------
// Internal wire types (not exported — these are Binance-specific)
// ---------------------------------------------------------------------------

interface BinanceKlinePayload {
  /** Kline open time (ms). */
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  /** Whether this kline is closed/final. */
  x: boolean;
}

interface BinanceKlineMessage {
  e?: string; // event type, e.g. "kline"
  k?: BinanceKlinePayload;
}
