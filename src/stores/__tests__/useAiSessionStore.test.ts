/**
 * src/stores/__tests__/useAiSessionStore.test.ts
 *
 * Unit tests for useAiSessionStore.
 *
 * Strategy:
 *   - Mock the db layer (../../../lib/db) so no Tauri IPC calls are made.
 *   - Mock useToastStore so toast imports don't fail in jsdom.
 *   - Use fake timers (vi.useFakeTimers) for busy-window tests.
 *   - Reset store state between tests to keep tests isolated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the db layer BEFORE importing the store.
// ---------------------------------------------------------------------------

const mockDbAiSessionsList = vi.fn();
const mockDbAiSessionsUpsert = vi.fn();
const mockDbAiSessionsDelete = vi.fn();

vi.mock('../../lib/db', () => ({
  dbAiSessionsList: (...args: unknown[]) => mockDbAiSessionsList(...args),
  dbAiSessionsUpsert: (...args: unknown[]) => mockDbAiSessionsUpsert(...args),
  dbAiSessionsDelete: (...args: unknown[]) => mockDbAiSessionsDelete(...args),
  dbAiSessionsGet: vi.fn(),
}));

// Mock useToastStore so the dynamic import inside the store resolves cleanly.
const mockToastPush = vi.fn();
vi.mock('../useToastStore', () => ({
  useToastStore: {
    getState: () => ({ push: mockToastPush }),
  },
}));

// ---------------------------------------------------------------------------
// Import store AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { useAiSessionStore } from '../useAiSessionStore';
import type { AiSession } from '../../lib/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<AiSession> = {}): AiSession {
  return {
    id: 'test-session-001',
    mode: 'research',
    cwd_path: '/tmp/test',
    model: null,
    created_at: 1_000_000,
    last_used_at: 1_000_000,
    summary: null,
    title: null,
    ...overrides,
  };
}

/** Reset Zustand store state fully between tests. */
function resetStore() {
  useAiSessionStore.setState({
    sessions: [],
    hydrated: false,
    busyUntil: {},
    runState: {},
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
  mockDbAiSessionsList.mockReset();
  mockDbAiSessionsUpsert.mockReset();
  mockDbAiSessionsDelete.mockReset();
  mockToastPush.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// recordSpawn
// ---------------------------------------------------------------------------

describe('recordSpawn', () => {
  it('optimistically prepends the session and marks it RUNNING before db resolves', async () => {
    let resolveUpsert!: () => void;
    mockDbAiSessionsUpsert.mockReturnValue(
      new Promise<void>((res) => { resolveUpsert = res; }),
    );

    const id = 'spawn-001';
    const spawnPromise = useAiSessionStore.getState().recordSpawn({
      id,
      mode: 'research',
      cwd_path: '/home/user',
    });

    // Before db resolves: session in store, RUNNING.
    const { sessions, runState } = useAiSessionStore.getState();
    expect(sessions.find((s) => s.id === id)).toBeDefined();
    expect(runState[id]).toBe('RUNNING');

    resolveUpsert();
    await spawnPromise;

    expect(mockDbAiSessionsUpsert).toHaveBeenCalledOnce();
    const calledRow = mockDbAiSessionsUpsert.mock.calls[0][0] as AiSession;
    expect(calledRow.id).toBe(id);
    expect(calledRow.mode).toBe('research');
    expect(calledRow.title).toBeNull();
  });

  it('calls dbAiSessionsUpsert with the full 8-field row', async () => {
    mockDbAiSessionsUpsert.mockResolvedValue(undefined);
    await useAiSessionStore.getState().recordSpawn({
      id: 'spawn-002',
      mode: 'strategy',
      cwd_path: '/workspace',
      model: 'claude-opus-4',
      title: 'My session',
    });

    const row = mockDbAiSessionsUpsert.mock.calls[0][0] as AiSession;
    expect(row.id).toBe('spawn-002');
    expect(row.mode).toBe('strategy');
    expect(row.cwd_path).toBe('/workspace');
    expect(row.model).toBe('claude-opus-4');
    expect(row.title).toBe('My session');
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.last_used_at).toBe('number');
  });

  it('toast-fallback: shows error toast when db upsert rejects', async () => {
    mockDbAiSessionsUpsert.mockRejectedValue(new Error('disk full'));

    await useAiSessionStore.getState().recordSpawn({
      id: 'spawn-err',
      mode: 'research',
      cwd_path: '/tmp',
    });

    // Session stays in store (optimistic).
    expect(useAiSessionStore.getState().sessions.find((s) => s.id === 'spawn-err')).toBeDefined();
    // Toast was pushed — dynamic import resolves synchronously via mock.
    await vi.runAllTimersAsync();
    expect(mockToastPush).toHaveBeenCalledOnce();
    expect(mockToastPush.mock.calls[0][0]).toMatchObject({ kind: 'error' });
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe('rename', () => {
  it('optimistically updates title and calls dbAiSessionsUpsert', async () => {
    const session = makeSession({ id: 'rename-001', title: null });
    useAiSessionStore.setState({ sessions: [session] });
    mockDbAiSessionsUpsert.mockResolvedValue(undefined);

    await useAiSessionStore.getState().rename('rename-001', 'My Chart Study');

    const updated = useAiSessionStore.getState().sessions.find((s) => s.id === 'rename-001');
    expect(updated?.title).toBe('My Chart Study');
    expect(mockDbAiSessionsUpsert).toHaveBeenCalledOnce();
    const row = mockDbAiSessionsUpsert.mock.calls[0][0] as AiSession;
    expect(row.title).toBe('My Chart Study');
    // created_at must be preserved.
    expect(row.created_at).toBe(session.created_at);
  });

  it('toast-fallback: shows error toast when db upsert rejects on rename', async () => {
    const session = makeSession({ id: 'rename-err' });
    useAiSessionStore.setState({ sessions: [session] });
    mockDbAiSessionsUpsert.mockRejectedValue(new Error('write failed'));

    await useAiSessionStore.getState().rename('rename-err', 'New Name');

    await vi.runAllTimersAsync();
    expect(mockToastPush).toHaveBeenCalledOnce();
    expect(mockToastPush.mock.calls[0][0]).toMatchObject({ kind: 'error' });
  });

  it('is a no-op when session id is not found', async () => {
    mockDbAiSessionsUpsert.mockResolvedValue(undefined);
    await useAiSessionStore.getState().rename('nonexistent', 'x');
    expect(mockDbAiSessionsUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('removes session from store and calls dbAiSessionsDelete', async () => {
    const session = makeSession({ id: 'rem-001' });
    useAiSessionStore.setState({ sessions: [session] });
    mockDbAiSessionsDelete.mockResolvedValue(undefined);

    await useAiSessionStore.getState().remove('rem-001');

    expect(useAiSessionStore.getState().sessions.find((s) => s.id === 'rem-001')).toBeUndefined();
    expect(mockDbAiSessionsDelete).toHaveBeenCalledWith('rem-001');
  });

  it('synchronously clears busy timer without advancing timers', () => {
    const id = 'rem-busy';
    const session = makeSession({ id });
    useAiSessionStore.setState({ sessions: [session], runState: { [id]: 'RUNNING' } });
    mockDbAiSessionsDelete.mockResolvedValue(undefined);

    // Arm the busy timer.
    useAiSessionStore.getState().markActivity(id);
    expect(useAiSessionStore.getState().busyUntil[id]).toBeDefined();

    // remove() must synchronously clear the busy state — no timer advance needed.
    void useAiSessionStore.getState().remove(id);

    expect(useAiSessionStore.getState().busyUntil[id]).toBeUndefined();
  });

  it('toast-fallback: shows error toast when db delete rejects', async () => {
    const session = makeSession({ id: 'rem-err' });
    useAiSessionStore.setState({ sessions: [session] });
    mockDbAiSessionsDelete.mockRejectedValue(new Error('locked'));

    await useAiSessionStore.getState().remove('rem-err');

    await vi.runAllTimersAsync();
    expect(mockToastPush).toHaveBeenCalledOnce();
    expect(mockToastPush.mock.calls[0][0]).toMatchObject({ kind: 'error' });
  });
});

// ---------------------------------------------------------------------------
// markIdle
// ---------------------------------------------------------------------------

describe('markIdle', () => {
  it('markIdle sets IDLE and synchronously clears busy timer', () => {
    const id = 'mi-001';
    const session = makeSession({ id });
    useAiSessionStore.setState({ sessions: [session], runState: { [id]: 'RUNNING' } });

    // Arm busy timer.
    useAiSessionStore.getState().markActivity(id);
    expect(useAiSessionStore.getState().busyUntil[id]).toBeDefined();
    expect(useAiSessionStore.getState().isBusy(id)).toBe(true);

    // markIdle must clear SYNCHRONOUSLY — no timer advance.
    useAiSessionStore.getState().markIdle(id);

    expect(useAiSessionStore.getState().runState[id]).toBe('IDLE');
    expect(useAiSessionStore.getState().busyUntil[id]).toBeUndefined();
    expect(useAiSessionStore.getState().isBusy(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markActivity — busy window
// ---------------------------------------------------------------------------

describe('markActivity (busy window)', () => {
  it('sets isBusy immediately after markActivity', () => {
    const id = 'act-001';
    const session = makeSession({ id });
    useAiSessionStore.setState({ sessions: [session], runState: { [id]: 'RUNNING' } });

    useAiSessionStore.getState().markActivity(id);

    expect(useAiSessionStore.getState().busyUntil[id]).toBeGreaterThan(Date.now());
    expect(useAiSessionStore.getState().isBusy(id)).toBe(true);
  });

  it('clears busyUntil after 700ms (fake timer advance)', () => {
    const id = 'act-timer';
    const session = makeSession({ id });
    useAiSessionStore.setState({ sessions: [session], runState: { [id]: 'RUNNING' } });

    useAiSessionStore.getState().markActivity(id);
    expect(useAiSessionStore.getState().isBusy(id)).toBe(true);

    // Advance past the 700ms window.
    vi.advanceTimersByTime(750);

    expect(useAiSessionStore.getState().busyUntil[id]).toBeUndefined();
    expect(useAiSessionStore.getState().isBusy(id)).toBe(false);
  });

  it('re-arming markActivity resets the 700ms window', () => {
    const id = 'act-rearm';
    const session = makeSession({ id });
    useAiSessionStore.setState({ sessions: [session], runState: { [id]: 'RUNNING' } });

    useAiSessionStore.getState().markActivity(id);
    vi.advanceTimersByTime(400);
    // Re-arm before the window expires.
    useAiSessionStore.getState().markActivity(id);
    vi.advanceTimersByTime(400);
    // Original 700ms has elapsed from first call, but second call restarted it.
    expect(useAiSessionStore.getState().isBusy(id)).toBe(true);

    vi.advanceTimersByTime(350);
    // Now 750ms from second call — window should have lapsed.
    expect(useAiSessionStore.getState().isBusy(id)).toBe(false);
  });

  it('isAnyBusy returns true when at least one session is busy', () => {
    const id = 'any-busy';
    const session = makeSession({ id });
    useAiSessionStore.setState({ sessions: [session], runState: { [id]: 'RUNNING' } });

    expect(useAiSessionStore.getState().isAnyBusy()).toBe(false);
    useAiSessionStore.getState().markActivity(id);
    expect(useAiSessionStore.getState().isAnyBusy()).toBe(true);

    vi.advanceTimersByTime(750);
    expect(useAiSessionStore.getState().isAnyBusy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hydrate
// ---------------------------------------------------------------------------

describe('hydrate', () => {
  it('loads sessions from db and sets hydrated=true, all IDLE', async () => {
    const s1 = makeSession({ id: 'h-001', mode: 'research', last_used_at: 2000 });
    const s2 = makeSession({ id: 'h-002', mode: 'strategy', last_used_at: 1000 });
    mockDbAiSessionsList.mockImplementation(async (mode: string) => {
      if (mode === 'research') return [s1];
      if (mode === 'strategy') return [s2];
      return [];
    });

    await useAiSessionStore.getState().hydrate();

    const state = useAiSessionStore.getState();
    expect(state.hydrated).toBe(true);
    // Sorted newest-first: s1 (2000) before s2 (1000).
    expect(state.sessions[0].id).toBe('h-001');
    expect(state.sessions[1].id).toBe('h-002');
    // All IDLE after hydration.
    expect(state.runState['h-001']).toBe('IDLE');
    expect(state.runState['h-002']).toBe('IDLE');
    expect(state.busyUntil).toEqual({});
  });

  it('sets hydrated=true and shows warn toast on db failure', async () => {
    mockDbAiSessionsList.mockRejectedValue(new Error('db unavailable'));

    await useAiSessionStore.getState().hydrate();

    expect(useAiSessionStore.getState().hydrated).toBe(true);
    await vi.runAllTimersAsync();
    expect(mockToastPush).toHaveBeenCalledOnce();
    expect(mockToastPush.mock.calls[0][0]).toMatchObject({ kind: 'warn' });
  });
});
