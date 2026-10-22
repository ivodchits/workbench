//! Duck's host for stdio MCP servers (step B2): the servers in your Claude Code
//! config (`crate::mcp::mcp_list`, user scope first), started as Duck's own
//! processes so Duck can use them from its thread without a worker session. The
//! first is your Firefox bridge (`uvx … mcp-bridge-for-firefox --stdio`); the
//! engine decides which servers are opted in (`src/assistant/tools/mcpHost.ts`).
//!
//! - **Lazy:** a server starts on its first call (no window, no shell unless its
//!   command is a `.cmd`), and its process tree is killed after 10 minutes idle or
//!   when the app exits. Your Firefox add-on reconnects to it by itself.
//! - **The tool list** is kept in `mcp_tool_cache` by a hash of the command line, so
//!   at start Duck knows a server's tools without starting it, and the list the
//!   model sees stays the same from request to request. A changed command line
//!   (a new commit of the bridge) is a new key: the list is fetched again.
//! - The server's environment (it may hold a token) is passed to the child and
//!   never returned to the webview.
//!
//! `firefox_start_profile` starts Firefox on the agent profile, which Firefox's
//! profile switcher doesn't list, when a browser task needs it and no add-on is
//! connected.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use super::Assistant;

/// A server idle this long is stopped.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// The first start of a `uvx --from git+…` server installs it: give it time.
const START_TIMEOUT: Duration = Duration::from_secs(120);
const LIST_TIMEOUT: Duration = Duration::from_secs(60);

struct Live {
    service: Arc<RunningService<RoleClient, ()>>,
    pid: Option<u32>,
    key: String,
    last: Instant,
}

/// Tauri-managed: the servers running now, by name.
#[derive(Default, Clone)]
pub struct McpHost {
    live: Arc<tokio::sync::Mutex<HashMap<String, Live>>>,
    reaper: Arc<std::sync::atomic::AtomicBool>,
}

/// A stdio server as your Claude Code config defines it.
struct Spec {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

impl Spec {
    /// The cache key: the command line, hashed (the environment is left out: it
    /// may hold a secret, and doesn't change the tools).
    fn key(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.command.as_bytes());
        for a in &self.args {
            h.update([0u8]);
            h.update(a.as_bytes());
        }
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "no home folder".to_string())
}

fn spec(server: &str) -> Result<Spec, String> {
    let home = home()?;
    let list = crate::mcp::mcp_list(home.to_string_lossy().into_owned())?;
    let s = list
        .into_iter()
        .find(|s| s.name == server && !s.shadowed)
        .ok_or_else(|| format!("there's no MCP server \"{server}\" in your Claude Code config"))?;
    if s.transport != "stdio" {
        return Err(format!("\"{server}\" isn't a stdio server (Duck reaches http servers through its own settings)"));
    }
    let command = s.command.filter(|c| !c.trim().is_empty()).ok_or_else(|| format!("\"{server}\" has no command"))?;
    Ok(Spec {
        command,
        args: s.args,
        env: s.env.into_iter().map(|kv| (kv.key, kv.value)).collect(),
    })
}

fn command(spec: &Spec) -> Result<tokio::process::Command, String> {
    let exe = which::which(&spec.command).map_err(|e| format!("`{}` isn't on PATH ({e})", spec.command))?;
    let ext = exe.extension().and_then(OsStr::to_str).map(str::to_ascii_lowercase);
    let mut cmd = match ext.as_deref() {
        // A `.cmd` shim (npx) can only run through cmd.exe.
        Some("cmd") | Some("bat") => {
            let mut c = tokio::process::Command::new("cmd.exe");
            c.arg("/c").arg(&exe);
            c
        }
        _ => tokio::process::Command::new(&exe),
    };
    cmd.args(&spec.args).envs(spec.env.iter().cloned()).current_dir(home()?).kill_on_drop(true);
    cmd.env_remove(crate::hooks::install::INSTANCE_ENV);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

impl McpHost {
    /// The running service for `server`, started if it isn't.
    async fn ensure(&self, server: &str) -> Result<(Arc<RunningService<RoleClient, ()>>, String), String> {
        let spec = spec(server)?;
        let key = spec.key();
        let mut live = self.live.lock().await;
        if let Some(l) = live.get_mut(server) {
            if l.key == key && !l.service.is_transport_closed() {
                l.last = Instant::now();
                return Ok((l.service.clone(), key));
            }
            let old = live.remove(server).unwrap();
            stop(old);
        }
        let cmd = command(&spec)?;
        let (transport, _) = TokioChildProcess::builder(cmd)
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("{server} couldn't be started: {e}"))?;
        let pid = transport.id();
        let service = match tokio::time::timeout(START_TIMEOUT, ().serve(transport)).await {
            Ok(Ok(s)) => Arc::new(s),
            Ok(Err(e)) => {
                kill_pid(pid);
                return Err(format!("{server} started but didn't speak MCP: {e}"));
            }
            Err(_) => {
                kill_pid(pid);
                return Err(format!("{server} didn't finish starting in {} s", START_TIMEOUT.as_secs()));
            }
        };
        live.insert(server.to_string(), Live { service: service.clone(), pid, key: key.clone(), last: Instant::now() });
        drop(live);
        self.start_reaper();
        Ok((service, key))
    }

    async fn touch(&self, server: &str) {
        if let Some(l) = self.live.lock().await.get_mut(server) {
            l.last = Instant::now();
        }
    }

    async fn drop_server(&self, server: &str) {
        if let Some(l) = self.live.lock().await.remove(server) {
            stop(l);
        }
    }

    /// Once: stop servers that have been idle for [`IDLE`].
    fn start_reaper(&self) {
        if self.reaper.swap(true, std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let mut live = host.live.lock().await;
                let idle: Vec<String> =
                    live.iter().filter(|(_, l)| l.last.elapsed() >= IDLE).map(|(n, _)| n.clone()).collect();
                for n in idle {
                    if let Some(l) = live.remove(&n) {
                        stop(l);
                    }
                }
            }
        });
    }

    fn kill_all(&self) {
        if let Ok(mut live) = self.live.try_lock() {
            for (_, l) in live.drain() {
                stop(l);
            }
        }
    }
}

