/**
 * src/terminal/terminalClient.ts
 *
 * TypeScript client wrapper for the four Rust PTY commands:
 *   terminal_spawn, terminal_write, terminal_resize, terminal_kill
 * and two Tauri events:
 *   terminal:data  → { session_id, bytes_b64 }
 *   terminal:exit  → { session_id, code }
 *
 * Subscribe-before-spawn ordering mirrors claudeClient.ts (line ~405):
 * both `terminal:data` and `terminal:exit` listeners are attached BEFORE
 * `terminal_spawn` is invoked so the first frame is never lost.
 *
 * Base64 chunking threshold: 16 384 bytes (16 KiB). Payloads at or below
 * this size use the single-pass path; larger payloads chunk in 16 KiB
 * blocks to avoid `String.fromCharCode` call-stack limits.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenTerminalOptions {
  cols: number;
  rows: number;
  cwd?: string;
  cliPath?: string;
}

export interface TerminalDataEvent {
  sessionId: string;
  bytes: Uint8Array;
}

export interface TerminalExitEvent {
  sessionId: string;
  code: number;
}

export interface TerminalHandle {
  sessionId: string;
  write(bytes: Uint8Array | string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  on(event: 'data', cb: (e: TerminalDataEvent) => void): () => void;
  on(event: 'exit', cb: (e: TerminalExitEvent) => void): () => void;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal Rust event payload shapes (snake_case wire format)
// ---------------------------------------------------------------------------

interface RustDataPayload {
  session_id: string;
  bytes_b64: string;
}

interface RustExitPayload {
  session_id: string;
  code: number;
}

// ---------------------------------------------------------------------------
// Base64 helpers (no runtime deps — btoa/atob only)
// ---------------------------------------------------------------------------

const B64_CHUNK = 16_384; // 16 KiB threshold

/** Encode a Uint8Array to a base64 string, chunked to avoid stack limits. */
function bytesToB64(bytes: Uint8Array): string {
  if (bytes.length <= B64_CHUNK) {
    return btoa(String.fromCharCode(...bytes));
  }
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    const slice = bytes.subarray(offset, offset + B64_CHUNK);
    result += String.fromCharCode(...slice);
  }
  return btoa(result);
}

/** Decode a base64 string to a Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// openTerminal
// ---------------------------------------------------------------------------

export async function openTerminal(
  opts: OpenTerminalOptions,
): Promise<TerminalHandle> {
  // Subscriber registries.
  const dataCallbacks = new Set<(e: TerminalDataEvent) => void>();
  const exitCallbacks = new Set<(e: TerminalExitEvent) => void>();

  // Unlisten functions — null until subscriptions are live.
  let unlistenData: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;

  // Disposed flag — set on dispose() and after exit fires.
  let disposed = false;

  // session_id is resolved after terminal_spawn; captured via Promise.
  let resolvedSessionId = '';

  function teardown() {
    if (disposed) return;
    disposed = true;
    dataCallbacks.clear();
    exitCallbacks.clear();
    if (unlistenData) {
      try { unlistenData(); } catch (_) { /* best-effort */ }
      unlistenData = null;
    }
    if (unlistenExit) {
      try { unlistenExit(); } catch (_) { /* best-effort */ }
      unlistenExit = null;
    }
  }

  // Subscribe BEFORE invoking terminal_spawn (mirrors claudeClient.ts ~line 405).
  const dataListenPromise = listen<RustDataPayload>('terminal:data', (ev) => {
    const payload = ev.payload;
    if (payload.session_id !== resolvedSessionId) return; // filter other sessions
    const bytes = b64ToBytes(payload.bytes_b64);
    const event: TerminalDataEvent = { sessionId: payload.session_id, bytes };
    for (const cb of dataCallbacks) cb(event);
  }).then((u) => {
    unlistenData = u;
  });

  const exitListenPromise = listen<RustExitPayload>('terminal:exit', (ev) => {
    const payload = ev.payload;
    if (payload.session_id !== resolvedSessionId) return; // filter other sessions
    const event: TerminalExitEvent = { sessionId: payload.session_id, code: payload.code };
    for (const cb of exitCallbacks) cb(event);
    // Auto-dispose after exit: unlisten both, clear callbacks.
    // We do NOT call terminal_kill here because the process is already gone.
    teardown();
  }).then((u) => {
    unlistenExit = u;
  });

  // Wait for both subscriptions to be live before spawning.
  await Promise.all([dataListenPromise, exitListenPromise]);

  // Invoke terminal_spawn — errors propagate as thrown Error.
  let spawnResult: { session_id: string };
  try {
    spawnResult = await invoke<{ session_id: string }>('terminal_spawn', {
      args: {
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? null,
        cli_path: opts.cliPath ?? null,
      },
    });
  } catch (err) {
    // Cleanup subscriptions on spawn failure.
    teardown();
    throw err instanceof Error ? err : new Error(String(err));
  }

  resolvedSessionId = spawnResult.session_id;

  // ---------------------------------------------------------------------------
  // TerminalHandle implementation
  // ---------------------------------------------------------------------------

  const handle: TerminalHandle = {
    get sessionId() {
      return resolvedSessionId;
    },

    async write(data: Uint8Array | string): Promise<void> {
      if (disposed) {
        throw new Error('session_exited');
      }
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const datab64 = bytesToB64(bytes);
      await invoke<void>('terminal_write', {
        args: { session_id: resolvedSessionId, data_b64: datab64 },
      });
    },

    async resize(cols: number, rows: number): Promise<void> {
      if (disposed) return;
      await invoke<void>('terminal_resize', {
        args: { session_id: resolvedSessionId, cols, rows },
      });
    },

    async kill(): Promise<void> {
      // kill() signals the child; the exit event fires after the child dies
      // and gets delivered to subscribers before teardown. We do NOT call
      // teardown here — that happens automatically in the exit handler.
      await invoke<void>('terminal_kill', { sessionId: resolvedSessionId });
    },

    on(
      event: 'data' | 'exit',
      cb: ((e: TerminalDataEvent) => void) | ((e: TerminalExitEvent) => void),
    ): () => void {
      if (event === 'data') {
        const typedCb = cb as (e: TerminalDataEvent) => void;
        dataCallbacks.add(typedCb);
        return () => dataCallbacks.delete(typedCb);
      } else {
        const typedCb = cb as (e: TerminalExitEvent) => void;
        exitCallbacks.add(typedCb);
        return () => exitCallbacks.delete(typedCb);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return; // idempotent
      // Call terminal_kill (Rust side is idempotent — safe even after exit).
      try {
        await invoke<void>('terminal_kill', { sessionId: resolvedSessionId });
      } catch (_) {
        // best-effort
      }
      teardown();
    },
  };

  return handle;
}
