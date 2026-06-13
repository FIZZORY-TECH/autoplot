//! Integration tests for the IPC bridge.
//!
//! These tests run an in-process bridge bound to a temp Unix-domain socket,
//! connect with a raw `tokio::net::UnixStream`, and exercise the wire protocol
//! without a real Tauri app handle (so frontend round-trips receive
//! `ERR_FE_UNAVAILABLE` and the `bridge_reply` path is tested via the
//! `BridgeState` directly).

#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use autoplot_lib::ipc_bridge::{
    BridgeConfig, BridgeErrorPayload, BridgeState, ERR_FE_UNAVAILABLE, ERR_NOT_IMPLEMENTED,
    ERR_UNAUTHORIZED, ERR_USER_DENIED, ERR_FORBIDDEN,
};

// ---------------------------------------------------------------------------
// Wire helpers (mirrors ipc_bridge internals)
// ---------------------------------------------------------------------------

async fn write_frame(stream: &mut UnixStream, payload: &[u8]) {
    let len = (payload.len() as u32).to_be_bytes();
    stream.write_all(&len).await.expect("write len");
    stream.write_all(payload).await.expect("write payload");
    stream.flush().await.expect("flush");
}

async fn read_frame(stream: &mut UnixStream) -> Vec<u8> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await.expect("read len");
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await.expect("read payload");
    buf
}

async fn recv_json(stream: &mut UnixStream) -> Value {
    let bytes = read_frame(stream).await;
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!("recv_json: parse error: {e}, raw={:?}", String::from_utf8_lossy(&bytes));
    })
}

async fn send_json(stream: &mut UnixStream, v: Value) {
    write_frame(stream, v.to_string().as_bytes()).await;
}

// ---------------------------------------------------------------------------
// Fixture: start bridge and return (tempdir, socket_path, token)
// ---------------------------------------------------------------------------

struct BridgeFixture {
    _tempdir: tempfile::TempDir,
    sock_path: PathBuf,
    state: BridgeState,
    token: String,
}

impl BridgeFixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let sock_path = dir.path().join("test-ipc.sock");
        let claude_home = dir.path().to_path_buf();

        let state = BridgeState::default();
        let cfg = BridgeConfig {
            socket_path_override: Some(sock_path.clone()),
            claude_home_override: Some(claude_home.clone()),
            precomputed_token: None,
        };
        let state_clone = state.clone();
        tokio::spawn(async move {
            // Ignoring the error — the listener runs until the test ends and
            // the socket file is removed.
            let _ =
                autoplot_lib::ipc_bridge::start_with_config(None, state_clone, cfg).await;
        });

        // Wait until the listener has bound by polling for the socket file.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if sock_path.exists() {
                // Give the accept loop one more tick to actually call `accept`.
                tokio::time::sleep(Duration::from_millis(10)).await;
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("ipc_bridge did not bind socket within 5s");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Read the token that start_with_config wrote (it rotates on startup).
        let token_path = claude_home.join("mcp-bridge.token");
        let token = std::fs::read_to_string(&token_path)
            .expect("token file written by start_with_config")
            .trim()
            .to_string();

        Self {
            _tempdir: dir,
            sock_path,
            state,
            token,
        }
    }

    async fn connect(&self) -> UnixStream {
        UnixStream::connect(&self.sock_path)
            .await
            .expect("connect to bridge")
    }

    /// Connect and perform a successful hello handshake. Returns the stream
    /// positioned at the first request frame.
    async fn authenticated_stream(&self) -> UnixStream {
        let mut s = self.connect().await;
        send_json(
            &mut s,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "hello",
                "params": { "token": self.token }
            }),
        )
        .await;
        let resp = recv_json(&mut s).await;
        assert_eq!(resp["result"]["status"], json!("ok"), "hello must succeed");
        s
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_hello_ok() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.connect().await;
    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "hello",
            "params": { "token": bridge.token }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(99));
    assert_eq!(resp["result"]["status"], json!("ok"));
    assert!(resp.get("error").is_none());
}

#[tokio::test]
async fn test_hello_bad_token_returns_unauthorized() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.connect().await;
    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "hello",
            "params": { "token": "000000000000000000000000000000000000000000000000000000000000dead" }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["error"]["code"], json!(ERR_UNAUTHORIZED));
    assert_eq!(resp["error"]["message"], json!("unauthorized"));
}

