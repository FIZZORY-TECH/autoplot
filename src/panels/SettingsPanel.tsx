/**
 * src/panels/SettingsPanel.tsx — App settings panel (W2-A).
 *
 * 440px right-slide panel with seven tab bodies inline:
 *   General · Models · Tools & Permissions · MCP · Skills · Hooks · Privacy
 *
 * W2-A fully wires General / Models / Tools. The remaining four tabs render a
 * placeholder card with a stable `data-w2-stub="<id>"` insertion point so the
 * later Wave 2 agents (W2-B/C/D1/G) can drop content in without conflicting.
 *
 * Visual structure mirrors `app-design/project/agents.jsx:AgentsPanel` 1:1 —
 * tokens reused from `src/styles/agents.css`. We never invent new tokens.
 *
 * Persistence: every wired setting is bound to `useSettingsStore`, which is
 * itself debounced-written to SQLite via `mountSettingsSync` in `hydrate.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useMcpStore } from '../stores/useMcpStore';
import { useToastStore } from '../stores/useToastStore';
import {
  useSettingsUiStore,
  type SettingsTab,
} from '../stores/useSettingsUiStore';
import { useDockStore } from '../stores/useDockStore';
import { DockDrawer } from './DockDrawer';
import { PanelHeader } from './PanelHeader';
import type { Mode, PermissionMode } from '../ai/types';
import {
  auditLogPath,
  claudeTestConnection,
  mcpAppConfigPath,
  mcpAppConfigRemove,
  mcpAppConfigUpsert,
  mcpHealthCheck,
  mcpImportFromUserProfile,
  mcpListMerged,
  profileAuthStatus,
  profileLogout,
  profilePaths,
  settingsAppGet,
  settingsAppPath,
  settingsAppSetHooks,
  skillSetEnabled,
  skillsListMerged,
  subagentsList,
  type McpServer,
  type McpTransport,
  type ProfileAuthStatus,
  type ProfilePaths,
  type Skill,
  type SubagentMeta,
} from '../lib/db';
import { ClaudeLoginPanel } from './auth/ClaudeLoginPanel';

// Wave 0 — module-scoped cache so multiple consumers don't re-invoke the
// `profile_paths` Tauri command on every render. Reset on first read failure
// so the user sees a coarse fallback string until Tauri responds.
let _profilePathsCache: ProfilePaths | null = null;
let _profilePathsPromise: Promise<ProfilePaths> | null = null;
function useProfilePaths(): ProfilePaths | null {
  const [paths, setPaths] = useState<ProfilePaths | null>(_profilePathsCache);
  useEffect(() => {
    if (_profilePathsCache) return;
    if (!_profilePathsPromise) {
      _profilePathsPromise = profilePaths().then((p) => {
        _profilePathsCache = p;
        return p;
      });
    }
    let cancelled = false;
    _profilePathsPromise
      .then((p) => {
        if (!cancelled) setPaths(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return paths;
}

// ---------------------------------------------------------------------------
// Canonical tool list — W2-A's snapshot. The store seeds `allowedToolsByMode`
// from a subset of these in `hydrate.ts:seedToolDefaultsIfEmpty()`.
// W2-C extends this with discovered MCP/Skill tools.
// ---------------------------------------------------------------------------

const KNOWN_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'Task',
  // Tool surface from AI tool registry (research + strategy modes).
  'fetch_ohlc',
  'compute_indicator',
  'return_dataset',
  'validate_strategy',
  'backtest_strategy',
  'return_strategy',
];

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

const TAB_DEFS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'tools', label: 'Tools' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'privacy', label: 'Privacy' },
];

// ---------------------------------------------------------------------------
// Top-level panel
// ---------------------------------------------------------------------------

export function SettingsPanel(): JSX.Element {
  // Open-state derives from useDockStore ('settings', right side).
  const open = useDockStore((s) => s.openRight === 'settings');
  const activeTab = useSettingsUiStore((s) => s.activeTab);
  const setActiveTab = useSettingsUiStore((s) => s.setActiveTab);

  return (
    <DockDrawer
      side="right"
      id="settings"
      ariaLabel="Settings"
      mountOnOpen
      open={open}
    >
      <PanelHeader
        label="Settings"
        closeLabel="Close settings panel"
        onClose={() => useDockStore.getState().close('right')}
      />

      <div className="settings-tabstrip" role="tablist" aria-label="Settings tabs">
        {TAB_DEFS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`settings-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-body">
        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'tools' && <ToolsTab />}
        {activeTab === 'mcp' && <McpTab />}
        {activeTab === 'skills' && <SkillsTab />}
        {activeTab === 'hooks' && <HooksTab />}
        {activeTab === 'privacy' && <PrivacyTab />}
      </div>
    </DockDrawer>
  );
}

// ---------------------------------------------------------------------------
// General tab
// ---------------------------------------------------------------------------

type TestState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; version: string }
  | { status: 'err'; message: string };

function GeneralTab(): JSX.Element {
  const cliPath = useSettingsStore((s) => s.cliPath);
  const setCliPath = useSettingsStore((s) => s.setCliPath);
  const verboseLogging = useSettingsStore((s) => s.verboseLogging);
  const setVerboseLogging = useSettingsStore((s) => s.setVerboseLogging);
  const dataRefresh = useSettingsStore((s) => s.dataRefreshIntervalSec);
  const setDataRefresh = useSettingsStore((s) => s.setDataRefreshIntervalSec);

  const [test, setTest] = useState<TestState>({ status: 'idle' });

  const handleTest = useCallback(async () => {
    setTest({ status: 'pending' });
    try {
      const version = await claudeTestConnection(cliPath ?? undefined);
      setTest({ status: 'ok', version });
    } catch (err) {
      setTest({ status: 'err', message: extractError(err) });
    }
  }, [cliPath]);

  return (
    <>
      <section className="settings-section">
        <span className="settings-section-title">Claude CLI</span>
        <div className="settings-row">
          <label htmlFor="settings-cli-path">CLI path</label>
          <input
            id="settings-cli-path"
            type="text"
            placeholder="/usr/local/bin/claude (auto-detect when blank)"
            value={cliPath ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setCliPath(v.length === 0 ? null : v);
            }}
          />
          <span className="settings-row-hint">
            Leave blank to auto-detect via <code>which claude</code>, then
            <code> ~/.local/bin/claude</code>, then <code>~/.claude/local/claude</code>.
          </span>
        </div>
        <div className="settings-row-inline">
          <button
            type="button"
            className="settings-btn"
            onClick={handleTest}
            disabled={test.status === 'pending'}
          >
            {test.status === 'pending' ? 'Testing…' : 'Test connection'}
          </button>
          <TestStatusBadge state={test} />
        </div>
      </section>

      <AccountSection cliPath={cliPath ?? undefined} />

      <section className="settings-section">
        <span className="settings-section-title">Logging</span>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={verboseLogging}
            onChange={(e) => setVerboseLogging(e.target.checked)}
          />
          Verbose logging (writes <code>--verbose</code> stderr to disk)
        </label>
      </section>

      <section className="settings-section">
        <span className="settings-section-title">Data</span>
        <div className="settings-row">
          <label htmlFor="settings-refresh">Refresh interval (seconds)</label>
          <input
            id="settings-refresh"
            type="number"
            min={5}
            max={600}
            step={1}
            value={dataRefresh}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              setDataRefresh(Math.max(5, Math.min(600, Math.round(n))));
            }}
          />
          <span className="settings-row-hint">Range 5–600s. Default 30s.</span>
        </div>
      </section>
    </>
  );
}

function TestStatusBadge({ state }: { state: TestState }): JSX.Element | null {
  switch (state.status) {
    case 'idle':
      return null;
    case 'pending':
      return (
        <span className="settings-status">
          <span className="dot" />
          checking…
        </span>
      );
    case 'ok':
      return (
        <span className="settings-status ok" title={state.version}>
          <span className="dot" />
          {state.version}
        </span>
      );
    case 'err':
      return (
        <span className="settings-status err" title={state.message}>
          <span className="dot" />
          {state.message}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Account section (Wave 0 follow-up — in-app Claude OAuth login).
// Sits inside the General tab so it's the first thing users see when they
// need to manage their isolated-profile credentials.
// ---------------------------------------------------------------------------

function AccountSection({ cliPath }: { cliPath?: string }): JSX.Element {
  const [status, setStatus] = useState<ProfileAuthStatus | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await profileAuthStatus(cliPath);
      setStatus(s);
      setError(null);
    } catch (err) {
      setStatus({ signedIn: false, mode: 'none' });
      setError(extractError(err));
    }
  }, [cliPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSignOut = useCallback(async () => {
    setLogoutPending(true);
    setError(null);
    try {
      await profileLogout(cliPath);
    } catch (err) {
      setError(extractError(err));
    } finally {
      await refresh();
      setLogoutPending(false);
    }
  }, [cliPath, refresh]);

  const onLoginSuccess = useCallback(() => {
    setLoginOpen(false);
    void refresh();
  }, [refresh]);

  return (
    <section className="settings-section">
      <span className="settings-section-title">Account</span>
      <AccountStatusLine status={status} />
      {error && (
        <span className="settings-status err" title={error}>
          <span className="dot" />
          {error}
        </span>
      )}
      {loginOpen ? (
        <ClaudeLoginPanel
          cliPath={cliPath}
          onSuccess={onLoginSuccess}
          onCancel={() => setLoginOpen(false)}
        />
      ) : (
        <div className="settings-row-inline">
          <button
            type="button"
            className="settings-btn"
            onClick={() => setLoginOpen(true)}
            disabled={logoutPending}
          >
            {status?.signedIn ? 'Re-login' : 'Sign in with Claude'}
          </button>
          <button
            type="button"
            className="settings-btn ghost"
            onClick={() => void onSignOut()}
            disabled={logoutPending || !status?.signedIn}
          >
            {logoutPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
      <span className="settings-row-hint">
        This signs out of this app's isolated profile only — your other Claude
        installations are unaffected.
      </span>
    </section>
  );
}

function AccountStatusLine({
  status,
}: {
  status: ProfileAuthStatus | null;
}): JSX.Element {
  if (status === null) {
    return <span className="settings-row-hint">Checking sign-in status…</span>;
  }
  if (status.mode === 'oauth') {
    return (
      <span className="settings-status ok">
        <span className="dot" />
        Signed in as <code>{status.account ?? 'Claude account'}</code>
      </span>
    );
  }
  if (status.mode === 'apiKey') {
    return (
      <span className="settings-status ok">
        <span className="dot" />
        Using API key
      </span>
    );
  }
  return (
    <span className="settings-status">
      <span className="dot" />
      Not signed in
    </span>
  );
}

// ---------------------------------------------------------------------------
// Models tab
// ---------------------------------------------------------------------------

function ModelsTab(): JSX.Element {
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);
  const modelByMode = useSettingsStore((s) => s.modelByMode);
  const setModelForMode = useSettingsStore((s) => s.setModelForMode);

  const onChangeFor = (
    target: 'default' | Mode,
    raw: string,
  ) => {
    const v = raw.length === 0 ? null : raw;
    if (target === 'default') setDefaultModel(v);
    else setModelForMode(target, v);
  };

  return (
    <>
      <section className="settings-section">
        <span className="settings-section-title">Default model</span>
        <div className="settings-row">
          <label htmlFor="settings-default-model">Model id</label>
          <input
            id="settings-default-model"
            type="text"
            placeholder="claude-sonnet-4-6"
            value={defaultModel ?? ''}
            onChange={(e) => onChangeFor('default', e.target.value)}
          />
          <span className="settings-row-hint">
            Used for both modes unless overridden below.
          </span>
        </div>
      </section>

      <section className="settings-section">
        <span className="settings-section-title">Per-mode override</span>
        <div className="settings-row">
          <label htmlFor="settings-research-model">Research model</label>
          <input
            id="settings-research-model"
            type="text"
            placeholder="claude-sonnet-4-6"
            value={modelByMode.research ?? ''}
            onChange={(e) => onChangeFor('research', e.target.value)}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="settings-strategy-model">Strategy model</label>
          <input
            id="settings-strategy-model"
            type="text"
            placeholder="claude-opus-4-7"
            value={modelByMode.strategy ?? ''}
            onChange={(e) => onChangeFor('strategy', e.target.value)}
          />
        </div>
        <div className="settings-row-inline">
          <button
            type="button"
            className="settings-btn"
            disabled
            title="Coming in P8"
          >
            Auto-discover models
          </button>
          <span className="settings-row-hint">Coming in P8.</span>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tools & Permissions tab
// ---------------------------------------------------------------------------

function ToolsTab(): JSX.Element {
  const allowedToolsByMode = useSettingsStore((s) => s.allowedToolsByMode);
  const disallowedToolsByMode = useSettingsStore((s) => s.disallowedToolsByMode);
  const setAllowedTools = useSettingsStore((s) => s.setAllowedTools);
  const setDisallowedTools = useSettingsStore((s) => s.setDisallowedTools);
  const permissionModeByMode = useSettingsStore((s) => s.permissionModeByMode);
  const setPermissionMode = useSettingsStore((s) => s.setPermissionMode);
  const settingsSeededV1 = useSettingsStore((s) => s.settingsSeededV1);
  const setSettingsSeededV1 = useSettingsStore((s) => s.setSettingsSeededV1);

  // Late-seed safety net — first-render fallback if hydrate.ts didn't run
  // (e.g. browser-only mode where Tauri's `db_app_state_get` rejects). The
  // gate is the same persistence flag, so this is idempotent across reloads.
  // W2-C extends this with discovered MCP/Skill tools.
  useEffect(() => {
    if (settingsSeededV1) return;
    const allEmpty =
      allowedToolsByMode.research.length === 0 &&
      allowedToolsByMode.strategy.length === 0 &&
      disallowedToolsByMode.research.length === 0 &&
      disallowedToolsByMode.strategy.length === 0;
    if (!allEmpty) {
      // Some prior state already exists — flip the flag and don't overwrite.
      setSettingsSeededV1(true);
      return;
    }
    setAllowedTools('research', ['Read', 'Glob', 'Grep', 'WebFetch', 'fetch_ohlc', 'compute_indicator', 'return_dataset']);
    setAllowedTools('strategy', ['Read', 'Glob', 'Grep', 'WebFetch', 'fetch_ohlc', 'compute_indicator', 'validate_strategy', 'backtest_strategy', 'return_strategy']);
    setDisallowedTools('research', ['Bash', 'Edit', 'Write']);
    setDisallowedTools('strategy', ['Bash', 'Edit', 'Write']);
    setSettingsSeededV1(true);
  }, [
    settingsSeededV1,
    allowedToolsByMode,
    disallowedToolsByMode,
    setAllowedTools,
    setDisallowedTools,
    setSettingsSeededV1,
  ]);

  return (
    <>
      <ModeToolsSection
        mode="research"
        allowed={allowedToolsByMode.research}
        disallowed={disallowedToolsByMode.research}
        permissionMode={permissionModeByMode.research}
        onAllowedChange={(v) => setAllowedTools('research', v)}
        onDisallowedChange={(v) => setDisallowedTools('research', v)}
        onPermissionChange={(v) => setPermissionMode('research', v)}
      />
      <ModeToolsSection
        mode="strategy"
        allowed={allowedToolsByMode.strategy}
        disallowed={disallowedToolsByMode.strategy}
        permissionMode={permissionModeByMode.strategy}
        onAllowedChange={(v) => setAllowedTools('strategy', v)}
        onDisallowedChange={(v) => setDisallowedTools('strategy', v)}
        onPermissionChange={(v) => setPermissionMode('strategy', v)}
      />

      <section className="settings-section">
        <span className="settings-row-hint">
          (More tools from MCP / Skills load when those tabs are configured.)
        </span>
      </section>

      <section className="settings-section">
        <span className="settings-section-title">Subagents</span>
        <SubagentsList />
      </section>
    </>
  );
}

function SubagentsList(): JSX.Element {
  const profile = useProfilePaths();
  const agentsPath = profile?.agents ?? '<claude-home>/agents/';
  const [agents, setAgents] = useState<SubagentMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    subagentsList()
      .then((rows) => {
        if (!cancelled) setAgents(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(extractError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="settings-row-hint">
        Discovery failed: {error}. Subagent files live under <code>{agentsPath}</code>.
      </div>
    );
  }
  if (agents === null) return <div className="settings-row-hint">Loading subagents…</div>;
  if (agents.length === 0) {
    return (
      <div className="settings-row-hint">
        No subagents found. Drop <code>*.md</code> files with YAML frontmatter into{' '}
        <code>{agentsPath}</code> to register custom agents.
      </div>
    );
  }
  return (
    <ul className="settings-list">
      {agents.map((a) => (
        <li key={a.path} className="settings-list-row">
          <span className="settings-list-name">{a.name}</span>
          {a.description && <span className="settings-list-desc">{a.description}</span>}
          <span className="settings-row-hint" style={{ marginLeft: 'auto' }}>
            {a.source}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface ModeToolsSectionProps {
  mode: Mode;
  allowed: string[];
  disallowed: string[];
  permissionMode: PermissionMode;
  onAllowedChange: (v: string[]) => void;
  onDisallowedChange: (v: string[]) => void;
  onPermissionChange: (v: PermissionMode) => void;
}

function ModeToolsSection({
  mode,
  allowed,
  disallowed,
  permissionMode,
  onAllowedChange,
  onDisallowedChange,
  onPermissionChange,
}: ModeToolsSectionProps): JSX.Element {
  const allowedSet = useMemo(() => new Set(allowed), [allowed]);
  const disallowedSet = useMemo(() => new Set(disallowed), [disallowed]);

  const toggle = (column: 'allowed' | 'disallowed', tool: string) => {
    if (column === 'allowed') {
      const next = allowedSet.has(tool)
        ? allowed.filter((t) => t !== tool)
        : [...allowed, tool];
      onAllowedChange(next);
    } else {
      const next = disallowedSet.has(tool)
        ? disallowed.filter((t) => t !== tool)
        : [...disallowed, tool];
      onDisallowedChange(next);
    }
  };

  const title = mode === 'research' ? 'Research mode' : 'Strategy mode';

  return (
    <section className="settings-section">
      <span className="settings-section-title">{title}</span>
      <div className="settings-row-inline">
        <label htmlFor={`settings-perm-${mode}`}>Permission mode</label>
        <select
          id={`settings-perm-${mode}`}
          value={permissionMode}
          onChange={(e) => onPermissionChange(e.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div className="settings-cols-2">
        <div className="settings-row">
          <span className="settings-row-hint">Allowed</span>
          <div className="settings-chips" role="group" aria-label={`${mode} allowed tools`}>
            {KNOWN_TOOLS.map((t) => (
              <button
                key={`${mode}-allow-${t}`}
                type="button"
                className={`settings-chip ${allowedSet.has(t) ? 'on' : ''}`}
                aria-pressed={allowedSet.has(t)}
                onClick={() => toggle('allowed', t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-hint">Disallowed</span>
          <div className="settings-chips" role="group" aria-label={`${mode} disallowed tools`}>
            {KNOWN_TOOLS.map((t) => (
              <button
                key={`${mode}-deny-${t}`}
                type="button"
                className={`settings-chip ${disallowedSet.has(t) ? 'on' : ''}`}
                aria-pressed={disallowedSet.has(t)}
                onClick={() => toggle('disallowed', t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// MCP tab (W2-B + W2-B follow-up: forms + 5s health poller)
// ---------------------------------------------------------------------------

/** Public so the MCP-form vitests can drive it without the whole panel. */
export const MCP_POLL_INTERVAL_MS = 5000;

