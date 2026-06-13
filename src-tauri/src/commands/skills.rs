//! src-tauri/src/commands/skills.rs — Skills + slash-command discovery (W2-C).
//!
//! Discovers two artefact families across four precedence layers:
//!   1. App-shipped: `<dirs::data_dir>/autoplot/{skills,commands}/...`
//!   2. User:       `~/.claude/{skills,commands}/...`
//!   3. Plugin:     `~/.claude/plugins/*/plugins/*/{skills,commands}/...`
//!   4. Project:    `<cwd>/.claude/{skills,commands}/...`
//!
//! Higher precedence (later in the list) shadows earlier matches by name. The
//! list returned to the frontend keeps every entry — shadowed rows are tagged
//! `shadowed: true` and the UI fades them with a tooltip.
//!
//! Slash commands additionally support a one-time idempotent install of four
//! app-shipped templates (`/explain`, `/research`, `/strategy`, `/save-current`)
//! into the app-managed commands dir. Invoked from `lib.rs` setup after
//! migrations.
//!
//! Disabled skills are tracked in app-managed merged settings at
//! `<dirs::data_dir>/autoplot/settings.json` under `disabledSkills`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: Option<String>,
    /// One of "app" | "user" | "plugin" | "project".
    pub source: String,
    pub path: String,
    /// True if a higher-precedence layer also defines the same name.
    pub shadowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub source: String,
    pub path: String,
    pub body: String,
    pub shadowed: bool,
}

// ---------------------------------------------------------------------------
// Path roots
// ---------------------------------------------------------------------------

fn data_root() -> Option<PathBuf> {
    dirs::data_dir().map(|p| p.join("autoplot"))
}

fn app_skills_dir() -> Option<PathBuf> {
    data_root().map(|p| p.join("skills"))
}

fn app_commands_dir() -> Option<PathBuf> {
    data_root().map(|p| p.join("commands"))
}

// Wave 0 — these "user" / "plugin" lookups are rebased onto the app's
// isolated profile at `<claude-home>/{skills,commands,plugins}` so the user's
// main `~/.claude/*` is never read. The wire labels (`"user"`, `"plugin"`)
// are preserved for TS compat — semantically they're now layers within our
// own profile dir.
fn user_skills_dir() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    Some(crate::profile::skills_dir_at(&base))
}

fn user_commands_dir() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    Some(crate::profile::commands_dir_at(&base))
}

fn plugins_root() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    Some(crate::profile::plugins_dir_at(&base))
}

fn project_root() -> Option<PathBuf> {
    std::env::current_dir().ok().map(|p| p.join(".claude"))
}

fn project_skills_dir() -> Option<PathBuf> {
    project_root().map(|p| p.join("skills"))
}

fn project_commands_dir() -> Option<PathBuf> {
    project_root().map(|p| p.join("commands"))
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/// Walk `<root>/<skill_name>/SKILL.md` one level deep. Each subdir whose
/// SKILL.md exists yields a `Skill`.
fn discover_skills_in(root: &Path, source: &str) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let (name, description) = parse_skill_md(&skill_md, &dir);
        out.push(Skill {
            name,
            description,
            source: source.to_string(),
            path: skill_md.to_string_lossy().to_string(),
            shadowed: false,
        });
    }
    out
}

/// Parse a SKILL.md: `name` is the first non-empty markdown line stripped of
/// a leading `# ` if present; `description:` line (case-insensitive prefix)
/// found within the first 30 lines becomes `description`. Falls back to the
/// directory name when nothing else is parseable.
fn parse_skill_md(path: &Path, dir: &Path) -> (String, Option<String>) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if name.is_none() {
            // Strip a leading "# " for a markdown heading.
            let n = if let Some(rest) = trimmed.strip_prefix("# ") {
                rest.trim().to_string()
            } else if let Some(rest) = trimmed.strip_prefix("#") {
                rest.trim().to_string()
            } else {
                trimmed.to_string()
            };
            if !n.is_empty() {
                name = Some(n);
            }
        }
        // Look for a `description:` line (case-insensitive). YAML front-matter
        // and prose body both work — we just match the first hit.
        if description.is_none() {
            let lower = trimmed.to_ascii_lowercase();
            if let Some(idx) = lower.find("description:") {
                let val = &trimmed[idx + "description:".len()..];
                let v = val.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                if !v.is_empty() {
                    description = Some(v);
                }
            }
        }
        if i > 30 && name.is_some() {
            break;
        }
    }
    let name = name.unwrap_or_else(|| {
        dir.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string())
    });
    (name, description)
}

/// Walk `<plugins_root>/*/plugins/*/skills/*/SKILL.md`.
fn discover_plugin_skills(root: &Path) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    let plugins = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for plugin_owner in plugins.flatten() {
        let owner_dir = plugin_owner.path();
        if !owner_dir.is_dir() {
            continue;
        }
        let inner_plugins = owner_dir.join("plugins");
        let inner_entries = match std::fs::read_dir(&inner_plugins) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for inner in inner_entries.flatten() {
            let plugin_dir = inner.path();
            if !plugin_dir.is_dir() {
                continue;
            }
            let skills_dir = plugin_dir.join("skills");
            if skills_dir.is_dir() {
                out.extend(discover_skills_in(&skills_dir, "plugin"));
            }
        }
    }
    out
}

