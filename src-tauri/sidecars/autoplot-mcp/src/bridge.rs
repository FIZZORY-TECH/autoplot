//! Bridge connection management — dials the app-side `ipc_bridge.rs` over a
//! Unix-domain socket (Unix) or named pipe (Windows), authenticates with the
//! per-launch token, and forwards JSON-RPC 2.0 call frames.
//!
//! ## Wire protocol (mirrored from ipc_bridge.rs)
//!
//! ```text
//! Frame:   [u32 big-endian length][UTF-8 JSON bytes]
//! Max:     1 MiB
//!
//! Hello:   {"jsonrpc":"2.0","method":"hello","params":{"token":"<hex>"}}
//! Reply:   {"jsonrpc":"2.0","id":0,"result":{"status":"ok"}}
//!       or {"jsonrpc":"2.0","id":0,"error":{"code":-32001,"message":"unauthorized"}}
//!
//! Request: {"jsonrpc":"2.0","id":"<uuid>","method":"<name>","params":{...}}
//! Response:{"jsonrpc":"2.0","id":"<uuid>","result":<json>}
//!       or {"jsonrpc":"2.0","id":"<uuid>","error":{"code":<int>,"message":"..."}}
//! ```

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Re-exported error codes (copies of ipc_bridge.rs constants — no import from tauri crate).
pub const ERR_UNAUTHORIZED: i32 = -32001;
pub const ERR_NOT_IMPLEMENTED: i32 = -32002;
#[allow(dead_code)]
pub const ERR_USER_DENIED: i32 = -32006;

/// Timeout for the initial dial + hello exchange.
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for each individual tool call.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Backoff delays for reconnection attempts (100ms, 500ms, 2s, then give up).
const RECONNECT_BACKOFFS: &[Duration] = &[
    Duration::from_millis(100),
    Duration::from_millis(500),
    Duration::from_secs(2),
];

// ---------------------------------------------------------------------------
// Platform stream type
// ---------------------------------------------------------------------------

#[cfg(unix)]
type BridgeStream = tokio::net::UnixStream;

#[cfg(windows)]
type BridgeStream = tokio::net::windows::named_pipe::NamedPipeClient;

// ---------------------------------------------------------------------------
// BridgeState — tracks live connection (or the reason it is absent).
// ---------------------------------------------------------------------------

/// Holds either a live authenticated socket or the reason connection failed.
pub enum BridgeState {
    /// Authenticated stream, ready for JSON-RPC calls.
    Connected(tokio::sync::Mutex<BridgeStream>),
    /// Bridge is unreachable; store the error message for MCP error replies.
    Unavailable(String),
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/// Derive the default socket path: `<data_dir>/autoplot/ipc.sock`.
/// Mirrors the path logic in `ipc_bridge.rs::start_with_config`.
pub fn default_socket_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("autoplot")
        .join("ipc.sock")
}

#[cfg(windows)]
pub fn default_pipe_name(sock_path: &std::path::Path) -> String {
    format!(
        r"\\.\pipe\autoplot-mcp-{}",
        sock_path.file_name().unwrap_or_default().to_string_lossy()
    )
}

// ---------------------------------------------------------------------------
// Frame I/O helpers
// ---------------------------------------------------------------------------

async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, payload: &[u8]) -> std::io::Result<()> {
    let len = payload.len() as u32;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await
}

async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    const MAX_FRAME: u32 = 1_048_576;
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame too large: {len} bytes (max {MAX_FRAME})"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

// ---------------------------------------------------------------------------
// connect_and_auth — public entry point
// ---------------------------------------------------------------------------

/// Dial the bridge socket and perform the hello handshake.
///
/// Returns `Ok(BridgeStream)` on success.
/// Returns `Err` with a clear message if the dial or handshake fails.
/// Exits the process non-zero if the server returns `unauthorized`.
pub async fn connect_and_auth(
    sock_path: &std::path::Path,
    token: &str,
) -> anyhow::Result<BridgeStream> {
    let stream = tokio::time::timeout(DIAL_TIMEOUT, dial_stream(sock_path))
        .await
        .map_err(|_| anyhow::anyhow!("dial timed out after 5s (app not running?)"))?
        .map_err(|e| anyhow::anyhow!("dial failed: {e}"))?;

    // Perform hello handshake.
    hello_handshake(stream, token).await
}

#[cfg(unix)]
async fn dial_stream(sock_path: &std::path::Path) -> std::io::Result<BridgeStream> {
    tokio::net::UnixStream::connect(sock_path).await
}

