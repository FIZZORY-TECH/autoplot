/**
 * src/data/adapters/coinbase.test.ts — Vitest suite for the Coinbase WS adapter.
 *
 * Tests use a mocked WebSocket (vi.stubGlobal) to avoid real network calls.
 * Covers:
 *   1. WS URL is always the Coinbase feed endpoint.
 *   2. Subscribe message format (type, product_ids, channels).
 *   3. Ticker message → synthetic Bar mapping (o=h=l=c=price, v=0, ts=Date.parse(time)).
 *   4. Non-ticker messages are ignored.
 *   5. unsubscribe() closes the WS and stops reconnect attempts.
 *   6. Reconnect after unexpected onclose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeCoinbase, mapSymbol } from './coinbase';
import type { Bar } from '../MarketDataProvider';

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
  /** Simulate the server sending a message to this client. */
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

function makeTickerMsg(overrides: Partial<{
  product_id: string;
  price: string;
  time: string;
}> = {}): string {
  return JSON.stringify({
    type: 'ticker',
    product_id: overrides.product_id ?? 'BTC-USD',
    price: overrides.price ?? '27000.50',
    time: overrides.time ?? '2023-10-01T00:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mapSymbol', () => {
  it('maps BTC → BTC-USD', () => {
    expect(mapSymbol('BTC')).toBe('BTC-USD');
  });

  it('maps ETH → ETH-USD (lowercase input normalised)', () => {
    expect(mapSymbol('eth')).toBe('ETH-USD');
  });

  it('maps SOL → SOL-USD', () => {
    expect(mapSymbol('SOL')).toBe('SOL-USD');
  });
});

describe('subscribeCoinbase', () => {
  beforeEach(() => {
    lastWs = null;
    allInstances.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. WS URL
  // -------------------------------------------------------------------------
  it('always connects to the Coinbase feed URL', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});
    expect(lastWs?.url).toBe('wss://ws-feed.exchange.coinbase.com');
    conn.unsubscribe();
  });

  it('uses the same feed URL for ETH', () => {
    const conn = subscribeCoinbase('ETH', '1h', () => {});
    expect(lastWs?.url).toBe('wss://ws-feed.exchange.coinbase.com');
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 2. Subscribe message format
  // -------------------------------------------------------------------------
  it('sends correct subscribe message for BTC on open', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});

    // Trigger onopen so the adapter sends the subscribe message.
    lastWs!.onopen?.();

    expect(lastWs!.sentMessages).toHaveLength(1);
    const msg = JSON.parse(lastWs!.sentMessages[0]) as {
      type: string;
      product_ids: string[];
      channels: string[];
    };
    expect(msg.type).toBe('subscribe');
    expect(msg.product_ids).toEqual(['BTC-USD']);
    expect(msg.channels).toEqual(['ticker']);

    conn.unsubscribe();
  });

  it('sends correct subscribe message for ETH on open', () => {
    const conn = subscribeCoinbase('ETH', '1h', () => {});
    lastWs!.onopen?.();

    const msg = JSON.parse(lastWs!.sentMessages[0]) as { product_ids: string[] };
    expect(msg.product_ids).toEqual(['ETH-USD']);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 3. Ticker → running aggregated Bar mapping
  // -------------------------------------------------------------------------
  it('first tick in a bucket emits o=h=l=c=price and v=0', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(makeTickerMsg({ price: '27000.50', time: '2023-10-01T00:00:00.000Z' }));

    expect(received).toHaveLength(1);
    const bar = received[0];
    expect(bar.o).toBeCloseTo(27000.50);
    expect(bar.h).toBeCloseTo(27000.50);
    expect(bar.l).toBeCloseTo(27000.50);
    expect(bar.c).toBeCloseTo(27000.50);
    expect(bar.v).toBe(0);

    conn.unsubscribe();
  });

  it('bar.ts is bucketed to floor(tickTs / tfMs) * tfMs (1h)', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    // 00:17:23 inside the 00:00 hourly bucket → bar.ts == 00:00:00.
    const time = '2023-10-01T00:17:23.500Z';
    lastWs!.receive(makeTickerMsg({ time }));

    const HOUR = 60 * 60 * 1000;
    const expected = Math.floor(Date.parse(time) / HOUR) * HOUR;
    expect(received[0].ts).toBe(expected);
    expect(received[0].ts).toBe(Date.parse('2023-10-01T00:00:00.000Z'));

    conn.unsubscribe();
  });

  it('emits one bar per ticker message (running aggregation)', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    // Both ticks are inside the same 1h bucket — two emits, both update c.
    lastWs!.receive(makeTickerMsg({ price: '27000.00', time: '2023-10-01T00:00:00.000Z' }));
    lastWs!.receive(makeTickerMsg({ price: '27100.00', time: '2023-10-01T00:30:00.000Z' }));

    expect(received).toHaveLength(2);
    expect(received[0].c).toBeCloseTo(27000.00);
    expect(received[1].c).toBeCloseTo(27100.00);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 3b. Running aggregation correctness — the bug the fix addresses.
  // -------------------------------------------------------------------------
  it('same-bucket ticks update h/l/c without resetting o', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    // All three ticks fall inside the 00:00–01:00 bucket.
    lastWs!.receive(makeTickerMsg({ price: '27000', time: '2023-10-01T00:00:00.000Z' }));
    lastWs!.receive(makeTickerMsg({ price: '27250', time: '2023-10-01T00:15:00.000Z' }));
    lastWs!.receive(makeTickerMsg({ price: '26850', time: '2023-10-01T00:30:00.000Z' }));

    expect(received).toHaveLength(3);
    // Open is pinned to the FIRST tick of the bucket — must not flatten.
    expect(received[0].o).toBeCloseTo(27000);
    expect(received[1].o).toBeCloseTo(27000);
    expect(received[2].o).toBeCloseTo(27000);
    // High climbs with the 27250 tick and stays there.
    expect(received[1].h).toBeCloseTo(27250);
    expect(received[2].h).toBeCloseTo(27250);
    // Low drops with the 26850 tick.
    expect(received[2].l).toBeCloseTo(26850);
    expect(received[2].h).toBeCloseTo(27250);
    // Close tracks the latest tick.
    expect(received[2].c).toBeCloseTo(26850);
    // All emits share the bucket-start timestamp.
    const bucketTs = Date.parse('2023-10-01T00:00:00.000Z');
    expect(received[0].ts).toBe(bucketTs);
    expect(received[1].ts).toBe(bucketTs);
    expect(received[2].ts).toBe(bucketTs);

    conn.unsubscribe();
  });

  it('a tick crossing into a new bucket opens a fresh bar', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    // First two ticks: 00:00 bucket, prices 27000 / 27500.
    lastWs!.receive(makeTickerMsg({ price: '27000', time: '2023-10-01T00:10:00.000Z' }));
    lastWs!.receive(makeTickerMsg({ price: '27500', time: '2023-10-01T00:50:00.000Z' }));
    // Third tick: 01:00 bucket — new bar, o = 26900, ts = 01:00.
    lastWs!.receive(makeTickerMsg({ price: '26900', time: '2023-10-01T01:05:00.000Z' }));

    expect(received).toHaveLength(3);
    const bucket0 = Date.parse('2023-10-01T00:00:00.000Z');
    const bucket1 = Date.parse('2023-10-01T01:00:00.000Z');
    expect(received[0].ts).toBe(bucket0);
    expect(received[1].ts).toBe(bucket0);
    expect(received[2].ts).toBe(bucket1);
    // The new bucket's bar opens fresh — not carrying high/low from the old one.
    expect(received[2].o).toBeCloseTo(26900);
    expect(received[2].h).toBeCloseTo(26900);
    expect(received[2].l).toBeCloseTo(26900);
    expect(received[2].c).toBeCloseTo(26900);

    conn.unsubscribe();
  });

  it('emits cloned bars — caller mutation does not bleed into the next emit', () => {
    const snapshots: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => {
      // Snapshot first so we can assert on the unmutated emit.
      snapshots.push({ ...bar });
      // Simulate a downstream consumer mutating the bar (the bug class
      // we're guarding against — the registry/realtime pipeline must not
      // be holding a live reference into our running aggregation).
      bar.h = -1;
      bar.l = -1;
      bar.c = -1;
      bar.o = -1;
    });
    lastWs!.onopen?.();

    lastWs!.receive(makeTickerMsg({ price: '27000', time: '2023-10-01T00:00:00.000Z' }));
    lastWs!.receive(makeTickerMsg({ price: '27500', time: '2023-10-01T00:30:00.000Z' }));

    // The second emit must reflect the true running aggregation, not the
    // mutated values from the first emit.
    expect(snapshots[1].h).toBeCloseTo(27500);
    expect(snapshots[1].l).toBeCloseTo(27000);
    expect(snapshots[1].c).toBeCloseTo(27500);
    expect(snapshots[1].o).toBeCloseTo(27000);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 4. Non-ticker messages ignored
  // -------------------------------------------------------------------------
  it('ignores subscription confirmation messages', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(JSON.stringify({ type: 'subscriptions', channels: [] }));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('ignores heartbeat messages', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(JSON.stringify({ type: 'heartbeat', sequence: 123 }));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('ignores ticker messages with missing price', () => {
    const received: Bar[] = [];
    const conn = subscribeCoinbase('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(JSON.stringify({ type: 'ticker', time: '2023-10-01T00:00:00Z' }));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('does not throw on malformed JSON', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});
    lastWs!.onopen?.();
    expect(() => lastWs!.receive('not-json')).not.toThrow();
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 5. unsubscribe() closes WS and stops reconnect
  // -------------------------------------------------------------------------
  it('unsubscribe() closes the WebSocket', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});
    const ws = lastWs!;

    conn.unsubscribe();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('unsubscribe() stops reconnect — no new WS after close', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});

    conn.unsubscribe();

    // Advance timers well past the max reconnect delay (30s).
    vi.advanceTimersByTime(60_000);

    expect(allInstances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. Reconnect after unexpected close
  // -------------------------------------------------------------------------
  it('reconnects after onclose when not stopped', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});
    expect(allInstances).toHaveLength(1);

    const ws1 = lastWs!;
    // Replace close so it does NOT auto-trigger onclose (we trigger manually).
    ws1.close = vi.fn();
    ws1.onclose?.(); // simulate server-side disconnect

    vi.advanceTimersByTime(2_000);

    expect(allInstances).toHaveLength(2);

    conn.unsubscribe();
  });

  it('does not reconnect if unsubscribe was called before onclose fires', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});
    const ws1 = lastWs!;

    conn.unsubscribe(); // sets stopped = true
    // Simulate close arriving after unsubscribe (race condition).
    ws1.onclose?.();

    vi.advanceTimersByTime(5_000);
    expect(allInstances).toHaveLength(1);
  });

  it('resets reconnect delay to 1000ms on successful open', () => {
    const conn = subscribeCoinbase('BTC', '1h', () => {});
    const ws = lastWs!;

    ws.onopen?.();
    ws.close = vi.fn();
    ws.onclose?.(); // triggers reconnect

    vi.advanceTimersByTime(2_000);
    const ws2 = lastWs!;
    ws2.onopen?.();
    ws2.close = vi.fn();
    ws2.onclose?.();

    vi.advanceTimersByTime(2_000);

    // Third WS — backoff reset on the second open so it reconnects in ~1s.
    expect(allInstances).toHaveLength(3);

    conn.unsubscribe();
  });
});
