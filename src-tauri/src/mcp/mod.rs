//! MCP server manager (step 3.7) — design §7 "MCP server manager".
//!
//! Views and edits Claude Code's MCP servers across the three scopes (design §7,
//! precedence **local > project > user**):
//!
//!   • **user**    — global, `~/.claude.json` top-level `mcpServers`.
//!   • **local**   — private to you for this project, `~/.claude.json` under
//!                   `projects[<project dir>].mcpServers` (NOT
//!                   `.claude/settings.local.json` — a documented gotcha).
//!   • **project** — shared, git-committed `<root>/.mcp.json` `mcpServers`.
//!
//! **Reads** parse those JSON files directly: that yields structured records
//! (transport, args, env, headers) with reliable scope/precedence, and avoids
//! `claude mcp list`'s human-formatted, network-health-checked output.
//!
//! **Writes** shell out to `claude mcp add` / `claude mcp remove` (decision: the CLI
//! is authoritative and won't corrupt the large shared `~/.claude.json` the way a
//! hand-rolled JSON rewrite could). The small `.mcp.json` additionally gets a
//! raw-text editor (`mcp_project_file` / `mcp_save_project_file`) — that file is
//! safe to edit directly and is the only place the CLI can't fully express.
//!
//! `claude mcp` resolves `project`/`local` scope from its working directory, so
//! every shell-out runs with `current_dir(project_root)`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// A single environment variable or HTTP header, as an ordered pair so the editor
/// can round-trip it (a JSON object loses nothing here but a map is awkward to edit
/// row-by-row on the frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// One configured MCP server, resolved from a scope's config (the list row).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// `"user" | "project" | "local"`.
    pub scope: String,
    /// `"stdio" | "http" | "sse"`.
    pub transport: String,
    /// The launch command (stdio only).
    pub command: Option<String>,
    /// Arguments after the command (stdio only).
    pub args: Vec<String>,
    /// The endpoint URL (http/sse only).
    pub url: Option<String>,
    /// Environment variables (stdio).
    pub env: Vec<KeyValue>,
    /// Request headers (http/sse).
    pub headers: Vec<KeyValue>,
    /// True when a higher-precedence scope defines a server with the same name, so
    /// this one is overridden (local > project > user).
    pub shadowed: bool,
}

/// Add (or edit) input from the frontend. An edit is modelled as remove-then-add
/// (the CLI has no edit verb); `replaces` names the row being replaced so a rename
/// drops the old entry first.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMcpServer {
    pub project_root: String,
    pub scope: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<KeyValue>,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    /// Previous name to remove before adding (set on an edit, esp. a rename).
    pub replaces: Option<String>,
}

// ---------------------------------------------------------------------------
// Read path — parse the config files directly.
// ---------------------------------------------------------------------------

/// List every MCP server visible to `project_root`, across all three scopes, with
/// `shadowed` marking the entries a higher-precedence scope overrides. Sorted by
/// name then precedence so the frontend can group/render deterministically.
#[tauri::command]
pub fn mcp_list(project_root: String) -> Result<Vec<McpServer>, String> {
    let mut out: Vec<McpServer> = Vec::new();
    let claude = read_claude_json();

    // user scope — top-level mcpServers.
    if let Some(map) = claude.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg) in map {
            out.push(parse_server(name, "user", cfg));
        }
    }

    // local scope — projects[<this dir>].mcpServers. Claude Code keys the project
    // map by the working directory (forward-slashed on Windows), so match on a
    // normalized path rather than a raw string compare.
    if let Some(projects) = claude.get("projects").and_then(|v| v.as_object()) {
        let want = norm_path(&project_root);
        if let Some((_, entry)) = projects.iter().find(|(k, _)| norm_path(k) == want) {
            if let Some(map) = entry.get("mcpServers").and_then(|v| v.as_object()) {
                for (name, cfg) in map {
                    out.push(parse_server(name, "local", cfg));
                }
            }
        }
    }

    // project scope — <root>/.mcp.json mcpServers.
    if let Ok(text) = std::fs::read_to_string(Path::new(&project_root).join(".mcp.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(map) = v.get("mcpServers").and_then(|m| m.as_object()) {
                for (name, cfg) in map {
                    out.push(parse_server(name, "project", cfg));
                }
            }
        }
    }

    mark_shadowed(&mut out);
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| scope_rank(&a.scope).cmp(&scope_rank(&b.scope)))
    });
    Ok(out)
}