#[cfg(windows)]
async fn dial_stream(sock_path: &std::path::Path) -> std::io::Result<BridgeStream> {
    let pipe_name = default_pipe_name(sock_path);
    tokio::net::windows::named_pipe::ClientOptions::new().open(&pipe_name)
}

async fn hello_handshake(mut stream: BridgeStream, token: &str) -> anyhow::Result<BridgeStream> {
    let hello = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "hello",
        "params": { "token": token }
    });

    write_frame(&mut stream, hello.to_string().as_bytes()).await?;

    let raw = read_frame(&mut stream)
        .await?
        .ok_or_else(|| anyhow::anyhow!("bridge closed before hello reply"))?;

    let resp: Value = serde_json::from_slice(&raw)
        .map_err(|e| anyhow::anyhow!("hello reply parse error: {e}"))?;

    if let Some(err) = resp.get("error") {
        let code = err
            .get("code")
            .and_then(|c| c.as_i64())
            .unwrap_or(0) as i32;
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");

        if code == ERR_UNAUTHORIZED {
            eprintln!("[autoplot-mcp] bridge rejected token: unauthorized — exiting");
            std::process::exit(1);
        }
        return Err(anyhow::anyhow!("hello failed: code={code} msg={msg}"));
    }

    Ok(stream)
}

// ---------------------------------------------------------------------------
// call — send one JSON-RPC request and await the response.
// ---------------------------------------------------------------------------

/// The result of a bridge call: either a JSON value or a (code, message) error.
#[derive(Debug)]
pub enum CallResult {
    Ok(Value),
    Err { code: i32, message: String },
}

impl CallResult {
    pub fn app_not_running(reason: &str) -> Self {
        Self::Err {
            code: -32000, // app_not_running sentinel
            message: format!("app_not_running: {reason}"),
        }
    }
}

/// Make a single JSON-RPC call over the bridge stream.
///
/// The stream must be locked by the caller.
pub async fn call_rpc(
    stream: &mut BridgeStream,
    method: &str,
    params: Value,
) -> CallResult {
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });

    // Write request.
    if let Err(e) = write_frame(stream, request.to_string().as_bytes()).await {
        return CallResult::app_not_running(&format!("write failed: {e}"));
    }

    // Read response with timeout.
    let read_fut = read_frame(stream);
    let raw = match tokio::time::timeout(CALL_TIMEOUT, read_fut).await {
        Ok(Ok(Some(b))) => b,
        Ok(Ok(None)) => {
            return CallResult::app_not_running("bridge closed mid-call");
        }
        Ok(Err(e)) => {
            return CallResult::app_not_running(&format!("read failed: {e}"));
        }
        Err(_) => {
            return CallResult::Err {
                code: -32004,
                message: format!("call timed out after 30s ({method})"),
            };
        }
    };

    // Parse response.
    let resp: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => {
            return CallResult::Err {
                code: -32005,
                message: format!("response parse error: {e}"),
            };
        }
    };

    if let Some(err) = resp.get("error") {
        let code = err
            .get("code")
            .and_then(|c| c.as_i64())
            .unwrap_or(-32005) as i32;
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();
        CallResult::Err { code, message }
    } else {
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        CallResult::Ok(result)
    }
}

// ---------------------------------------------------------------------------
// reconnect_call — call with one reconnect attempt on IO failure.
// ---------------------------------------------------------------------------

/// Attempt the call; if the stream appears broken, try to reconnect once with
/// backoff.  If reconnect succeeds, update the `BridgeState` in-place.
///
/// Returns the `CallResult` from the successful (or final-failed) attempt.
pub async fn reconnect_call(
    state: &BridgeState,
    sock_path: &std::path::Path,
    token: &str,
    method: &str,
    params: Value,
) -> CallResult {
    match state {
        BridgeState::Unavailable(reason) => {
            CallResult::app_not_running(reason)
        }
        BridgeState::Connected(mutex) => {
            let mut stream = mutex.lock().await;
            let result = call_rpc(&mut stream, method, params.clone()).await;
            match &result {
                CallResult::Err { message, .. }
                    if message.contains("app_not_running") || message.contains("write failed") =>
                {
                    // Try to reconnect with backoff.
                    for delay in RECONNECT_BACKOFFS {
                        tokio::time::sleep(*delay).await;
                        match connect_and_auth(sock_path, token).await {
                            Ok(new_stream) => {
                                *stream = new_stream;
                                // Retry call once on new stream.
                                return call_rpc(&mut stream, method, params).await;
                            }
                            Err(_) => continue,
                        }
                    }
                    // All reconnect attempts exhausted.
                    CallResult::app_not_running("reconnect exhausted")
                }
                _ => result,
            }
        }
    }
}
