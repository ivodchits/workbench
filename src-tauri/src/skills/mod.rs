//! Skill manager (step 3.7b) — design §7 "Skill/plugin awareness".
//!
//! Agent Skills are a folder + a `SKILL.md` per skill, discovered by Claude Code
//! from two **writable** scopes plus read-only plugin bundles:
//!
//!   • **user**    — `~/.claude/skills/<name>/SKILL.md` (global, every project).
//!   • **project** — `<root>/.claude/skills/<name>/SKILL.md` (this repo,
//!                   git-committable / shareable).
//!   • **plugin**  — bundled by an installed plugin under `~/.claude/plugins/` —
//!                   shown read-only for awareness, never edited here.
//!
//! Unlike the MCP manager (step 3.7) these are **pure filesystem ops** — a folder
//! and a markdown file — so there's no shared-JSON corruption risk and no CLI to
//! drive: `skill_list` / `skill_create` / `skill_remove` operate on the directory
//! tree directly, and *editing* reuses the generic file editor (the panel hands it
//! the `SKILL.md` path returned by the list / create).
//!
//! The folder name is the skill's invocation id (`/<name>`). The `SKILL.md`
//! frontmatter `name`/`description` drive Claude Code's matching, so the list
//! validates them (kebab-case `name`, non-empty `description`) and surfaces any
//! problems rather than silently shipping a skill that won't trigger.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One discovered skill (a list row).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Folder name — the invocation id (`/<name>`) and the stable key.
    pub name: String,
    /// `"user" | "project" | "plugin"`.
    pub scope: String,
    /// Absolute path to the skill's `SKILL.md` (what the editor opens).
    pub skill_path: String,
    /// The `name:` frontmatter field, if present (ideally matches the folder).
    pub frontmatter_name: Option<String>,
    /// The `description:` frontmatter field, if present.
    pub description: Option<String>,
    /// Frontmatter passes validation (kebab `name` + non-empty `description`).
    pub valid: bool,
    /// Human-readable validation problems (empty when `valid`).
    pub problems: Vec<String>,
    /// For `plugin` scope, the owning plugin/source label (read-only awareness).
    pub plugin: Option<String>,
}

/// Create input from the frontend. `description` seeds the scaffolded frontmatter.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSkill {
    pub project_root: String,
    /// `"user" | "project"` (plugin skills are read-only).
    pub scope: String,
    /// The folder + frontmatter name (validated kebab-case).
    pub name: String,
    pub description: String,
}

// ---------------------------------------------------------------------------
// Read path — scan the scope directories.
// ---------------------------------------------------------------------------

/// List every skill visible to `project_root`: user + project (writable) and any
/// plugin-bundled skills (read-only). Sorted by scope precedence then name so the
/// frontend renders deterministically.
#[tauri::command]
pub fn skill_list(project_root: String) -> Result<Vec<Skill>, String> {
    let mut out: Vec<Skill> = Vec::new();

    if let Some(home) = home_dir() {
        collect_scope(&home.join(".claude").join("skills"), "user", &mut out);
    }
    collect_scope(
        &Path::new(&project_root).join(".claude").join("skills"),
        "project",
        &mut out,
    );
    collect_plugin_skills(&mut out);

    out.sort_by(|a, b| {
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Append every `<dir>/<name>/SKILL.md` under one scope root. A missing root is
/// simply "no skills" — not an error (most projects have none).
fn collect_scope(root: &Path, scope: &str, out: &mut Vec<Skill>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue; // a folder without a SKILL.md isn't a skill
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(build_skill(&name, scope, &skill_md, None));
    }
}

/// Best-effort scan for plugin-bundled skills (read-only). Plugins live under
/// `~/.claude/plugins/repos/<owner>/<repo>/<plugin>/skills/<name>/SKILL.md`; the
/// exact nesting varies, so walk a bounded depth looking for any `skills/<name>/
/// SKILL.md` and label it with the nearest enclosing plugin directory. Anything
/// unexpected just yields no rows — awareness, never a hard dependency.
fn collect_plugin_skills(out: &mut Vec<Skill>) {
    let Some(home) = home_dir() else { return };
    let root = home.join(".claude").join("plugins").join("repos");
    walk_for_skills(&root, 0, 6, out);
}

/// Recurse `dir` (to `max_depth`) collecting `skills/<name>/SKILL.md`. When a
/// `skills` directory is found, its children are the skills and the *parent* of
/// `skills` names the plugin.
fn walk_for_skills(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<Skill>) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if entry.file_name().to_string_lossy() == "skills" {
            let plugin = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            collect_plugin_scope(&path, &plugin, out);
        } else {
            walk_for_skills(&path, depth + 1, max_depth, out);
        }
    }
}

