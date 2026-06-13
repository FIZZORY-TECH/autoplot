/**
 * src/data/adapters/alpaca.ts — Alpaca Markets WebSocket adapter (ADR-0008).
 *
 * Subscribes to the Alpaca IEX free-tier WebSocket feed for equity bars and
 * aggregates incoming 1-minute bars into the active `Tf` bucket using UTC
 * alignment (NOT session-alignment — see ADR-0008 §5).
 *
 * Architecture (A2): REST history lives in Rust; WS live deltas live here in TS
 * so bars stream directly into the chart layer without an IPC hop.
 *
 * Feed URL: wss://stream.data.alpaca.markets/v2/iex (free tier)
 *           wss://stream.data.alpaca.markets/v2/sip  (paid SIP tier)
 *
 * Auth: send `{ action: "auth", key, secret }` immediately on open.
 * Subscribe: `{ action: "subscribe", bars: [sym] }` after auth is confirmed.
 *
 * Alpaca emits 1-minute OHLCV bars on the `bars` channel:
 *   { T: "b", S: "AAPL", o, h, l, c, v, t, ... }
 *
 * Because the frozen Tf set is 1h/4h/1d/1w (ADR-0002) and Alpaca delivers
 * 1-minute bars, the adapter aggregates multiple 1m bars into each tf-bucket
 * using UTC floor alignment — the same pattern the Coinbase adapter uses to
 * aggregate per-tick data into OHLC buckets.
 *
 * Error path: if the server sends `{ T: "error", code, msg }` the adapter
 * logs a [TODO P8 toast] warn and returns a noop unsubscribe (graceful fallthrough).
 *
 * Credentials are read from Vite env vars at build time:
 *   VITE_ALPACA_KEY_ID     (maps from env ALPACA_KEY_ID in .env)
 *   VITE_ALPACA_SECRET_KEY (maps from env ALPACA_SECRET_KEY in .env)
 *
 * If either is absent the adapter falls through to a noop with a warn.
 *
 * Reconnect: exponential backoff with ±500 ms jitter, capped at 30 s —
 * same pattern as the Coinbase and Binance adapters.
 */

import type { Bar, Tf } from '../MarketDataProvider';
import { tfToMs } from '../tf';
import { marketFetchLatest1m } from '../../lib/db';
import { isTauriRuntime } from '../../lib/runtime';

export interface AlpacaWsConnection {
  /** Stop the subscription and close the underlying WebSocket. */
  unsubscribe: () => void;
}

const WS_URL = 'wss://stream.data.alpaca.markets/v2/iex';

/**
 * Map canonical symbol to Alpaca wire symbol.
 * Alpaca uses the exchange symbol directly — identity mapping for US equities.
 * (e.g. 'AAPL' → 'AAPL', 'SPY' → 'SPY')
 */
export function mapSymbol(sym: string): string {
  return sym.toUpperCase();
}

/**
 * Returns true if both VITE_ALPACA_KEY_ID and VITE_ALPACA_SECRET_KEY are
 * defined in the Vite env at build-time. Used by the provider registry to
 * decide whether to attempt a WS subscription or surface a hard-fail error.
 */
export function hasAlpacaCredentials(): boolean {
  const keyId = import.meta.env.VITE_ALPACA_KEY_ID as string | undefined;
  const secretKey = import.meta.env.VITE_ALPACA_SECRET_KEY as string | undefined;
  return Boolean(keyId && secretKey);
}

/**
 * Subscribe to Alpaca 1-minute bar updates for `sym` at timeframe `tf`.
 *
 * Incoming 1-minute bars are aggregated into the active tf-bucket using UTC
 * floor alignment: open is the first 1m bar's open within the bucket,
 * high/low track running extremes across all 1m bars in the bucket, close
 * is the latest 1m bar's close, and volume accumulates.
 *
 * When a 1m bar crosses into the next tf-bucket, a fresh aggregation begins.
 *
 * Returns an `AlpacaWsConnection` with an `unsubscribe` method; MUST be
 * called on cleanup to prevent reconnect loops.
 *
 * If credentials are absent, returns a noop unsubscribe immediately.
 */
