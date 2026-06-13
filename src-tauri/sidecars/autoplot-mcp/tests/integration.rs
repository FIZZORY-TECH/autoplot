//! Integration tests for `autoplot-mcp` sidecar.
//!
//! ## Transport framing
//!
//! rmcp (v1.6.0) uses **newline-delimited JSON** (NDJSON) over stdio:
//! one JSON object per line, each terminated with `\n`.
//! There are NO Content-Length headers — raw JSON + newline.
//!
//! ## Smoke test (no bridge needed)
//!
//! `tools_list_without_bridge` verifies that:
//! 1. The sidecar binary starts and produces a valid MCP `initialize` response.
//! 2. `tools/list` returns all seven read-only tools even when the IPC bridge
//!    is unreachable.
//!
//! ## Bridge test (optional)
//!
//! `tools_call_get_current_symbol_via_fake_bridge` spins up a fake bridge (an
//! in-process `UnixListener`) that handles the hello handshake and one
//! `get_current_symbol` request.  It then launches the sidecar binary via
//! `tokio::process::Command` and exercises `tools/call`.

#![cfg(unix)]

use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Path to the sidecar binary built by Cargo
// ---------------------------------------------------------------------------

fn sidecar_binary() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR = src-tauri/sidecars/autoplot-mcp/
    // The binary ends up at src-tauri/target/debug/autoplot-mcp.
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR not set — run via `cargo test`"),
    );

    // Walk up to find the workspace root (the dir containing [workspace] in Cargo.toml).
    let workspace_root = manifest_dir
        .ancestors()
        .find(|p| {
            p.join("Cargo.toml").exists() && {
                let content = std::fs::read_to_string(p.join("Cargo.toml")).unwrap_or_default();
                content.contains("[workspace]")
            }
        })
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| manifest_dir.clone());

    workspace_root
        .join("target")
        .join("debug")
        .join("autoplot-mcp")
}

// ---------------------------------------------------------------------------
// NDJSON I/O helpers — rmcp uses newline-delimited JSON over stdio
// ---------------------------------------------------------------------------

/// Write one MCP message to stdin as a single JSON line.
async fn write_mcp(stdin: &mut tokio::process::ChildStdin, msg: &Value) {
    let mut line = serde_json::to_string(msg).unwrap();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.expect("write stdin");
    stdin.flush().await.expect("flush stdin");
}

/// Read one MCP message from stdout (reads one non-empty line).
async fn read_mcp(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .expect("read stdout line");
        if n == 0 {
            panic!("read_mcp: EOF on sidecar stdout");
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue; // skip blank lines
        }
        return serde_json::from_str(trimmed)
            .unwrap_or_else(|e| panic!("read_mcp: parse error: {e}, raw={trimmed:?}"));
    }
}

// ---------------------------------------------------------------------------
// Smoke test — tools/list works without a live bridge
// ---------------------------------------------------------------------------

/// Verify that the sidecar serves `tools/list` with all 7 read-only tools
/// even when the IPC bridge is unreachable.
#[tokio::test]
async fn tools_list_without_bridge() {
    let binary = sidecar_binary();
    if !binary.exists() {
        eprintln!(
            "SKIP: sidecar binary not found at {} — run `cargo build -p autoplot-mcp` first",
            binary.display()
        );
        return;
    }

    // Use a path that definitely won't exist as a live socket.
    let sock_path = "/tmp/tp-mcp-test-nonexistent-99999.sock";
    let token = "0000000000000000000000000000000000000000000000000000000000000001";

    let mut child = Command::new(&binary)
        .env("TRADING_PORTAL_MCP_TOKEN", token)
        .env("TRADING_PORTAL_MCP_SOCKET", sock_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sidecar");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    // --- 1. initialize ---
    write_mcp(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0.0.1" }
            }
        }),
    )
    .await;

    let init_resp = tokio::time::timeout(Duration::from_secs(10), read_mcp(&mut reader))
        .await
        .expect("initialize response timed out");

    assert_eq!(
        init_resp["id"],
        json!(1),
        "initialize id mismatch: {init_resp}"
    );
    assert!(
        init_resp.get("result").is_some(),
        "initialize should succeed: {init_resp}"
    );

    // --- notifications/initialized ---
    write_mcp(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )
    .await;

    // --- 2. tools/list ---
    write_mcp(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }),
    )
    .await;

    let list_resp = tokio::time::timeout(Duration::from_secs(10), read_mcp(&mut reader))
        .await
        .expect("tools/list response timed out");

    assert_eq!(
        list_resp["id"],
        json!(2),
        "tools/list id mismatch: {list_resp}"
    );

    let tools = list_resp["result"]["tools"].as_array().expect("tools array");

    // Step 6: full surface is 31 tools.
    // If the binary was built before Step 6, gracefully accept the old 7-tool count.
    let tool_count = tools.len();
    assert!(
        tool_count >= 7,
        "expected at least 7 tools, got: {tool_count}"
    );

    // Verify expected tool names.
    let names: Vec<&str> = tools
        .iter()
        .map(|t| t["name"].as_str().unwrap_or(""))
        .collect();

    for expected in &[
        "fetch_ohlc",
        "compute_indicator",
        "list_assets",
        "get_current_symbol",
        "get_visible_range",
        "list_overlays",
        "read_attachment",
    ] {
        assert!(
            names.contains(expected),
            "missing tool {expected} in {names:?}"
        );
    }

    // --- Clean shutdown: close stdin (EOF) ---
    drop(stdin);

    // Give it up to 5 s to exit cleanly.
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

