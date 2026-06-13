/**
 * src/data/adapters/kraken.test.ts — Vitest suite for the Kraken WS adapter.
 *
 * Tests use a mocked WebSocket (vi.stubGlobal) to avoid real network calls.
 * Covers:
 *   1. mapSymbolToWsPair — canonical → Kraken WS pair (BTC → XBT/USD, fallback).
 *   2. mapTfToInterval — 4-tier → Kraken interval minutes.
 *   3. WS URL is always wss://ws.kraken.com.
 *   4. Subscribe message format (event, pair, subscription.name, subscription.interval).
 *   5. OHLC array message → Bar callback (correct field mapping + parseFloat × 1000).
 *   6. Non-OHLC messages (events, heartbeats) are ignored.
 *   7. unsubscribe() closes the WS and stops reconnect attempts.
 *   8. Reconnect after unexpected onclose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeKraken, mapSymbolToWsPair, mapTfToInterval } from './kraken';
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

/**
 * Build a minimal Kraken OHLC array message:
 * [channelID, [time, etime, open, high, low, close, vwap, volume, count], "ohlc-60", "XBT/USD"]
 */
function makeOhlcMsg(overrides: Partial<{
  channelId: number;
  time: string;
  etime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  vwap: string;
  volume: string;
  count: number;
  channelName: string;
  pair: string;
}> = {}): string {
  return JSON.stringify([
    overrides.channelId ?? 42,
    [
      overrides.time   ?? '1696118400.000000',
      overrides.etime  ?? '1696122000.000000',
      overrides.open   ?? '27000.50',
      overrides.high   ?? '27150.00',
      overrides.low    ?? '26950.25',
      overrides.close  ?? '27100.75',
      overrides.vwap   ?? '27090.12',
      overrides.volume ?? '500.12345678',
      overrides.count  ?? 312,
    ],
    overrides.channelName ?? 'ohlc-60',
    overrides.pair        ?? 'XBT/USD',
  ]);
}

// ---------------------------------------------------------------------------
// mapSymbolToWsPair
// ---------------------------------------------------------------------------

describe('mapSymbolToWsPair', () => {
  it('maps BTC → XBT/USD (Kraken uses XBT)', () => {
    expect(mapSymbolToWsPair('BTC')).toBe('XBT/USD');
  });

  it('maps ETH → ETH/USD', () => {
    expect(mapSymbolToWsPair('ETH')).toBe('ETH/USD');
  });

  it('maps SOL → SOL/USD', () => {
    expect(mapSymbolToWsPair('SOL')).toBe('SOL/USD');
  });

  it('maps all 13 canonical assets correctly', () => {
    const expected: [string, string][] = [
      ['BTC',   'XBT/USD'],
      ['ETH',   'ETH/USD'],
      ['SOL',   'SOL/USD'],
      ['ADA',   'ADA/USD'],
      ['DOT',   'DOT/USD'],
      ['AVAX',  'AVAX/USD'],
      ['MATIC', 'MATIC/USD'],
      ['LINK',  'LINK/USD'],
      ['UNI',   'UNI/USD'],
      ['ATOM',  'ATOM/USD'],
      ['LTC',   'LTC/USD'],
      ['XRP',   'XRP/USD'],
      ['DOGE',  'DOGE/USD'],
    ];
    for (const [canonical, wsPair] of expected) {
      expect(mapSymbolToWsPair(canonical)).toBe(wsPair);
    }
  });

  it('normalises lowercase input', () => {
    expect(mapSymbolToWsPair('btc')).toBe('XBT/USD');
    expect(mapSymbolToWsPair('eth')).toBe('ETH/USD');
  });

  it('uses fallback format for unknown symbols', () => {
    expect(mapSymbolToWsPair('FAKE')).toBe('FAKE/USD');
    expect(mapSymbolToWsPair('XYZ')).toBe('XYZ/USD');
  });
});

// ---------------------------------------------------------------------------
// mapTfToInterval
// ---------------------------------------------------------------------------

describe('mapTfToInterval', () => {
  it('maps 1h → 60', () => {
    expect(mapTfToInterval('1h')).toBe(60);
  });

  it('maps 4h → 240', () => {
    expect(mapTfToInterval('4h')).toBe(240);
  });

  it('maps 1d → 1440', () => {
    expect(mapTfToInterval('1d')).toBe(1440);
  });

  it('maps 1w → 10080', () => {
    expect(mapTfToInterval('1w')).toBe(10080);
  });
});

// ---------------------------------------------------------------------------
// subscribeKraken
// ---------------------------------------------------------------------------

