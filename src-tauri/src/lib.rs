//! autoplot — Tauri library entry point (Tauri v2)

mod ai_workspace;
mod commands;
mod db;
pub mod ipc_bridge;
mod profile;
mod providers;

use commands::terminal::{terminal_kill, terminal_resize, terminal_spawn, terminal_write, TerminalState};
use ipc_bridge::{bridge_reply, bridge_status, mcp_consent_reply, BridgeState};
use commands::db::{
    DbState,
    db_marks_delete, db_marks_insert, db_marks_list,
    db_watchlist_list, db_watchlist_add, db_watchlist_remove,
    db_watchlist_v2_list, db_watchlist_v2_add, db_watchlist_v2_remove,
    db_bars_v2_get_range, db_bars_v2_upsert,
    db_app_state_get, db_app_state_set,
    db_bars_get_range, db_bars_upsert,
    db_trends_list, db_trends_insert, db_trends_delete,
    db_datasets_list, db_datasets_upsert, db_datasets_delete,
    db_research_overlays_list, db_research_overlays_upsert, db_research_overlays_delete,
    db_strategies_list, db_strategies_upsert, db_strategies_delete,
    db_ai_sessions_list, db_ai_sessions_get, db_ai_sessions_delete,
    db_ai_strategy_get, db_ai_strategy_update_body,
    db_portfolio_list, db_portfolio_upsert, db_portfolio_add_lot,
    db_portfolio_reduce, db_portfolio_remove,
};
use commands::symbols::{
    symbol_catalog_fetch, symbol_catalog_list, symbol_catalog_search, symbol_catalog_meta,
};
use commands::market::{AppState, market_fetch_history, market_fetch_history_v2, market_fetch_latest_1m, reload_provider};
use commands::credentials::{
    get_provider_credentials, probe_alpaca_credentials, provider_has_credentials,
    set_provider_credentials,
};
use commands::mcp::{
    mcp_app_config_path, mcp_app_config_remove, mcp_app_config_upsert, mcp_emit_temp_config,
    mcp_health_check, mcp_import_from_user_profile, mcp_list_merged,
};
use profile::{
    claude_test_connection, profile_auth_status, profile_init, profile_login,
    profile_login_cancel, profile_logout, profile_paths, profile_set_api_key, LoginState,
};
use commands::settings_hooks::{
    audit_log_append, audit_log_path, settings_app_get, settings_app_path,
    settings_app_set_hooks, subagents_list,
};
use commands::skills::{
    install_app_shipped_commands, skill_set_enabled, skills_list_merged,
    slash_command_install_app_shipped, slash_commands_list_merged,
};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use providers::binance::BinanceProvider;
use providers::coinbase::CoinbaseProvider;
use providers::kraken::KrakenProvider;
use providers::alpaca::AlpacaProvider;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Open DB + run migrations before the first window appears.
        // If migrations fail we panic with a clear message (per A1).
        .setup(|app| {
            let conn = db::open_db(app.handle())
                .expect("Failed to open SQLite database");
            db::run_migrations(&conn)
                .expect("Database migration failed — cannot start app");

            let db_state: DbState = Arc::new(Mutex::new(conn));

            // Keep the legacy DbState managed so existing
            // `tauri::State<DbState>` commands (marks / watchlist / app_state)
            // continue to work unchanged.
            app.manage(db_state.clone());

            // P4.1 — bundled state for the market data layer:
            //   * the same DB handle (so warm-cache writes share the connection)
            //   * per-provider rate limiters (Binance / Coinbase / Kraken)
            //   * the provider registry (empty until P4.2/3/4 install adapters)
            let app_state = AppState::new(db_state);

            // P4.2 + P4.3 + P4.4 — register Binance, Coinbase, and Kraken REST
            // adapters. Tauri v2's `setup` callback runs *before* the Tokio
            // runtime is entered for the main task, so `Handle::current()`
            // panics with "there is no reactor running". Use
            // `tauri::async_runtime::block_on`, which routes through Tauri's
            // own managed runtime regardless of context.
            tauri::async_runtime::block_on(async {
                let mut r = app_state.registry.lock().await;
                let mut cr = app_state.catalog_registry.lock().await;

                // ADR-0009 — each provider impl carries both traits; register both
                // the typed handle (used by v2 dispatch via inherent
                // `fetch_history_pair`) and the catalog fetcher.
                let binance = Arc::new(BinanceProvider::new());
                r.register_binance(binance.clone());
                cr.register(binance);

                let coinbase = Arc::new(CoinbaseProvider::new());
                r.register_coinbase(coinbase.clone());
                cr.register(coinbase);

                let kraken = Arc::new(KrakenProvider::new());
                r.register_kraken(kraken.clone());
                cr.register(kraken);

                // Step 3 (equities) — register Alpaca if credentials are available.
                // Credential lookup: env var ALPACA_KEY_ID / ALPACA_SECRET_KEY →
                // credentials.json → None (falls through to mock in the TS layer).
                match get_provider_credentials("alpaca") {
                    Some((key_id, secret)) => {
                        let alpaca = Arc::new(AlpacaProvider::with_credentials(key_id, secret));
                        r.register_alpaca(alpaca.clone());
                        cr.register(alpaca);
                        eprintln!("[alpaca] credentials found — adapter registered");
                    }
                    None => {
                        // ADR-0009: still register a creds-less catalog fetcher so the UI
                        // gets `AuthFailed` (→ AlpacaCredentialsModal flow) rather than
                        // "fetcher not registered".
                        let alpaca = Arc::new(AlpacaProvider::with_credentials(
                            String::new(),
                            String::new(),
                        ));
                        cr.register(alpaca);
                        eprintln!("[alpaca] no credentials found — the OS keychain is no longer used; re-enter your Alpaca keys in Settings to store them in credentials.json. Adapter not registered (mock fallback active); catalog fetcher registered (will return AuthFailed)");
                    }
                }
            });

            app.manage(app_state);

            // In-app account login — single-flight slot for the
            // `claude auth login` child process so a sibling
            // `profile_login_cancel` command can kill it.
            app.manage(LoginState::new(None));

            // Step 8 — PTY terminal sessions (terminal_spawn / terminal_kill).
            // Cap at 4 concurrent sessions; each session holds a master PTY
            // handle, a sync-mutex writer, and a sync-mutex child handle.
            app.manage(TerminalState::default());

            // Wave 0 — bootstrap the isolated Claude profile under
            // `<data_dir>/autoplot/claude-home/`. Idempotent. Failure is
            // logged but non-fatal — the FirstRun gate's `profile-setup` state
            // surfaces the error path to the user and lets them retry.
            match profile::bootstrap_profile() {
                Ok(home) => {
                    eprintln!("[profile] isolated claude-home ready at {}", home.display());
                }
                Err(e) => {
                    eprintln!("[profile] bootstrap failed (will retry on demand): {e}");
                }
            }

            // Wave 0 — detect-and-warn on legacy app-config fragments. We do
            // NOT migrate, move, or delete; this is logging-only.
            profile::detect_legacy_fragments_and_warn();

            // P5 W2-C — idempotently install the four app-shipped slash
            // commands into `<dirs::data_dir>/autoplot/commands/`.
            // Failure to write is non-fatal: log + continue (the user can
            // still drop their own commands into the user / project dirs).
            if let Err(e) = install_app_shipped_commands() {
                eprintln!("[skills] install_app_shipped_commands failed: {e}");
            }

            // Step 7 — rotate MCP bridge token, upsert sidecar in mcp.json,
            // and seed profile assets.  Must run BEFORE the IPC bridge starts
            // so the token file exists when the bridge tries to authenticate
            // incoming connections.  Returns the rotated token so the bridge
            // uses the same one (single rotation per launch).
            let precomputed_token = profile::bootstrap_profile_extensions(app.handle());

            // Step 4 — IPC bridge: manage state and spawn the listener.
            // Pass the pre-computed token so the bridge doesn't rotate again.
            let bridge_state = BridgeState::default();
            app.manage(bridge_state.clone());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let cfg = ipc_bridge::BridgeConfig {
                    precomputed_token,
                    ..Default::default()
                };
                if let Err(e) = ipc_bridge::start_with_config(Some(app_handle), bridge_state, cfg).await {
                    eprintln!("[ipc_bridge] failed to start: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            db_marks_list,
            db_marks_insert,
            db_marks_delete,
            db_watchlist_list,
            db_watchlist_add,
            db_watchlist_remove,
            db_watchlist_v2_list,
            db_watchlist_v2_add,
            db_watchlist_v2_remove,
            db_bars_v2_get_range,
            db_bars_v2_upsert,
            symbol_catalog_fetch,
            symbol_catalog_list,
            symbol_catalog_search,
            symbol_catalog_meta,
            db_app_state_get,
            db_app_state_set,
            db_bars_get_range,
            db_bars_upsert,
            db_trends_list,
            db_trends_insert,
            db_trends_delete,
            db_datasets_list,
            db_datasets_upsert,
            db_datasets_delete,
            db_research_overlays_list,
            db_research_overlays_upsert,
            db_research_overlays_delete,
            db_strategies_list,
            db_strategies_upsert,
            db_strategies_delete,
            db_ai_sessions_list,
            db_ai_sessions_get,
            db_ai_sessions_delete,
            db_ai_strategy_get,
            db_ai_strategy_update_body,
            market_fetch_history,
            market_fetch_history_v2,
            market_fetch_latest_1m,
            reload_provider,
            set_provider_credentials,
            probe_alpaca_credentials,
            provider_has_credentials,
            mcp_list_merged,
            mcp_app_config_path,
            mcp_app_config_upsert,
            mcp_app_config_remove,
            mcp_health_check,
            mcp_emit_temp_config,
            mcp_import_from_user_profile,
            profile_init,
            profile_paths,
            claude_test_connection,
            profile_set_api_key,
            profile_login,
            profile_login_cancel,
            profile_logout,
            profile_auth_status,
            skills_list_merged,
            slash_commands_list_merged,
            skill_set_enabled,
            slash_command_install_app_shipped,
            settings_app_path,
            settings_app_get,
            settings_app_set_hooks,
            audit_log_append,
            audit_log_path,
            subagents_list,
            bridge_reply,
            bridge_status,
            mcp_consent_reply,
            terminal_spawn,
            terminal_kill,
            terminal_write,
            terminal_resize,
            db_portfolio_list,
            db_portfolio_upsert,
            db_portfolio_add_lot,
            db_portfolio_reduce,
            db_portfolio_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
