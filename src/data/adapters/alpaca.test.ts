/**
 * src/data/adapters/alpaca.test.ts — Vitest suite for the Alpaca WS adapter.
 *
 * Tests use a mocked WebSocket (vi.stubGlobal) and mocked import.meta.env to
 * avoid real network calls or credential requirements.
 *
 * Covers:
 *   1. WS URL is always the Alpaca IEX feed endpoint.
 *   2. Auth message is sent on open, subscribe sent after auth confirmed.
 *   3. Happy path — Alpaca bar message (`T:"b"`) → correct Bar emit.
 *   4. Bucket aggregation — multiple 1m bars accumulate into one tf-bucket
 *      bar (UTC-floor aligned, ADR-0008 §5).
 *   5. Error message path (`T:"error"`) — warn logged, no bar emitted.
 *   6. Non-bar messages ignored.
 *   7. unsubscribe() closes the WS and stops reconnect attempts.
 *   8. Missing credentials — noop unsubscribe returned, warn logged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Bar } from '../MarketDataProvider';

// ---------------------------------------------------------------------------
// Mock the Rust IPC + runtime guard (Fix A — 1m-seed path)
//
// `seedCurrentBucket` only runs under the Tauri runtime and pulls the latest
// 1m bar via `marketFetchLatest1m`. We mock both so the seed path is exercised
// in jsdom without a real Tauri/IPC bridge.
// ---------------------------------------------------------------------------

const marketFetchLatest1mMock =
  vi.fn<(provider: string, sym: string, quote: string) => Promise<Bar | null>>();
let tauriRuntime = false;

vi.mock('../../lib/db', () => ({
  marketFetchLatest1m: (provider: string, sym: string, quote: string) =>
    marketFetchLatest1mMock(provider, sym, quote),
}));
vi.mock('../../lib/runtime', () => ({
  isTauriRuntime: () => tauriRuntime,
}));

// ---------------------------------------------------------------------------
// Mock import.meta.env
// ---------------------------------------------------------------------------

// We inject credentials before importing the adapter so the module sees them.
vi.stubEnv('VITE_ALPACA_KEY_ID', 'test-key-id');
vi.stubEnv('VITE_ALPACA_SECRET_KEY', 'test-secret-key');

// Import AFTER stubbing env so the module captures the values.
import { subscribeAlpaca, mapSymbol } from './alpaca';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockWsInstance {
  url: string;
  onopen: (() => void) | null;
  onmessage: ((evt: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  /** Messages captured by the mock send() call. */
  sentMessages: string[];
  /** Simulate the server sending a message (or array of messages) to this client. */
  receive: (data: string) => void;
}

let lastWs: MockWsInstance | null = null;
const allInstances: MockWsInstance[] = [];

