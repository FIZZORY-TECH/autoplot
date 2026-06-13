//! src-tauri/src/commands/credentials.rs — Provider credential management.
//!
//! Stores and retrieves API key/secret pairs for market data providers in a
//! single **portable plaintext JSON file** with an env-var override path.
//!
//! ## Storage location
//!   Credentials live at `data_root()/credentials.json`, which resolves to
//!   `dirs::data_dir()/autoplot/credentials.json`. This is a DIFFERENT
//!   root than the SQLite DB's Tauri `app_data_dir()`
//!   (`.../com.fizzory.autoplot/`). The split is intentional and
//!   pre-existing: the free functions here have no `AppHandle`, so they resolve
//!   the data dir directly via `profile::data_root()` (the same root the Claude
//!   profile and `mcp.json` use). This is not a bug.
//!
//! ## File format
//!   A flat JSON object mapping account string → value, e.g.:
//!     ```json
//!     { "alpaca.key_id": "...", "alpaca.secret": "..." }
//!     ```
//!   Account keys are `{provider}.key_id` and `{provider}.secret`.
//!
//! ## Security invariants
//!   - The secret is NEVER returned to the frontend after writing.
//!   - The secret is NEVER logged (not even in debug builds).
//!   - On Unix the file is chmod'd to `0o600` (owner read/write only).
//!   - The `key_id` is considered non-sensitive (it is not a secret) and IS
//!     surfaced to the UI for display purposes only.
//!   - This is plaintext at rest — no encryption, no key file. The threat model
//!     relies on the user profile directory's filesystem permissions/ACL.
//!
//! ## Credential lookup precedence (highest wins)
//!   1. Environment variables `{PROVIDER}_KEY_ID` / `{PROVIDER}_SECRET_KEY`
//!      (uppercased provider name).
//!   2. The plaintext `credentials.json` file written by
//!      `set_provider_credentials`.
//!   3. `None` — caller falls through to the mock provider.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::profile;
use crate::providers::alpaca::{default_start_iso, format_rfc3339_utc, parse_bars};

/// Path to the plaintext credential store under the `autoplot` data root.
/// `base` is that data root (e.g. `profile::data_root()`, which already owns the
/// `autoplot` segment shared with the Claude profile and `mcp.json`); the
/// file lives at `<base>/credentials.json`.
fn creds_path_at(base: &Path) -> PathBuf {
    base.join("credentials.json")
}

/// Read the whole credential map from the file at `creds_path_at(base)`.
/// Returns an empty map on ANY error (missing file, malformed JSON, etc.) so
/// callers never see garbage and never panic.
fn read_creds_map_at(base: &Path) -> BTreeMap<String, String> {
    let path = creds_path_at(base);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return BTreeMap::new(),
    };
    serde_json::from_slice::<BTreeMap<String, String>>(&bytes).unwrap_or_default()
}

/// Read a single credential `account` (e.g. `alpaca.key_id`) from the plaintext
/// file under `base`.
///
/// Returns `None` on ANY error (missing file, malformed/garbage JSON, missing
/// key, short/truncated content) so callers can fall through to the mock
/// provider. Never panics, never propagates garbage. Never logs the value.
fn read_credential_at(base: &Path, account: &str) -> Option<String> {
    read_creds_map_at(base).get(account).cloned()
}

/// Write a single credential `account` → `value` to the plaintext file under
/// `base`. Read-modify-write of the JSON object map: load the existing map,
/// upsert the one key, persist the whole map. Creates the parent dir if
/// missing (mirrors `profile.rs`). Returns an error string on failure. Never
/// logs `value`.
fn write_credential_at(base: &Path, account: &str, value: &str) -> Result<(), String> {
    let path = creds_path_at(base);

    // Create the parent dir if missing, like profile.rs does for its seeded files.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create credential dir: {e}"))?;
    }

    // Read-modify-write: preserve any other accounts already present.
    let mut map = read_creds_map_at(base);
    map.insert(account.to_string(), value.to_string());

    let serialized =
        serde_json::to_vec_pretty(&map).map_err(|e| format!("serialize credentials: {e}"))?;
    std::fs::write(&path, &serialized)
        .map_err(|e| format!("write credentials.json: {e}"))?;

    // Tighten permissions to owner-only on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod credentials.json: {e}"))?;
    }
    // Windows: file-mode bits are a no-op; perms rely on the user profile dir
    // ACL (documented limitation).

    Ok(())
}

