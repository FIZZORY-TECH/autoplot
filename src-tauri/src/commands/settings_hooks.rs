//! src-tauri/src/commands/settings_hooks.rs — App-managed settings file +
//! hooks editor + opt-in audit log + subagent discovery (P5 W2-D1).
//!
//! ## Files this module owns
//!
//!   * `<dirs::data_dir>/autoplot/settings.json` — app-managed JSON
//!     passed to `claude --settings <path>`. The Hooks tab JSON editor binds
//!     to the `hooks` key. **Concurrent-write coordination:** W2-C also
//!     writes to this file under the `disabledSkills` key. Every write here
//!     uses a read-modify-write merge so we never clobber other agents'
//!     keys — see `update_settings_json`.
//!
//!   * `<dirs::data_dir>/autoplot/logs/audit.log` — append-only JSONL
//!     audit log. Opt-in via the Hooks tab toggle (`auditLogEnabled`).
//!     Rotation is deferred per the W2-D1 spec.
//!
//! ## `--settings` merge order
//!
//! W2-D1 spec assumption (pending W2-F smoke verification): the Claude CLI
//! treats `--settings <path>` as a merge ON TOP OF the user defaults at
//! `~/.claude/settings.json`. Conflicting keys in the app-managed file
//! override the user-managed ones. If smoke testing finds the order is
//! reversed in some CLI versions, the app-managed file should still be
//! safe — `disabledSkills` and `hooks` are additive in spirit.

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// File-system helpers (private)
// ---------------------------------------------------------------------------

fn data_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "could not resolve OS data dir".to_string())?;
    let root = base.join("autoplot");
    fs::create_dir_all(&root).map_err(|e| format!("create data root: {e}"))?;
    Ok(root)
}

fn settings_file_path() -> Result<PathBuf, String> {
    // Wave 0 — app-managed settings live INSIDE the isolated profile so the
    // `--settings` flag points at a path under `<claude-home>/`. Bootstrap
    // (called from lib.rs setup) seeds this file as `{}` if missing.
    let home = crate::profile::app_claude_home()?;
    fs::create_dir_all(&home).map_err(|e| format!("create claude-home: {e}"))?;
    Ok(home.join("settings.json"))
}

fn audit_log_file_path() -> Result<PathBuf, String> {
    let logs = data_root()?.join("logs");
    fs::create_dir_all(&logs).map_err(|e| format!("create logs dir: {e}"))?;
    Ok(logs.join("audit.log"))
}

/// Read the app-managed settings JSON, returning `{}` when the file is
/// absent. Treats malformed JSON as a recoverable empty object so that one
/// corrupt write doesn't lock the user out of the editor.
fn read_settings_json() -> Result<Value, String> {
    let path = settings_file_path()?;
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings.json: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => Ok(v),
        Err(_) => Ok(json!({})),
    }
}

fn write_settings_json(value: &Value) -> Result<(), String> {
    let path = settings_file_path()?;
    let pretty = serde_json::to_string_pretty(value).map_err(|e| format!("serialise: {e}"))?;
    fs::write(&path, pretty).map_err(|e| format!("write settings.json: {e}"))?;
    Ok(())
}

/// Read-modify-write helper. The closure mutates the (already-loaded) JSON
/// object in place; the result is written back. Other top-level keys (e.g.
/// `disabledSkills` owned by W2-C) are preserved untouched.
pub(crate) fn update_settings_json<F>(mutate: F) -> Result<(), String>
where
    F: FnOnce(&mut Map<String, Value>) -> Result<(), String>,
{
    let mut current = read_settings_json()?;
    if !current.is_object() {
        // If the file was somehow not an object (or we recovered from a
        // parse failure with `{}`), restart from a fresh object so we don't
        // overwrite raw scalars/arrays.
        current = json!({});
    }
    let obj = current.as_object_mut().expect("checked above");
    mutate(obj)?;
    write_settings_json(&Value::Object(obj.clone()))
}

// ---------------------------------------------------------------------------
// Hook shape validation
// ---------------------------------------------------------------------------

const HOOK_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];

