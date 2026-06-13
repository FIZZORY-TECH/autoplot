# Windows Verification Checklist — Terminal Mode

Run on a Windows 10/11 machine after merging the Terminal-mode branch.

`dirs::data_dir()` on Windows resolves to `%APPDATA%\Roaming` (i.e.
`C:\Users\<user>\AppData\Roaming`). The app data root is therefore
`%APPDATA%\Roaming\autoplot\` and the isolated Claude profile lives at
`%APPDATA%\Roaming\autoplot\claude-home\`.
(Verified against `src-tauri/src/profile.rs` — `dirs::data_dir().join("autoplot")`.)

---

## Build

- [ ] `npm install` succeeds (no native-module rebuild errors).
- [ ] `npm run tauri:build` produces an `.msi` or `.exe` installer without
      missing-DLL errors.
- [ ] No mention of `winpty.dll` in build logs (portable-pty 0.9 uses native
      ConPTY — no winpty shim is required).
- [ ] The `autoplot-mcp` sidecar binary is included in the installer
      bundle (`tauri.conf.json` `externalBin` list).

---

## Runtime smoke

- [ ] Launch the built app.
- [ ] Click the Terminal FAB (bottom-right circle, `>_` icon) → panel opens in
      the bottom-centre slot with the Claude TUI welcome message.
- [ ] Type `claude --help` → output renders with ANSI colours (bold/dim text).
- [ ] Type a multi-line command and verify the prompt does not wrap incorrectly
      at 120 columns.
- [ ] Resize the app window by dragging: the TUI reflows to the new column
      count (PTY resize via `terminal_resize` IPC).
- [ ] `Ctrl+C` interrupts a running command (e.g. `ping 127.0.0.1 -t`).
- [ ] Close the Terminal panel via the `×` button → the child process is
      terminated. Confirm in Task Manager (Processes tab) that no orphan
      `claude.exe` remains.
- [ ] Re-open the panel → a fresh PTY session starts cleanly.

---

## Profile isolation

- [ ] After a Terminal session, inspect
      `%APPDATA%\Roaming\autoplot\claude-home\settings.json`.
      The file should exist and contain a JSON object managed by the app.
- [ ] `%USERPROFILE%\.claude\settings.json` (the user's global Claude profile)
      should be **untouched** — no timestamps or content changes.
- [ ] `%APPDATA%\Roaming\autoplot\claude-home\mcp-bridge.token` rotates
      on each app launch (each `profile_init` call regenerates it).

---

## MCP bridge

- [ ] Inside the Terminal panel, run `claude mcp list`. The `autoplot`
      server entry should appear with the full tool list
      (`list_datasets`, `list_strategies`, `list_watchlist`, `get_ohlcv`, etc.).
- [ ] In the same session, ask Claude: "list my datasets".
      Claude should call `mcp__autoplot__list_datasets` and return the
      SQLite contents (empty list on a fresh install is correct).
- [ ] Named-pipe path: on Windows the IPC socket is at
      `\\.\pipe\autoplot-ipc` (vs. a Unix domain socket on macOS/Linux).
      Confirm `ipc_bridge.rs` logs the correct path on startup (search the
      Tauri log at `%APPDATA%\Roaming\autoplot\logs\`).

---

## Known platform notes

- portable-pty 0.9 uses ConPTY, which requires **Windows 10 version 1809 or
  later**. Older Windows versions are unsupported and will fail at
  `terminal_spawn` with a ConPTY allocation error.
- Named pipes are at `\\.\pipe\autoplot-ipc` on Windows vs. a Unix
  domain socket at `<data_dir>/autoplot/ipc.sock` on Unix. Path
  resolution is encapsulated in `ipc_bridge.rs` — no hard-coded paths exist
  in the TS layer.
- ANSI colour support requires Windows Terminal or a ConPTY-aware host (the
  built-in `cmd.exe` console is **not** ConPTY-aware when launched outside
  Windows Terminal). The app spawns `claude` via portable-pty which always
  allocates a ConPTY, so ANSI sequences render correctly regardless of the
  host terminal.