// ---------------------------------------------------------------------------
// Bridge integration test — fake bridge + tools/call
// ---------------------------------------------------------------------------

/// Fake bridge: accepts one connection, handles hello + get_current_symbol.
async fn spawn_fake_bridge(
    dir: &tempfile::TempDir,
    token: &str,
) -> std::path::PathBuf {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    let sock_path = dir.path().join("fake-bridge.sock");
    let listener = UnixListener::bind(&sock_path).expect("bind fake bridge");
    let token_owned = token.to_string();

    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept");

        // Read hello frame (4-byte big-endian length prefix).
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await.unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await.unwrap();
        let hello: Value = serde_json::from_slice(&body).unwrap();

        // Validate token.
        let provided = hello["params"]["token"].as_str().unwrap_or("");
        let resp = if provided == token_owned {
            json!({"jsonrpc":"2.0","id":0,"result":{"status":"ok"}})
        } else {
            json!({"jsonrpc":"2.0","id":0,"error":{"code":-32001,"message":"unauthorized"}})
        };
        let resp_bytes = resp.to_string();
        let resp_len = (resp_bytes.len() as u32).to_be_bytes();
        stream.write_all(&resp_len).await.unwrap();
        stream.write_all(resp_bytes.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();

        if provided != token_owned {
            return;
        }

        // Read one JSON-RPC request frame.
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await.unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await.unwrap();
        let req: Value = serde_json::from_slice(&body).unwrap();

        let id = req.get("id").cloned().unwrap_or(json!(null));
        let method = req["method"].as_str().unwrap_or("");

        let result_val = if method == "get_current_symbol" {
            json!("BTC-USD")
        } else {
            json!(null)
        };

        let rpc_resp = json!({ "jsonrpc":"2.0", "id": id, "result": result_val });
        let rpc_bytes = rpc_resp.to_string();
        let rpc_len = (rpc_bytes.len() as u32).to_be_bytes();
        stream.write_all(&rpc_len).await.unwrap();
        stream.write_all(rpc_bytes.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
    });

    // Give the listener a moment to bind before the sidecar connects.
    tokio::time::sleep(Duration::from_millis(30)).await;
    sock_path
}

