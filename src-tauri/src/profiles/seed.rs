//! Seeding a new profile from Personal (profiles plan, step P2.1).
//!
//! A brand-new profile dir starts as a copy of Personal's own setup, so a team
//! account works the way you're used to: `settings.json`, `CLAUDE.md`,
//! `keybindings.json`, the `skills/`, `agents/`, `commands/`, `rules/` and
//! `output-styles/` folders, and the user-scope `mcpServers` from `.claude.json`.
//!
//! Left out on purpose: credentials (the profile logs in to its own account),
//! transcripts and history (they belong to the other account), and `plugins/`
//! (plugin installs record absolute paths, so the profile installs them again).
//! Workbench's own hook and statusline entries are dropped from the copied
//! `settings.json`; the installer adds fresh ones for the profile.
//!
//! The copy goes into an empty dir only and never overwrites a file. Linked folders
//! in Personal are copied by content, so the two profiles change independently.

use std::path::Path;

use serde_json::{Map, Value};

/// Files copied as they are.
const FILES: &[&str] = &["CLAUDE.md", "keybindings.json"];
/// Folders copied with everything in them.
const DIRS: &[&str] = &["skills", "agents", "commands", "rules", "output-styles"];
/// How deep a copied folder may nest (guards against a link loop).
const MAX_DEPTH: usize = 16;

/// What a seed copied, for the caller's log.
#[derive(Debug, Default, PartialEq)]
pub struct Seeded {
    pub items: Vec<String>,
}

/// Whether `dir` is missing or has nothing in it.
pub fn is_empty_dir(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Copy Personal's setup into `to`, which must be empty (or missing).
///
/// - `personal`: Personal's config dir (`~/.claude`).
/// - `personal_json`: Personal's `.claude.json`, for its user `mcpServers`.
/// - `chained_statusline`: the statusline command Workbench's own script chains
///   to, which takes the place of Workbench's in the copied `settings.json` (the
///   installer then chains it in the new profile too).
pub fn seed(
    personal: &Path,
    personal_json: Option<&Path>,
    chained_statusline: Option<&str>,
    to: &Path,
) -> Result<Seeded, String> {
    if !is_empty_dir(to) {
        return Err(format!("{} isn't empty; a profile is only seeded into an empty folder", to.display()));
    }
    std::fs::create_dir_all(to).map_err(|e| format!("creating {}: {e}", to.display()))?;
    let mut out = Seeded::default();

    // settings.json, without Workbench's own entries.
    let settings = personal.join("settings.json");
    if settings.is_file() {
        let text = std::fs::read_to_string(&settings)
            .map_err(|e| format!("reading {}: {e}", settings.display()))?;
        let mut v: Value = serde_json::from_str(&text)
            .map_err(|e| format!("{} isn't valid JSON: {e}", settings.display()))?;
        strip_workbench(&mut v, chained_statusline);
        write_new(&to.join("settings.json"), &pretty(&v)?)?;
        out.items.push("settings.json".into());
    }

    for name in FILES {
        let src = personal.join(name);
        if src.is_file() {
            let bytes = std::fs::read(&src).map_err(|e| format!("reading {}: {e}", src.display()))?;
            write_new(&to.join(name), &bytes)?;
            out.items.push((*name).into());
        }
    }

    for name in DIRS {
        let src = personal.join(name);
        if src.is_dir() {
            copy_dir(&src, &to.join(name), 0)?;
            out.items.push(format!("{name}/"));
        }
    }

    // The user-scope MCP servers; Claude Code fills in the rest of `.claude.json`.
    let servers = personal_json
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("mcpServers").cloned())
        .filter(|m| m.as_object().is_some_and(|o| !o.is_empty()));
    if let Some(servers) = servers {
        let mut root = Map::new();
        root.insert("mcpServers".into(), servers);
        write_new(&to.join(".claude.json"), &pretty(&Value::Object(root))?)?;
        out.items.push("mcpServers".into());
    }

    Ok(out)
}

/// Drop Workbench's hooks (any build's) and its statusline from a settings object.
/// Workbench's statusline gives way to the command it chained, if any.
fn strip_workbench(settings: &mut Value, chained_statusline: Option<&str>) {
    let Some(root) = settings.as_object_mut() else { return };

    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            let Some(entries) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
                continue;
            };
            entries.retain_mut(|entry| {
                let Some(inner) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                    return true;
                };
                let before = inner.len();
                inner.retain(|h| !is_workbench_hook(h));
                !(inner.is_empty() && before > 0)
            });
            if entries.is_empty() {
                hooks.remove(&event);
            }
        }
        if hooks.is_empty() {
            root.remove("hooks");
        }
    }

    let ours = root
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains("workbench-statusline"));
    if ours {
        match chained_statusline.filter(|c| !c.contains("workbench-statusline")) {
            Some(cmd) => {
                root.insert(
                    "statusLine".into(),
                    serde_json::json!({ "type": "command", "command": cmd }),
                );
            }
            None => {
                root.remove("statusLine");
            }
        }
    }
}

