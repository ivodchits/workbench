//! Where the fleet keeps what it knows (fleet plan F1.1): this machine's identity in
//! `meta` (its id and its instance key's secret half, like the VAPID key), and every
//! member's record, tombstones included, in `fleet_members`. `last_seen` is this
//! machine's own observation and is never gossiped. The fleet's shared settings (F1.2)
//! are one JSON value in `meta`.

use rusqlite::{Connection, OptionalExtension};

use super::proto::{FleetConfig, Member};

const ID_KEY: &str = "fleet_instance_id";
const SECRET_KEY: &str = "fleet_instance_key";
const CONFIG_KEY: &str = "fleet_config";

pub fn identity(conn: &Connection) -> Option<(String, String)> {
    let get = |k: &str| {
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [k], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
    };
    Some((get(ID_KEY)?, get(SECRET_KEY)?))
}

pub fn set_identity(conn: &Connection, id: &str, secret: &str) -> rusqlite::Result<()> {
    for (k, v) in [(ID_KEY, id), (SECRET_KEY, secret)] {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (k, v),
        )?;
    }
    Ok(())
}

pub fn members(conn: &Connection) -> Vec<(Member, Option<u64>)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, public_key, ip, port, host, updated_at, removed, last_seen, kind, public_url FROM fleet_members",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            Member {
                id: r.get(0)?,
                name: r.get(1)?,
                public_key: r.get(2)?,
                ip: r.get(3)?,
                port: r.get::<_, i64>(4)? as u16,
                host: r.get(5)?,
                kind: r.get(9)?,
                public_url: r.get(10)?,
                updated_at: r.get::<_, i64>(6)? as u64,
                removed: r.get::<_, i64>(7)? != 0,
            },
            r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
        ))
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

pub fn save(conn: &Connection, m: &Member) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO fleet_members (id, name, public_key, ip, port, host, updated_at, removed, kind, public_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key,
           ip = excluded.ip, port = excluded.port, host = excluded.host,
           updated_at = excluded.updated_at, removed = excluded.removed, kind = excluded.kind,
           public_url = excluded.public_url",
        (
            &m.id,
            &m.name,
            &m.public_key,
            &m.ip,
            m.port as i64,
            &m.host,
            m.updated_at as i64,
            m.removed as i64,
            &m.kind,
            &m.public_url,
        ),
    )?;
    Ok(())
}

/// The fleet's settings; the never-edited default when there are none (or they don't
/// read).
pub fn config(conn: &Connection) -> FleetConfig {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [CONFIG_KEY], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

pub fn set_config(conn: &Connection, cfg: &FleetConfig) -> rusqlite::Result<()> {
    let v = serde_json::to_string(cfg).expect("config serializes");
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (CONFIG_KEY, v),
    )?;
    Ok(())
}

pub fn seen(conn: &Connection, id: &str, at: u64) {
    let _ = conn.execute("UPDATE fleet_members SET last_seen = ?1 WHERE id = ?2", (at as i64, id));
}

/// Forget every member but `keep` (leaving the fleet, or a reset identity).
pub fn clear_except(conn: &Connection, keep: &str) {
    let _ = conn.execute("DELETE FROM fleet_members WHERE id <> ?1", [keep]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn keeps_identity_and_members() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(identity(&conn).is_none());
        set_identity(&conn, "abc", "secret").unwrap();
        assert_eq!(identity(&conn), Some(("abc".into(), "secret".into())));

        let mut m = Member {
            id: "b".into(),
            name: "laptop".into(),
            public_key: "k".into(),
            ip: "100.64.0.2".into(),
            port: 48955,
            host: Some("laptop.t.ts.net".into()),
            kind: "laptop".into(),
            public_url: Some("https://laptop.t.ts.net".into()),
            updated_at: 5,
            removed: false,
        };
        save(&conn, &m).unwrap();
        seen(&conn, "b", 77);
        m.removed = true;
        m.updated_at = 6;
        save(&conn, &m).unwrap();
        let all = members(&conn);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, m);
        assert_eq!(all[0].1, Some(77), "a new version keeps last_seen");
        clear_except(&conn, "a");
        assert!(members(&conn).is_empty());

        assert_eq!(config(&conn), FleetConfig::default());
        let cfg = FleetConfig { order: vec!["b".into()], pin: Some("b".into()), updated_at: 9, by: "a".into(), ..Default::default() };
        set_config(&conn, &cfg).unwrap();
        assert_eq!(config(&conn), cfg);
    }
}