/// Read a single credential `account` (e.g. `alpaca.key_id`) from the plaintext
/// credential file under `profile::data_root()`.
///
/// Returns `None` on any error so callers can fall through to the mock
/// provider. Never logs the value.
///
/// INVARIANT: this function never logs `account` nor the returned value — no
/// `println!`/`eprintln!`/`log::`/`dbg!` of either appears in this body.
fn read_credential(account: &str) -> Option<String> {
    read_credential_at(&profile::data_root().ok()?, account)
}

/// Write a single credential `account` → `value` to the plaintext credential
/// file under `profile::data_root()`. Returns an error string on failure.
///
/// INVARIANT: this function never logs `value` — no `println!`/`eprintln!`/
/// `log::`/`dbg!` of the value appears in this body.
fn write_credential(account: &str, value: &str) -> Result<(), String> {
    write_credential_at(&profile::data_root()?, account, value)
}

/// Write a provider's API key ID and secret to the plaintext credential file.
///
/// Callable from the TS frontend via Tauri IPC. Idempotent — calling again
/// with new values overwrites the old entry.
///
/// # Security
/// - The `secret` parameter is consumed and stored; it is never echoed back.
/// - Do not add any logging that includes `secret`.
#[tauri::command]
pub fn set_provider_credentials(
    provider: String,
    key_id: String,
    secret: String,
) -> Result<(), String> {
    // Write each half to the SAME file the readback below reads. Never log the
    // values.
    let key_id_account = format!("{provider}.key_id");
    write_credential(&key_id_account, &key_id)
        .map_err(|e| format!("credential write error (key_id): {e}"))?;
    let secret_account = format!("{provider}.secret");
    write_credential(&secret_account, &secret)
        .map_err(|e| format!("credential write error (secret): {e}"))?;

    // Sanity readback: confirm BOTH halves actually persisted. If the file
    // backend silently failed to write, the read returns different/absent bytes
    // — surface a hard error rather than letting the caller proceed with phantom
    // credentials. Verifies against the same file we just wrote, via
    // `read_credential`. (Comparisons run before `secret` is dropped below.)
    for (account, expected, label) in [
        (&key_id_account, &key_id, "key_id"),
        (&secret_account, &secret, "secret"),
    ] {
        if read_credential(account).as_deref() != Some(expected.as_str()) {
            return Err(format!(
                "credential file readback mismatch ({label}) — write may have \
                 failed; credentials were not persisted to credentials.json."
            ));
        }
    }

    // Zero out the secret from the stack as soon as we're done with it.
    // Rust doesn't guarantee zeroing, but this is a best-effort measure.
    drop(secret);

    Ok(())
}

