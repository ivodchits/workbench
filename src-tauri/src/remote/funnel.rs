//! Tailscale Funnel (step R3): the remote server at a fixed public HTTPS address, so a
//! phone without Tailscale can reach it.
//!
//! Funnel is driven through the `tailscale` CLI. Tailscale terminates TLS on its public
//! relays and proxies to the server's loopback listener. What we need from the CLI is
//! small: `status --json` (connected? HTTPS certificates and the Funnel attribute
//! granted?), `serve status --json` (is our port already taken, and by what?), and
//! `funnel --bg` / `funnel … off` to add and remove our one entry. The parsing and the
//! "what's missing" rules are pure and unit-tested. Running the CLI is kept to
//! [`run`].
//!
//! We never replace a serve entry someone else made: a port already serving anything
//! other than our loopback address is reported, not overwritten.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// The public HTTPS port. Funnel serves only 443, 8443 and 10000. A release takes 443
/// (an address with no port in it), a debug build 8443, so both can be public at once.
pub const FUNNEL_PORT: u16 = if cfg!(debug_assertions) { 8443 } else { 443 };

/// How long one CLI call may take. `funnel` can sit waiting on a consent URL when the
/// tailnet has not enabled Funnel; we read what it said and stop it.
const CLI_TIMEOUT: Duration = Duration::from_secs(20);

/// Where public access stands, for the menu.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PublicPhase {
    /// Switched off (or the server is off).
    Off,
    /// Switched on; not checked yet.
    Starting,
    /// Serving at `url`.
    On,
    /// Switched on, but something is missing; `problem` says what.
    Problem,
}

/// What the Remote Access menu shows about public access.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicStatus {
    /// The switch.
    pub enabled: bool,
    pub phase: PublicPhase,
    /// `https://<machine>.<tailnet>.ts.net[:port]` once known.
    pub url: Option<String>,
    /// The public port this build uses.
    pub port: u16,
    pub problem: Option<String>,
    /// A page that fixes `problem`, when there is one.
    pub fix_url: Option<String>,
}

impl PublicStatus {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            phase: if enabled { PublicPhase::Starting } else { PublicPhase::Off },
            url: None,
            port: FUNNEL_PORT,
            problem: None,
            fix_url: None,
        }
    }
}

/// Something that stops public access, in words for the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub message: String,
    pub fix_url: Option<String>,
}

impl Problem {
    fn new(message: impl Into<String>, fix_url: Option<&str>) -> Self {
        Self { message: message.into(), fix_url: fix_url.map(str::to_string) }
    }
}

const ADMIN_DNS: &str = "https://login.tailscale.com/admin/dns";
const ADMIN_ACLS: &str = "https://login.tailscale.com/admin/acls/file";
const FUNNEL_DOCS: &str = "https://tailscale.com/kb/1223/funnel";
const DOWNLOAD: &str = "https://tailscale.com/download";

/// The facts we need from `tailscale status --json`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TsInfo {
    /// `Running`, `Stopped`, `NeedsLogin`, `Starting`, …
    pub backend: String,
    /// This machine's MagicDNS name, without the trailing dot.
    pub host: Option<String>,
    /// HTTPS certificates are enabled for the tailnet.
    pub https: bool,
    /// The Funnel node attribute is granted to this machine.
    pub funnel: bool,
    /// The public ports Funnel allows, when the tailnet says.
    pub funnel_ports: Option<Vec<u16>>,
}