/// Read `~/.claude.json` as a JSON value (the big shared config). A missing or
/// unparseable file yields `Null` so the read path degrades to "no servers".
fn read_claude_json() -> serde_json::Value {
    home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".claude.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Build an `McpServer` from one entry of a `mcpServers` object. Transport comes
/// from the `type` field, falling back to http when a `url` is present (older
/// entries omit `type`) and stdio otherwise.
fn parse_server(name: &str, scope: &str, cfg: &serde_json::Value) -> McpServer {
    let declared = cfg.get("type").and_then(|t| t.as_str());
    let command = cfg
        .get("command")
        .and_then(|c| c.as_str())
        .map(str::to_owned);
    let url = cfg.get("url").and_then(|u| u.as_str()).map(str::to_owned);
    let transport = match declared {
        Some(t) => t.to_owned(),
        None if url.is_some() => "http".to_owned(),
        None => "stdio".to_owned(),
    };
    let args = cfg
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    McpServer {
        name: name.to_owned(),
        scope: scope.to_owned(),
        transport,
        command,
        args,
        url,
        env: parse_kv(cfg.get("env")),
        headers: parse_kv(cfg.get("headers")),
        shadowed: false,
    }
}

/// Parse a JSON object of string values into sorted key/value pairs (stable order
/// for the editor). Non-string values are stringified so nothing is silently lost.
fn parse_kv(value: Option<&serde_json::Value>) -> Vec<KeyValue> {
    let mut out: Vec<KeyValue> = match value.and_then(|v| v.as_object()) {
        Some(map) => map
            .iter()
            .map(|(k, v)| KeyValue {
                key: k.clone(),
                value: v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()),
            })
            .collect(),
        None => Vec::new(),
    };
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// Precedence rank: lower wins (local > project > user). Unknown scopes sort last.
fn scope_rank(scope: &str) -> u8 {
    match scope {
        "local" => 0,
        "project" => 1,
        "user" => 2,
        _ => 3,
    }
}

/// Flag every server overridden by a higher-precedence scope sharing its name.
fn mark_shadowed(list: &mut [McpServer]) {
    let mut best: HashMap<String, u8> = HashMap::new();
    for s in list.iter() {
        let r = scope_rank(&s.scope);
        best.entry(s.name.clone())
            .and_modify(|b| {
                if r < *b {
                    *b = r;
                }
            })
            .or_insert(r);
    }
    for s in list.iter_mut() {
        if let Some(&top) = best.get(&s.name) {
            s.shadowed = scope_rank(&s.scope) > top;
        }
    }
}

/// Normalize a path for comparison: forward slashes, no trailing slash, lowercased
/// (Windows is case-insensitive and Claude Code stores the dir as the user typed it).
fn norm_path(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

// ---------------------------------------------------------------------------
// Write path — drive the `claude mcp` CLI.
// ---------------------------------------------------------------------------

/// Add (or replace) an MCP server via `claude mcp add`. On an edit, the previous
/// entry (`replaces`, falling back to the new name) is removed first so `add`
/// doesn't reject a duplicate — the CLI has no in-place edit.
#[tauri::command]
pub fn mcp_add(input: NewMcpServer) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("a server name is required".into());
    }
    let args = build_add_args(&input)?;

    // Remove the row this add supersedes (ignore "not found"): a fresh add removes
    // its own name (a harmless no-op), an edit removes the name it replaces.
    let prior = input.replaces.clone().unwrap_or_else(|| input.name.clone());
    let _ = run_claude(
        &input.project_root,
        &[
            "mcp".into(),
            "remove".into(),
            "--scope".into(),
            input.scope.clone(),
            prior,
        ],
    );

    run_claude(&input.project_root, &args).map(|_| ())
}