// ADR-0009: quote now passed in; no behavior change beyond literal substitution.
// Alpaca is USD-only (equities); `quote` defaults to 'USD' and is otherwise
// ignored at the wire level. Threaded only for signature parity with the other
// adapters so the providerRegistry can call them uniformly.
export function subscribeAlpaca(
  sym: string,
  tf: Tf,
  cb: (bar: Bar) => void,
  quote: string = 'USD',
): AlpacaWsConnection {
  const keyId = import.meta.env.VITE_ALPACA_KEY_ID as string | undefined;
  const secretKey = import.meta.env.VITE_ALPACA_SECRET_KEY as string | undefined;

  if (!keyId || !secretKey) {
    // eslint-disable-next-line no-console
    console.warn('[TODO P8 toast] alpaca: missing credentials');
    return { unsubscribe: () => {} };
  }

  const wireSym = mapSymbol(sym);
  const authMsg = JSON.stringify({ action: 'auth', key: keyId, secret: secretKey });
  const subscribeMsg = JSON.stringify({ action: 'subscribe', bars: [wireSym] });
  const tfMs = tfToMs(tf);

  // Running aggregation: in-progress bucket bar. Aggregates multiple 1m bars
  // from Alpaca into a single tf-bucket bar using UTC-floor alignment.
  // Reset on reconnect (a gap in the stream means we shouldn't extend a stale
  // bar across the disconnect).
  let runningBar: Bar | null = null;

  let ws: WebSocket | null = null;
  let reconnectDelay = 1_000; // ms; doubles on each disconnect
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the server has confirmed auth — guards against subscribing early. */
  let authed = false;

  /**
   * Merge a single OHLCV sample into the running tf-bucket aggregation and emit
   * a clone. `bucketStart` is the UTC-floor of the active tf window. This is the
   * one shared code path for both live 1m WS bars and the subscribe/reconnect
   * seed, so the seed merges identically and can never produce a duplicate or
   * out-of-order bar — a later WS tick in the same bucket just extends it.
   */
  const mergeSample = (
    bucketStart: number,
    o: number,
    h: number,
    l: number,
    c: number,
    v: number,
  ): void => {
    if (runningBar === null || bucketStart !== runningBar.ts) {
      // New bucket — open a fresh aggregation with the sample's values.
      runningBar = { ts: bucketStart, o, h, l, c, v };
    } else {
      // Same bucket — extend the running aggregation.
      if (h > runningBar.h) runningBar.h = h;
      if (l < runningBar.l) runningBar.l = l;
      runningBar.c = c;
      runningBar.v += v;
    }
    // Emit a clone so downstream mutations don't bleed back into our
    // in-progress aggregation.
    cb({ ...runningBar });
  };

  /**
   * Layer 2 seed (root-cause B): emit a fresh "current bucket" price the moment
   * a subscription starts (and after every reconnect) instead of waiting up to
   * ~60s for the first 1m WS bar — or forever while the market is closed.
   *
   * Fix A (1h stale-price bug): we pull the latest **1-minute** bar (≤~60s old)
   * via `marketFetchLatest1m` → `market_fetch_latest_1m`, NOT `count=1` of the
   * chart's own timeframe. Fetching `count=1` of a 1h chart returned the last
   * *completed* hour, which is up to ~59 min stale. The 1m path forces Alpaca's
   * `1Min` REST timeframe and bypasses the 4-tier `tf_ms` gate (`'1m'` is not in
   * the frozen `Tf` set — ADR-0002).
   *
   * We then re-stamp the 1m close onto the *current* active tf bucket
   * (`floor(now / tfMs) * tfMs`, where `tfMs` is for the chart `tf`) so it lands
   * on the bucket the next WS tick will extend — never a stale completed bucket.
   * Volume is dropped (set to 0) because we are seeding the open of a
   * not-yet-traded bucket, not replaying a completed bar's volume; the first
   * real WS tick supplies live volume.
   *
   * Only runs under the Tauri runtime — REST history is Rust-only, and in
   * browser/test contexts there is no IPC to call. On any failure we warn per
   * repo convention and fall back to the pre-seed behavior (wait for the first
   * WS bar).
   */
  const seedCurrentBucket = (): void => {
    if (!isTauriRuntime()) return;
    marketFetchLatest1m('alpaca', wireSym, quote)
      .then((latest) => {
        if (stopped) return;
        if (!latest || typeof latest.c !== 'number') return;
        const bucketStart = Math.floor(Date.now() / tfMs) * tfMs;
        // Seed the bucket open from the freshest known close so all four
        // OHLC fields start coherent (o=h=l=c) until a live tick arrives.
        const px = latest.c;
        mergeSample(bucketStart, px, px, px, px, 0);
      })
      .catch((err: unknown) => {
        // Fail silently — seeding is best-effort. Fall back to waiting for the
        // first WS bar (pre-Layer-2 behavior).
        // eslint-disable-next-line no-console
        console.warn(
          `[TODO P8 toast] alpaca: seed fetch failed for ${wireSym}@${tf}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  };

  const connect = (): void => {
    if (stopped) return;

    ws = new WebSocket(WS_URL);
    authed = false;

    ws.onopen = () => {
      // Reset backoff on successful connect.
      reconnectDelay = 1_000;
      // Send auth immediately on open.
      ws?.send(authMsg);
    };

    ws.onmessage = (evt: MessageEvent) => {
      try {
        // Alpaca sends arrays of message objects.
        const messages = JSON.parse(evt.data as string) as AlpacaWsMessage[];
        if (!Array.isArray(messages)) return;

        for (const msg of messages) {
          if (msg.T === 'error') {
            // Surface the error as a [TODO P8 toast] warn and fall through.
            // eslint-disable-next-line no-console
            console.warn(`[TODO P8 toast] alpaca: ${msg.msg ?? 'unknown error'} (code ${msg.code ?? '?'})`);
            continue;
          }

          if (msg.T === 'success' && msg.msg === 'authenticated') {
            // Auth confirmed — now safe to subscribe.
            authed = true;
            ws?.send(subscribeMsg);
            // Layer 2 seed: emit a fresh current-bucket price now rather than
            // waiting for the first 1m WS bar. This fires on the initial
            // connect AND after every reconnect (each reconnect re-runs the
            // auth→subscribe handshake), so the in-progress bucket that
            // onclose drops at the disconnect is restored to a fresh value.
            seedCurrentBucket();
            continue;
          }

          if (msg.T === 'b' && authed) {
            // 1-minute bar from the bars channel.
            const barTs = typeof msg.t === 'string' ? Date.parse(msg.t) : (msg.t ?? 0);
            if (isNaN(barTs) || barTs === 0) continue;

            const o = msg.o ?? 0;
            const h = msg.h ?? 0;
            const l = msg.l ?? 0;
            const c = msg.c ?? 0;
            const v = msg.v ?? 0;

            // Bucket to the UTC-floor of the active tf window, then merge the
            // 1m bar into the running aggregation (shared with the seed path).
            const bucketStart = Math.floor(barTs / tfMs) * tfMs;
            mergeSample(bucketStart, o, h, l, c, v);
          }
          // Ignore other message types (subscription confirmations, etc.).
        }
      } catch {
        // Malformed frame — log and continue; do not close the connection.
        // eslint-disable-next-line no-console
        console.warn('[alpaca-ws] failed to parse message', evt.data);
      }
    };

    ws.onclose = () => {
      ws = null;
      authed = false;
      // A reconnect introduces a gap in the bar stream; drop the in-progress
      // bucket so the next 1m bar opens a fresh aggregation rather than
      // extending a stale one across the disconnect.
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
// Internal wire types (not exported — Alpaca-specific)
// ---------------------------------------------------------------------------

interface AlpacaWsMessage {
  /** Message type discriminator. 'b' = bar, 'error' = error, 'success' = auth/sub ack. */
  T: string;
  /** Symbol — present on bar messages. */
  S?: string;
  /** Bar open price. */
  o?: number;
  /** Bar high price. */
  h?: number;
  /** Bar low price. */
  l?: number;
  /** Bar close price. */
  c?: number;
  /** Bar volume. */
  v?: number;
  /** Bar timestamp (ISO 8601 string). */
  t?: string | number;
  /** Error / success message text. */
  msg?: string;
  /** Error code (present on error messages). */
  code?: string | number;
}