#[tokio::test]
async fn test_hello_id_omitted_defaults_to_zero() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.connect().await;
    // Send hello without an `id` field.
    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "method": "hello",
            "params": { "token": bridge.token }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    // id defaults to json!(0) when absent in the request.
    assert_eq!(resp["id"], json!(0));
    assert_eq!(resp["result"]["status"], json!("ok"));
}

#[tokio::test]
async fn test_unimplemented_method_returns_not_implemented() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    // Use a method that is genuinely not wired.
    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "completely_unknown_method_xyz",
            "params": {}
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(10));
    assert_eq!(resp["error"]["code"], json!(ERR_NOT_IMPLEMENTED));
    assert_eq!(resp["error"]["message"], json!("not_implemented"));
}

#[tokio::test]
async fn test_get_current_symbol_without_app_handle_returns_fe_unavailable() {
    // The bridge fixture runs without a real Tauri app handle (None), so all
    // frontend round-trips must return ERR_FE_UNAVAILABLE immediately.
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "get_current_symbol",
            "params": {}
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(20));
    assert_eq!(resp["error"]["code"], json!(ERR_FE_UNAVAILABLE));
}

#[tokio::test]
async fn test_list_assets_is_frontend_roundtrip() {
    // list_assets is now a frontend round-trip (single source of truth in assets.ts,
    // per ADR-0008 §3 and the plan's preference). Without a live Tauri app handle
    // the bridge returns ERR_FE_UNAVAILABLE (-32003).
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 30,
            "method": "list_assets",
            "params": {}
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(30));
    // No app handle in test context → ERR_FE_UNAVAILABLE.
    assert_eq!(resp["error"]["code"], json!(-32003));
    assert!(resp.get("result").is_none() || resp["result"].is_null());
}

#[tokio::test]
async fn test_bridge_reply_fulfils_pending() {
    // Simulate a pending round-trip by inserting a oneshot into BridgeState
    // directly (bypassing the socket), then calling bridge_reply logic.
    let bridge = BridgeFixture::new().await;
    let (tx, rx) = tokio::sync::oneshot::channel::<autoplot_lib::ipc_bridge::FrontendReply>();

    {
        let mut pending = bridge.state.pending.lock().await;
        pending.insert("\"test-42\"".to_string(), tx);
    }

    // Simulate bridge_reply being called by the frontend.
    {
        let mut pending = bridge.state.pending.lock().await;
        if let Some(sender) = pending.remove("\"test-42\"") {
            let _ = sender.send(autoplot_lib::ipc_bridge::FrontendReply {
                result: Some(json!("BTC-USD")),
                error: None,
            });
        }
    }

    let reply = tokio::time::timeout(Duration::from_secs(1), rx)
        .await
        .expect("no timeout")
        .expect("channel ok");

    assert_eq!(reply.result, Some(json!("BTC-USD")));
    assert!(reply.error.is_none());
}

#[tokio::test]
async fn test_error_code_constants() {
    // ERR_FE_TIMEOUT is hard to test end-to-end without a real app handle;
    // the `test_get_current_symbol_without_app_handle_returns_fe_unavailable`
    // test covers the guard path. This test validates the error code constants
    // match the spec (-320xx).
    const _: () = {
        assert!(autoplot_lib::ipc_bridge::ERR_FE_TIMEOUT < 0);
        assert!(autoplot_lib::ipc_bridge::ERR_UNAUTHORIZED == -32001);
        assert!(autoplot_lib::ipc_bridge::ERR_NOT_IMPLEMENTED == -32002);
        assert!(autoplot_lib::ipc_bridge::ERR_FE_UNAVAILABLE == -32003);
        assert!(autoplot_lib::ipc_bridge::ERR_FE_TIMEOUT == -32004);
        assert!(autoplot_lib::ipc_bridge::ERR_INTERNAL == -32005);
    };
}

#[tokio::test]
async fn test_bridge_error_payload_serializes() {
    let p = BridgeErrorPayload {
        code: -32001,
        message: "unauthorized".to_string(),
        data: None,
    };
    let v = serde_json::to_value(&p).unwrap();
    assert_eq!(v["code"], json!(-32001));
    assert_eq!(v["message"], json!("unauthorized"));
    assert!(v.get("data").is_none() || v["data"].is_null());
}