/// Retrieve a provider's `(key_id, secret)` pair using the lookup precedence:
/// env var → plaintext file → `None`.
///
/// This is an internal helper — it is NOT exposed as a Tauri command because
/// doing so would allow the frontend to read back the secret.
///
/// # Security
/// - Never log the returned secret value.
/// - The caller (e.g. `AlpacaProvider::new`) stores the credentials in memory
///   for the lifetime of the provider struct; they are not persisted anywhere
///   beyond the credential file.
pub fn get_provider_credentials(provider: &str) -> Option<(String, String)> {
    let upper = provider.to_uppercase();

    // 1. Environment variable override — highest precedence.
    //    Expected env vars: `{PROVIDER}_KEY_ID` and `{PROVIDER}_SECRET_KEY`
    //    e.g. ALPACA_KEY_ID and ALPACA_SECRET_KEY
    //    Partial env (only one half) does NOT win — both halves are required;
    //    otherwise we fall through to the file.
    let env_key_id = std::env::var(format!("{upper}_KEY_ID")).ok();
    let env_secret = std::env::var(format!("{upper}_SECRET_KEY")).ok();

    if let (Some(kid), Some(sec)) = (env_key_id, env_secret) {
        return Some((kid, sec));
    }

    // 2. Plaintext credential file — load the map ONCE (this runs on the startup
    //    adapter-registration path) and pull both halves from it. If either half
    //    is missing (unlikely but defensive), `?` yields `None` → treat as absent.
    let map = read_creds_map_at(&profile::data_root().ok()?);
    let key_id = map.get(&format!("{provider}.key_id"))?;
    let secret = map.get(&format!("{provider}.secret"))?;
    Some((key_id.clone(), secret.clone()))
}

/// Whether stored credentials exist for `provider` (env-var override or the
/// plaintext credential file). Returns only a boolean — never the secret — so
/// the frontend can decide whether to show a "Connect Alpaca" affordance
/// without a live network probe and without touching secret material. Reads the
/// same sources, in the same precedence, as [`get_provider_credentials`].
#[tauri::command]
pub fn provider_has_credentials(provider: &str) -> bool {
    get_provider_credentials(provider).is_some()
}

// ---------------------------------------------------------------------------
// Alpaca credentials probe
// ---------------------------------------------------------------------------
//
// `probe_alpaca_credentials` is the second half of the credentials lifecycle:
// after `set_provider_credentials` writes to the credential file, the UI calls
// this command to verify that the keys ACTUALLY authenticate against Alpaca's
// market-data API. The result is a tagged union so the React modal can render
// a precise next-step message (auth vs. no-market-data vs. network).
//
// Why a separate REST call (not a `MarketDataProvider::fetch_history` call)?
//   - The probe needs to surface auth/no-market-data/network distinctions
//     directly, BEFORE the registry has been reloaded. Going through the
//     provider abstraction would lose those distinctions in the error
//     conversion.
//   - We always probe a known-liquid symbol (AAPL) with a generous `start`
//     window, so a no-data reply unambiguously means "subscription doesn't
//     permit market data" — not "weekend, no trades".

/// Tagged union returned by `probe_alpaca_credentials`. Snake-case fields
/// match the TS contract in `AlpacaCredentialsModal.tsx`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ProbeResponse {
    Ok {
        ok: bool,
        sample_close: f64,
        sample_symbol: String,
        fetched_at: String,
        latency_ms: u64,
    },
    Err {
        ok: bool,
        kind: ProbeErrorKind,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        http_status: Option<u16>,
    },
}

/// Reasons a probe can fail, mapped one-to-one to the React modal's error
/// branches (`auth` / `no_market_data` / `network` / `unknown`).
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ProbeErrorKind {
    Auth,
    NoMarketData,
    Network,
    Unknown,
}

/// Classify an Alpaca error response body for the probe.
///
/// The matching is pure string-contains on a lower-cased body — NEVER regex
/// over user-controlled content. Order matters: `auth` is checked first when
/// the body mentions "unauthorized"/"forbidden"/"invalid key", because a 403
/// body can contain BOTH auth and subscription language (e.g. "not authorized
/// to access the market data endpoint"). Auth intent takes precedence;
/// `no_market_data` only wins when auth signals are absent.
fn classify_probe_body(status: u16, body: &str) -> ProbeErrorKind {
    let lower = body.to_lowercase();
    let mentions_subscription =
        lower.contains("subscription does not permit") || lower.contains("market data");
    let mentions_unauthorized = lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("invalid key");

    match status {
        401 | 403 if mentions_unauthorized => ProbeErrorKind::Auth,
        403 if mentions_subscription => ProbeErrorKind::NoMarketData,
        401 => ProbeErrorKind::Auth,
        403 => ProbeErrorKind::Auth,
        _ => ProbeErrorKind::Unknown,
    }
}

