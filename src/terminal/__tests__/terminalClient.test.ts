/**
 * src/terminal/__tests__/terminalClient.test.ts
 *
 * Vitest coverage for terminalClient.ts.
 *
 * Mock strategy mirrors src/ai/claudeClient.unlisten.test.ts:
 *   - `@tauri-apps/api/core` invoke is vi.mocked per-test.
 *   - `@tauri-apps/api/event` listen is vi.mocked to capture handlers.
 *
 * The two listen subscriptions are captured in order via `capturedListeners`:
 * index 0 = terminal:data, index 1 = terminal:exit — matching the
 * subscribe-before-spawn ordering in terminalClient.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalDataEvent, TerminalExitEvent } from '../terminalClient';

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/event
// ---------------------------------------------------------------------------

import type { Event as TauriEvent } from '@tauri-apps/api/event';

type EventHandler = (evt: TauriEvent<unknown>) => void;

const unlistenMocks: ReturnType<typeof vi.fn>[] = [];
const capturedListeners: Array<{ event: string; handler: EventHandler }> = [];

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: EventHandler) => {
    const unlisten = vi.fn();
    unlistenMocks.push(unlisten);
    capturedListeners.push({ event, handler });
    return unlisten;
  }),
}));

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { openTerminal } from '../terminalClient';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireDataEvent(sessionId: string, b64: string) {
  // terminal:data is always the first listener registered.
  const listener = capturedListeners.find((l) => l.event === 'terminal:data');
  listener?.handler({ event: 'terminal:data', id: 1, payload: { session_id: sessionId, bytes_b64: b64 } });
}

function fireExitEvent(sessionId: string, code: number) {
  const listener = capturedListeners.find((l) => l.event === 'terminal:exit');
  listener?.handler({ event: 'terminal:exit', id: 2, payload: { session_id: sessionId, code } });
}

const TEST_SESSION_ID = 'test-session-abc';

function setupSpawn(sessionId = TEST_SESSION_ID) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'terminal_spawn') return { session_id: sessionId };
    if (cmd === 'terminal_kill') return undefined;
    if (cmd === 'terminal_write') return undefined;
    if (cmd === 'terminal_resize') return undefined;
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  unlistenMocks.length = 0;
  capturedListeners.length = 0;
  mockInvoke.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('openTerminal', () => {
  it('subscribes BEFORE invoking terminal_spawn', async () => {
    // Track call order: listen calls must precede terminal_spawn invoke.
    const callOrder: string[] = [];

    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockImplementation(async (event: string, handler: EventHandler) => {
      callOrder.push(`listen:${event}`);
      const unlisten = vi.fn();
      capturedListeners.push({ event, handler });
      return unlisten;
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      callOrder.push(`invoke:${cmd}`);
      if (cmd === 'terminal_spawn') return { session_id: TEST_SESSION_ID };
      return undefined;
    });

    await openTerminal({ cols: 80, rows: 24 });

    // Both listen calls must appear before terminal_spawn.
    const spawnIdx = callOrder.indexOf('invoke:terminal_spawn');
    const dataIdx = callOrder.indexOf('listen:terminal:data');
    const exitIdx = callOrder.indexOf('listen:terminal:exit');

    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThan(dataIdx);
    expect(spawnIdx).toBeGreaterThan(exitIdx);
  });

  it('data events decode base64 to Uint8Array and dispatch to all subscribers', async () => {
    setupSpawn();
    const handle = await openTerminal({ cols: 80, rows: 24 });

    const received1: TerminalDataEvent[] = [];
    const received2: TerminalDataEvent[] = [];
    handle.on('data', (e) => received1.push(e));
    handle.on('data', (e) => received2.push(e));

    // "hello" in base64 is 'aGVsbG8='
    const helloBytes = new TextEncoder().encode('hello');
    const b64 = btoa(String.fromCharCode(...helloBytes));
    fireDataEvent(TEST_SESSION_ID, b64);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(Array.from(received1[0].bytes)).toEqual(Array.from(helloBytes));
    expect(Array.from(received2[0].bytes)).toEqual(Array.from(helloBytes));
    expect(received1[0].sessionId).toBe(TEST_SESSION_ID);
  });

  it('events for a different sessionId are filtered out', async () => {
    setupSpawn('session-A');
    const handle = await openTerminal({ cols: 80, rows: 24 });

    const dataReceived: TerminalDataEvent[] = [];
    const exitReceived: TerminalExitEvent[] = [];
    handle.on('data', (e) => dataReceived.push(e));
    handle.on('exit', (e) => exitReceived.push(e));

    // Fire events tagged for a completely different session.
    fireDataEvent('session-B', btoa('x'));
    fireExitEvent('session-B', 0);

    expect(dataReceived).toHaveLength(0);
    expect(exitReceived).toHaveLength(0);
  });

  it('write encodes string via UTF-8 + base64 and forwards to terminal_write', async () => {
    setupSpawn();
    const handle = await openTerminal({ cols: 80, rows: 24 });

    mockInvoke.mockResolvedValue(undefined);
    await handle.write('ls\n');

    // Find the terminal_write call.
    const writeCall = mockInvoke.mock.calls.find(
      (c: unknown[]) => c[0] === 'terminal_write',
    );
    expect(writeCall).toBeDefined();

    const args = writeCall![1] as { args: { session_id: string; data_b64: string } };
    expect(args.args.session_id).toBe(TEST_SESSION_ID);

    // Verify the base64 decodes back to "ls\n".
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(args.args.data_b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe('ls\n');
  });

  it('write encodes Uint8Array via base64 unchanged (no double-encoding)', async () => {
    setupSpawn();
    const handle = await openTerminal({ cols: 80, rows: 24 });

    mockInvoke.mockResolvedValue(undefined);
    const rawBytes = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    await handle.write(rawBytes);

    const writeCall = mockInvoke.mock.calls.find(
      (c: unknown[]) => c[0] === 'terminal_write',
    );
    expect(writeCall).toBeDefined();

    const args = writeCall![1] as { args: { data_b64: string } };
    const decoded = Uint8Array.from(atob(args.args.data_b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(rawBytes);
  });

  it('resize forwards cols/rows to terminal_resize', async () => {
    setupSpawn();
    const handle = await openTerminal({ cols: 80, rows: 24 });

    mockInvoke.mockResolvedValue(undefined);
    await handle.resize(120, 40);

    const resizeCall = mockInvoke.mock.calls.find(
      (c: unknown[]) => c[0] === 'terminal_resize',
    );
    expect(resizeCall).toBeDefined();

    const args = resizeCall![1] as { args: { session_id: string; cols: number; rows: number } };
    expect(args.args.session_id).toBe(TEST_SESSION_ID);
    expect(args.args.cols).toBe(120);
    expect(args.args.rows).toBe(40);
  });

  it('dispose calls terminal_kill, unlistens both events, and is idempotent', async () => {
    // Use a fresh pair of unlisten spies scoped to this test.
    const localUnlistens: ReturnType<typeof vi.fn>[] = [];
    const localListeners: Array<{ event: string; handler: EventHandler }> = [];

    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockImplementation(async (event: string, handler: EventHandler) => {
      const unlisten = vi.fn();
      localUnlistens.push(unlisten);
      localListeners.push({ event, handler });
      capturedListeners.push({ event, handler });
      return unlisten;
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'terminal_spawn') return { session_id: TEST_SESSION_ID };
      return undefined;
    });

    const handle = await openTerminal({ cols: 80, rows: 24 });

    expect(localUnlistens).toHaveLength(2); // one for data, one for exit

    // Call dispose twice — must be idempotent.
    await handle.dispose();
    await handle.dispose();

    // terminal_kill should have been called exactly once.
    const killCalls = mockInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === 'terminal_kill',
    );
    expect(killCalls).toHaveLength(1);

    // Each unlisten called exactly once (teardown is idempotent).
    for (const u of localUnlistens) {
      expect(u).toHaveBeenCalledTimes(1);
    }
  });

  it('exit event triggers exit subscribers and the handle becomes inert (write rejects)', async () => {
    setupSpawn();
    const handle = await openTerminal({ cols: 80, rows: 24 });

    const exitEvents: TerminalExitEvent[] = [];
    handle.on('exit', (e) => exitEvents.push(e));

    // Fire the exit event from the Rust side.
    fireExitEvent(TEST_SESSION_ID, 0);

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].code).toBe(0);
    expect(exitEvents[0].sessionId).toBe(TEST_SESSION_ID);

    // After exit, write must reject with a "session_exited" error.
    mockInvoke.mockResolvedValue(undefined);
    await expect(handle.write('x')).rejects.toThrow('session_exited');
  });

  it('on() returns an unsubscribe function that removes only that callback', async () => {
    setupSpawn();
    const handle = await openTerminal({ cols: 80, rows: 24 });

    const received: TerminalDataEvent[] = [];
    const unsub = handle.on('data', (e) => received.push(e));

    const b64 = btoa('a');
    fireDataEvent(TEST_SESSION_ID, b64);
    expect(received).toHaveLength(1);

    // Unsubscribe and fire again — no new events should arrive.
    unsub();
    fireDataEvent(TEST_SESSION_ID, b64);
    expect(received).toHaveLength(1);
  });

  it('terminal_spawn errors propagate as thrown Error', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'terminal_spawn') throw new Error('max_sessions_reached');
      return undefined;
    });

    await expect(openTerminal({ cols: 80, rows: 24 })).rejects.toThrow(
      'max_sessions_reached',
    );
  });
});
