use super::refuse::{answer as refusal, only_opens_media};
use super::serve::range;
use super::*;

fn conn() -> std::sync::MutexGuard<'static, Connection> {
    let db = Box::leak(Box::new(Db::open_in_memory().unwrap()));
    db.conn.lock().unwrap()
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wb-media-{name}-{}", new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_file_is_shown_by_its_extension() {
    assert_eq!(classify(Path::new("a/Chart.PNG")), (Kind::Image, "image/png"));
    assert_eq!(classify(Path::new("clip.mov")).0, Kind::Video);
    assert_eq!(classify(Path::new("x.flac")).0, Kind::Audio);
    assert_eq!(classify(Path::new("report.pdf")).0, Kind::File);
    assert_eq!(classify(Path::new("noext")).0, Kind::File);
}

#[test]
fn showing_registers_every_file_and_names_them_in_the_result() {
    let dir = temp_dir("show");
    std::fs::write(dir.join("chart.png"), [0u8; 2048]).unwrap();
    std::fs::write(dir.join("notes.pdf"), b"pdf").unwrap();
    let c = conn();
    let (text, ids) = show(
        &c,
        "inst-1",
        &["chart.png".into(), dir.join("notes.pdf").to_string_lossy().into_owned()],
        Some("  the chart  "),
        Some(&dir),
    )
    .unwrap();
    assert_eq!(ids.len(), 2);
    assert!(text.starts_with("Shown in the session: chart.png (picture, 2.0 KB), notes.pdf (file, 3 B, shown as a file card"));
    assert_eq!(text.lines().last().unwrap(), format!("media: {} {}", ids[0], ids[1]));

    let got = infos(&c, &ids);
    assert_eq!(got[0].kind, Kind::Image);
    assert_eq!(got[0].name, "chart.png");
    assert_eq!(got[0].caption.as_deref(), Some("the chart"));
    assert_eq!(got[0].state, "ok");
    assert_eq!(list(&c, "inst-1").len(), 2);
    assert!(list(&c, "other").is_empty());

    // Changed since it was shown, then gone.
    std::fs::write(dir.join("chart.png"), [1u8; 10]).unwrap();
    assert_eq!(lookup(&c, &ids[0]).unwrap().state, "changed");
    assert_eq!(lookup(&c, &ids[0]).unwrap().size, 10);
    std::fs::remove_file(dir.join("chart.png")).unwrap();
    assert_eq!(lookup(&c, &ids[0]).unwrap().state, "gone");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_file_is_an_error_and_nothing_is_registered() {
    let dir = temp_dir("missing");
    std::fs::write(dir.join("ok.png"), b"x").unwrap();
    let c = conn();
    let err = show(&c, "i", &["ok.png".into(), "nope.png".into()], None, Some(&dir)).unwrap_err();
    assert!(err.contains("nope.png (not found)"), "{err}");
    assert!(list(&c, "i").is_empty());
    // A relative path with no working dir to resolve it against.
    assert!(show(&c, "i", &["ok.png".into()], None, None).unwrap_err().contains("not an absolute path"));
    assert!(show(&c, "i", &[], None, None).is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_unknown_id_is_nothing() {
    let c = conn();
    assert!(lookup(&c, "deadbeef").is_none());
    assert!(infos(&c, &["deadbeef".into()]).is_empty());
}

#[test]
fn each_session_has_its_own_token() {
    let a = MediaState::default();
    let b = MediaState::default();
    assert_eq!(a.token("x"), a.token("x"));
    assert_ne!(a.token("x"), a.token("y"));
    // Another run's token for the same session doesn't work in this one.
    assert_ne!(a.token("x"), b.token("x"));
    assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
}

#[test]
fn the_config_names_the_instance() {
    let cfg: Value = serde_json::from_str(&mcp_config(4100, "inst-9", "tok")).unwrap();
    assert_eq!(cfg["mcpServers"]["workbench"]["url"], "http://127.0.0.1:4100/mcp/inst-9");
    assert_eq!(cfg["mcpServers"]["workbench"]["headers"]["Authorization"], "Bearer tok");
}

#[test]
fn the_server_answers_the_handshake_and_lists_show_media() {
    let init = answer("initialize", &json!({ "protocolVersion": "2025-11-25" })).unwrap();
    assert_eq!(init["protocolVersion"], "2025-11-25");
    assert_eq!(answer("tools/list", &Value::Null).unwrap()["tools"][0]["name"], "show_media");
    assert!(answer("resources/list", &Value::Null).is_err());
    let (paths, caption) =
        arguments(&json!({ "name": "show_media", "arguments": { "paths": ["a.png"], "caption": "c" } })).unwrap();
    assert_eq!((paths, caption.as_deref()), (vec!["a.png".to_string()], Some("c")));
    assert!(arguments(&json!({ "name": "other" })).is_err());
}

#[test]
fn only_a_command_that_just_opens_media_is_refused() {
    for c in [
        "start out.png",
        "start \"\" \"C:\\out dir\\chart.png\"",
        "cmd /c start \"\" clip.mp4",
        "Invoke-Item .\\render.webm",
        "ii a.wav b.mp3",
        "explorer.exe chart.svg",
        "open shot.gif",
        "xdg-open y.webm",
        "Invoke-Item -Path out.png",
    ] {
        assert!(only_opens_media(c), "{c}");
    }
    for c in [
        "python plot.py && start out.png",
        "start out.png; echo done",
        "start https://example.com/x.png",
        "start report.pdf",
        "start",
        "explorer .",
        "ls *.png",
        "cat out.png | head",
        "start notepad.exe",
    ] {
        assert!(!only_opens_media(c), "{c}");
    }
}

#[test]
fn the_refusal_is_a_pretooluse_denial_for_shell_tools_only() {
    let rest = |cmd: &str| json!({ "tool_input": { "command": cmd } }).as_object().unwrap().clone();
    let out = refusal(Some("Bash"), &rest("start out.png")).unwrap();
    assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "deny");
    assert!(out["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().contains("show_media"));
    assert!(refusal(Some("PowerShell"), &rest("ii a.png")).is_some());
    assert!(refusal(Some("Bash"), &rest("echo hi")).is_none());
    assert!(refusal(Some("Write"), &rest("start out.png")).is_none());
    assert!(refusal(None, &rest("start out.png")).is_none());
}

#[test]
fn ranges_are_read_the_way_a_player_asks() {
    assert_eq!(range(None, 100), Ok(None));
    assert_eq!(range(Some("bytes=0-9"), 100), Ok(Some((0, 9))));
    assert_eq!(range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
    assert_eq!(range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
    assert_eq!(range(Some("bytes=50-500"), 100), Ok(Some((50, 99))));
    // Open-ended on a big file: one chunk.
    assert_eq!(range(Some("bytes=0-"), 200 << 20), Ok(Some((0, (4 << 20) - 1))));
    assert_eq!(range(Some("bytes=100-"), 100), Err(()));
    assert_eq!(range(Some("bytes=x-"), 100), Err(()));
    assert_eq!(range(Some("bytes=0-"), 0), Err(()));
}

#[test]
fn sizes_read_plainly() {
    assert_eq!(size_words(3), "3 B");
    assert_eq!(size_words(2048), "2.0 KB");
    assert_eq!(size_words(200 * 1024 * 1024), "200 MB");
    assert_eq!(size_words(1288490189), "1.2 GB");
}

#[test]
fn another_machines_file_is_fetched_within_the_limits_only() {
    use super::fleet::{within_limits, AV_MAX, IMAGE_MAX};
    assert!(within_limits("image", IMAGE_MAX));
    assert!(!within_limits("image", IMAGE_MAX + 1));
    assert!(within_limits("video", 30 * 1024 * 1024));
    assert!(within_limits("audio", AV_MAX));
    assert!(!within_limits("video", 1 << 30));
    // A file card is never fetched: it opens over there.
    assert!(!within_limits("file", 10));
}

#[test]
fn the_cache_drops_the_least_recently_used_first_but_never_the_new_one() {
    use std::time::{Duration, SystemTime};
    let dir = temp_dir("cache");
    let at = |name: &str, len: usize, secs_ago: u64| {
        let p = dir.join(name);
        std::fs::write(&p, vec![0u8; len]).unwrap();
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago)).unwrap();
        p
    };
    at("old", 400, 300);
    at("mid", 400, 200);
    let fresh = at("new", 400, 400);
    super::fleet::evict(&dir, &fresh, 900);
    let mut left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
    left.sort();
    // "new" is the oldest by time but is the one just fetched; "old" went.
    assert_eq!(left, ["mid", "new"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_page_s_encoding_is_undone() {
    use super::serve::decode;
    assert_eq!(decode("m/lap%20top/0a1b"), "m/lap top/0a1b");
    assert_eq!(decode("m/a%2Fb/0a"), "m/a/b/0a");
    assert_eq!(decode("50%"), "50%");
    assert_eq!(decode("%zz"), "%zz");
    assert_eq!(decode("ab%4"), "ab%4");
}