/// Like `collect_scope` but tags rows as `plugin` with their source label.
fn collect_plugin_scope(skills_dir: &Path, plugin: &str, out: &mut Vec<Skill>) {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(build_skill(&name, "plugin", &skill_md, Some(plugin.to_owned())));
    }
}

/// Read + validate one skill's `SKILL.md` into a `Skill` row.
fn build_skill(name: &str, scope: &str, skill_md: &Path, plugin: Option<String>) -> Skill {
    let text = std::fs::read_to_string(skill_md).unwrap_or_default();
    let (fm_name, description) = parse_frontmatter(&text);

    let mut problems: Vec<String> = Vec::new();
    match &fm_name {
        None => problems.push("frontmatter is missing a `name`".into()),
        Some(n) if !is_kebab_case(n) => {
            problems.push(format!("`name` \"{n}\" should be kebab-case (a-z, 0-9, -)"));
        }
        Some(n) if n != name => {
            // Not fatal — Claude Code matches on the frontmatter name — but a
            // mismatch with the folder is a common, confusing footgun worth flagging.
            problems.push(format!("`name` \"{n}\" doesn't match the folder \"{name}\""));
        }
        _ => {}
    }
    if description.as_deref().map(str::trim).unwrap_or("").is_empty() {
        problems.push("frontmatter `description` is empty".into());
    }

    Skill {
        name: name.to_owned(),
        scope: scope.to_owned(),
        skill_path: skill_md.to_string_lossy().into_owned(),
        frontmatter_name: fm_name,
        description,
        valid: problems.is_empty(),
        problems,
        plugin,
    }
}

/// Pull `name` and `description` out of a leading YAML frontmatter block (the part
/// between the first two `---` fences). Values may be bare or quoted; only these
/// two scalars matter here, so this is a deliberately tiny line scanner rather than
/// a full YAML parse.
fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    // The file must open with a `---` fence (allowing a UTF-8 BOM).
    let first = lines.next().unwrap_or("").trim_start_matches('\u{feff}').trim();
    if first != "---" {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break; // end of frontmatter
        }
        if let Some(v) = trimmed.strip_prefix("name:") {
            name = Some(unquote(v.trim()));
        } else if let Some(v) = trimmed.strip_prefix("description:") {
            description = Some(unquote(v.trim()));
        }
    }
    (name, description)
}

/// Strip a single pair of matching surrounding quotes, if present.
fn unquote(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        s[1..s.len() - 1].to_owned()
    } else {
        s.to_owned()
    }
}

/// `^[a-z0-9]+(-[a-z0-9]+)*$` — lowercase alphanumerics in hyphen-separated groups,
/// no leading/trailing/double hyphens. Hand-rolled to avoid a regex dependency.
fn is_kebab_case(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let mut prev_hyphen = true; // treat the start like "after a hyphen" → no leading -
    for c in s.chars() {
        if c == '-' {
            if prev_hyphen {
                return false; // leading or doubled hyphen
            }
            prev_hyphen = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            prev_hyphen = false;
        } else {
            return false; // uppercase, separator, or other punctuation
        }
    }
    !prev_hyphen // no trailing hyphen
}

/// Precedence rank for sorting (project before user before plugin — the order the
/// user is most likely to be editing). Unknown scopes sort last.
fn scope_rank(scope: &str) -> u8 {
    match scope {
        "project" => 0,
        "user" => 1,
        "plugin" => 2,
        _ => 3,
    }
}

// ---------------------------------------------------------------------------
// Write path — create / remove the skill directory.
// ---------------------------------------------------------------------------