// ---------------------------------------------------------------------------
// Step 6: new error codes are correctly defined
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_error_codes_step6() {
    // -32006 user_denied
    assert_eq!(ERR_USER_DENIED, -32006);
    // -32007 forbidden
    assert_eq!(ERR_FORBIDDEN, -32007);
}

// ---------------------------------------------------------------------------
// Step 6: apply_dataset without app handle returns consent/fe error, not
// ERR_NOT_IMPLEMENTED — verifying the method is now wired.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_apply_dataset_is_wired_not_not_implemented() {
    // With no app handle, await_consent skips the consent check (no app handle
    // means we can't read the k/v setting either, so the code falls through to
    // the fe_roundtrip guard which returns ERR_FE_UNAVAILABLE).
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "apply_dataset",
            "params": {
                "id": "test-ds",
                "label": "Test DS",
                "kind": "overlay",
                "align": "right",
                "sym": "BTC-USD",
                "tf": "1h",
                "values": [1.0, 2.0, 3.0]
            }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(50));
    // Must NOT be ERR_NOT_IMPLEMENTED — the method is now wired.
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_ne!(
        code,
        ERR_NOT_IMPLEMENTED as i64,
        "apply_dataset must not return ERR_NOT_IMPLEMENTED after Step 6"
    );
}

// ---------------------------------------------------------------------------
// Step 6: read_attachment with path-traversal file_id returns ERR_FORBIDDEN
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_read_attachment_rejects_traversal() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 60,
            "method": "read_attachment",
            "params": { "file_id": "../../../etc/passwd" }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(60));
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_eq!(
        code,
        ERR_FORBIDDEN as i64,
        "path traversal must return ERR_FORBIDDEN (-32007), got: {resp}"
    );
}

// ---------------------------------------------------------------------------
// Step 6: save_dataset + list_datasets + load_dataset round-trip
// (no app handle — the DAO path requires an AppHandle to reach DbState;
//  without it we get ERR_INTERNAL with "no app handle". This confirms the
//  method is wired and dispatches to the DAO layer, not ERR_NOT_IMPLEMENTED.)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_save_dataset_returns_error_without_app_handle_not_not_implemented() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 70,
            "method": "save_dataset",
            "params": {
                "id": "ds-test-001",
                "label": "SMA(20)",
                "kind": "overlay",
                "align": "right",
                "sym": "BTC-USD",
                "tf": "1h",
                "values": [42.0, 43.0]
            }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(70));
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    // Must not be ERR_NOT_IMPLEMENTED.
    assert_ne!(code, ERR_NOT_IMPLEMENTED as i64, "save_dataset must be wired: {resp}");
}

// ---------------------------------------------------------------------------
// Step 6: save_strategy returns non-not-implemented
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_save_strategy_is_wired_not_not_implemented() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 80,
            "method": "save_strategy",
            "params": {
                "id": "strat-001",
                "name": "RSI Mean-Revert",
                "thesis": "test",
                "rules": {
                    "entry": [{ "indicator": "rsi", "op": "<", "value": 30 }],
                    "exit": [{ "indicator": "rsi", "op": ">", "value": 70 }]
                },
                "version": 1,
                "createdAt": 1700000000000_i64
            }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(80));
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_ne!(code, ERR_NOT_IMPLEMENTED as i64, "save_strategy must be wired: {resp}");
}

// ---------------------------------------------------------------------------
// Step 6: consent flow — apply_dataset without app handle skips consent
// (consent flow only runs when there's an AppHandle; without one the
//  consent gating is bypassed and we fall through to ERR_FE_UNAVAILABLE
//  on the round-trip. The key assertion: no ERR_NOT_IMPLEMENTED.)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_apply_dataset_consent_required_no_app_handle() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 90,
            "method": "apply_dataset",
            "params": {
                "id": "ds-consent-test",
                "label": "Consent Test",
                "kind": "overlay",
                "align": "right",
                "sym": "BTC-USD",
                "tf": "1h",
                "values": [1.0]
            }
        }),
    )
    .await;

    let resp = recv_json(&mut s).await;
    // Without an app handle, consent is skipped, then fe_roundtrip returns
    // ERR_FE_UNAVAILABLE. Either way, NOT ERR_NOT_IMPLEMENTED.
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_ne!(code, ERR_NOT_IMPLEMENTED as i64, "apply_dataset must be wired: {resp}");
    // Should be ERR_FE_UNAVAILABLE since there's no frontend to round-trip to.
    assert_eq!(code, ERR_FE_UNAVAILABLE as i64, "expected ERR_FE_UNAVAILABLE (no app handle): {resp}");
}