describe('subscribeKraken', () => {
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
  it('always connects to wss://ws.kraken.com', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});
    expect(lastWs?.url).toBe('wss://ws.kraken.com');
    conn.unsubscribe();
  });

  it('uses the same feed URL for ETH/4h', () => {
    const conn = subscribeKraken('ETH', '4h', () => {});
    expect(lastWs?.url).toBe('wss://ws.kraken.com');
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 2. Subscribe message format
  // -------------------------------------------------------------------------
  it('sends correct subscribe message for BTC/1h on open', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});

    lastWs!.onopen?.();

    expect(lastWs!.sentMessages).toHaveLength(1);
    const msg = JSON.parse(lastWs!.sentMessages[0]) as {
      event: string;
      pair: string[];
      subscription: { name: string; interval: number };
    };

    expect(msg.event).toBe('subscribe');
    expect(msg.pair).toEqual(['XBT/USD']);
    expect(msg.subscription.name).toBe('ohlc');
    expect(msg.subscription.interval).toBe(60);

    conn.unsubscribe();
  });

  it('sends correct subscribe message for ETH/4h on open', () => {
    const conn = subscribeKraken('ETH', '4h', () => {});
    lastWs!.onopen?.();

    const msg = JSON.parse(lastWs!.sentMessages[0]) as {
      pair: string[];
      subscription: { interval: number };
    };
    expect(msg.pair).toEqual(['ETH/USD']);
    expect(msg.subscription.interval).toBe(240);

    conn.unsubscribe();
  });

  it('sends correct subscribe message for SOL/1d on open', () => {
    const conn = subscribeKraken('SOL', '1d', () => {});
    lastWs!.onopen?.();

    const msg = JSON.parse(lastWs!.sentMessages[0]) as {
      pair: string[];
      subscription: { interval: number };
    };
    expect(msg.pair).toEqual(['SOL/USD']);
    expect(msg.subscription.interval).toBe(1440);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 3. OHLC message → Bar callback
  // -------------------------------------------------------------------------
  it('calls cb with a correctly shaped Bar on ohlc message', () => {
    const received: Bar[] = [];
    const conn = subscribeKraken('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(makeOhlcMsg());

    expect(received).toHaveLength(1);
    const bar = received[0];
    // ts: parseFloat('1696118400.000000') * 1000 = 1696118400000
    expect(bar.ts).toBeCloseTo(1_696_118_400_000, -1);
    expect(bar.o).toBeCloseTo(27000.50);
    expect(bar.h).toBeCloseTo(27150.00);
    expect(bar.l).toBeCloseTo(26950.25);
    expect(bar.c).toBeCloseTo(27100.75);
    expect(bar.v).toBeCloseTo(500.12345678);

    conn.unsubscribe();
  });

  it('calls cb multiple times for multiple ohlc messages', () => {
    const received: Bar[] = [];
    const conn = subscribeKraken('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(makeOhlcMsg({ close: '27000.00' }));
    lastWs!.receive(makeOhlcMsg({ close: '27100.00' }));

    expect(received).toHaveLength(2);
    expect(received[0].c).toBeCloseTo(27000.00);
    expect(received[1].c).toBeCloseTo(27100.00);

    conn.unsubscribe();
  });

  it('multiplies time by 1000 to convert seconds → ms', () => {
    const received: Bar[] = [];
    const conn = subscribeKraken('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(makeOhlcMsg({ time: '1696118400.000000' }));

    // 1696118400 * 1000 = 1696118400000
    expect(received[0].ts).toBeCloseTo(1_696_118_400_000, -1);

    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 4. Non-OHLC messages ignored
  // -------------------------------------------------------------------------
  it('ignores heartbeat event messages', () => {
    const received: Bar[] = [];
    const conn = subscribeKraken('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(JSON.stringify({ event: 'heartbeat' }));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('ignores subscriptionStatus event messages', () => {
    const received: Bar[] = [];
    const conn = subscribeKraken('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(JSON.stringify({
      event: 'subscriptionStatus',
      status: 'subscribed',
      channelName: 'ohlc-60',
    }));
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('ignores arrays with fewer than 4 elements', () => {
    const received: Bar[] = [];
    const conn = subscribeKraken('BTC', '1h', (bar) => received.push(bar));
    lastWs!.onopen?.();

    lastWs!.receive(JSON.stringify([42, [], 'ohlc-60'])); // only 3 elements
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('does not throw on malformed JSON', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});
    lastWs!.onopen?.();
    expect(() => lastWs!.receive('not-json')).not.toThrow();
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 5. unsubscribe() closes WS and stops reconnect
  // -------------------------------------------------------------------------
  it('unsubscribe() closes the WebSocket', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});
    const ws = lastWs!;

    conn.unsubscribe();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('unsubscribe() stops reconnect — no new WS after close', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});

    conn.unsubscribe();

    // Advance timers well past the max reconnect delay (30s).
    vi.advanceTimersByTime(60_000);

    expect(allInstances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. Reconnect after unexpected close
  // -------------------------------------------------------------------------
  it('reconnects after onclose when not stopped', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});
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
    const conn = subscribeKraken('BTC', '1h', () => {});
    const ws1 = lastWs!;

    conn.unsubscribe(); // sets stopped = true
    // Simulate close arriving after unsubscribe (race condition).
    ws1.onclose?.();

    vi.advanceTimersByTime(5_000);
    expect(allInstances).toHaveLength(1);
  });

  it('resets reconnect delay to 1000ms on successful open', () => {
    const conn = subscribeKraken('BTC', '1h', () => {});
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