/// Scaffold a new skill: `<base>/<name>/SKILL.md` with valid frontmatter and a
/// stub body. Returns the `SKILL.md` path so the panel can open it in the editor.
/// Refuses to overwrite an existing skill or to write a plugin skill.
#[tauri::command]
pub fn skill_create(input: NewSkill) -> Result<String, String> {
    let name = input.name.trim();
    if !is_kebab_case(name) {
        return Err("the skill name must be kebab-case (lowercase a-z, 0-9, hyphens)".into());
    }
    let description = input.description.trim();
    if description.is_empty() {
        return Err("a description is required (it's how Claude decides to use the skill)".into());
    }

    let base = scope_base(&input.scope, &input.project_root)?;
    let dir = base.join(name);
    if dir.exists() {
        return Err(format!("a skill named \"{name}\" already exists in this scope"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let skill_md = dir.join("SKILL.md");
    let body = scaffold(name, description);
    std::fs::write(&skill_md, body)
        .map_err(|e| format!("cannot write {}: {e}", skill_md.display()))?;
    Ok(skill_md.to_string_lossy().into_owned())
}

/// Remove a skill folder (and its `SKILL.md`) entirely. Plugin skills are read-only
/// and rejected. The name must be a single path component (no separators / `..`) so
/// a crafted value can't escape the scope directory.
#[tauri::command]
pub fn skill_remove(project_root: String, scope: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if !is_safe_component(name) {
        return Err("invalid skill name".into());
    }
    let base = scope_base(&scope, &project_root)?;
    let dir = base.join(name);
    if !dir.is_dir() {
        return Err(format!("\"{name}\" no longer exists"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("cannot remove {}: {e}", dir.display()))
}

/// The writable base directory for a scope. Plugin scope has no writable base.
fn scope_base(scope: &str, project_root: &str) -> Result<PathBuf, String> {
    match scope {
        "user" => home_dir()
            .map(|h| h.join(".claude").join("skills"))
            .ok_or_else(|| "cannot resolve your home directory".to_owned()),
        "project" => Ok(Path::new(project_root).join(".claude").join("skills")),
        "plugin" => Err("plugin skills are read-only".into()),
        other => Err(format!("unknown scope: {other}")),
    }
}

/// The scaffolded `SKILL.md` for a fresh skill — valid frontmatter plus a stub the
/// user fills in. The body intentionally prompts the two things that make a skill
/// trigger well: a precise description and clear "use when" guidance.
fn scaffold(name: &str, description: &str) -> String {
    let title = name
        .split('-')
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n\n# {title}\n\n\
         Describe what this skill does and the steps to follow.\n\n\
         ## When to use\n\n\
         Spell out the situations where Claude should reach for this skill.\n"
    )
}

/// A single, safe path component: non-empty, no separators, not `.`/`..`.
fn is_safe_component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kebab_validation() {
        assert!(is_kebab_case("deep-research"));
        assert!(is_kebab_case("verify"));
        assert!(is_kebab_case("a1-b2-c3"));
        assert!(!is_kebab_case("Deep-Research")); // uppercase
        assert!(!is_kebab_case("-lead")); // leading hyphen
        assert!(!is_kebab_case("trail-")); // trailing hyphen
        assert!(!is_kebab_case("double--hyphen"));
        assert!(!is_kebab_case("has space"));
        assert!(!is_kebab_case(""));
    }

    #[test]
    fn frontmatter_parses_name_and_description() {
        let text = "---\nname: my-skill\ndescription: \"Does a thing.\"\n---\n\n# Body\n";
        let (name, desc) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(desc.as_deref(), Some("Does a thing."));
    }

    #[test]
    fn frontmatter_requires_leading_fence() {
        let (name, desc) = parse_frontmatter("# no frontmatter\nname: x\n");
        assert!(name.is_none() && desc.is_none());
    }

    #[test]
    fn frontmatter_stops_at_closing_fence() {
        // A `description:` in the body (after the closing ---) must not be read.
        let text = "---\nname: a\n---\ndescription: body line\n";
        let (name, desc) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("a"));
        assert!(desc.is_none());
    }

    #[test]
    fn scaffold_has_valid_frontmatter() {
        let md = scaffold("invoice-fixer", "Fixes invoices.");
        let (name, desc) = parse_frontmatter(&md);
        assert_eq!(name.as_deref(), Some("invoice-fixer"));
        assert_eq!(desc.as_deref(), Some("Fixes invoices."));
        assert!(md.contains("# Invoice Fixer"));
    }

    #[test]
    fn safe_component_rejects_traversal() {
        assert!(is_safe_component("ok-name"));
        assert!(!is_safe_component(".."));
        assert!(!is_safe_component("a/b"));
        assert!(!is_safe_component("a\\b"));
        assert!(!is_safe_component(""));
    }

    #[test]
    fn scope_base_rejects_plugin_and_unknown() {
        assert!(scope_base("plugin", "C:/repo").is_err());
        assert!(scope_base("nope", "C:/repo").is_err());
        assert!(scope_base("project", "C:/repo").is_ok());
    }
}
