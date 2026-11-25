use super::*;
use serde_json::json;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wb-daylog-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn note(id: &str, at: i64) -> Value {
    json!({ "id": id, "at": at, "text": id })
}

#[test]
fn a_day_is_a_date() {
    assert!(day_ok("2026-11-24"));
    for no in ["2026-11-4", "2026/11/24", "../etc/x", "2026-11-24x", ""] {
        assert!(!day_ok(no), "{no}");
    }
}

#[test]
fn the_log_is_read_with_reverts_marked_and_bodies_cut() {
    let long = "x".repeat(BODY_MAX + 50);
    let out = format!(
        "{a}\x1f1700000100\x1fAdd the export\x1fwith a body\x1e\n{b}\x1f1700000000\x1fRevert \"Add the export\"\x1f{long}\x1e\n",
        a = "a".repeat(40),
        b = "b".repeat(40)
    );
    let v = parse_log(&out);
    assert_eq!(v.len(), 2);
    // Oldest first.
    assert_eq!(v[0].subject, "Revert \"Add the export\"");
    assert!(v[0].revert && !v[1].revert);
    assert!(v[0].body.ends_with(" …") && v[0].body.len() <= BODY_MAX + 4);
    assert_eq!(v[1].body, "with a body");
    assert!(parse_log("nothing\x1fhere\x1e").is_empty());
}

#[test]
fn only_resets_after_the_time_are_read_from_the_reflog() {
    let out = "HEAD@{1700000300}\x1freset: moving to HEAD~2\nHEAD@{1700000200}\x1fcommit: Add x\nHEAD@{1600000000}\x1freset: moving to main\n";
    let v = parse_reflog(out, 1700000000);
    assert_eq!(v, vec![GitReset { at: 1700000300, what: "reset: moving to HEAD~2".into() }]);
}

#[test]
fn a_repo_s_commits_and_resets_are_its_activity() {
    let dir = temp("git");
    let g = |args: &[&str]| assert!(exec(&dir, Spec::local(args)).unwrap().ok, "{args:?}");
    g(&["init", "-q", "-b", "main"]);
    let commit = |f: &str, m: &str| {
        std::fs::write(dir.join(f), m).unwrap();
        g(&["add", "-A"]);
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", m]);
    };
    commit("a", "First");
    commit("b", "Second");
    g(&["reset", "-q", "--hard", "HEAD~1"]);
    let a = activity(&dir, 0);
    // The reset commit is still on no branch, so only the reachable ones are listed.
    assert_eq!(a.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["First"]);
    assert_eq!(a.resets.len(), 1);
    assert!(a.resets[0].what.starts_with("reset: moving to"));
    // Nothing after now.
    assert_eq!(activity(&dir, i64::MAX / 2), GitActivity::default());
    // Not a repo: nothing.
    let plain = temp("plain");
    assert_eq!(activity(&plain, 0), GitActivity::default());
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(plain);
}

#[test]
fn notes_are_a_union_and_never_dropped() {
    let (all, added) = union(vec![note("b", 2), note("a", 1)], vec![note("a", 1), note("c", 0), json!({ "text": "no id" })]);
    assert_eq!(added, 1);
    assert_eq!(all.iter().map(|n| n["id"].as_str().unwrap()).collect::<Vec<_>>(), ["c", "a", "b"]);
}

#[test]
fn a_save_adds_notes_writes_days_and_state_and_says_which_files() {
    let ws = temp("save");
    let day = "2026-11-24".to_string();
    let s = Save {
        notes: BTreeMap::from([(day.clone(), vec![note("n1", 10)])]),
        days: BTreeMap::from([(day.clone(), json!({ "day": day, "entries": [{ "id": "e1", "hidden": false }, { "id": "e2", "hidden": true }] }))]),
        state: Some(json!({ "version": 1 })),
    };
    let saved = save(&ws, &s).unwrap();
    assert_eq!(saved.added, 1);
    assert_eq!(saved.files, ["daylog/notes/2026-11-24.jsonl", "daylog/days/2026-11-24.json", "daylog/state.json"]);
    // The same again changes nothing.
    assert_eq!(save(&ws, &s).unwrap(), Saved::default());
    // More notes keep the old ones.
    let more = Save { notes: BTreeMap::from([(day.clone(), vec![note("n0", 5)])]), ..Default::default() };
    assert_eq!(save(&ws, &more).unwrap().added, 1);
    let loaded = load(&ws, &[day.clone(), "2026-11-23".into()]).unwrap();
    assert_eq!(loaded.state.unwrap()["version"], 1);
    let d = &loaded.days[&day];
    assert_eq!(d.notes.iter().map(|n| n["id"].as_str().unwrap()).collect::<Vec<_>>(), ["n0", "n1"]);
    assert!(d.entries.is_some());
    assert!(loaded.days["2026-11-23"].entries.is_none());
    // Hidden entries aren't counted.
    assert_eq!(days(&ws), [(day.clone(), 1)]);
    assert_eq!(recent_notes(&ws, "2026-11-24").len(), 2);
    assert!(recent_notes(&ws, "2026-11-25").is_empty());
    assert!(save(&ws, &Save { days: BTreeMap::from([("../x".into(), json!({}))]), ..Default::default() }).is_err());
    let _ = std::fs::remove_dir_all(ws);
}

#[test]
fn an_old_main_s_branch_notes_are_found() {
    let ws = temp("branch");
    let g = |args: &[&str]| assert!(exec(&ws, Spec::local(args)).unwrap().ok, "{args:?}");
    g(&["init", "-q", "-b", "main"]);
    let day = "2026-11-24".to_string();
    save(&ws, &Save { notes: BTreeMap::from([(day.clone(), vec![note("old", 1)])]), ..Default::default() }).unwrap();
    g(&["add", "-A"]);
    g(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
    g(&["branch", "fleet/before-term-3"]);
    let found = branch_notes(&ws, "2026-11-01");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["id"], "old");
    assert!(branch_notes(&ws, "2026-12-01").is_empty());
    let _ = std::fs::remove_dir_all(ws);
}