function MockWebSocket(url: string): MockWsInstance {
  const instance: MockWsInstance = {
    url,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sentMessages: [],
    close: vi.fn(() => {
      instance.onclose?.();
    }),
    send: vi.fn((data: string) => {
      instance.sentMessages.push(data);
    }),
    receive: (data: string) => {
      instance.onmessage?.({ data });
    },
  };

  lastWs = instance;
  allInstances.push(instance);
  return instance;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send the success auth ack so the adapter transitions to subscribed state. */
function sendAuthAck(ws: MockWsInstance): void {
  ws.receive(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
}

/**
 * Construct an Alpaca 1-minute bar message following the wire schema:
 * https://docs.alpaca.markets/reference/stockbars
 *
 * { T: "b", S: sym, o, h, l, c, v, t: ISO8601, ... }
 */
function makeBarMsg(overrides: Partial<{
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
}> = {}): string {
  return JSON.stringify([{
    T: 'b',
    S: overrides.S ?? 'AAPL',
    o: overrides.o ?? 150.00,
    h: overrides.h ?? 151.00,
    l: overrides.l ?? 149.50,
    c: overrides.c ?? 150.75,
    v: overrides.v ?? 1000,
    t: overrides.t ?? '2024-01-15T14:30:00Z',
    vw: 150.50,
    n: 42,
  }]);
}

/** Make an Alpaca error message. */
function makeErrorMsg(msg: string, code: string | number = '40410000'): string {
  return JSON.stringify([{ T: 'error', code, msg }]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mapSymbol', () => {
  it('maps AAPL → AAPL (identity)', () => {
    expect(mapSymbol('AAPL')).toBe('AAPL');
  });

  it('uppercases lowercase input', () => {
    expect(mapSymbol('aapl')).toBe('AAPL');
  });

  it('maps SPY → SPY', () => {
    expect(mapSymbol('SPY')).toBe('SPY');
  });
});

describe('subscribeAlpaca', () => {
  beforeEach(() => {
    lastWs = null;
    allInstances.length = 0;
    // Default: NOT in the Tauri runtime → seedCurrentBucket is a no-op, so the
    // existing WS-only tests are unaffected. The 1m-seed suite opts in.
    tauriRuntime = false;
    marketFetchLatest1mMock.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Re-stub env after unstubAllGlobals clears it.
    vi.stubEnv('VITE_ALPACA_KEY_ID', 'test-key-id');
    vi.stubEnv('VITE_ALPACA_SECRET_KEY', 'test-secret-key');
  });

  // -------------------------------------------------------------------------
  // 1. WS URL
  // -------------------------------------------------------------------------
  it('always connects to the Alpaca IEX feed URL', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    expect(lastWs?.url).toBe('wss://stream.data.alpaca.markets/v2/iex');
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 2. Auth → subscribe sequence
  // -------------------------------------------------------------------------
  it('sends auth message on open', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    lastWs!.onopen?.();

    expect(lastWs!.sentMessages).toHaveLength(1);
    const auth = JSON.parse(lastWs!.sentMessages[0]) as {
      action: string; key: string; secret: string;
    };
    expect(auth.action).toBe('auth');
    expect(auth.key).toBe('test-key-id');
    expect(auth.secret).toBe('test-secret-key');

    conn.unsubscribe();
  });

  it('sends subscribe message for the symbol only after auth ack', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    lastWs!.onopen?.();

    // Only auth at this point.
    expect(lastWs!.sentMessages).toHaveLength(1);

    sendAuthAck(lastWs!);

    expect(lastWs!.sentMessages).toHaveLength(2);
    const sub = JSON.parse(lastWs!.sentMessages[1]) as {
      action: string; bars: string[];
    };
    expect(sub.action).toBe('subscribe');
    expect(sub.bars).toEqual(['AAPL']);

    conn.unsubscribe();
  });

  it('does not subscribe before auth is confirmed', () => {
    const conn = subscribeAlpaca('MSFT', '1h', () => {});
    lastWs!.onopen?.();

    // Only one message sent — the auth.
    expect(lastWs!.sentMessages).toHaveLength(1);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 3. Happy path — bar message → correct Bar emit
  // -------------------------------------------------------------------------
  it('emits a Bar with correct OHLCV from an Alpaca bar message', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    lastWs!.receive(makeBarMsg({
      o: 150.00, h: 152.00, l: 149.00, c: 151.50, v: 5000,
      t: '2024-01-15T14:30:00Z',
    }));

    expect(received).toHaveLength(1);
    const bar = received[0];
    expect(bar.o).toBeCloseTo(150.00);
    expect(bar.h).toBeCloseTo(152.00);
    expect(bar.l).toBeCloseTo(149.00);
    expect(bar.c).toBeCloseTo(151.50);
    expect(bar.v).toBeCloseTo(5000);

    conn.unsubscribe();
  });

  it('bar.ts is UTC-floor bucketed to the tf boundary (1h)', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    // 14:47 sits inside the 14:00 hourly bucket.
    const t = '2024-01-15T14:47:00Z';
    lastWs!.receive(makeBarMsg({ t }));

    const HOUR = 60 * 60 * 1000;
    const expected = Math.floor(Date.parse(t) / HOUR) * HOUR;
    expect(received[0].ts).toBe(expected);
    // Sanity: 14:47 UTC → bucket at 14:00 UTC
    expect(received[0].ts).toBe(Date.parse('2024-01-15T14:00:00Z'));

    conn.unsubscribe();
  });

  it('emits cloned bars — caller mutation does not bleed into the next emit', () => {
    const snapshots: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => {
      snapshots.push({ ...bar });
      // Mutate — the adapter must NOT see these mutations in the next emit.
      bar.h = -1;
      bar.l = -1;
    });
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    // Two 1m bars in the same 1h bucket.
    lastWs!.receive(makeBarMsg({ o: 150, h: 152, l: 149, c: 151, v: 1000, t: '2024-01-15T14:00:00Z' }));
    lastWs!.receive(makeBarMsg({ o: 151, h: 154, l: 150, c: 153, v: 2000, t: '2024-01-15T14:01:00Z' }));

    // Second emit must reflect true running high (154), not the mutated -1.
    expect(snapshots[1].h).toBeCloseTo(154);
    expect(snapshots[1].l).toBeCloseTo(149);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 4. Bucket aggregation — multiple 1m bars → one tf-bucket bar
  // -------------------------------------------------------------------------
  it('multiple 1m bars in the same 1h bucket accumulate OHLCV correctly', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    // Three 1m bars within the 14:00 bucket.
    lastWs!.receive(makeBarMsg({ o: 150, h: 152, l: 149, c: 151, v: 1000, t: '2024-01-15T14:00:00Z' }));
    lastWs!.receive(makeBarMsg({ o: 151, h: 155, l: 150, c: 154, v: 2000, t: '2024-01-15T14:01:00Z' }));
    lastWs!.receive(makeBarMsg({ o: 154, h: 154, l: 147, c: 148, v: 3000, t: '2024-01-15T14:02:00Z' }));

    expect(received).toHaveLength(3);

    // Open stays pinned to the first 1m bar's open.
    expect(received[0].o).toBeCloseTo(150);
    expect(received[1].o).toBeCloseTo(150); // same bucket — open unchanged
    expect(received[2].o).toBeCloseTo(150); // same bucket — open unchanged

    // High tracks the running max across all 1m bars.
    expect(received[0].h).toBeCloseTo(152);
    expect(received[1].h).toBeCloseTo(155); // 155 > 152
    expect(received[2].h).toBeCloseTo(155); // 155 still the max

    // Low tracks the running min.
    expect(received[0].l).toBeCloseTo(149);
    expect(received[1].l).toBeCloseTo(149); // 150 > 149
    expect(received[2].l).toBeCloseTo(147); // 147 < 149

    // Close tracks the latest 1m close.
    expect(received[0].c).toBeCloseTo(151);
    expect(received[1].c).toBeCloseTo(154);
    expect(received[2].c).toBeCloseTo(148);

    // Volume accumulates.
    expect(received[0].v).toBeCloseTo(1000);
    expect(received[1].v).toBeCloseTo(3000);
    expect(received[2].v).toBeCloseTo(6000);

    // All three share the same UTC-floor bucket timestamp.
    const bucketTs = Date.parse('2024-01-15T14:00:00Z');
    expect(received[0].ts).toBe(bucketTs);
    expect(received[1].ts).toBe(bucketTs);
    expect(received[2].ts).toBe(bucketTs);

    conn.unsubscribe();
  });

  it('a 1m bar crossing into the next tf-bucket opens a fresh aggregation', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    // Bucket 14:00
    lastWs!.receive(makeBarMsg({ o: 150, h: 155, l: 149, c: 153, v: 1000, t: '2024-01-15T14:30:00Z' }));
    // Bucket 15:00 — new bucket, fresh bar
    lastWs!.receive(makeBarMsg({ o: 160, h: 162, l: 159, c: 161, v: 500,  t: '2024-01-15T15:00:00Z' }));

    expect(received).toHaveLength(2);

    // Second bar opens fresh — open/high/low/close from the 15:00 1m bar.
    expect(received[1].o).toBeCloseTo(160);
    expect(received[1].h).toBeCloseTo(162);
    expect(received[1].l).toBeCloseTo(159);
    expect(received[1].c).toBeCloseTo(161);
    expect(received[1].v).toBeCloseTo(500); // volume reset for new bucket

    // Bucket timestamps are distinct.
    expect(received[0].ts).toBe(Date.parse('2024-01-15T14:00:00Z'));
    expect(received[1].ts).toBe(Date.parse('2024-01-15T15:00:00Z'));

    conn.unsubscribe();
  });

  it('aggregates correctly at 4h tf boundary (UTC-aligned)', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('SPY', '4h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    // 12:00–15:59 UTC all fall inside the 12:00 4h bucket (12:00–16:00 UTC).
    lastWs!.receive(makeBarMsg({ o: 500, h: 502, l: 499, c: 501, v: 100, t: '2024-01-15T12:00:00Z' }));
    lastWs!.receive(makeBarMsg({ o: 501, h: 505, l: 500, c: 504, v: 200, t: '2024-01-15T13:30:00Z' }));
    // 16:00 UTC starts the next 4h bucket.
    lastWs!.receive(makeBarMsg({ o: 510, h: 512, l: 509, c: 511, v: 50,  t: '2024-01-15T16:00:00Z' }));

    expect(received).toHaveLength(3);

    // First two bars in 12:00 bucket.
    const bucket12 = Date.parse('2024-01-15T12:00:00Z');
    expect(received[0].ts).toBe(bucket12);
    expect(received[1].ts).toBe(bucket12);
    // Third bar in 16:00 bucket.
    const bucket16 = Date.parse('2024-01-15T16:00:00Z');
    expect(received[2].ts).toBe(bucket16);

    // High across the first bucket = 505.
    expect(received[1].h).toBeCloseTo(505);
    // Volume accumulated in the bucket.
    expect(received[1].v).toBeCloseTo(300);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 5. Error message path
  // -------------------------------------------------------------------------
  it('logs a [TODO P8 toast] warn on error message and emits no bar', () => {
    const received: Bar[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    lastWs!.receive(makeErrorMsg('subscription does not exist', '40410000'));

    expect(received).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[TODO P8 toast] alpaca:'),
      // message text appears in the warn call
    );

    warnSpy.mockRestore();
    conn.unsubscribe();
  });

  it('continues operating after an error message (does not close the WS)', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    // Error first, then a valid bar.
    lastWs!.receive(makeErrorMsg('some transient error'));
    lastWs!.receive(makeBarMsg({ o: 200, h: 201, l: 199, c: 200.5, v: 1000, t: '2024-01-15T14:00:00Z' }));

    expect(received).toHaveLength(1);
    expect(received[0].c).toBeCloseTo(200.5);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 6. Non-bar messages ignored
  // -------------------------------------------------------------------------
  it('ignores subscription confirmation messages', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    lastWs!.receive(JSON.stringify([{ T: 'subscription', bars: ['AAPL'] }]));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('does not emit bars received before auth is confirmed', () => {
    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();
    // No auth ack sent — adapter is not yet authed.

    lastWs!.receive(makeBarMsg({ t: '2024-01-15T14:00:00Z' }));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('does not throw on malformed JSON', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    lastWs!.onopen?.();
    expect(() => lastWs!.receive('not-json{{')).not.toThrow();
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 7. unsubscribe() closes WS and stops reconnect
  // -------------------------------------------------------------------------
  it('unsubscribe() closes the WebSocket', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    const ws = lastWs!;

    conn.unsubscribe();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('unsubscribe() stops reconnect — no new WS after close', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});

    conn.unsubscribe();

    // Advance past max backoff (30s).
    vi.advanceTimersByTime(60_000);

    expect(allInstances).toHaveLength(1);
  });

  it('reconnects after unexpected server-side close', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    expect(allInstances).toHaveLength(1);

    const ws1 = lastWs!;
    ws1.close = vi.fn(); // prevent auto-close triggering onclose twice
    ws1.onclose?.(); // simulate server disconnect

    vi.advanceTimersByTime(2_000);

    expect(allInstances).toHaveLength(2);

    conn.unsubscribe();
  });

  it('does not reconnect if unsubscribe was called before onclose fires', () => {
    const conn = subscribeAlpaca('AAPL', '1h', () => {});
    const ws1 = lastWs!;

    conn.unsubscribe(); // sets stopped = true
    ws1.onclose?.(); // race — close arrives after unsubscribe

    vi.advanceTimersByTime(5_000);
    expect(allInstances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 8. Missing credentials — noop path
  // -------------------------------------------------------------------------
  it('returns a noop unsubscribe and logs a warn when credentials are absent', async () => {
    // Temporarily clear the env stubs then import a fresh copy of the module
    // to verify the no-credentials path. We test this by re-importing with
    // stubbed env cleared.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Since import.meta.env is read at call time (not module load time),
    // we can clear the values and call the function again.
    vi.stubEnv('VITE_ALPACA_KEY_ID', '');
    vi.stubEnv('VITE_ALPACA_SECRET_KEY', '');

    // We need to re-import because the credentials are captured at call time
    // inside the function. Calling with the module already imported is fine —
    // import.meta.env reads happen inline at the function's start.
    const { subscribeAlpaca: subscribeAlpacaFresh } = await import('./alpaca');
    const received: Bar[] = [];
    const conn = subscribeAlpacaFresh('AAPL', '1h', (bar) => received.push(bar));

    // No WS should have been created.
    expect(allInstances).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith('[TODO P8 toast] alpaca: missing credentials');

    // unsubscribe on the noop must not throw.
    expect(() => conn.unsubscribe()).not.toThrow();

    warnSpy.mockRestore();
    // Restore credentials for other tests.
    vi.stubEnv('VITE_ALPACA_KEY_ID', 'test-key-id');
    vi.stubEnv('VITE_ALPACA_SECRET_KEY', 'test-secret-key');
  });

  // -------------------------------------------------------------------------
  // 9. Fix A — 1m-seed bucket stamping
  //
  // On auth ack (and after every reconnect), seedCurrentBucket() pulls the
  // latest 1m bar via marketFetchLatest1m and re-stamps its close onto the
  // CURRENT chart bucket (floor(now / tfMs) * tfMs). This is the freshness fix:
  // for a 1h chart, the seed must reflect a bar ≤~60s old, not the last
  // completed hour.
  // -------------------------------------------------------------------------
  it('seeds the current 1h bucket from the latest 1m close (floor(now/tfMs)*tfMs)', async () => {
    tauriRuntime = true;
    // Latest 1m bar close = 207.5; its own ts is irrelevant — only `c` is used.
    marketFetchLatest1mMock.mockResolvedValue({
      ts: 1_700_000_040_000,
      o: 207.1,
      h: 207.8,
      l: 207.0,
      c: 207.5,
      v: 1234,
    });

    // Pin "now" so the expected bucket is deterministic.
    const fixedNow = Date.parse('2024-01-15T14:47:33Z');
    vi.setSystemTime(fixedNow);

    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar), 'USD');
    lastWs!.onopen?.();
    sendAuthAck(lastWs!); // triggers seedCurrentBucket()

    // Flush the seed's promise chain (resolved value + .then).
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

    expect(marketFetchLatest1mMock).toHaveBeenCalledWith('alpaca', 'AAPL', 'USD');

    const HOUR = 60 * 60 * 1000;
    const expectedBucket = Math.floor(fixedNow / HOUR) * HOUR;
    const seed = received[0];
    // Lands on the CURRENT chart bucket (14:00 UTC), not the 1m bar's own ts.
    expect(seed.ts).toBe(expectedBucket);
    expect(seed.ts).toBe(Date.parse('2024-01-15T14:00:00Z'));
    // All OHLC seeded from the 1m close; volume dropped to 0.
    expect(seed.o).toBeCloseTo(207.5);
    expect(seed.h).toBeCloseTo(207.5);
    expect(seed.l).toBeCloseTo(207.5);
    expect(seed.c).toBeCloseTo(207.5);
    expect(seed.v).toBe(0);

    conn.unsubscribe();
  });

  it('does not seed when not in the Tauri runtime', async () => {
    tauriRuntime = false;
    marketFetchLatest1mMock.mockResolvedValue({
      ts: 1_700_000_040_000, o: 1, h: 1, l: 1, c: 1, v: 1,
    });

    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar), 'USD');
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);

    await Promise.resolve();
    expect(marketFetchLatest1mMock).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('a live 1m WS tick extends the seeded current bucket (no duplicate/stale bar)', async () => {
    tauriRuntime = true;
    marketFetchLatest1mMock.mockResolvedValue({
      ts: 1_700_000_040_000, o: 207.5, h: 207.5, l: 207.5, c: 207.5, v: 0,
    });

    const fixedNow = Date.parse('2024-01-15T14:00:30Z');
    vi.setSystemTime(fixedNow);

    const received: Bar[] = [];
    const conn = subscribeAlpaca('AAPL', '1h', (bar) => received.push(bar), 'USD');
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

    const bucket14 = Date.parse('2024-01-15T14:00:00Z');
    expect(received[0].ts).toBe(bucket14);
    expect(received[0].c).toBeCloseTo(207.5);

    // A live 1m WS bar in the SAME 14:00 bucket extends the seed.
    lastWs!.receive(makeBarMsg({
      o: 208, h: 209, l: 206, c: 208.5, v: 3000, t: '2024-01-15T14:01:00Z',
    }));

    const last = received[received.length - 1];
    expect(last.ts).toBe(bucket14); // same bucket — extended, not replaced
    expect(last.h).toBeCloseTo(209); // running high includes the live tick
    expect(last.l).toBeCloseTo(206);
    expect(last.c).toBeCloseTo(208.5);
    expect(last.v).toBeCloseTo(3000); // seed contributed 0 volume

    conn.unsubscribe();
  });

  it('seeds again after a reconnect (re-runs the auth → seed handshake)', async () => {
    tauriRuntime = true;
    marketFetchLatest1mMock.mockResolvedValue({
      ts: 1_700_000_040_000, o: 50, h: 50, l: 50, c: 50, v: 0,
    });
    vi.setSystemTime(Date.parse('2024-01-15T14:30:00Z'));

    const conn = subscribeAlpaca('AAPL', '1h', () => {}, 'USD');
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);
    await vi.waitFor(() => expect(marketFetchLatest1mMock).toHaveBeenCalledTimes(1));

    // Simulate a server-side disconnect → reconnect.
    const ws1 = lastWs!;
    ws1.close = vi.fn();
    ws1.onclose?.();
    vi.advanceTimersByTime(2_000);

    // Fresh WS re-auths → seed runs again.
    lastWs!.onopen?.();
    sendAuthAck(lastWs!);
    await vi.waitFor(() => expect(marketFetchLatest1mMock).toHaveBeenCalledTimes(2));

    conn.unsubscribe();
  });
});