fn kill_pid(pid: Option<u32>) {
    if let Some(pid) = pid {
        // uvx starts the server as its own child: the tree goes, not just uvx.
        crate::pty::kill_tree(pid);
    }
}

fn stop(l: Live) {
    kill_pid(l.pid);
    if let Ok(service) = Arc::try_unwrap(l.service) {
        tauri::async_runtime::spawn(async move {
            let _ = service.cancel().await;
        });
    }
}

/// Stop every server Duck started (the app is exiting).
pub fn kill_all(app: &AppHandle) {
    if let Some(host) = app.try_state::<McpHost>() {
        host.kill_all();
    }
}

fn cached(conn: &Connection, key: &str) -> Result<Option<(String, i64)>, String> {
    conn.query_row("SELECT tools, at FROM mcp_tool_cache WHERE key = ?1", params![key], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())
}

fn store(conn: &Connection, key: &str, tools: &str, at: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mcp_tool_cache (key, tools, at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET tools = excluded.tools, at = excluded.at",
        params![key, tools, at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A server's tools: `{tools, at, cached}`. From the cache when it has them for
/// this command line and `refresh` is false (nothing starts); otherwise the server
/// is started and asked.
#[tauri::command]
pub async fn mcp_host_tools(
    ctx: State<'_, Arc<Assistant>>,
    host: State<'_, McpHost>,
    server: String,
    refresh: Option<bool>,
) -> Result<Value, String> {
    let key = spec(&server)?.key();
    if refresh != Some(true) {
        if let Some((tools, at)) = cached(&super::lock(&ctx), &key)? {
            let tools: Value = serde_json::from_str(&tools).map_err(|e| e.to_string())?;
            return Ok(json!({"tools": tools, "at": at, "cached": true}));
        }
    }
    let (service, key) = host.ensure(&server).await?;
    let tools = match tokio::time::timeout(LIST_TIMEOUT, service.list_all_tools()).await {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            host.drop_server(&server).await;
            return Err(format!("{server} couldn't list its tools: {e}"));
        }
        Err(_) => return Err(format!("{server} didn't list its tools in time")),
    };
    let tools = serde_json::to_value(tools).map_err(|e| e.to_string())?;
    let at = super::now_ms();
    store(&super::lock(&ctx), &key, &tools.to_string(), at)?;
    Ok(json!({"tools": tools, "at": at, "cached": false}))
}

/// Call `tool` on `server` (started if it isn't); the MCP `CallToolResult`.
#[tauri::command]
pub async fn mcp_host_call(
    host: State<'_, McpHost>,
    server: String,
    tool: String,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let (service, _) = host.ensure(&server).await?;
    let mut params = CallToolRequestParams::new(tool.clone());
    match args {
        Some(Value::Object(m)) => params = params.with_arguments(m),
        None | Some(Value::Null) => {}
        Some(_) => return Err("a tool's arguments are an object".into()),
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 300_000));
    let out = tokio::time::timeout(timeout, service.call_tool(params)).await;
    host.touch(&server).await;
    match out {
        Ok(Ok(r)) => serde_json::to_value(r).map_err(|e| e.to_string()),
        Ok(Err(e)) => {
            if service.is_transport_closed() {
                host.drop_server(&server).await;
                return Err(format!("{server} stopped while calling {tool}: {e}"));
            }
            Err(format!("{server}: {tool} failed: {e}"))
        }
        Err(_) => Err(format!("{server}: {tool} didn't answer in {} s", timeout.as_secs())),
    }
}

/// The stdio servers in your Claude Code config Duck could host: each one's name
/// and its command's name (no arguments or environment: they may hold secrets).
#[tauri::command]
pub fn mcp_host_servers() -> Result<Vec<Value>, String> {
    let home = home()?;
    Ok(crate::mcp::mcp_list(home.to_string_lossy().into_owned())?
        .into_iter()
        .filter(|s| s.transport == "stdio" && !s.shadowed)
        .map(|s| {
            let command = s.command.as_deref().map(|c| {
                std::path::Path::new(c).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
            });
            json!({"name": s.name, "command": command})
        })
        .collect())
}

/// The servers running now.
#[tauri::command]
pub async fn mcp_host_running(host: State<'_, McpHost>) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = host.live.lock().await.keys().cloned().collect();
    names.sort();
    Ok(names)
}

/// Stop `server` now (its tree is killed).
#[tauri::command]
pub async fn mcp_host_stop(host: State<'_, McpHost>, server: String) -> Result<(), String> {
    host.drop_server(&server).await;
    Ok(())
}

fn firefox_exe() -> Option<PathBuf> {
    if let Ok(p) = which::which("firefox") {
        return Some(p);
    }
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|d| PathBuf::from(d).join("Mozilla Firefox").join("firefox.exe"))
        .find(|p| p.is_file())
}

