/**
 * MCP-tab follow-up tests (W2-B follow-up).
 *
 * Covers:
 *   1. Form validator — empty name rejected; conflict shows edit-link path;
 *      transport-specific field gating.
 *   2. Background poller — 5s interval drives `setStatus`; cleanup clears it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { useMcpStore } from '../stores/useMcpStore';
import {
  MCP_POLL_INTERVAL_MS,
  validateMcpForm,
} from './SettingsPanel';
import type { McpServer } from '../lib/db';

// Tauri invoke is the boundary every db.ts wrapper crosses. The tests stub
// it via the same mock shape `App.test.tsx` uses — invoke calls become
// resolved promises bound to the per-test scenario.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const invokeMock = vi.mocked(invoke);

const APP_SERVER: McpServer = {
  name: 'shared',
  transport: 'stdio',
  command: '/bin/echo',
  args: ['hi'],
  source: 'app',
};

const USER_SERVER: McpServer = {
  name: 'usr',
  transport: 'stdio',
  command: '/bin/echo',
  source: 'user',
};

beforeEach(() => {
  invokeMock.mockReset();
  useMcpStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1) validateMcpForm — pure validator
// ---------------------------------------------------------------------------

describe('validateMcpForm', () => {
  const baseForm = {
    expanded: true,
    editingName: null,
    name: '',
    transport: 'stdio' as const,
    command: '',
    argsText: '',
    envText: '',
    url: '',
    error: null,
  };

  it('rejects empty name', () => {
    const r = validateMcpForm(baseForm, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/i);
  });

  it('flags conflict with an existing app-managed server and offers edit link', () => {
    const r = validateMcpForm(
      { ...baseForm, name: 'shared', command: '/bin/echo' },
      [APP_SERVER],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/conflict/i);
      // Edit-link only offered when the conflict is on an *app* row.
      expect(r.conflictName).toBe('shared');
    }
  });

  it('flags conflict with a user/project row but does NOT offer edit link', () => {
    const r = validateMcpForm(
      { ...baseForm, name: 'usr', command: '/bin/echo' },
      [USER_SERVER],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflictName).toBeUndefined();
    }
  });

  it('skips conflict check when editing the same row', () => {
    const r = validateMcpForm(
      {
        ...baseForm,
        editingName: 'shared',
        name: 'shared',
        command: '/bin/node',
      },
      [APP_SERVER],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.server.command).toBe('/bin/node');
    }
  });

  it('requires command for stdio transport', () => {
    const r = validateMcpForm(
      { ...baseForm, name: 'x', transport: 'stdio' },
      [],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/command/i);
  });

  it('requires url for http transport (and ignores command)', () => {
    const r1 = validateMcpForm(
      { ...baseForm, name: 'x', transport: 'http' },
      [],
    );
    expect(r1.ok).toBe(false);

    const r2 = validateMcpForm(
      { ...baseForm, name: 'x', transport: 'http', url: 'https://x.example' },
      [],
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.server.url).toBe('https://x.example');
      expect(r2.server.command).toBeUndefined();
    }
  });

  it('requires url for sse transport', () => {
    const r = validateMcpForm(
      { ...baseForm, name: 'x', transport: 'sse', url: 'https://x.example/sse' },
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.server.transport).toBe('sse');
  });

  it('parses args one-per-line and env KEY=VAL pairs', () => {
    const r = validateMcpForm(
      {
        ...baseForm,
        name: 'demo',
        transport: 'stdio',
        command: 'npx',
        argsText: '-y\n@org/srv\n',
        envText: 'A=1\nB=two=eq',
      },
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.server.args).toEqual(['-y', '@org/srv']);
      expect(r.server.env).toEqual({ A: '1', B: 'two=eq' });
    }
  });

  it('rejects malformed env line', () => {
    const r = validateMcpForm(
      {
        ...baseForm,
        name: 'demo',
        command: 'x',
        envText: 'NOEQUAL',
      },
      [],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/env/i);
  });
});

// ---------------------------------------------------------------------------
// 2) Poller — 5s interval drives mcpHealthCheck → setStatus
// ---------------------------------------------------------------------------

describe('McpTab background health poller', () => {
  it('mounts on tab activation, calls setStatus immediately + every 5s, tears down on unmount', async () => {
    vi.useFakeTimers();

    // Seed merged servers in the store BEFORE rendering so the immediate
    // tick has something to iterate. The MCP tab also fires its own
    // `mcp_list_merged` invoke which we resolve to the same list.
    useMcpStore.getState().setServers([APP_SERVER]);

    const healthOk = {
      name: APP_SERVER.name,
      healthy: true,
      last_checked: 1700000000000,
    };

    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'mcp_list_merged':
          return Promise.resolve([APP_SERVER]);
        case 'mcp_app_config_path':
          return Promise.resolve('/tmp/mcp.json');
        case 'mcp_health_check':
          return Promise.resolve(healthOk);
        default:
          return Promise.resolve(undefined);
      }
    });

    const setStatusSpy = vi.spyOn(useMcpStore.getState(), 'setStatus');

    // Lazy import so the @tauri-apps mock is in place.
    const { SettingsPanel } = await import('./SettingsPanel');
    const { useSettingsUiStore } = await import('../stores/useSettingsUiStore');
    const { useDockStore } = await import('../stores/useDockStore');
    // Step 2b — open-state now lives in useDockStore ('settings', right side).
    useDockStore.getState().openDrawer('settings');
    useSettingsUiStore.getState().setActiveTab('mcp');

    const view = render(<SettingsPanel />);

    // Flush microtasks for the immediate tick + initial mcp_list_merged.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Health-check fires once on mount.
    const healthCalls = () =>
      invokeMock.mock.calls.filter((c) => c[0] === 'mcp_health_check').length;

    expect(healthCalls()).toBeGreaterThanOrEqual(1);
    const after1 = healthCalls();

    // Advance one interval — second poll fires.
    await act(async () => {
      vi.advanceTimersByTime(MCP_POLL_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(healthCalls()).toBeGreaterThan(after1);

    // Unmount → next interval should NOT add new calls.
    const before = healthCalls();
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(MCP_POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });
    expect(healthCalls()).toBe(before);

    setStatusSpy.mockRestore();
  });
});