interface McpFormState {
  expanded: boolean;
  /** When non-null we're editing the named server (replace on save). */
  editingName: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  /** Newline-separated; one arg per line. */
  argsText: string;
  /** Newline-separated `KEY=VAL` pairs. */
  envText: string;
  url: string;
  error: string | null;
}

const EMPTY_FORM: McpFormState = {
  expanded: false,
  editingName: null,
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  error: null,
};

function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseEnvText(text: string): { ok: true; env: Record<string, string> } | { ok: false; bad: string } {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const env: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) return { ok: false, bad: line };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!key) return { ok: false, bad: line };
    env[key] = value;
  }
  return { ok: true, env };
}

function formatArgs(args: string[] | undefined): string {
  return (args ?? []).join('\n');
}

function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Pure validator extracted for unit tests. Returns `{ ok: false, error }` when
 * the form would fail at save time (empty name, name-conflict against an
 * existing app row when adding new, transport-specific required fields).
 */
export function validateMcpForm(
  form: McpFormState,
  servers: ReadonlyArray<McpServer>,
): { ok: true; server: McpServer } | { ok: false; error: string; conflictName?: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };

  // Conflict only when adding a new entry — editing the same name is replace.
  if (form.editingName === null) {
    const dup = servers.find((s) => s.name === name);
    if (dup) {
      const where = dup.source === 'app'
        ? 'an existing app-managed server'
        : `a ${dup.source} server`;
      return {
        ok: false,
        error: `Name conflicts with ${where}.`,
        conflictName: dup.source === 'app' ? name : undefined,
      };
    }
  }

  if (form.transport === 'stdio') {
    const cmd = form.command.trim();
    if (!cmd) return { ok: false, error: 'Command is required for stdio.' };
    const args = parseArgsText(form.argsText);
    const envParsed = parseEnvText(form.envText);
    if (!envParsed.ok) {
      return { ok: false, error: `Bad env line: "${envParsed.bad}" — expected KEY=VAL.` };
    }
    const server: McpServer = {
      name,
      transport: 'stdio',
      command: cmd,
      args: args.length > 0 ? args : undefined,
      env: Object.keys(envParsed.env).length > 0 ? envParsed.env : undefined,
      source: 'app',
    };
    return { ok: true, server };
  }

  // http / sse
  const url = form.url.trim();
  if (!url) return { ok: false, error: 'URL is required.' };
  return {
    ok: true,
    server: {
      name,
      transport: form.transport,
      url,
      source: 'app',
    },
  };
}

