# Credential storage

*(Formerly "macOS Dev Code-Signing". The OS-keychain + dev-codesigning apparatus was removed; provider credentials now live in a single portable plaintext JSON file.)*

How the app stores and reads market-data provider credentials (currently Alpaca key ID + secret). Research / paper-trading only.

## Where credentials live

A single plaintext JSON file:

```
<OS data dir>/autoplot/credentials.json
```

`<OS data dir>` is `dirs::data_dir()` — on macOS that is `~/Library/Application Support/`, so the file resolves to:

```
~/Library/Application Support/autoplot/credentials.json
```

This is the same `autoplot` data root the Claude profile and `mcp.json` use (resolved via `profile::data_root()`), and is intentionally a different root than the SQLite DB's Tauri `app_data_dir()`.

The file is a flat JSON object mapping `{provider}.key_id` / `{provider}.secret` → value, e.g.:

```json
{ "alpaca.key_id": "…", "alpaca.secret": "…" }
```

On write, the parent dir is created if missing and, **on Unix, the file is chmod'd to `0o600`** (owner read/write only).

## Lookup precedence

Reads resolve in this order (highest wins):

1. **Environment variables** — `ALPACA_KEY_ID` *and* `ALPACA_SECRET_KEY` (generally `{PROVIDER}_KEY_ID` / `{PROVIDER}_SECRET_KEY`, uppercased provider name). **Both halves are required**; setting only one falls through.
2. **`credentials.json`** — written by the Alpaca Settings modal (`set_provider_credentials`).
3. **`None`** — the caller falls back to the mock provider.

The env-var override is the way to run with credentials without persisting them to disk (CI, ephemeral shells, throwaway containers).

## Security posture

This is **dev / paper-grade** storage for a research-only app that never places real orders:

- Plaintext at rest — **no encryption, no key file**. The threat model relies on the OS user-profile directory's filesystem permissions/ACL.
- Store **paper-trading Alpaca credentials only** — never a live-funded key.
- The secret is never returned to the frontend after writing and is never logged (enforced by a source-level test in `credentials.rs`). The `key_id` is treated as non-sensitive and may be shown in the UI.

### Windows caveat

The `0o600` permission tightening is **Unix-only**; on Windows it is a no-op and the file inherits the user-profile directory ACL. This is a documented limitation, acceptable for paper-trading dev use.

## Upgrading from the old keychain build

There is **no automated migration**. Earlier builds stored Alpaca credentials in the macOS login keychain (and, briefly, a dedicated dev keychain). Those entries are not read anymore. After upgrading, **re-enter your paper Alpaca key and secret once** in the app's **Alpaca Settings** modal; a startup log line points you there. The old keychain items can be left in place or deleted manually — the app no longer touches them.

## Running dev

`npm run tauri:dev` is now plain `tauri dev` — no `--runner`, no codesigning step, no keychain setup, no `TRADING_PORTAL_DEV_KEYCHAIN*` env vars. Just run it and enter credentials in the modal (or export the env vars above).