/// Remove an MCP server from a specific scope via `claude mcp remove`.
#[tauri::command]
pub fn mcp_remove(project_root: String, scope: String, name: String) -> Result<(), String> {
    run_claude(
        &project_root,
        &["mcp".into(), "remove".into(), "--scope".into(), scope, name],
    )
    .map(|_| ())
}

/// Assemble the `claude mcp add …` argv for a server. Mirrors the CLI grammar:
/// `mcp add [--scope s] [--transport t] [-e K=V…|-H "K: V"…] <name> [-- <command> args…|<url>]`.
fn build_add_args(input: &NewMcpServer) -> Result<Vec<String>, String> {
    if !matches!(input.scope.as_str(), "user" | "project" | "local") {
        return Err(format!("unknown scope: {}", input.scope));
    }
    let transport = if input.transport.trim().is_empty() {
        "stdio"
    } else {
        input.transport.trim()
    };

    let mut a: Vec<String> = vec![
        "mcp".into(),
        "add".into(),
        "--scope".into(),
        input.scope.clone(),
        "--transport".into(),
        transport.to_owned(),
    ];

    match transport {
        "http" | "sse" => {
            for h in &input.headers {
                if h.key.trim().is_empty() {
                    continue;
                }
                a.push("-H".into());
                a.push(format!("{}: {}", h.key.trim(), h.value));
            }
            let url = input.url.as_deref().unwrap_or("").trim();
            if url.is_empty() {
                return Err("an http/sse server needs a url".into());
            }
            a.push(input.name.clone());
            a.push(url.to_owned());
        }
        "stdio" => {
            for e in &input.env {
                if e.key.trim().is_empty() {
                    continue;
                }
                a.push("-e".into());
                a.push(format!("{}={}", e.key.trim(), e.value));
            }
            let command = input.command.as_deref().unwrap_or("").trim();
            if command.is_empty() {
                return Err("a stdio server needs a command".into());
            }
            a.push(input.name.clone());
            // `--` guards args that start with `-` from being parsed as flags.
            a.push("--".into());
            a.push(command.to_owned());
            for arg in &input.args {
                a.push(arg.clone());
            }
        }
        other => return Err(format!("unknown transport: {other}")),
    }
    Ok(a)
}

/// The raw text of a project's `.mcp.json` (the small git-committed file), or an
/// empty string when it doesn't exist yet — backing the raw-JSON editor.
#[tauri::command]
pub fn mcp_project_file(project_root: String) -> Result<String, String> {
    let path = Path::new(&project_root).join(".mcp.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("cannot read .mcp.json: {e}")),
    }
}

/// Write a project's `.mcp.json`, validating it parses as JSON first so the editor
/// can never persist a corrupt file. An empty body removes the file (no servers).
#[tauri::command]
pub fn mcp_save_project_file(project_root: String, content: String) -> Result<(), String> {
    let path = Path::new(&project_root).join(".mcp.json");
    if content.trim().is_empty() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("cannot remove .mcp.json: {e}"))?;
        }
        return Ok(());
    }
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("invalid JSON: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("cannot write .mcp.json: {e}"))
}