/// Validate the user-supplied `hooks` JSON value against the documented
/// shape. Returns `Ok(())` when valid; otherwise an error string suitable
/// for inline UI display.
///
/// Shape:
/// ```jsonc
/// {
///   "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop": [
///     {
///       "matcher": "<string>",
///       "hooks": [
///         { "type": "command", "command": "<string>" }
///       ]
///     }
///   ]
/// }
/// ```
fn validate_hooks_shape(v: &Value) -> Result<(), String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "hooks must be an object".to_string())?;

    for (key, group) in obj {
        if !HOOK_EVENTS.contains(&key.as_str()) {
            return Err(format!(
                "unknown hook event '{key}'. Allowed: {}",
                HOOK_EVENTS.join(", ")
            ));
        }
        let arr = group
            .as_array()
            .ok_or_else(|| format!("hooks.{key} must be an array"))?;
        for (i, entry) in arr.iter().enumerate() {
            let entry_obj = entry.as_object().ok_or_else(|| {
                format!("hooks.{key}[{i}] must be an object")
            })?;

            let matcher = entry_obj
                .get("matcher")
                .ok_or_else(|| format!("hooks.{key}[{i}].matcher is required"))?;
            if !matcher.is_string() {
                return Err(format!("hooks.{key}[{i}].matcher must be a string"));
            }

            let hooks_arr = entry_obj
                .get("hooks")
                .ok_or_else(|| format!("hooks.{key}[{i}].hooks is required"))?
                .as_array()
                .ok_or_else(|| format!("hooks.{key}[{i}].hooks must be an array"))?;

            for (j, h) in hooks_arr.iter().enumerate() {
                let h_obj = h.as_object().ok_or_else(|| {
                    format!("hooks.{key}[{i}].hooks[{j}] must be an object")
                })?;
                let typ = h_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        format!("hooks.{key}[{i}].hooks[{j}].type must be a string")
                    })?;
                if typ != "command" {
                    return Err(format!(
                        "hooks.{key}[{i}].hooks[{j}].type must be \"command\" (got \"{typ}\")"
                    ));
                }
                let cmd = h_obj
                    .get("command")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        format!("hooks.{key}[{i}].hooks[{j}].command must be a string")
                    })?;
                if cmd.trim().is_empty() {
                    return Err(format!(
                        "hooks.{key}[{i}].hooks[{j}].command must be non-empty"
                    ));
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Subagent discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SubagentMeta {
    pub name: String,
    pub description: Option<String>,
    /// `"user"` (under `~/.claude/agents/`) or `"plugin:<plugin>"`.
    pub source: String,
    pub path: String,
    pub model: Option<String>,
}

/// Parse the YAML-like frontmatter from a `.md` agent file. The format is
/// `---\nkey: value\n...\n---\n`. Multi-line values aren't expected here
/// (description fits one line by convention); our parser handles only the
/// simple `key: value` shape and ignores anything else.
fn parse_frontmatter(text: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    if !text.starts_with("---") {
        return out;
    }
    // Skip the opening fence line.
    let body = &text[3..];
    let lines = body.lines();
    // Skip the leading newline after `---`.
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_string();
            let val = v.trim().to_string();
            if !key.is_empty() {
                out.insert(key, val);
            }
        }
    }
    out
}

fn read_agent_file(path: &PathBuf, source: String) -> Option<SubagentMeta> {
    let raw = fs::read_to_string(path).ok()?;
    let fm = parse_frontmatter(&raw);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = fm
        .get("name")
        .map(|s| s.as_str().to_string())
        .unwrap_or(stem);
    let description = fm.get("description").map(|s| s.as_str().to_string());
    let model = fm.get("model").map(|s| s.as_str().to_string());

    Some(SubagentMeta {
        name,
        description,
        source,
        path: path.to_string_lossy().to_string(),
        model,
    })
}

