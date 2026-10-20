//! The trust engine's storage (step T1). The engine itself runs in the webview
//! (`src/assistant/trust/`); this keeps what it reads and writes in `duck.db`: the
//! rules, each project's mode, the floor entries you turned off, the kill switch,
//! and the decision log.
//!
//! The kill switch lives here rather than in the webview because the tray can flip
//! it with no window open: [`set_paused`] writes it, ticks the tray item and tells
//! the webview (`assistant-trust-paused`).

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::db::DuckDb;

pub const PAUSED_KEY: &str = "assistant_trust_paused";
const FLOOR_OFF_KEY: &str = "assistant_trust_floor_off";
const SEEDED_KEY: &str = "assistant_trust_seeded";
/// The log keeps this many decisions; older ones go when a new one is written.
const KEEP_DECISIONS: i64 = 5000;

const EFFECTS: &[&str] = &["allow", "ask", "deny"];
const MODES: &[&str] = &["off", "shadow", "live"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub effect: String,
    pub pattern: String,
    /// `None`: a global rule.
    pub project_id: Option<String>,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMode {
    pub project_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustState {
    pub paused: bool,
    pub rules: Vec<Rule>,
    pub modes: Vec<ProjectMode>,
    pub floor_off: Vec<String>,
    /// The starter rules were written (once, on the first load).
    pub seeded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Assigned on write; ignored when given.
    #[serde(default)]
    pub id: i64,
    pub ts: i64,
    pub thread_id: String,
    pub tool_use_id: String,
    pub project_id: Option<String>,
    pub tool: String,
    pub summary: String,
    pub input: Value,
    pub decision: String,
    pub layer: String,
    pub reason: String,
    pub rule_id: Option<String>,
    pub shadow: bool,
}

pub fn paused(db: &DuckDb) -> bool {
    matches!(db.meta_get(PAUSED_KEY), Ok(Some(v)) if v == "1")
}

pub fn set_paused_flag(db: &DuckDb, paused: bool) -> Result<(), String> {
    db.meta_set(PAUSED_KEY, if paused { "1" } else { "0" })
        .map_err(|e| e.to_string())
}

pub(crate) fn meta(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

const MANDATE_PREFIX: &str = "assistant_mandate:";
/// A mandate's JSON is the user's request plus a thread id; anything this big
/// isn't one.
const MANDATE_MAX: usize = 64 * 1024;

/// Store (or with `None`, drop) a session's mandate (step T2).
pub fn set_mandate(conn: &Connection, instance_id: &str, mandate: Option<&str>) -> Result<(), String> {
    let key = format!("{MANDATE_PREFIX}{instance_id}");
    match mandate {
        Some(m) if m.len() > MANDATE_MAX => Err("the mandate is too long".into()),
        Some(m) => set_meta(conn, &key, m),
        None => conn
            .execute("DELETE FROM meta WHERE key = ?1", [&key])
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

pub fn mandate(conn: &Connection, instance_id: &str) -> Result<Option<String>, String> {
    meta(conn, &format!("{MANDATE_PREFIX}{instance_id}"))
}

fn floor_off(conn: &Connection) -> Result<Vec<String>, String> {
    Ok(meta(conn, FLOOR_OFF_KEY)?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

pub fn load(conn: &Connection) -> Result<TrustState, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, effect, pattern, project_id, created FROM assistant_rules
             ORDER BY created, id",
        )
        .map_err(|e| e.to_string())?;
    let rules = stmt
        .query_map([], |r| {
            Ok(Rule {
                id: r.get(0)?,
                effect: r.get(1)?,
                pattern: r.get(2)?,
                project_id: r.get(3)?,
                created: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT project_id, mode FROM assistant_trust_modes ORDER BY project_id")
        .map_err(|e| e.to_string())?;
    let modes = stmt
        .query_map([], |r| {
            Ok(ProjectMode {
                project_id: r.get(0)?,
                mode: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(TrustState {
        paused: meta(conn, PAUSED_KEY)?.as_deref() == Some("1"),
        rules,
        modes,
        floor_off: floor_off(conn)?,
        seeded: meta(conn, SEEDED_KEY)?.is_some(),
    })
}

fn check_rule(rule: &Rule) -> Result<(), String> {
    if rule.id.is_empty() {
        return Err("a rule needs an id".into());
    }
    if !EFFECTS.contains(&rule.effect.as_str()) {
        return Err(format!("unknown effect {:?}", rule.effect));
    }
    let p = rule.pattern.trim();
    if p.is_empty() || p.len() > 500 {
        return Err("a rule's pattern must be 1-500 characters".into());
    }
    Ok(())
}

pub fn add_rule(conn: &Connection, rule: &Rule) -> Result<(), String> {
    check_rule(rule)?;
    conn.execute(
        "INSERT INTO assistant_rules (id, effect, pattern, project_id, created)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            &rule.id,
            &rule.effect,
            rule.pattern.trim(),
            &rule.project_id,
            rule.created,
        ),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn remove_rule(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM assistant_rules WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Write the starter rules, once: a later load (after you deleted some) never puts
/// them back.
pub fn seed(conn: &mut Connection, rules: &[Rule]) -> Result<TrustState, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if meta(&tx, SEEDED_KEY)?.is_none() {
        for r in rules {
            add_rule(&tx, r)?;
        }
        set_meta(&tx, SEEDED_KEY, "1")?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    load(conn)
}

/// `None` puts the project back on the default (`live`).
pub fn set_mode(conn: &Connection, project_id: &str, mode: Option<&str>) -> Result<(), String> {
    match mode {
        None => conn.execute(
            "DELETE FROM assistant_trust_modes WHERE project_id = ?1",
            [project_id],
        ),
        Some(m) if MODES.contains(&m) => conn.execute(
            "INSERT INTO assistant_trust_modes (project_id, mode) VALUES (?1, ?2)
             ON CONFLICT(project_id) DO UPDATE SET mode = excluded.mode",
            (project_id, m),
        ),
        Some(m) => return Err(format!("unknown mode {m:?}")),
    }
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn set_floor(conn: &Connection, id: &str, enabled: bool) -> Result<Vec<String>, String> {
    let mut off = floor_off(conn)?;
    off.retain(|x| x != id);
    if !enabled {
        off.push(id.to_string());
    }
    off.sort();
    set_meta(
        conn,
        FLOOR_OFF_KEY,
        &serde_json::to_string(&off).map_err(|e| e.to_string())?,
    )?;
    Ok(off)
}

pub fn add_decision(conn: &Connection, d: &Decision) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO assistant_decisions
           (ts, thread_id, tool_use_id, project_id, tool, summary, input, decision,
            layer, reason, rule_id, shadow)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            d.ts,
            d.thread_id,
            d.tool_use_id,
            d.project_id,
            d.tool,
            d.summary,
            d.input.to_string(),
            d.decision,
            d.layer,
            d.reason,
            d.rule_id,
            d.shadow,
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "DELETE FROM assistant_decisions WHERE id <= ?1",
        [id - KEEP_DECISIONS],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Newest first: up to `limit` decisions older than `before` (an id), or the latest.
pub fn decisions(conn: &Connection, before: Option<i64>, limit: u32) -> Result<Vec<Decision>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, thread_id, tool_use_id, project_id, tool, summary, input,
                    decision, layer, reason, rule_id, shadow
             FROM assistant_decisions WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((before.unwrap_or(i64::MAX), limit.min(500)), |r| {
            Ok(Decision {
                id: r.get(0)?,
                ts: r.get(1)?,
                thread_id: r.get(2)?,
                tool_use_id: r.get(3)?,
                project_id: r.get(4)?,
                tool: r.get(5)?,
                summary: r.get(6)?,
                input: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(Value::Null),
                decision: r.get(8)?,
                layer: r.get(9)?,
                reason: r.get(10)?,
                rule_id: r.get(11)?,
                shadow: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(id: &str, effect: &str, pattern: &str) -> Rule {
        Rule {
            id: id.into(),
            effect: effect.into(),
            pattern: pattern.into(),
            project_id: None,
            created: 1,
        }
    }

    fn decision(n: i64) -> Decision {
        Decision {
            id: 0,
            ts: n,
            thread_id: "t1".into(),
            tool_use_id: format!("u{n}"),
            project_id: Some("p1".into()),
            tool: "assistant:write_note".into(),
            summary: "Rewrite note".into(),
            input: json!({"name": "todo"}),
            decision: "allow".into(),
            layer: "rule".into(),
            reason: "allow assistant:write_note".into(),
            rule_id: Some("r1".into()),
            shadow: false,
        }
    }

    #[test]
    fn seeds_the_starter_rules_once() {
        let db = DuckDb::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let s = seed(&mut conn, &[rule("r1", "allow", "assistant:write_note")]).unwrap();
        assert!(s.seeded);
        assert_eq!(s.rules.len(), 1);
        remove_rule(&conn, "r1").unwrap();
        // Deleted on purpose: a second seed doesn't bring it back.
        let s = seed(&mut conn, &[rule("r1", "allow", "assistant:write_note")]).unwrap();
        assert!(s.rules.is_empty());
    }

    #[test]
    fn refuses_bad_rules_and_modes() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(add_rule(&conn, &rule("r1", "maybe", "assistant:x")).is_err());
        assert!(add_rule(&conn, &rule("r1", "allow", "  ")).is_err());
        assert!(set_mode(&conn, "p1", Some("loud")).is_err());
        set_mode(&conn, "p1", Some("shadow")).unwrap();
        set_mode(&conn, "p1", Some("off")).unwrap();
        assert_eq!(
            load(&conn).unwrap().modes,
            vec![ProjectMode { project_id: "p1".into(), mode: "off".into() }]
        );
        set_mode(&conn, "p1", None).unwrap();
        assert!(load(&conn).unwrap().modes.is_empty());
    }

    #[test]
    fn keeps_the_floor_entries_turned_off() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        set_floor(&conn, "push", false).unwrap();
        set_floor(&conn, "publish", false).unwrap();
        assert_eq!(set_floor(&conn, "push", true).unwrap(), vec!["publish"]);
        assert_eq!(load(&conn).unwrap().floor_off, vec!["publish"]);
    }

    #[test]
    fn pages_decisions_newest_first() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        for n in 1..=5 {
            add_decision(&conn, &decision(n)).unwrap();
        }
        let page = decisions(&conn, None, 2).unwrap();
        assert_eq!(page.iter().map(|d| d.ts).collect::<Vec<_>>(), vec![5, 4]);
        assert_eq!(page[0].input, json!({"name": "todo"}));
        let next = decisions(&conn, Some(page[1].id), 10).unwrap();
        assert_eq!(next.iter().map(|d| d.ts).collect::<Vec<_>>(), vec![3, 2, 1]);
    }

    #[test]
    fn keeps_a_mandate_per_session() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(mandate(&conn, "a").unwrap(), None);
        set_mandate(&conn, "a", Some(r#"{"text":"fix the auth test"}"#)).unwrap();
        set_mandate(&conn, "b", Some("x")).unwrap();
        assert_eq!(mandate(&conn, "a").unwrap().as_deref(), Some(r#"{"text":"fix the auth test"}"#));
        set_mandate(&conn, "a", None).unwrap();
        assert_eq!(mandate(&conn, "a").unwrap(), None);
        assert_eq!(mandate(&conn, "b").unwrap().as_deref(), Some("x"));
        assert!(set_mandate(&conn, "c", Some(&"x".repeat(MANDATE_MAX + 1))).is_err());
    }

    #[test]
    fn the_kill_switch_is_stored() {
        let db = DuckDb::open_in_memory().unwrap();
        assert!(!paused(&db));
        set_paused_flag(&db, true).unwrap();
        assert!(paused(&db));
        assert!(load(&db.conn.lock().unwrap()).unwrap().paused);
    }
}