pub fn parse_status(v: &Value) -> TsInfo {
    let me = &v["Self"];
    // Capabilities arrive as `CapMap` keys (current) or a `Capabilities` list (older).
    let mut caps: Vec<String> = me["CapMap"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    if let Some(list) = me["Capabilities"].as_array() {
        caps.extend(list.iter().filter_map(|c| c.as_str().map(str::to_string)));
    }
    let has = |name: &str| {
        caps.iter()
            .any(|c| c == name || c == &format!("https://tailscale.com/cap/{name}"))
    };
    let funnel_ports = caps.iter().find_map(|c| {
        let list = c.strip_prefix("https://tailscale.com/cap/funnel-ports?ports=")?;
        Some(list.split(',').filter_map(|p| p.trim().parse().ok()).collect())
    });
    let cert_domains = v["CertDomains"].as_array().is_some_and(|d| !d.is_empty());
    TsInfo {
        backend: v["BackendState"].as_str().unwrap_or("").to_string(),
        host: me["DNSName"]
            .as_str()
            .map(|n| n.trim_end_matches('.').to_string())
            .filter(|n| !n.is_empty()),
        https: has("https") || cert_domains,
        funnel: has("funnel"),
        funnel_ports,
    }
}

/// What stands between this machine and a funnel on `port`, if anything. On success,
/// the machine's public host name.
pub fn diagnose(info: &TsInfo, port: u16) -> Result<String, Problem> {
    match info.backend.as_str() {
        "Running" => {}
        "NeedsLogin" | "NeedsMachineAuth" => {
            return Err(Problem::new(
                "Tailscale isn’t logged in. Log in from the Tailscale app; Workbench \
                 picks it up by itself.",
                None,
            ))
        }
        other => {
            let state = if other.is_empty() { "not running" } else { other };
            return Err(Problem::new(
                format!(
                    "Tailscale is disconnected ({}). Connect it from the Tailscale app; \
                     Workbench picks it up by itself.",
                    state.to_lowercase()
                ),
                None,
            ));
        }
    }
    let Some(host) = info.host.clone() else {
        return Err(Problem::new(
            "This machine has no tailnet name. Turn on MagicDNS for the tailnet (once).",
            Some(ADMIN_DNS),
        ));
    };
    if !info.https {
        return Err(Problem::new(
            "HTTPS certificates are off for the tailnet. Turn on “HTTPS Certificates” on \
             the DNS page (once).",
            Some(ADMIN_DNS),
        ));
    }
    if !info.funnel {
        return Err(Problem::new(
            "Funnel isn’t allowed for this machine. Add the “funnel” node attribute in the \
             tailnet policy (once).",
            Some(ADMIN_ACLS),
        ));
    }
    if let Some(ports) = &info.funnel_ports {
        if !ports.contains(&port) {
            let allowed: Vec<String> = ports.iter().map(u16::to_string).collect();
            return Err(Problem::new(
                format!(
                    "The tailnet allows Funnel only on port {}; this build needs {port}.",
                    allowed.join(", ")
                ),
                Some(FUNNEL_DOCS),
            ));
        }
    }
    Ok(host)
}

/// Who holds `host:port` in the serve config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    Free,
    /// Our funnel, already in place.
    Ours,
    /// Our proxy is there but not public (a `tailscale serve`), so `funnel` can take
    /// it over.
    OursPrivate,
    /// Something else, described.
    Other(String),
}

/// Read `tailscale serve status --json` for `host:port`. `target` is the loopback URL
/// our funnel proxies to.
pub fn parse_slot(v: &Value, host: &str, port: u16, target: &str) -> Slot {
    let key = format!("{host}:{port}");
    let web = &v["Web"][&key]["Handlers"];
    if let Some(handlers) = web.as_object() {
        let ours = handlers.len() == 1
            && handlers
                .get("/")
                .and_then(|h| h["Proxy"].as_str())
                .is_some_and(|p| same_target(p, target));
        if !ours {
            let what: Vec<String> = handlers
                .iter()
                .map(|(path, h)| {
                    let to = h["Proxy"]
                        .as_str()
                        .or_else(|| h["Path"].as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| "static content".into());
                    format!("{path} → {to}")
                })
                .collect();
            return Slot::Other(what.join(", "));
        }
        return if v["AllowFunnel"][&key].as_bool() == Some(true) {
            Slot::Ours
        } else {
            Slot::OursPrivate
        };
    }
    let tcp = &v["TCP"][port.to_string()];
    if tcp.is_object() && tcp["HTTPS"].as_bool() != Some(true) {
        let to = tcp["TCPForward"].as_str().unwrap_or("a TCP forwarder");
        return Slot::Other(format!("TCP → {to}"));
    }
    Slot::Free
}

/// Whether two proxy targets name the same place (`http://127.0.0.1:N` may be stored
/// with or without the scheme or a trailing slash).
fn same_target(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim_end_matches('/')
            .trim_start_matches("http://")
            .replace("localhost", "127.0.0.1")
    };
    norm(a) == norm(b)
}

/// The public address for `host` on `port`.
pub fn public_url(host: &str, port: u16) -> String {
    if port == 443 {
        format!("https://{host}")
    } else {
        format!("https://{host}:{port}")
    }
}

/// The first `https://login.tailscale.com/...` link in CLI output (the consent page
/// `funnel` prints when the tailnet hasn't enabled it).
pub fn find_link(text: &str) -> Option<String> {
    let start = text.find("https://login.tailscale.com/")?;
    let link: String = text[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
        .collect();
    Some(link.trim_end_matches(['.', ',', ')']).to_string())
}

/// The CLI's own words, first useful line, for the menu.
fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no output")
        .to_string()
}