/// Full integration: fake bridge + sidecar binary + MCP tools/call.
#[tokio::test]
async fn tools_call_get_current_symbol_via_fake_bridge() {
    let binary = sidecar_binary();
    if !binary.exists() {
        eprintln!(
            "SKIP: sidecar binary not found at {} — build first",
            binary.display()
        );
        return;
    }

    let token = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    let dir = tempfile::tempdir().expect("tempdir");
    let sock_path = spawn_fake_bridge(&dir, token).await;

    let mut child = Command::new(&binary)
        .env("TRADING_PORTAL_MCP_TOKEN", token)
        .env("TRADING_PORTAL_MCP_SOCKET", sock_path.to_str().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sidecar");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    // initialize
    write_mcp(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0.0.1" }
            }
        }),
    )
    .await;

    let _ = tokio::time::timeout(Duration::from_secs(10), read_mcp(&mut reader))
        .await
        .expect("init response");

    // notifications/initialized
    write_mcp(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;

    // tools/call get_current_symbol
    write_mcp(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "get_current_symbol",
                "arguments": {}
            }
        }),
    )
    .await;

    let call_resp = tokio::time::timeout(Duration::from_secs(15), read_mcp(&mut reader))
        .await
        .expect("tools/call response timed out");

    assert_eq!(call_resp["id"], json!(2), "call id mismatch: {call_resp}");

    // Result should have a content array containing "BTC-USD".
    let content = &call_resp["result"]["content"];
    assert!(
        content.is_array(),
        "expected content array in call result: {call_resp}"
    );
    let text = content[0]["text"].as_str().unwrap_or("");
    assert!(
        text.contains("BTC-USD"),
        "expected BTC-USD in result text, got: {text:?}"
    );

    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

// ---------------------------------------------------------------------------
// Step 6: test_tools_list_contains_full_surface
// ---------------------------------------------------------------------------

/// Assert all 31 tools are listed (full Step 6 surface).
///
/// This test is skipped when the binary pre-dates Step 6 (only 7 tools).
#[tokio::test]
async fn test_tools_list_contains_full_surface() {
    let binary = sidecar_binary();
    if !binary.exists() {
        eprintln!("SKIP: sidecar binary not found — build first");
        return;
    }

    let sock_path = "/tmp/tp-mcp-test-nonexistent-full.sock";
    let token = "0000000000000000000000000000000000000000000000000000000000000002";

    let mut child = Command::new(&binary)
        .env("TRADING_PORTAL_MCP_TOKEN", token)
        .env("TRADING_PORTAL_MCP_SOCKET", sock_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sidecar");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    write_mcp(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0.0.1" }
            }
        }),
    ).await;
    let _ = tokio::time::timeout(Duration::from_secs(10), read_mcp(&mut reader)).await.ok();

    write_mcp(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;

    write_mcp(&mut stdin, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })).await;

    let list_resp = tokio::time::timeout(Duration::from_secs(10), read_mcp(&mut reader))
        .await
        .expect("tools/list timed out");

    let tools = list_resp["result"]["tools"].as_array().expect("tools array");
    let tool_count = tools.len();

    // Step 6 adds ~24 tools on top of the 7 from Step 5; the portfolio wave
    // adds 7 more (3 read-only + 4 consent-gated mutations).
    // We assert >= 38 to allow for minor future additions.
    assert!(
        tool_count >= 38,
        "expected >= 38 tools (full Step 6 + portfolio surface), got {tool_count}. \
         If this binary was built before the portfolio tools merged, rebuild it."
    );

    let all_expected = [
        "fetch_ohlc", "compute_indicator", "list_assets", "get_current_symbol",
        "get_visible_range", "list_overlays", "read_attachment", "list_attachments",
        "apply_dataset", "remove_dataset", "apply_timeline_events", "remove_timeline_layer",
        "apply_strategy", "remove_strategy_overlay", "open_strategy_artifact",
        "save_dataset", "list_datasets", "load_dataset", "delete_dataset",
        "validate_strategy", "backtest_strategy",
        "save_strategy", "list_strategies", "load_strategy", "update_strategy", "delete_strategy",
        "save_research_note", "list_research_notes",
        "paper_open_position", "paper_close_position", "get_paper_pnl",
        "portfolio_list_holdings", "portfolio_get_summary", "portfolio_get_allocation",
        "portfolio_set_holding", "portfolio_add_lot", "portfolio_reduce_holding",
        "portfolio_remove_holding",
    ];

    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap_or("")).collect();
    for expected in &all_expected {
        assert!(names.contains(expected), "missing tool: {expected}");
    }

    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

// ---------------------------------------------------------------------------
// Step 6: test_user_denied_surfaces_as_mcp_error
// ---------------------------------------------------------------------------

