/**
 * src/data/adapters/binance.test.ts — Vitest suite for the Binance WS adapter.
 *
 * Tests use a mocked WebSocket (vi.stubGlobal) to avoid real network calls.
 * Covers:
 *   1. URL construction (symbol + tf → correct stream URL).
 *   2. Kline message → Bar callback (correct field mapping + parseFloat).
 *   3. unsubscribe() closes the WS and stops reconnect attempts.
 *   4. Reconnect after onclose (when not stopped).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeBinance } from './binance';
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
  /** Simulate the server sending a message. */
  send: (data: string) => void;
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
    close: vi.fn(() => {
      instance.onclose?.();
    }),
    send: (data: string) => {
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

function makeBtcKlineMsg(overrides: Partial<{
  t: number; o: string; h: string; l: string; c: string; v: string; x: boolean;
}> = {}): string {
  return JSON.stringify({
    e: 'kline',
    k: {
      t: overrides.t ?? 1696118400000,
      o: overrides.o ?? '27000.50',
      h: overrides.h ?? '27150.00',
      l: overrides.l ?? '26950.25',
      c: overrides.c ?? '27100.75',
      v: overrides.v ?? '500.123',
      x: overrides.x ?? false,
    },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('subscribeBinance', () => {
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
  // 1. URL construction
  // -------------------------------------------------------------------------
  it('constructs the correct WS URL for BTC/1h', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});
    expect(lastWs?.url).toBe('wss://stream.binance.com:9443/ws/btcusdt@kline_1h');
    conn.unsubscribe();
  });

  it('constructs the correct WS URL for ETH/4h', () => {
    const conn = subscribeBinance('ETH', '4h', () => {});
    expect(lastWs?.url).toBe('wss://stream.binance.com:9443/ws/ethusdt@kline_4h');
    conn.unsubscribe();
  });

  it('constructs the correct WS URL for SOL/1d', () => {
    const conn = subscribeBinance('SOL', '1d', () => {});
    expect(lastWs?.url).toBe('wss://stream.binance.com:9443/ws/solusdt@kline_1d');
    conn.unsubscribe();
  });

  it('constructs the correct WS URL for BTC/1w', () => {
    const conn = subscribeBinance('BTC', '1w', () => {});
    expect(lastWs?.url).toBe('wss://stream.binance.com:9443/ws/btcusdt@kline_1w');
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 2. Kline message → Bar callback
  // -------------------------------------------------------------------------
  it('calls cb with a correctly shaped Bar on kline message', () => {
    const received: Bar[] = [];
    const conn = subscribeBinance('BTC', '1h', (bar) => received.push(bar));

    lastWs!.send(makeBtcKlineMsg());

    expect(received).toHaveLength(1);
    const bar = received[0];
    expect(bar.ts).toBe(1696118400000);
    expect(bar.o).toBeCloseTo(27000.50);
    expect(bar.h).toBeCloseTo(27150.00);
    expect(bar.l).toBeCloseTo(26950.25);
    expect(bar.c).toBeCloseTo(27100.75);
    expect(bar.v).toBeCloseTo(500.123);

    conn.unsubscribe();
  });

  it('calls cb multiple times for multiple messages', () => {
    const received: Bar[] = [];
    const conn = subscribeBinance('BTC', '1h', (bar) => received.push(bar));

    lastWs!.send(makeBtcKlineMsg({ ts: 1, c: '27000.00' } as never));
    lastWs!.send(makeBtcKlineMsg({ ts: 2, c: '27100.00' } as never));

    expect(received).toHaveLength(2);
    conn.unsubscribe();
  });

  it('does not call cb when message has no k field', () => {
    const received: Bar[] = [];
    const conn = subscribeBinance('BTC', '1h', (bar) => received.push(bar));

    lastWs!.send(JSON.stringify({ e: 'ping' })); // no `k`
    expect(received).toHaveLength(0);

    conn.unsubscribe();
  });

  it('does not throw on malformed JSON', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});
    // Should log a warning but not throw.
    expect(() => lastWs!.send('not-json')).not.toThrow();
    conn.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // 3. unsubscribe() closes WS and stops reconnect
  // -------------------------------------------------------------------------
  it('unsubscribe() closes the WebSocket', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});
    const ws = lastWs!;

    conn.unsubscribe();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('unsubscribe() stops reconnect — no new WS after close', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});

    // Unsubscribe before the connection closes.
    conn.unsubscribe();

    // Advance timers far past the max reconnect delay (30s).
    vi.advanceTimersByTime(60_000);

    // Only one WS instance should have been created.
    expect(allInstances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 4. Reconnect after unexpected close
  // -------------------------------------------------------------------------
  it('reconnects after onclose when not stopped', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});
    expect(allInstances).toHaveLength(1);

    // Simulate unexpected disconnect (not triggered by unsubscribe).
    // Replace close so it does NOT trigger onclose (we trigger manually).
    const ws1 = lastWs!;
    ws1.close = vi.fn(); // no-op
    ws1.onclose?.(); // simulate server-side close

    // Advance past the initial reconnect delay (1000ms + jitter).
    vi.advanceTimersByTime(2_000);

    // A new WebSocket should have been created.
    expect(allInstances).toHaveLength(2);

    conn.unsubscribe();
  });

  it('does not reconnect if unsubscribe was called before onclose fires', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});
    const ws1 = lastWs!;

    conn.unsubscribe(); // sets stopped = true
    // Simulate close event arriving *after* unsubscribe (race condition).
    ws1.onclose?.();

    vi.advanceTimersByTime(5_000);
    // Still only one instance — no reconnect.
    expect(allInstances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. onopen resets reconnect delay
  // -------------------------------------------------------------------------
  it('resets reconnect delay to 1000ms on successful open', () => {
    const conn = subscribeBinance('BTC', '1h', () => {});
    const ws = lastWs!;

    // Simulate open → disconnect → reconnect.
    ws.onopen?.();
    ws.close = vi.fn();
    ws.onclose?.(); // triggers reconnect timer

    vi.advanceTimersByTime(2_000);

    const ws2 = lastWs!;
    // Second connection opened — simulate open to verify reset happened.
    ws2.onopen?.();
    ws2.close = vi.fn();
    ws2.onclose?.();

    vi.advanceTimersByTime(2_000);

    // Third WS created — backoff should have reset after the successful open.
    expect(allInstances).toHaveLength(3);

    conn.unsubscribe();
  });
});