/// The `tailscale` executable: on `PATH`, or where the installers put it.
pub fn find_cli() -> Option<PathBuf> {
    if let Ok(p) = which::which("tailscale") {
        return Some(p);
    }
    let known: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe"]
    } else if cfg!(target_os = "macos") {
        &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale"]
    } else {
        &["/usr/bin/tailscale", "/usr/local/bin/tailscale"]
    };
    known.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// One CLI call's result: whether it exited 0, and stdout + stderr.
struct Run {
    ok: bool,
    out: String,
}

/// Run the CLI with a deadline. A call that hangs (waiting on a consent page) is
/// killed and returns what it printed so far.
fn run(cli: &PathBuf, args: &[&str]) -> Result<Run, String> {
    let mut cmd = Command::new(cli);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn’t run tailscale: {e}"))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out_t = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err_t = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = Instant::now() + CLI_TIMEOUT;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let mut out = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned();
    out.push_str(&String::from_utf8_lossy(&err_t.join().unwrap_or_default()));
    Ok(Run { ok, out })
}

fn run_json(cli: &PathBuf, args: &[&str]) -> Result<Value, String> {
    let r = run(cli, args)?;
    serde_json::from_str(&r.out).map_err(|_| first_line(&r.out))
}

/// Make sure our funnel to `target` is up on [`FUNNEL_PORT`]. On success, the public
/// URL.
pub fn ensure(target: &str) -> Result<String, Problem> {
    let Some(cli) = find_cli() else {
        return Err(Problem::new(
            "The tailscale command isn’t installed. Install Tailscale and log in (once).",
            Some(DOWNLOAD),
        ));
    };
    let info = run_json(&cli, &["status", "--json"])
        .map(|v| parse_status(&v))
        .map_err(|e| Problem::new(format!("Couldn’t read Tailscale’s status: {e}"), None))?;
    let host = diagnose(&info, FUNNEL_PORT)?;
    let url = public_url(&host, FUNNEL_PORT);
    let slot = |cli: &PathBuf| {
        run_json(cli, &["serve", "status", "--json"])
            .map(|v| parse_slot(&v, &host, FUNNEL_PORT, target))
            .map_err(|e| Problem::new(format!("Couldn’t read the funnel setup: {e}"), None))
    };
    match slot(&cli)? {
        Slot::Ours => return Ok(url),
        Slot::Other(what) => {
            return Err(Problem::new(
                format!(
                    "Port {FUNNEL_PORT} is already serving {what}. Workbench won’t replace \
                     it; remove it with `tailscale serve --https={FUNNEL_PORT} off`."
                ),
                None,
            ))
        }
        Slot::Free | Slot::OursPrivate => {}
    }
    let https = format!("--https={FUNNEL_PORT}");
    let r = run(&cli, &["funnel", "--bg", "--yes", &https, target])
        .map_err(|e| Problem::new(e, None))?;
    if slot(&cli)? == Slot::Ours {
        return Ok(url);
    }
    let link = find_link(&r.out);
    let said = if r.ok { "it didn’t take".to_string() } else { first_line(&r.out) };
    Err(Problem::new(
        format!("Tailscale refused the funnel: {said}"),
        link.as_deref().or(Some(FUNNEL_DOCS)),
    ))
}

/// Remove our funnel, if it is there. Leaves anything else alone. `Ok(false)` means
/// Tailscale couldn't be asked (absent or disconnected), so it is worth retrying.
pub fn remove(target: &str) -> Result<bool, String> {
    let Some(cli) = find_cli() else { return Ok(true) };
    let info = parse_status(&run_json(&cli, &["status", "--json"])?);
    if info.backend != "Running" {
        return Ok(false);
    }
    let Some(host) = info.host else { return Ok(true) };
    let slot = parse_slot(&run_json(&cli, &["serve", "status", "--json"])?, &host, FUNNEL_PORT, target);
    if !matches!(slot, Slot::Ours | Slot::OursPrivate) {
        return Ok(true);
    }
    let https = format!("--https={FUNNEL_PORT}");
    let r = run(&cli, &["funnel", "--yes", &https, "off"])?;
    if r.ok {
        Ok(true)
    } else {
        Err(first_line(&r.out))
    }
}