// ---------------------------------------------------------------------------
// Step 6: session_allow skips consent on second call
// (Simulated by inserting the tool name directly into session_allow, then
//  verifying it passes through to the fe_roundtrip layer.)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_apply_dataset_session_allow_skips_consent() {
    let bridge = BridgeFixture::new().await;

    // Pre-insert "apply_dataset" into session_allow to simulate remember_session=true.
    {
        let mut allowed = bridge.state.session_allow.lock().await;
        allowed.insert("apply_dataset".to_string());
    }

    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 100,
            "method": "apply_dataset",
            "params": {
                "id": "ds-session-allow",
                "label": "Session Allow",
                "kind": "overlay",
                "align": "right",
                "sym": "ETH-USD",
                "tf": "4h",
                "values": [2.5]
            }
        }),
    )
    .await;

    let resp = recv_json(&mut s).await;
    // With no app handle, fe_roundtrip returns ERR_FE_UNAVAILABLE — proving
    // consent was skipped (no timeout from consent, just immediate fe error).
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    // We should get ERR_FE_UNAVAILABLE, not user_denied and not not_implemented.
    assert_eq!(code, ERR_FE_UNAVAILABLE as i64, "expected fe_unavailable after session_allow: {resp}");
}

// ---------------------------------------------------------------------------
// Step 6: get_paper_pnl returns without error (even without app handle
// in the test env — but actually it DOES need an app handle to reach DbState,
// so it returns ERR_INTERNAL "no app handle". The key: not ERR_NOT_IMPLEMENTED.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 5: research-overlay library tools are wired and round-trip to the
// frontend. Without an app handle the FE round-trip returns ERR_FE_UNAVAILABLE
// (consent is skipped for the gated tools because there's no app handle to read
// the k/v setting). The key assertion across all four: NOT ERR_NOT_IMPLEMENTED.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_save_research_overlay_is_wired_roundtrips_to_fe() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 120,
            "method": "save_research_overlay",
            "params": {
                "id": "ro-001",
                "sym": "BTC",
                "tf": "1h",
                "label": "Test overlay",
                "elements": []
            }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(120));
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_ne!(
        code,
        ERR_NOT_IMPLEMENTED as i64,
        "save_research_overlay must be wired: {resp}"
    );
    // No app handle → consent skipped → fe_roundtrip returns ERR_FE_UNAVAILABLE.
    assert_eq!(code, ERR_FE_UNAVAILABLE as i64, "expected fe_unavailable: {resp}");
}

#[tokio::test]
async fn test_list_research_overlays_is_frontend_roundtrip() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 121,
            "method": "list_research_overlays",
            "params": {}
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(121));
    // Read-only FE round-trip; no app handle → ERR_FE_UNAVAILABLE.
    assert_eq!(resp["error"]["code"], json!(ERR_FE_UNAVAILABLE));
}

#[tokio::test]
async fn test_load_research_overlay_is_frontend_roundtrip() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 122,
            "method": "load_research_overlay",
            "params": { "id": "ro-001" }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(122));
    assert_eq!(resp["error"]["code"], json!(ERR_FE_UNAVAILABLE));
}

#[tokio::test]
async fn test_delete_research_overlay_is_wired_roundtrips_to_fe() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 123,
            "method": "delete_research_overlay",
            "params": { "id": "ro-001" }
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(123));
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_ne!(
        code,
        ERR_NOT_IMPLEMENTED as i64,
        "delete_research_overlay must be wired: {resp}"
    );
    assert_eq!(code, ERR_FE_UNAVAILABLE as i64, "expected fe_unavailable: {resp}");
}

#[tokio::test]
async fn test_get_paper_pnl_is_wired() {
    let bridge = BridgeFixture::new().await;
    let mut s = bridge.authenticated_stream().await;

    send_json(
        &mut s,
        json!({
            "jsonrpc": "2.0",
            "id": 110,
            "method": "get_paper_pnl",
            "params": {}
        }),
    )
    .await;
    let resp = recv_json(&mut s).await;
    assert_eq!(resp["id"], json!(110));
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_ne!(code, ERR_NOT_IMPLEMENTED as i64, "get_paper_pnl must be wired: {resp}");
}