fn profile_name_ok(p: &str) -> bool {
    !p.is_empty() && p.len() <= 64 && p.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

/// Start Firefox on `profile` (`firefox.exe -P <profile> --no-remote`), apart from
/// any Firefox already running. It isn't waited on, and it stays open.
#[tauri::command]
pub fn firefox_start_profile(profile: String) -> Result<(), String> {
    if !profile_name_ok(&profile) {
        return Err(format!("\"{profile}\" isn't a profile name"));
    }
    let exe = firefox_exe().ok_or("Firefox isn't installed (no firefox.exe found)")?;
    std::process::Command::new(exe)
        .args(["-P", &profile, "--no-remote"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Firefox couldn't be started: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cache_key_is_the_command_line_and_rows_are_replaced() {
        let a = Spec { command: "uvx".into(), args: vec!["--from".into(), "x@1".into()], env: vec![] };
        let b = Spec { command: "uvx".into(), args: vec!["--from".into(), "x@2".into()], env: vec![("T".into(), "s".into())] };
        let a2 = Spec { command: "uvx".into(), args: vec!["--fromx@1".into()], env: vec![] };
        assert_ne!(a.key(), b.key());
        assert_ne!(a.key(), a2.key());
        assert_eq!(a.key().len(), 64);

        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(cached(&conn, &a.key()).unwrap().is_none());
        store(&conn, &a.key(), "[1]", 5).unwrap();
        store(&conn, &a.key(), "[2]", 6).unwrap();
        assert_eq!(cached(&conn, &a.key()).unwrap(), Some(("[2]".into(), 6)));
    }

    /// The pids whose parent is `pid` (Windows).
    #[cfg(windows)]
    fn children(pid: u32) -> Vec<u32> {
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("(Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}').ProcessId")])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    /// Your real Firefox bridge, from your Claude Code config: it starts, lists
    /// its tools, and its whole tree (uvx and the Python under it) goes when
    /// stopped. `cargo test --lib live_firefox -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_firefox_bridge_starts_lists_and_dies() {
        tauri::async_runtime::block_on(async {
            let host = McpHost::default();
            let (service, _) = host.ensure("firefox").await.unwrap();
            let tools = service.list_all_tools().await.unwrap();
            assert!(tools.iter().any(|t| t.name == "browsers_list"), "{} tools", tools.len());
            // A read: the result as the webview gets it.
            let r = service.call_tool(CallToolRequestParams::new("browsers_list")).await.unwrap();
            let v = serde_json::to_value(r).unwrap();
            println!("browsers_list: {v}");
            assert_eq!(v["content"][0]["type"], "text");
            let pid = host.live.lock().await.get("firefox").unwrap().pid.unwrap();
            let kids = children(pid);
            println!("bridge pid {pid}, children {kids:?}, {} tools", tools.len());
            assert!(!kids.is_empty(), "uvx should have started the server as its child");
            drop(service);
            host.drop_server("firefox").await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            assert!(!alive(pid), "uvx is still running");
            for k in kids {
                assert!(!alive(k), "child {k} is still running");
            }
        });
    }

    #[test]
    fn profile_names_are_plain() {
        assert!(profile_name_ok("claude-agent"));
        assert!(profile_name_ok("default release"));
        assert!(!profile_name_ok(""));
        assert!(!profile_name_ok("x\" -url evil"));
        assert!(!profile_name_ok("a/b"));
    }
}