/// `text` as a QR code, as an SVG document.
pub fn qr_svg(text: &str) -> Result<String, String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(160, 160)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(backend: &str, caps: &[&str]) -> Value {
        let cap_map: serde_json::Map<String, Value> =
            caps.iter().map(|c| (c.to_string(), json!([]))).collect();
        json!({
            "BackendState": backend,
            "CertDomains": ["box.tail1.ts.net"],
            "Self": { "DNSName": "box.tail1.ts.net.", "CapMap": cap_map },
        })
    }

    const ALL: &[&str] = &[
        "https",
        "funnel",
        "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000",
    ];

    #[test]
    fn reads_status() {
        let info = parse_status(&status("Running", ALL));
        assert_eq!(info.backend, "Running");
        assert_eq!(info.host.as_deref(), Some("box.tail1.ts.net"));
        assert!(info.https && info.funnel);
        assert_eq!(info.funnel_ports, Some(vec![443, 8443, 10000]));
        // The older list form counts too.
        let old = json!({
            "BackendState": "Running",
            "Self": { "DNSName": "a.b.ts.net.", "Capabilities": ["https://tailscale.com/cap/funnel"] },
        });
        let info = parse_status(&old);
        assert!(info.funnel && !info.https);
    }

    #[test]
    fn diagnoses_in_order() {
        let ok = parse_status(&status("Running", ALL));
        assert_eq!(diagnose(&ok, 443), Ok("box.tail1.ts.net".into()));
        assert_eq!(diagnose(&ok, 8443), Ok("box.tail1.ts.net".into()));

        let stopped = diagnose(&parse_status(&status("Stopped", ALL)), 443).unwrap_err();
        assert!(stopped.message.contains("disconnected (stopped)"), "{}", stopped.message);
        let login = diagnose(&parse_status(&status("NeedsLogin", ALL)), 443).unwrap_err();
        assert!(login.message.contains("logged in"));

        let mut no_https = parse_status(&status("Running", &["funnel"]));
        no_https.https = false;
        assert_eq!(diagnose(&no_https, 443).unwrap_err().fix_url.as_deref(), Some(ADMIN_DNS));

        let no_funnel = parse_status(&status("Running", &["https"]));
        assert_eq!(diagnose(&no_funnel, 443).unwrap_err().fix_url.as_deref(), Some(ADMIN_ACLS));

        let narrow = parse_status(&status(
            "Running",
            &["https", "funnel", "https://tailscale.com/cap/funnel-ports?ports=443"],
        ));
        assert!(diagnose(&narrow, 443).is_ok());
        assert!(diagnose(&narrow, 8443).unwrap_err().message.contains("only on port 443"));
    }

    const T: &str = "http://127.0.0.1:48990";

    #[test]
    fn reads_the_slot() {
        assert_eq!(parse_slot(&json!({}), "box", 443, T), Slot::Free);
        let ours = json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": { "box:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:48990" } } } },
            "AllowFunnel": { "box:443": true },
        });
        assert_eq!(parse_slot(&ours, "box", 443, T), Slot::Ours);
        // Another port of the same machine is free.
        assert_eq!(parse_slot(&ours, "box", 8443, T), Slot::Free);
        let private = json!({
            "Web": { "box:443": { "Handlers": { "/": { "Proxy": "127.0.0.1:48990/" } } } },
        });
        assert_eq!(parse_slot(&private, "box", 443, T), Slot::OursPrivate);
        let other = json!({
            "Web": { "box:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } },
            "AllowFunnel": { "box:443": true },
        });
        assert_eq!(
            parse_slot(&other, "box", 443, T),
            Slot::Other("/ → http://127.0.0.1:3000".into())
        );
        let tcp = json!({ "TCP": { "443": { "TCPForward": "127.0.0.1:22" } } });
        assert_eq!(parse_slot(&tcp, "box", 443, T), Slot::Other("TCP → 127.0.0.1:22".into()));
    }

    #[test]
    fn urls_and_links() {
        assert_eq!(public_url("box.t.ts.net", 443), "https://box.t.ts.net");
        assert_eq!(public_url("box.t.ts.net", 8443), "https://box.t.ts.net:8443");
        let said = "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         \
                    https://login.tailscale.com/f/funnel?node=abc123.\n";
        assert_eq!(
            find_link(said).as_deref(),
            Some("https://login.tailscale.com/f/funnel?node=abc123")
        );
        assert_eq!(find_link("nothing here"), None);
    }

    #[test]
    fn renders_a_qr_code() {
        let svg = qr_svg("https://box.t.ts.net").unwrap();
        assert!(svg.contains("<svg") && svg.contains("</svg>"));
    }
}