/// A hook Workbench installed, from the release or the dev build.
fn is_workbench_hook(hook: &Value) -> bool {
    hook.get("type").and_then(Value::as_str) == Some("http")
        && hook
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|u| u.contains("/__workbench_hook"))
}

fn pretty(v: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(v).map_err(|e| e.to_string())
}

/// Write a file that must not exist yet.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    f.write_all(bytes).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// Copy a folder's contents, following links (so a linked folder is copied, not
/// linked). Nothing that exists is overwritten.
fn copy_dir(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("creating {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("reading {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        // `metadata` follows links; a dangling link is skipped.
        let Ok(meta) = std::fs::metadata(&from) else { continue };
        if meta.is_dir() {
            copy_dir(&from, &to, depth + 1)?;
        } else if meta.is_file() && !to.exists() {
            std::fs::copy(&from, &to).map_err(|e| format!("copying {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wb-seed-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_personal() -> (PathBuf, PathBuf) {
        let home = temp_dir("home");
        let p = home.join(".claude");
        std::fs::create_dir_all(p.join("skills/review")).unwrap();
        std::fs::create_dir_all(p.join("projects/C--repo")).unwrap();
        std::fs::create_dir_all(p.join("plugins/repos/x")).unwrap();
        std::fs::write(p.join("skills/review/SKILL.md"), "---\nname: review\n---\n").unwrap();
        std::fs::write(p.join("projects/C--repo/s.jsonl"), "{}").unwrap();
        std::fs::write(p.join(".credentials.json"), "{\"secret\":1}").unwrap();
        std::fs::write(p.join("history.jsonl"), "{}").unwrap();
        std::fs::write(p.join("CLAUDE.md"), "be terse").unwrap();
        std::fs::write(
            p.join("settings.json"),
            r#"{
              "model": "opus",
              "hooks": {
                "Stop": [
                  {"hooks": [{"type": "http", "url": "http://127.0.0.1:1/__workbench_hook"}]},
                  {"hooks": [{"type": "command", "command": "say done"}]}
                ],
                "PreToolUse": [
                  {"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:2/__workbench_hook__dev"}]}
                ]
              },
              "statusLine": {"type": "command", "command": "node \"C:/x/.claude/workbench-statusline.mjs\""}
            }"#,
        )
        .unwrap();
        let json = home.join(".claude.json");
        std::fs::write(
            &json,
            r#"{"oauthAccount":{"emailAddress":"me@x"},"mcpServers":{"fs":{"command":"npx"}},"projects":{}}"#,
        )
        .unwrap();
        (p, json)
    }

    #[test]
    fn seed_copies_the_setup_and_leaves_the_account_behind() {
        let (personal, json) = fake_personal();
        let to = temp_dir("team").join("new");
        let got = seed(&personal, Some(&json), Some("bash ~/line.sh"), &to).unwrap();
        assert!(got.items.contains(&"skills/".to_string()));

        assert!(to.join("skills/review/SKILL.md").is_file());
        assert_eq!(std::fs::read_to_string(to.join("CLAUDE.md")).unwrap(), "be terse");
        // Not copied: credentials, transcripts, history, plugins.
        assert!(!to.join(".credentials.json").exists());
        assert!(!to.join("projects").exists());
        assert!(!to.join("history.jsonl").exists());
        assert!(!to.join("plugins").exists());

        // MCP servers carried over, the account not.
        let j: Value = serde_json::from_str(&std::fs::read_to_string(to.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(j["mcpServers"]["fs"]["command"], "npx");
        assert!(j.get("oauthAccount").is_none());

        // Workbench's hooks gone (both builds), foreign ones kept; the chained
        // statusline takes Workbench's place.
        let s: Value = serde_json::from_str(&std::fs::read_to_string(to.join("settings.json")).unwrap()).unwrap();
        assert_eq!(s["model"], "opus");
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert!(s["hooks"].get("PreToolUse").is_none());
        assert_eq!(s["statusLine"]["command"], "bash ~/line.sh");
    }

    #[test]
    fn seed_without_a_chained_statusline_drops_workbenchs() {
        let (personal, json) = fake_personal();
        let to = temp_dir("team2").join("new");
        seed(&personal, Some(&json), None, &to).unwrap();
        let s: Value = serde_json::from_str(&std::fs::read_to_string(to.join("settings.json")).unwrap()).unwrap();
        assert!(s.get("statusLine").is_none());
    }

    #[test]
    fn seed_refuses_a_folder_with_something_in_it() {
        let (personal, json) = fake_personal();
        let to = temp_dir("busy");
        std::fs::write(to.join("settings.json"), "{}").unwrap();
        assert!(seed(&personal, Some(&json), None, &to).is_err());
        assert_eq!(std::fs::read_to_string(to.join("settings.json")).unwrap(), "{}");
    }
}