/// Fake bridge that returns a user_denied error (-32006) for any call.
async fn spawn_user_denied_bridge(dir: &tempfile::TempDir, token: &str) -> std::path::PathBuf {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    let sock_path = dir.path().join("denied-bridge.sock");
    let listener = UnixListener::bind(&sock_path).expect("bind denied bridge");
    let token_owned = token.to_string();

    tokio::spawn(async move {
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };

            let token_cloned = token_owned.clone();
            tokio::spawn(async move {
                // Read + send hello.
                let mut len_buf = [0u8; 4];
                if stream.read_exact(&mut len_buf).await.is_err() { return; }
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut body = vec![0u8; len];
                if stream.read_exact(&mut body).await.is_err() { return; }
                let hello: Value = serde_json::from_slice(&body).unwrap_or(json!(null));
                let provided = hello["params"]["token"].as_str().unwrap_or("");

                let resp = if provided == token_cloned {
                    json!({"jsonrpc":"2.0","id":0,"result":{"status":"ok"}})
                } else {
                    json!({"jsonrpc":"2.0","id":0,"error":{"code":-32001,"message":"unauthorized"}})
                };
                let rb = resp.to_string();
                let rl = (rb.len() as u32).to_be_bytes();
                let _ = stream.write_all(&rl).await;
                let _ = stream.write_all(rb.as_bytes()).await;
                let _ = stream.flush().await;
                if provided != token_cloned { return; }

                // For every subsequent call, return user_denied.
                loop {
                    let mut len_buf = [0u8; 4];
                    if stream.read_exact(&mut len_buf).await.is_err() { break; }
                    let len = u32::from_be_bytes(len_buf) as usize;
                    let mut body = vec![0u8; len];
                    if stream.read_exact(&mut body).await.is_err() { break; }
                    let req: Value = serde_json::from_slice(&body).unwrap_or(json!(null));
                    let rid = req.get("id").cloned().unwrap_or(json!(null));
                    let denied = json!({
                        "jsonrpc": "2.0",
                        "id": rid,
                        "error": { "code": -32006, "message": "user_denied" }
                    });
                    let db = denied.to_string();
                    let dl = (db.len() as u32).to_be_bytes();
                    let _ = stream.write_all(&dl).await;
                    let _ = stream.write_all(db.as_bytes()).await;
                    let _ = stream.flush().await;
                }
            });
        }
    });

    tokio::time::sleep(Duration::from_millis(30)).await;
    sock_path
}

/// `user_denied` from the bridge must surface as MCP error content with the
/// canonical text "User denied this action."
#[tokio::test]
async fn test_user_denied_surfaces_as_mcp_error() {
    let binary = sidecar_binary();
    if !binary.exists() {
        eprintln!("SKIP: sidecar binary not found — build first");
        return;
    }

    let token = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    let dir = tempfile::tempdir().expect("tempdir");
    let sock_path = spawn_user_denied_bridge(&dir, token).await;

    let mut child = Command::new(&binary)
        .env("TRADING_PORTAL_MCP_TOKEN", token)
        .env("TRADING_PORTAL_MCP_SOCKET", sock_path.to_str().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sidecar");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    write_mcp(&mut stdin, &json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.0.1" }
        }
    })).await;
    let _ = tokio::time::timeout(Duration::from_secs(10), read_mcp(&mut reader)).await.ok();
    write_mcp(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;

    // Call apply_dataset — bridge will return user_denied.
    write_mcp(&mut stdin, &json!({
        "jsonrpc": "2.0", "id": 3,
        "method": "tools/call",
        "params": {
            "name": "apply_dataset",
            "arguments": {
                "id": "test-ds",
                "label": "Test",
                "kind": "overlay",
                "align": "right",
                "sym": "BTC-USD",
                "tf": "1h",
                "values": [1.0, 2.0]
            }
        }
    })).await;

    let resp = tokio::time::timeout(Duration::from_secs(15), read_mcp(&mut reader))
        .await
        .expect("call response timed out");

    // The MCP result should be a CallToolResult with isError=true and
    // content containing "User denied this action."
    let content = resp["result"]["content"].as_array();
    if let Some(content) = content {
        let text = content.iter()
            .find_map(|c| c["text"].as_str())
            .unwrap_or("");
        assert!(
            text.contains("User denied") || text.contains("user_denied"),
            "expected user_denied message in content, got: {text:?}"
        );
    } else {
        // Some MCP library versions encode this differently; accept an error field too.
        let err_msg = resp["error"]["message"].as_str().unwrap_or("");
        assert!(
            err_msg.contains("user_denied") || err_msg.contains("denied"),
            "unexpected response: {resp}"
        );
    }

    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}