/// Run `claude <args>` in `cwd`, returning trimmed stdout on success or the captured
/// stderr (else stdout) on failure so the dialog can surface *why* the CLI rejected.
fn run_claude(cwd: &str, args: &[String]) -> Result<String, String> {
    let out = claude_command(Path::new(cwd), args)?
        .output()
        .map_err(|e| format!("failed to run claude: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let msg = if !err.is_empty() { err } else { stdout };
        return Err(if msg.is_empty() {
            "claude mcp command failed".to_owned()
        } else {
            msg
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Build a `Command` for `claude <args>` in `cwd`. `claude` is resolved off PATH;
/// a `.cmd`/`.bat` shim can't be handed to `CreateProcess` directly, so it's run
/// through `cmd.exe /c` (and a `.ps1` shim through PowerShell) — the same handling
/// as the PTY launcher (`pty::claude_command`). The Windows console window the
/// shim would flash is suppressed.
fn claude_command(cwd: &Path, args: &[String]) -> Result<Command, String> {
    let exe = which::which("claude")
        .map_err(|e| format!("`claude` not found on PATH ({e}). Is Claude Code installed?"))?;
    let ext = exe
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);

    let mut cmd = match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = Command::new("cmd.exe");
            c.arg("/c").arg(&exe).args(args);
            c
        }
        Some("ps1") => {
            let mut c = Command::new("pwsh.exe");
            c.arg("-NoLogo").arg("-File").arg(&exe).args(args);
            c
        }
        _ => {
            let mut c = Command::new(&exe);
            c.args(args);
            c
        }
    };
    cmd.current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(transport: &str) -> NewMcpServer {
        NewMcpServer {
            project_root: "C:/repo".into(),
            scope: "user".into(),
            name: "demo".into(),
            transport: transport.into(),
            command: None,
            args: vec![],
            url: None,
            env: vec![],
            headers: vec![],
            replaces: None,
        }
    }

    #[test]
    fn stdio_add_args_put_command_after_double_dash() {
        let mut i = input("stdio");
        i.command = Some("npx".into());
        i.args = vec!["my-server".into(), "--flag".into()];
        i.env = vec![KeyValue { key: "API_KEY".into(), value: "x".into() }];
        let a = build_add_args(&i).unwrap();
        assert_eq!(
            a,
            vec![
                "mcp", "add", "--scope", "user", "--transport", "stdio", "-e", "API_KEY=x",
                "demo", "--", "npx", "my-server", "--flag",
            ]
        );
    }

    #[test]
    fn http_add_args_carry_url_and_headers() {
        let mut i = input("http");
        i.url = Some("https://example.com/mcp".into());
        i.headers = vec![KeyValue { key: "Authorization".into(), value: "Bearer t".into() }];
        let a = build_add_args(&i).unwrap();
        assert_eq!(
            a,
            vec![
                "mcp", "add", "--scope", "user", "--transport", "http", "-H",
                "Authorization: Bearer t", "demo", "https://example.com/mcp",
            ]
        );
    }

    #[test]
    fn add_args_reject_missing_command_or_url() {
        assert!(build_add_args(&input("stdio")).is_err()); // no command
        assert!(build_add_args(&input("http")).is_err()); // no url
        let mut bad = input("stdio");
        bad.scope = "global".into();
        assert!(build_add_args(&bad).is_err()); // unknown scope
    }

    #[test]
    fn parse_server_infers_transport_and_reads_fields() {
        let stdio = parse_server(
            "s",
            "local",
            &json!({ "command": "docker", "args": ["run", "x"], "env": { "T": "1" } }),
        );
        assert_eq!(stdio.transport, "stdio"); // no type, no url → stdio
        assert_eq!(stdio.command.as_deref(), Some("docker"));
        assert_eq!(stdio.args, vec!["run", "x"]);
        assert_eq!(stdio.env.len(), 1);

        let http = parse_server("h", "user", &json!({ "url": "https://x/mcp" }));
        assert_eq!(http.transport, "http"); // url present, no type → http
        assert_eq!(http.url.as_deref(), Some("https://x/mcp"));

        let typed = parse_server("t", "user", &json!({ "type": "sse", "url": "https://x/sse" }));
        assert_eq!(typed.transport, "sse");
    }

    #[test]
    fn shadowing_follows_local_over_project_over_user() {
        let mut list = vec![
            parse_server("dup", "user", &json!({ "url": "https://u" })),
            parse_server("dup", "project", &json!({ "url": "https://p" })),
            parse_server("solo", "user", &json!({ "url": "https://s" })),
        ];
        mark_shadowed(&mut list);
        let by = |scope: &str| list.iter().find(|s| s.name == "dup" && s.scope == scope).unwrap();
        assert!(by("user").shadowed, "user is overridden by project");
        assert!(!by("project").shadowed, "project wins over user");
        assert!(!list.iter().find(|s| s.name == "solo").unwrap().shadowed);
    }

    #[test]
    fn norm_path_unifies_separators_and_case() {
        assert_eq!(norm_path("C:\\Users\\Me\\repo\\"), "c:/users/me/repo");
        assert_eq!(norm_path("C:/Users/Me/repo"), "c:/users/me/repo");
    }
}