/// Validate the most-recently-saved Alpaca credentials by issuing a single
/// AAPL 1Day bar request against Alpaca's market-data API.
///
/// Reads credentials via `get_provider_credentials("alpaca")` (env → file).
/// Times the round-trip and surfaces the latency to the UI. The response is a
/// tagged union — see `ProbeResponse` above and the TS counterpart in
/// `AlpacaCredentialsModal.tsx`.
///
/// Never logs the secret. Returns within ~10s (reqwest timeout).
#[tauri::command]
pub async fn probe_alpaca_credentials() -> Result<ProbeResponse, String> {
    // Pull the credentials we just wrote. If they aren't there, the modal
    // logic shouldn't have called us — surface a structured Unknown error
    // rather than panic.
    let (key_id, secret) = match get_provider_credentials("alpaca") {
        Some(pair) => pair,
        None => {
            return Ok(ProbeResponse::Err {
                ok: false,
                kind: ProbeErrorKind::Unknown,
                message: "no alpaca credentials found in credentials.json or env".to_string(),
                http_status: None,
            });
        }
    };

    let url = format!(
        "https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=1Day&limit=1&adjustment=raw&feed=iex&start={}",
        // Re-use the same default window the adapter uses to keep behavior
        // identical between probe and real fetches.
        default_start_iso()
    );

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(ProbeResponse::Err {
                ok: false,
                kind: ProbeErrorKind::Unknown,
                message: format!("failed to build http client: {e}"),
                http_status: None,
            });
        }
    };

    let started = std::time::Instant::now();
    let resp = client
        .get(&url)
        .header("APCA-API-KEY-ID", &key_id)
        .header("APCA-API-SECRET-KEY", &secret)
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let kind = if e.is_connect() || e.is_timeout() || e.is_request() {
                ProbeErrorKind::Network
            } else {
                ProbeErrorKind::Unknown
            };
            return Ok(ProbeResponse::Err {
                ok: false,
                kind,
                message: e.to_string(),
                http_status: None,
            });
        }
    };

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let latency_ms = started.elapsed().as_millis() as u64;

    if !(200..300).contains(&status) {
        let kind = classify_probe_body(status, &body);
        return Ok(ProbeResponse::Err {
            ok: false,
            kind,
            // Keep the first 240 chars of the body so the UI can surface a
            // hint without leaking enormous payloads. Never echo the secret.
            message: body.chars().take(240).collect(),
            http_status: Some(status),
        });
    }

    // 2xx — parse bars and pull the latest close. An empty/null bars list is
    // unusual on a 365-day window for AAPL; we treat it as `no_market_data`
    // because the IEX free tier returns null when the account has no
    // entitlement.
    match parse_bars(&body) {
        Ok(parsed) => {
            let bars = parsed.bars_slice();
            if let Some(last) = bars.last() {
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                Ok(ProbeResponse::Ok {
                    ok: true,
                    sample_close: last.c,
                    sample_symbol: "AAPL".to_string(),
                    fetched_at: format_rfc3339_utc(now_secs),
                    latency_ms,
                })
            } else {
                Ok(ProbeResponse::Err {
                    ok: false,
                    kind: ProbeErrorKind::NoMarketData,
                    message:
                        "Alpaca returned an empty bars list — Market Data is likely not enabled \
                         on this account."
                            .to_string(),
                    http_status: Some(status),
                })
            }
        }
        Err(e) => Ok(ProbeResponse::Err {
            ok: false,
            kind: ProbeErrorKind::Unknown,
            message: format!("response parse error: {e:?}"),
            http_status: Some(status),
        }),
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Probe body classifier — pure, no network
    // -----------------------------------------------------------------------

    #[test]
    fn classify_probe_body_401_unauthorized_is_auth() {
        let kind =
            classify_probe_body(401, r#"{"message":"request not authorized"}"#);
        assert!(matches!(kind, ProbeErrorKind::Auth));
    }

    #[test]
    fn classify_probe_body_403_market_data_is_no_market_data() {
        let kind = classify_probe_body(
            403,
            r#"{"message":"your subscription does not permit querying market data"}"#,
        );
        assert!(matches!(kind, ProbeErrorKind::NoMarketData));
    }

    /// A 403 body that contains BOTH auth and "market data" language must be
    /// classified as Auth (not NoMarketData) because auth takes priority in the
    /// reordered match arms.
    #[test]
    fn classify_probe_body_403_unauthorized_plus_market_data_is_auth() {
        // Body contains "unauthorized" (auth signal) AND "market data" (subscription
        // signal) — the reordered arms should fire auth first.
        let kind = classify_probe_body(
            403,
            r#"{"message":"unauthorized to access the market data endpoint"}"#,
        );
        assert!(
            matches!(kind, ProbeErrorKind::Auth),
            "Expected Auth when body contains 'unauthorized' AND 'market data'"
        );
    }

    /// Clean NoMarketData case: body mentions subscription but NOT auth keywords.
    #[test]
    fn classify_probe_body_403_subscription_only_is_no_market_data() {
        let kind = classify_probe_body(
            403,
            r#"{"message":"subscription does not permit this operation"}"#,
        );
        assert!(
            matches!(kind, ProbeErrorKind::NoMarketData),
            "Expected NoMarketData when body mentions subscription but not auth"
        );
    }

    #[test]
    fn classify_probe_body_403_forbidden_is_auth() {
        let kind = classify_probe_body(403, r#"{"message":"forbidden"}"#);
        assert!(matches!(kind, ProbeErrorKind::Auth));
    }

    #[test]
    fn classify_probe_body_500_is_unknown() {
        let kind = classify_probe_body(500, "internal error");
        assert!(matches!(kind, ProbeErrorKind::Unknown));
    }

    /// Env-var path: set vars, call `get_provider_credentials`, assert result,
    /// then clean up. This test never touches the credential file.
    #[test]
    fn env_var_override_takes_precedence() {
        // Use a provider name that won't collide with any real entry.
        let provider = "testprovider";
        std::env::set_var("TESTPROVIDER_KEY_ID", "test-key-id");
        std::env::set_var("TESTPROVIDER_SECRET_KEY", "test-secret");

        let result = get_provider_credentials(provider);

        // Clean up immediately before any assertion so the vars are gone even
        // if the assertion panics.
        std::env::remove_var("TESTPROVIDER_KEY_ID");
        std::env::remove_var("TESTPROVIDER_SECRET_KEY");

        let (kid, _sec) = result.expect("env vars should produce credentials");
        assert_eq!(kid, "test-key-id");
        // We don't assert on `_sec` to avoid logging it; presence is sufficient.
    }

    /// When neither env vars nor file entries exist, the function returns `None`.
    #[test]
    fn missing_credentials_returns_none() {
        // Use a name that almost certainly has no file entry.
        let result = get_provider_credentials("zz_nonexistent_provider_zz");
        assert!(result.is_none(), "unknown provider should yield None");
    }

    /// Partial env (only key_id set) — should fall through to the file, and if
    /// the file also lacks the entry, return None.
    #[test]
    fn partial_env_falls_through_to_none() {
        let provider = "partialtest";
        std::env::set_var("PARTIALTEST_KEY_ID", "only-key");
        // PARTIALTEST_SECRET_KEY deliberately not set.

        let result = get_provider_credentials(provider);
        std::env::remove_var("PARTIALTEST_KEY_ID");

        // With no file entry for this fake provider, result is None.
        assert!(
            result.is_none(),
            "partial env + no file entry should yield None"
        );
    }

    // -----------------------------------------------------------------------
    // Plaintext-file backend — cross-platform, via the `_at(base)` seam.
    // Pure file I/O: no OS keychain, no prompts.
    // -----------------------------------------------------------------------

    /// Round-trip both halves of a provider's credentials through the plaintext
    /// file under a tempdir, and confirm a missing account reads back as `None`.
    #[test]
    fn file_creds_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path();

        write_credential_at(base, "alpaca.key_id", "key-id-abc-123")
            .expect("write key_id should succeed");
        write_credential_at(base, "alpaca.secret", "secret-xyz-789")
            .expect("write secret should succeed");

        assert_eq!(
            read_credential_at(base, "alpaca.key_id").as_deref(),
            Some("key-id-abc-123"),
            "key_id should round-trip"
        );
        assert_eq!(
            read_credential_at(base, "alpaca.secret").as_deref(),
            Some("secret-xyz-789"),
            "secret should round-trip"
        );

        // A never-written account must read back as None.
        assert!(
            read_credential_at(base, "nope.key_id").is_none(),
            "missing account should yield None"
        );

        // On Unix, confirm the file is owner-only (0o600).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = creds_path_at(base);
            let mode = std::fs::metadata(&path)
                .expect("stat credentials.json")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "credentials.json should be chmod 0o600 on Unix");
        }
    }

    /// A garbage / truncated / non-JSON credential file must read back as `None`
    /// for any account, never panic.
    #[test]
    fn corrupted_or_short_file_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path();
        let path = creds_path_at(base);
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");

        // Invalid JSON: a truncated object plus stray bytes.
        std::fs::write(&path, b"{ not-json \x00\xfftruncated").expect("write garbage");

        assert!(
            read_credential_at(base, "alpaca.key_id").is_none(),
            "garbage file should yield None, not panic"
        );

        // A short/empty file is also fine.
        std::fs::write(&path, b"x").expect("write short");
        assert!(
            read_credential_at(base, "alpaca.secret").is_none(),
            "short file should yield None"
        );
    }

    /// Secret-never-logged guard. We can't easily capture stdout/stderr from a
    /// Rust unit test, so this is a SOURCE-LEVEL invariant assertion: the bodies
    /// of `read_credential`, `write_credential`, `read_credential_at`, and
    /// `write_credential_at` must not contain any `println!`/`eprintln!`/`dbg!`/
    /// `log::` macro that could leak a credential value. We assert this by
    /// scanning this very source file at test time.
    ///
    /// INVARIANT: no credential value is ever logged. See the per-function
    /// `INVARIANT:` doc comments on `read_credential` / `write_credential`.
    #[test]
    fn credential_fns_do_not_log_values() {
        let src = include_str!("credentials.rs");

        // Find the span of each credential function and assert it contains no
        // logging macro. We scope to the function names so unrelated logging
        // elsewhere in the file (e.g. probe error messages) doesn't trip this.
        for fn_name in [
            "fn read_credential(",
            "fn write_credential(",
            "fn read_credential_at(",
            "fn write_credential_at(",
        ] {
            let start = src
                .find(fn_name)
                .unwrap_or_else(|| panic!("expected to find `{fn_name}` in source"));
            // Scope the window to this function body only: from the `fn`
            // keyword to the first column-0 closing brace (`\n}`), which ends a
            // top-level fn. A fixed-size window would bleed into sibling fns or
            // this test's own `"println!"` string literals and false-positive.
            let rest = &src[start..];
            let body_end = rest
                .find("\n}")
                .map(|i| i + 2)
                .unwrap_or(rest.len());
            let window = &rest[..body_end];
            for bad in ["println!", "eprintln!", "dbg!", "log::"] {
                assert!(
                    !window.contains(bad),
                    "credential fn `{fn_name}` must not contain `{bad}` (would risk logging a value)"
                );
            }
        }
    }
}