/// Wave 0 — testable variant accepting a base dir. Production caller passes
/// `dirs::data_dir()` so scans hit `<claude-home>/agents` and
/// `<claude-home>/plugins/...` instead of the user's main `~/.claude`.
pub(crate) fn discover_subagents_at(base: &std::path::Path) -> Vec<SubagentMeta> {
    let mut out: Vec<SubagentMeta> = Vec::new();

    // 1. <claude-home>/agents/*.md  (was ~/.claude/agents)
    let user_agents = crate::profile::agents_dir_at(base);
    if let Ok(read) = fs::read_dir(&user_agents) {
        for entry in read.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(meta) = read_agent_file(&p, "user".into()) {
                    out.push(meta);
                }
            }
        }
    }

    // 2. <claude-home>/plugins/<pkg>/plugins/<plugin>/agents/*.md
    let plugins_root = crate::profile::plugins_dir_at(base);
    if let Ok(packages) = fs::read_dir(&plugins_root) {
        for pkg in packages.flatten() {
            let inner = pkg.path().join("plugins");
            if let Ok(plugins) = fs::read_dir(&inner) {
                for plugin in plugins.flatten() {
                    let plugin_name = plugin.file_name().to_string_lossy().to_string();
                    let agents_dir = plugin.path().join("agents");
                    if let Ok(read) = fs::read_dir(&agents_dir) {
                        for entry in read.flatten() {
                            let p = entry.path();
                            if p.extension().and_then(|s| s.to_str()) == Some("md") {
                                let source = format!("plugin:{plugin_name}");
                                if let Some(meta) = read_agent_file(&p, source) {
                                    out.push(meta);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Stable order: by source (user before plugin), then name.
    out.sort_by(|a, b| {
        let s = a.source.cmp(&b.source);
        if s != std::cmp::Ordering::Equal {
            s
        } else {
            a.name.cmp(&b.name)
        }
    });

    out
}

fn discover_subagents() -> Vec<SubagentMeta> {
    let Some(base) = dirs::data_dir() else {
        return Vec::new();
    };
    discover_subagents_at(&base)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_app_path() -> Result<String, String> {
    let path = settings_file_path()?;
    if !path.exists() {
        // Initialise with `{}` so the editor always has something to load.
        write_settings_json(&json!({}))?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn settings_app_get() -> Result<Value, String> {
    read_settings_json()
}

#[tauri::command]
pub async fn settings_app_set_hooks(hooks: Value) -> Result<(), String> {
    validate_hooks_shape(&hooks)?;
    update_settings_json(|obj| {
        obj.insert("hooks".to_string(), hooks);
        Ok(())
    })
}

#[tauri::command]
pub async fn audit_log_append(entry: Value) -> Result<(), String> {
    let path = audit_log_file_path()?;
    let line = serde_json::to_string(&entry).map_err(|e| format!("serialise audit: {e}"))?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open audit log: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("write audit log: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn audit_log_path() -> Result<String, String> {
    Ok(audit_log_file_path()?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn subagents_list() -> Result<Vec<SubagentMeta>, String> {
    Ok(discover_subagents())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_empty_object_ok() {
        validate_hooks_shape(&json!({})).expect("empty hooks ok");
    }

    #[test]
    fn validate_minimal_post_tool_use_ok() {
        let v = json!({
            "PostToolUse": [
                {
                    "matcher": "*",
                    "hooks": [{ "type": "command", "command": "echo hi" }]
                }
            ]
        });
        validate_hooks_shape(&v).expect("minimal shape ok");
    }

    #[test]
    fn validate_rejects_unknown_event() {
        let v = json!({ "BogusEvent": [] });
        let err = validate_hooks_shape(&v).expect_err("should reject");
        assert!(err.contains("unknown hook event"));
    }

    #[test]
    fn validate_rejects_non_object_root() {
        let v = json!([1, 2, 3]);
        let err = validate_hooks_shape(&v).expect_err("should reject array");
        assert!(err.contains("must be an object"));
    }

    #[test]
    fn validate_rejects_missing_matcher() {
        let v = json!({
            "PreToolUse": [
                { "hooks": [{ "type": "command", "command": "x" }] }
            ]
        });
        let err = validate_hooks_shape(&v).expect_err("should reject");
        assert!(err.contains("matcher is required"));
    }

    #[test]
    fn validate_rejects_non_command_type() {
        let v = json!({
            "Stop": [
                {
                    "matcher": "*",
                    "hooks": [{ "type": "script", "command": "x" }]
                }
            ]
        });
        let err = validate_hooks_shape(&v).expect_err("should reject");
        assert!(err.contains("must be \"command\""));
    }

    #[test]
    fn validate_rejects_empty_command() {
        let v = json!({
            "UserPromptSubmit": [
                {
                    "matcher": "*",
                    "hooks": [{ "type": "command", "command": "  " }]
                }
            ]
        });
        let err = validate_hooks_shape(&v).expect_err("should reject");
        assert!(err.contains("command must be non-empty"));
    }

    #[test]
    fn parse_frontmatter_minimal() {
        let raw = "---\nname: dave\ndescription: A helper.\nmodel: opus\n---\n# body";
        let fm = parse_frontmatter(raw);
        assert_eq!(fm.get("name").map(String::as_str), Some("dave"));
        assert_eq!(fm.get("description").map(String::as_str), Some("A helper."));
        assert_eq!(fm.get("model").map(String::as_str), Some("opus"));
    }

    #[test]
    fn discover_subagents_at_reads_only_under_claude_home() {
        // Sentinel base. Plant agents under `<base>/autoplot/claude-home/agents/`
        // and assert discovery returns them. We do NOT plant anything under
        // a `~/.claude/...` shape — the test passes only because the function
        // is rebased correctly.
        let base = std::env::temp_dir().join(format!(
            "tp-isolation-agents-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let agents_dir = crate::profile::agents_dir_at(&base);
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(
            agents_dir.join("alice.md"),
            "---\nname: alice\ndescription: A helper.\n---\nbody",
        )
        .unwrap();

        let agents = discover_subagents_at(&base);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "alice");
        // Source path lives strictly under our isolated profile.
        assert!(
            agents[0].path.contains("claude-home"),
            "agent path leaked outside claude-home: {}",
            agents[0].path
        );
        assert!(
            !agents[0].path.contains("/.claude/"),
            "agent path includes ~/.claude/ shape: {}",
            agents[0].path
        );

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn parse_frontmatter_no_fence_returns_empty() {
        let raw = "no frontmatter here";
        let fm = parse_frontmatter(raw);
        assert!(fm.is_empty());
    }
}
