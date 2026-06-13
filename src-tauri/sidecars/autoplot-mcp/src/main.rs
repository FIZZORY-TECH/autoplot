//! # autoplot-mcp
//!
//! Stdio MCP sidecar for the autoplot Tauri application.
//!
//! ## Startup sequence
//!
//! 1. Read `TRADING_PORTAL_MCP_TOKEN` env var.  Exit non-zero if absent.
//! 2. Read socket path from `TRADING_PORTAL_MCP_SOCKET` env var, else derive
//!    from `<dirs::data_dir>/autoplot/ipc.sock` (mirrors ipc_bridge.rs).
//! 3. Dial the bridge with a 5-second timeout.
//!    - On failure: every subsequent `tools/call` returns MCP error
//!      `app_not_running`.  The sidecar does NOT crash; `tools/list` still works.
//!    - On success: send `hello` frame with the token.
//!      - On `unauthorized` response: log to stderr and exit non-zero.
//! 4. Run the MCP server loop over stdin/stdout.
//!
//! ## Wire framing (bridge side)
//!
//! 4-byte big-endian length + UTF-8 JSON (mirrors ipc_bridge.rs).
//!
//! ## Env vars
//!
//! | Var                          | Required | Default                                            |
//! |------------------------------|----------|----------------------------------------------------|
//! | `TRADING_PORTAL_MCP_TOKEN`   | yes      | —                                                  |
//! | `TRADING_PORTAL_MCP_SOCKET`  | no       | `<data_dir>/autoplot/ipc.sock`               |

mod bridge;
mod server;
mod tools;

use anyhow::Context;
use rmcp::transport::io::stdio;
use rmcp::ServiceExt;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // -----------------------------------------------------------------------
    // 1. Read token from env.
    // -----------------------------------------------------------------------
    let token = std::env::var("TRADING_PORTAL_MCP_TOKEN").unwrap_or_else(|_| {
        // MCP requires the server to speak JSON on stdout before exiting.
        // Print a JSON-RPC error to stderr so the CLI surfaces a readable message,
        // then exit.
        eprintln!(
            "[autoplot-mcp] TRADING_PORTAL_MCP_TOKEN not set — \
             the sidecar must be launched via the app-managed mcp.json"
        );
        std::process::exit(1);
    });

    // -----------------------------------------------------------------------
    // 2. Resolve socket path.
    // -----------------------------------------------------------------------
    let sock_path = std::env::var("TRADING_PORTAL_MCP_SOCKET")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| bridge::default_socket_path());

    // -----------------------------------------------------------------------
    // 3. Attempt to connect and authenticate.
    // -----------------------------------------------------------------------
    let bridge_conn = bridge::connect_and_auth(&sock_path, &token).await;

    // bridge_conn is Ok(stream) on success, Err on failure.
    // Either way we run the MCP server — tools/call returns errors when the
    // bridge is unavailable.
    let bridge_state = match bridge_conn {
        Ok(stream) => {
            eprintln!("[autoplot-mcp] connected to bridge at {}", sock_path.display());
            bridge::BridgeState::Connected(tokio::sync::Mutex::new(stream))
        }
        Err(e) => {
            eprintln!("[autoplot-mcp] bridge unavailable ({e}); tools/call will return app_not_running");
            bridge::BridgeState::Unavailable(e.to_string())
        }
    };

    // -----------------------------------------------------------------------
    // 4. Build the MCP server and serve over stdio.
    // -----------------------------------------------------------------------
    let handler = server::TradingPortalServer::new(bridge_state, sock_path, token);

    let service = handler
        .serve(stdio())
        .await
        .context("MCP server exited with error")?;

    service.waiting().await?;
    Ok(())
}