function McpTab(): JSX.Element {
  const profile = useProfilePaths();
  const profileMcpPath = profile?.mcp ?? '<claude-home>/.claude.json';
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const onImport = async () => {
    setImporting(true);
    setImportStatus(null);
    try {
      const r = await mcpImportFromUserProfile();
      setImportStatus(`Imported ${r.imported}, skipped ${r.skipped}.`);
    } catch (e) {
      setImportStatus(`Import failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setImporting(false);
    }
  };
  const servers = useMcpStore((s) => s.servers);
  const setServers = useMcpStore((s) => s.setServers);
  const statuses = useMcpStore((s) => s.statuses);
  const [error, setError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormState>(EMPTY_FORM);
  const [now, setNow] = useState<number>(Date.now());
  const [removingName, setRemovingName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await mcpListMerged();
      setServers(rows);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    }
  }, [setServers]);

  useEffect(() => {
    void refresh();
    void mcpAppConfigPath().then(setConfigPath).catch(() => undefined);
  }, [refresh]);

  // ---- 5s background health poller ---------------------------------------
  // Mounts only because this component is rendered (i.e. the MCP tab is
  // active). Tearing down on unmount cancels the interval.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const list = useMcpStore.getState().servers;
      for (const srv of list) {
        try {
          const st = await mcpHealthCheck(srv);
          if (cancelled) return;
          useMcpStore.getState().setStatus(srv.name, st);
        } catch (err) {
          if (cancelled) return;
          useMcpStore.getState().setStatus(srv.name, {
            name: srv.name,
            healthy: false,
            last_checked: Date.now(),
            error: extractError(err),
          });
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), MCP_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Tick `now` every second so "checked Xs ago" stays fresh without forcing
  // a full re-poll.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const startEdit = useCallback((srv: McpServer) => {
    setForm({
      expanded: true,
      editingName: srv.name,
      name: srv.name,
      transport: srv.transport,
      command: srv.command ?? '',
      argsText: formatArgs(srv.args),
      envText: formatEnv(srv.env),
      url: srv.url ?? '',
      error: null,
    });
  }, []);

  const startEditByName = useCallback(
    (name: string) => {
      const found = servers.find((s) => s.name === name && s.source === 'app');
      if (found) startEdit(found);
    },
    [servers, startEdit],
  );

  const onSave = useCallback(async () => {
    const validated = validateMcpForm(form, servers);
    if (!validated.ok) {
      setForm((f) => ({ ...f, error: validated.error }));
      return;
    }
    try {
      await mcpAppConfigUpsert(validated.server);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      console.warn('[settings] mcpAppConfigUpsert failed', err);
      useToastStore.getState().push({
        kind: 'error',
        title: 'MCP server not saved',
        detail: 'Check the form below for the parser error',
      });
      setForm((f) => ({ ...f, error: extractError(err) }));
    }
  }, [form, servers, refresh]);

  const onRemove = useCallback(
    async (name: string) => {
      try {
        await mcpAppConfigRemove(name);
        setRemovingName(null);
        await refresh();
      } catch (err) {
        console.warn('[settings] mcpAppConfigRemove failed', err);
        useToastStore.getState().push({
          kind: 'error',
          title: 'MCP server not removed',
          detail: 'The on-disk config could not be rewritten',
        });
        setError(extractError(err));
        setRemovingName(null);
      }
    },
    [refresh],
  );

  const validation = useMemo(() => validateMcpForm(form, servers), [form, servers]);
  const conflictName = !validation.ok ? validation.conflictName : undefined;

  return (
    <>
      <section className="settings-section">
        <span className="settings-section-title">MCP servers</span>
        {error && <span className="settings-row-hint">Read failed: {error}</span>}

        <div className="settings-row-inline">
          <button
            type="button"
            className="settings-btn"
            onClick={() => void onImport().then(() => void refresh())}
            disabled={importing}
            title="One-shot READ-ONLY copy of `~/.claude.json`'s mcpServers map into the app config"
          >
            {importing ? 'Importing…' : 'Import MCP servers from main profile'}
          </button>
          {importStatus && (
            <span className="settings-row-hint">{importStatus}</span>
          )}
        </div>

        <div className={`mcp-form ${form.expanded ? 'open' : ''}`}>
          <button
            type="button"
            className="mcp-form-toggle"
            onClick={() =>
              setForm((f) =>
                f.expanded
                  ? EMPTY_FORM
                  : { ...EMPTY_FORM, expanded: true },
              )
            }
            aria-expanded={form.expanded}
          >
            <span className="mcp-form-toggle-icon" aria-hidden="true">
              {form.expanded ? '−' : '+'}
            </span>
            {form.editingName ? `Edit MCP server: ${form.editingName}` : 'Add MCP server'}
          </button>

          {form.expanded && (
            <div className="mcp-form-body">
              <div className="mcp-form-row">
                <label htmlFor="mcp-form-name">Name</label>
                <input
                  id="mcp-form-name"
                  type="text"
                  value={form.name}
                  // Editing existing row → name is the row key, lock it.
                  disabled={form.editingName !== null}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, error: null }))}
                  placeholder="e.g. brave-search"
                />
              </div>

              <div className="mcp-form-row">
                <label htmlFor="mcp-form-transport">Transport</label>
                <select
                  id="mcp-form-transport"
                  value={form.transport}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, transport: e.target.value as McpTransport, error: null }))
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </div>

              {form.transport === 'stdio' ? (
                <>
                  <div className="mcp-form-row">
                    <label htmlFor="mcp-form-command">Command</label>
                    <input
                      id="mcp-form-command"
                      type="text"
                      value={form.command}
                      onChange={(e) => setForm((f) => ({ ...f, command: e.target.value, error: null }))}
                      placeholder="npx"
                    />
                  </div>
                  <div className="mcp-form-row">
                    <label htmlFor="mcp-form-args">Args (one per line)</label>
                    <textarea
                      id="mcp-form-args"
                      rows={3}
                      value={form.argsText}
                      onChange={(e) => setForm((f) => ({ ...f, argsText: e.target.value, error: null }))}
                      placeholder={'-y\n@modelcontextprotocol/server-brave-search'}
                      style={{ fontFamily: 'monospace', fontSize: 11 }}
                    />
                  </div>
                  <div className="mcp-form-row">
                    <label htmlFor="mcp-form-env">Env (KEY=VAL per line)</label>
                    <textarea
                      id="mcp-form-env"
                      rows={3}
                      value={form.envText}
                      onChange={(e) => setForm((f) => ({ ...f, envText: e.target.value, error: null }))}
                      placeholder="BRAVE_API_KEY=..."
                      style={{ fontFamily: 'monospace', fontSize: 11 }}
                    />
                  </div>
                </>
              ) : (
                <div className="mcp-form-row">
                  <label htmlFor="mcp-form-url">URL</label>
                  <input
                    id="mcp-form-url"
                    type="text"
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value, error: null }))}
                    placeholder="https://example.com/mcp"
                  />
                </div>
              )}

              {form.error && (
                <div className="mcp-form-error" role="alert">
                  {form.error}
                  {conflictName && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="mcp-form-link"
                        onClick={() => startEditByName(conflictName)}
                      >
                        Edit existing
                      </button>
                    </>
                  )}
                </div>
              )}

              <div className="mcp-form-actions">
                <button type="button" className="settings-btn" onClick={() => void onSave()}>
                  Save
                </button>
                <button
                  type="button"
                  className="settings-btn ghost"
                  onClick={() => setForm(EMPTY_FORM)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {servers.length === 0 ? (
          <div className="settings-row-hint">
            No MCP servers configured. Use the form above, or add an entry to{' '}
            <code>{configPath ?? '<dirs::data>/autoplot/mcp.json'}</code>{' '}
            (or <code>{profileMcpPath}</code> / <code>./.mcp.json</code>).
          </div>
        ) : (
          <ul className="settings-list">
            {servers.map((srv) => {
              const st = statuses[srv.name];
              const dot = !st ? 'unknown' : st.healthy ? 'ok' : 'err';
              const ageSec = st ? Math.max(0, Math.floor((now - st.last_checked) / 1000)) : null;
              const isApp = srv.source === 'app';
              const removeArmed = removingName === srv.name;
              return (
                <li key={`${srv.source}-${srv.name}`} className="settings-list-row">
                  <span
                    className={`settings-status ${dot}`}
                    title={st && !st.healthy ? st.error ?? 'unhealthy' : undefined}
                  >
                    <span className="dot" />
                    {st ? (st.healthy ? 'healthy' : 'unhealthy') : 'unknown'}
                  </span>
                  <span className="settings-list-name">{srv.name}</span>
                  <span className="settings-row-hint">
                    {srv.transport} · {srv.source}
                    {ageSec !== null && (
                      <>
                        {' · '}
                        <span className="mcp-row-age">checked {ageSec}s ago</span>
                      </>
                    )}
                  </span>
                  <span className="mcp-row-actions" style={{ marginLeft: 'auto' }}>
                    {isApp ? (
                      <>
                        <button
                          type="button"
                          className="settings-btn ghost"
                          onClick={() => startEdit(srv)}
                          aria-label={`Edit ${srv.name}`}
                          title="Edit"
                        >
                          Edit
                        </button>
                        {removeArmed ? (
                          <>
                            <span className="mcp-row-confirm">Remove “{srv.name}”?</span>
                            <button
                              type="button"
                              className="settings-btn danger"
                              onClick={() => void onRemove(srv.name)}
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              className="settings-btn ghost"
                              onClick={() => setRemovingName(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="settings-btn ghost"
                            onClick={() => setRemovingName(srv.name)}
                            aria-label={`Remove ${srv.name}`}
                            title="Remove"
                          >
                            Remove
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="settings-btn ghost"
                          disabled
                          title={`Read-only — defined in ${srv.source} config.`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="settings-btn ghost"
                          disabled
                          title={`Read-only — defined in ${srv.source} config.`}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="settings-row-hint">
          Health re-checks every 5s while this tab is active.
        </div>
        <button type="button" className="settings-btn" onClick={() => void refresh()}>
          Refresh list
        </button>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Skills tab (W2-C)
// ---------------------------------------------------------------------------

function SkillsTab(): JSX.Element {
  const profile = useProfilePaths();
  const skillsPath = profile?.skills ?? '<claude-home>/skills';
  const disabled = useSettingsStore((s) => s.disabledSkills);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await skillsListMerged();
      setSkills(rows);
      setError(null);
    } catch (err) {
      setError(extractError(err));
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disabledSet = useMemo(() => new Set(disabled), [disabled]);

  return (
    <section className="settings-section">
      <span className="settings-section-title">Skills</span>
      {error && <span className="settings-row-hint">Discovery failed: {error}</span>}
      {!skills ? (
        <div className="settings-row-hint">Loading skills…</div>
      ) : skills.length === 0 ? (
        <div className="settings-row-hint">
          No skills found. Drop a <code>SKILL.md</code> under{' '}
          <code>{skillsPath}/&lt;name&gt;/</code> to register one.
        </div>
      ) : (
        <ul className="settings-list">
          {skills.map((sk) => {
            const enabled = !disabledSet.has(sk.name);
            return (
              <li
                key={`${sk.source}-${sk.name}`}
                className={`settings-list-row ${sk.shadowed ? 'shadowed' : ''}`}
                title={sk.shadowed ? 'Shadowed by a higher-precedence layer' : undefined}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={sk.shadowed}
                  onChange={(e) => {
                    const nextEnabled = e.target.checked;
                    void skillSetEnabled(sk.name, nextEnabled)
                      .then(() => {
                        const store = useSettingsStore.getState();
                        const current = store.disabledSkills;
                        const next = nextEnabled
                          ? current.filter((n) => n !== sk.name)
                          : Array.from(new Set([...current, sk.name]));
                        store.setDisabledSkills(next);
                      })
                      .catch((err: unknown) => {
                        console.warn('[settings] skillSetEnabled failed', err);
                        useToastStore.getState().push({
                          kind: 'error',
                          title: 'Skill toggle failed',
                          detail: `Could not change ${sk.name}`,
                        });
                      });
                  }}
                  aria-label={`Toggle skill ${sk.name}`}
                />
                <span className="settings-list-name">{sk.name}</span>
                {sk.description && <span className="settings-list-desc">{sk.description}</span>}
                <span className="settings-row-hint" style={{ marginLeft: 'auto' }}>
                  {sk.source}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="settings-btn" onClick={() => void refresh()}>
        Refresh
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Hooks tab (W2-D1)
// ---------------------------------------------------------------------------

function HooksTab(): JSX.Element {
  const auditEnabled = useSettingsStore((s) => s.auditLogEnabled);
  const setAuditEnabled = useSettingsStore((s) => s.setAuditLogEnabled);
  const [text, setText] = useState<string>('{}');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [settingsPath, setSettingsPath] = useState<string | null>(null);

  useEffect(() => {
    settingsAppGet()
      .then((v) => {
        const root = (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}) ?? {};
        const hooks = root.hooks ?? {};
        setText(JSON.stringify(hooks, null, 2));
      })
      .catch((err) => setLoadErr(extractError(err)));
    auditLogPath().then(setLogPath).catch(() => undefined);
    settingsAppPath().then(setSettingsPath).catch(() => undefined);
  }, []);

  const onSave = useCallback(async () => {
    try {
      const parsed = JSON.parse(text);
      await settingsAppSetHooks(parsed);
      setError(null);
      setSavedAt(Date.now());
    } catch (err) {
      setError(extractError(err));
    }
  }, [text]);

  return (
    <>
      <section className="settings-section">
        <span className="settings-section-title">Hooks</span>
        {loadErr && <span className="settings-row-hint">Load failed: {loadErr}</span>}
        <div className="settings-row">
          <label htmlFor="hooks-json">JSON editor</label>
          <textarea
            id="hooks-json"
            spellCheck={false}
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ fontFamily: 'monospace', minHeight: 200 }}
          />
          <span className="settings-row-hint">
            Mirrors <code>&lt;claude-home&gt;/settings.json:hooks</code> — accepts
            PreToolUse / PostToolUse / UserPromptSubmit / Stop.{' '}
            {settingsPath && <>Path: <code>{settingsPath}</code></>}
          </span>
        </div>
        <div className="settings-row-inline">
          <button type="button" className="settings-btn" onClick={() => void onSave()}>
            Save hooks
          </button>
          {savedAt && <span className="settings-status ok">Saved</span>}
          {error && (
            <span className="settings-status err" title={error}>
              {error}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <span className="settings-section-title">Audit log</span>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={auditEnabled}
            onChange={(e) => setAuditEnabled(e.target.checked)}
          />
          Append one JSONL line per AI invocation
        </label>
        {logPath && (
          <span className="settings-row-hint">
            Path: <code>{logPath}</code>
          </span>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Privacy tab (W2-G)
// ---------------------------------------------------------------------------

function PrivacyTab(): JSX.Element {
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const setPrivacyMode = useSettingsStore((s) => s.setPrivacyMode);
  const stripPiiFromLogs = useSettingsStore((s) => s.stripPiiFromLogs);
  const setStripPiiFromLogs = useSettingsStore((s) => s.setStripPiiFromLogs);
  const bypassConfirmed = useSettingsStore((s) => s.bypassConfirmed);
  const setBypassConfirmed = useSettingsStore((s) => s.setBypassConfirmed);

  return (
    <>
      <section className="settings-section">
        <span className="settings-section-title">Outgoing payload</span>
        <div className="settings-row">
          <label htmlFor="privacy-mode">Privacy mode</label>
          <select
            id="privacy-mode"
            value={privacyMode}
            onChange={(e) => setPrivacyMode(e.target.value as 'summary-only' | 'full-bars')}
          >
            <option value="summary-only">summary-only (default)</option>
            <option value="full-bars">full-bars</option>
          </select>
          <span className="settings-row-hint">
            <strong>summary-only</strong> sends a deterministic summary block (last close,
            change, overlay snapshots) instead of raw bar arrays. <strong>full-bars</strong>{' '}
            sends the full visible window — only enable for trusted local CLI use.
          </span>
        </div>
      </section>

      <section className="settings-section">
        <span className="settings-section-title">Logging</span>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={stripPiiFromLogs}
            onChange={(e) => setStripPiiFromLogs(e.target.checked)}
          />
          Strip emails / cards / inline secrets from audit-log excerpts
        </label>
        <span className="settings-row-hint">
          Best-effort regex redaction. The TS-side helper applies on the way in;{' '}
          {/* [TODO P8] Rust mirror of stripPii so plumbing-side log captures match. */}
          a parallel Rust mirror lands in P8.
        </span>
      </section>

      <section className="settings-section">
        <span className="settings-section-title">Bypass-permissions</span>
        <span className="settings-row-hint">
          The <code>bypassPermissions</code> mode shows a one-time confirmation dialog
          before its first use. Clear the confirmed flag to make the dialog appear again.
        </span>
        <div className="settings-row-inline">
          <button
            type="button"
            className="settings-btn"
            disabled={!bypassConfirmed}
            onClick={() => setBypassConfirmed(false)}
          >
            Clear bypass-confirmed flag
          </button>
          <span className="settings-row-hint">
            {bypassConfirmed ? 'Currently confirmed.' : 'Not yet confirmed.'}
          </span>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown';
  }
}