/// Run discovery in precedence order, mark earlier matches as shadowed when a
/// later match has the same name. Returned list keeps every entry.
pub(crate) fn skills_discover_merged() -> Vec<Skill> {
    let mut layers: Vec<Vec<Skill>> = Vec::new();
    if let Some(p) = app_skills_dir() {
        layers.push(discover_skills_in(&p, "app"));
    }
    if let Some(p) = user_skills_dir() {
        layers.push(discover_skills_in(&p, "user"));
    }
    if let Some(p) = plugins_root() {
        layers.push(discover_plugin_skills(&p));
    }
    if let Some(p) = project_skills_dir() {
        layers.push(discover_skills_in(&p, "project"));
    }

    // For each name, find the highest-precedence layer that defines it; mark
    // every other entry with that name as shadowed.
    let mut highest: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (idx, layer) in layers.iter().enumerate() {
        for s in layer {
            highest.insert(s.name.clone(), idx);
        }
    }

    let mut out: Vec<Skill> = Vec::new();
    for (idx, layer) in layers.into_iter().enumerate() {
        for mut s in layer {
            let top = highest.get(&s.name).copied().unwrap_or(idx);
            s.shadowed = idx != top;
            out.push(s);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Slash command discovery
// ---------------------------------------------------------------------------

fn discover_commands_in(root: &Path, source: &str) -> Vec<SlashCommand> {
    let mut out: Vec<SlashCommand> = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if ext != "md" {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        let description = extract_command_description(&body);
        out.push(SlashCommand {
            name: stem,
            description,
            source: source.to_string(),
            path: path.to_string_lossy().to_string(),
            body,
            shadowed: false,
        });
    }
    out
}

/// One-line description from the body — the first non-empty trimmed line
/// truncated to 200 chars, with leading `# ` stripped.
fn extract_command_description(body: &str) -> Option<String> {
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let cleaned = t
            .strip_prefix("# ")
            .or_else(|| t.strip_prefix("#"))
            .unwrap_or(t)
            .trim()
            .to_string();
        if cleaned.is_empty() {
            continue;
        }
        let truncated: String = cleaned.chars().take(200).collect();
        return Some(truncated);
    }
    None
}

fn discover_plugin_commands(root: &Path) -> Vec<SlashCommand> {
    let mut out: Vec<SlashCommand> = Vec::new();
    let plugins = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for plugin_owner in plugins.flatten() {
        let owner_dir = plugin_owner.path();
        if !owner_dir.is_dir() {
            continue;
        }
        let inner_plugins = owner_dir.join("plugins");
        let inner_entries = match std::fs::read_dir(&inner_plugins) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for inner in inner_entries.flatten() {
            let plugin_dir = inner.path();
            if !plugin_dir.is_dir() {
                continue;
            }
            let cmd_dir = plugin_dir.join("commands");
            if cmd_dir.is_dir() {
                out.extend(discover_commands_in(&cmd_dir, "plugin"));
            }
        }
    }
    out
}

pub(crate) fn slash_commands_discover_merged() -> Vec<SlashCommand> {
    let mut layers: Vec<Vec<SlashCommand>> = Vec::new();
    if let Some(p) = app_commands_dir() {
        layers.push(discover_commands_in(&p, "app"));
    }
    if let Some(p) = user_commands_dir() {
        layers.push(discover_commands_in(&p, "user"));
    }
    if let Some(p) = plugins_root() {
        layers.push(discover_plugin_commands(&p));
    }
    if let Some(p) = project_commands_dir() {
        layers.push(discover_commands_in(&p, "project"));
    }

    let mut highest: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (idx, layer) in layers.iter().enumerate() {
        for s in layer {
            highest.insert(s.name.clone(), idx);
        }
    }

    let mut out: Vec<SlashCommand> = Vec::new();
    for (idx, layer) in layers.into_iter().enumerate() {
        for mut s in layer {
            let top = highest.get(&s.name).copied().unwrap_or(idx);
            s.shadowed = idx != top;
            out.push(s);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// App-shipped slash command install (idempotent, called once on app boot)
// ---------------------------------------------------------------------------

const APP_SHIPPED_COMMANDS: &[(&str, &str)] = &[
    (
        "explain",
        "Explain the current chart context. Active sym: {{activeSym}}, tf: {{tf}}. Look at recent overlays and explain price action.",
    ),
    (
        "research",
        "Research the metric: $ARGS. Use fetch_ohlc + compute_indicator + return_dataset to produce a Dataset.",
    ),
    (
        "strategy",
        "Strategy thesis: $ARGS. Use validate_strategy + backtest_strategy + return_strategy to produce a Strategy.",
    ),
    (
        "save-current",
        "Save the active overlay to the Library if one is plotted; save the active strategy to the Library if one is applied; both if both. Toast 'Nothing to save' if neither.",
    ),
];

/// Idempotently write the four app-shipped slash commands. Files that already
/// exist are NOT overwritten — the user may have edited them.
pub fn install_app_shipped_commands() -> Result<(), String> {
    let dir = app_commands_dir()
        .ok_or_else(|| "could not resolve app data dir".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create app commands dir: {e}"))?;
    for (name, body) in APP_SHIPPED_COMMANDS {
        let path = dir.join(format!("{name}.md"));
        if path.exists() {
            continue;
        }
        std::fs::write(&path, body)
            .map_err(|e| format!("write {name}.md: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// disabledSkills persistence — delegates to settings_hooks's canonical
// read/write helpers so both modules touch the exact same file with the same
// error semantics. Without this, a future drift in the on-disk path would
// have one module reading from a stale location.
// ---------------------------------------------------------------------------

pub(crate) fn skill_set_enabled_inner(name: &str, enabled: bool) -> Result<(), String> {
    super::settings_hooks::update_settings_json(|root| {
        let entry = root
            .entry("disabledSkills".to_string())
            .or_insert_with(|| Value::Array(vec![]));
        let arr = entry
            .as_array_mut()
            .ok_or_else(|| "disabledSkills is not an array".to_string())?;
        // Drop existing match (we always normalise to a unique set).
        arr.retain(|v| v.as_str() != Some(name));
        if !enabled {
            arr.push(Value::String(name.to_string()));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn skills_list_merged() -> Result<Vec<Skill>, String> {
    Ok(skills_discover_merged())
}

#[tauri::command]
pub fn slash_commands_list_merged() -> Result<Vec<SlashCommand>, String> {
    Ok(slash_commands_discover_merged())
}

#[tauri::command]
pub fn skill_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    skill_set_enabled_inner(&name, enabled)
}

#[tauri::command]
pub fn slash_command_install_app_shipped() -> Result<(), String> {
    install_app_shipped_commands()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    fn scratch(label: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "tp-skills-test-{label}-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn parse_skill_md_extracts_name_and_description() {
        let dir = scratch("parse");
        let path = dir.join("SKILL.md");
        std::fs::write(
            &path,
            "# my-skill\n\ndescription: does a thing\n\nbody body body\n",
        )
        .unwrap();
        let (name, desc) = parse_skill_md(&path, &dir);
        assert_eq!(name, "my-skill");
        assert_eq!(desc.as_deref(), Some("does a thing"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_skill_md_falls_back_to_dir_name() {
        let dir = scratch("fallback-skill");
        let path = dir.join("SKILL.md");
        std::fs::write(&path, "").unwrap();
        let (name, desc) = parse_skill_md(&path, &dir);
        assert!(
            name.starts_with("tp-skills-test-fallback-skill-"),
            "expected dir-name fallback, got {name}"
        );
        assert!(desc.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discover_skills_finds_subdir_skill_md() {
        let root = scratch("disc");
        let inner = root.join("alpha");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(
            inner.join("SKILL.md"),
            "# alpha-skill\ndescription: alpha thing\n",
        )
        .unwrap();
        let beta = root.join("beta");
        std::fs::create_dir_all(&beta).unwrap();
        std::fs::write(beta.join("SKILL.md"), "beta-skill\n").unwrap();
        // Junk dir without SKILL.md should be ignored.
        std::fs::create_dir_all(root.join("ignored")).unwrap();

        let skills = discover_skills_in(&root, "user");
        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|s| s.name == "alpha-skill"));
        assert!(skills.iter().any(|s| s.name == "beta-skill"));
        for s in &skills {
            assert_eq!(s.source, "user");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discover_commands_skips_non_md() {
        let root = scratch("cmd");
        std::fs::write(root.join("explain.md"), "Explain the chart.\nMore details.\n").unwrap();
        std::fs::write(root.join("research.md"), "# research\nResearch a metric.").unwrap();
        std::fs::write(root.join("ignored.txt"), "nope").unwrap();

        let cmds = discover_commands_in(&root, "app");
        assert_eq!(cmds.len(), 2);
        let explain = cmds.iter().find(|c| c.name == "explain").expect("explain");
        assert_eq!(explain.source, "app");
        assert!(explain.body.starts_with("Explain"));
        assert_eq!(explain.description.as_deref(), Some("Explain the chart."));

        let research = cmds.iter().find(|c| c.name == "research").expect("research");
        assert_eq!(research.description.as_deref(), Some("research"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extract_command_description_strips_heading() {
        assert_eq!(
            extract_command_description("# foo bar\n\nbody"),
            Some("foo bar".to_string())
        );
        assert_eq!(
            extract_command_description("\n\nfirst line\nsecond"),
            Some("first line".to_string())
        );
        assert_eq!(extract_command_description(""), None);
    }
}
