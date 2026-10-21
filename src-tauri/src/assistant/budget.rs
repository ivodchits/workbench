//! The monthly budget (step A1), enforced in the proxy so nothing in the webview can
//! talk its way past it.
//!
//! - Below the **soft limit** (80% of the cap by default) everything runs. Past it the
//!   engine moves the main thread off the API (M2/M3); the proxy only reports it.
//! - At the **hard cap** ($90 by default, open question 5) the proxy refuses every
//!   call except Haiku primitives: a Haiku model with any purpose but the main thread
//!   ([`THREAD_PURPOSE`]). A refusal is a `402` with the error type [`CAP_ERROR`], which
//!   the engine recognizes and says out loud instead of failing silently.
//!
//! Months are calendar months in local time, computed by SQLite.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::db::DuckDb;

/// `meta` key holding the [`Limits`] as JSON.
const LIMITS_KEY: &str = "budget_limits";
/// The `x-wb-purpose` of the main conversation thread.
pub const THREAD_PURPOSE: &str = "thread";
pub const CAP_ERROR: &str = "budget_exceeded";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub hard_cap_usd: f64,
    /// The soft limit as a fraction of the cap.
    pub soft_ratio: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            hard_cap_usd: 90.0,
            soft_ratio: 0.8,
        }
    }
}

impl Limits {
    pub fn validate(self) -> Result<Self, String> {
        if !(self.hard_cap_usd.is_finite() && self.hard_cap_usd >= 0.0) {
            return Err("the cap must be a positive amount".into());
        }
        if !(self.soft_ratio > 0.0 && self.soft_ratio <= 1.0) {
            return Err("the soft limit must be between 1% and 100% of the cap".into());
        }
        Ok(self)
    }
}

pub fn limits(db: &DuckDb) -> Limits {
    db.meta_get(LIMITS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn set_limits(db: &DuckDb, l: Limits) -> Result<Limits, String> {
    let l = l.validate()?;
    let json = serde_json::to_string(&l).map_err(|e| e.to_string())?;
    db.meta_set(LIMITS_KEY, &json).map_err(|e| e.to_string())?;
    Ok(l)
}

/// Epoch ms of the start of this local month / day, as SQLite modifiers.
pub(crate) const MONTH_START: &str = "strftime('%s', 'now', 'localtime', 'start of month', 'utc') * 1000";
const DAY_START: &str = "strftime('%s', 'now', 'localtime', 'start of day', 'utc') * 1000";

pub fn month_to_date(conn: &Connection) -> rusqlite::Result<f64> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM assistant_usage WHERE ts >= {MONTH_START}"
        ),
        [],
        |r| r.get(0),
    )
}

/// Whether a call for `model` with `purpose` may go out when `spent` of `limits` is
/// used. `Err` carries the message for the refusal.
pub fn admit(limits: &Limits, spent: f64, model: &str, purpose: &str) -> Result<(), String> {
    if spent < limits.hard_cap_usd {
        return Ok(());
    }
    if model.starts_with("claude-haiku") && purpose != THREAD_PURPOSE {
        return Ok(());
    }
    Err(format!(
        "Duck's monthly API budget is used up (${spent:.2} of ${:.2}); only Haiku background jobs run until next month or until the cap is raised",
        limits.hard_cap_usd
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: String,
    pub calls: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub today_usd: f64,
    pub month_usd: f64,
    pub by_model: Vec<Bucket>,
    pub by_purpose: Vec<Bucket>,
    pub limits: Limits,
    /// `month_usd` is at or past the soft limit / the hard cap.
    pub soft_reached: bool,
    pub cap_reached: bool,
}

pub fn spend(conn: &Connection, limits: Limits) -> rusqlite::Result<Spend> {
    let today_usd: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(cost_usd), 0) FROM assistant_usage WHERE ts >= {DAY_START}"),
        [],
        |r| r.get(0),
    )?;
    let month_usd = month_to_date(conn)?;
    let buckets = |column: &str| -> rusqlite::Result<Vec<Bucket>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {column}, COUNT(*), SUM(cost_usd) FROM assistant_usage
             WHERE ts >= {MONTH_START} GROUP BY {column} ORDER BY SUM(cost_usd) DESC"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(Bucket {
                key: r.get(0)?,
                calls: r.get(1)?,
                cost_usd: r.get(2)?,
            })
        })?;
        rows.collect()
    };
    Ok(Spend {
        today_usd,
        month_usd,
        by_model: buckets("model")?,
        by_purpose: buckets("purpose")?,
        limits,
        soft_reached: month_usd >= limits.hard_cap_usd * limits.soft_ratio,
        cap_reached: month_usd >= limits.hard_cap_usd,
    })
}

#[cfg(test)]
mod tests {
    use super::super::usage::{insert, Record, Usage};
    use super::*;

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn row(ts: i64, model: &str, purpose: &str, cost: f64) -> Record {
        Record {
            ts,
            model: model.into(),
            purpose: purpose.into(),
            usage: Usage::default(),
            cost_usd: cost,
        }
    }

    #[test]
    fn sums_this_month_only_and_groups() {
        let db = DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let now = now_ms();
        insert(&conn, &row(now, "claude-sonnet-5-5", "thread", 1.5)).unwrap();
        insert(&conn, &row(now, "claude-haiku-5-5", "summary", 0.25)).unwrap();
        insert(&conn, &row(now, "claude-sonnet-5-5", "thread", 0.5)).unwrap();
        // 40 days ago is always in an earlier month.
        insert(
            &conn,
            &row(now - 40 * 86_400_000, "claude-sonnet-5-5", "thread", 100.0),
        )
        .unwrap();
        let s = spend(
            &conn,
            Limits {
                hard_cap_usd: 2.0,
                soft_ratio: 0.8,
            },
        )
        .unwrap();
        assert!((s.month_usd - 2.25).abs() < 1e-9);
        assert!((s.today_usd - 2.25).abs() < 1e-9);
        assert_eq!(s.by_model[0].key, "claude-sonnet-5-5");
        assert_eq!(s.by_model[0].calls, 2);
        assert_eq!(s.by_purpose.len(), 2);
        assert!(s.soft_reached && s.cap_reached);
    }

    #[test]
    fn the_cap_lets_only_haiku_primitives_through() {
        let l = Limits::default();
        assert!(admit(&l, 89.99, "claude-sonnet-5-5", "thread").is_ok());
        assert!(admit(&l, 90.0, "claude-sonnet-5-5", "summary").is_err());
        assert!(admit(&l, 90.0, "claude-haiku-5-5", "thread").is_err());
        assert!(admit(&l, 90.0, "claude-haiku-5-5", "summary").is_ok());
    }

    #[test]
    fn limits_default_and_round_trip() {
        let db = DuckDb::open_in_memory().unwrap();
        assert_eq!(limits(&db), Limits::default());
        let l = Limits {
            hard_cap_usd: 50.0,
            soft_ratio: 0.5,
        };
        set_limits(&db, l).unwrap();
        assert_eq!(limits(&db), l);
        assert!(set_limits(
            &db,
            Limits {
                hard_cap_usd: -1.0,
                soft_ratio: 0.5
            }
        )
        .is_err());
        assert!(set_limits(
            &db,
            Limits {
                hard_cap_usd: 10.0,
                soft_ratio: 0.0
            }
        )
        .is_err());
    }
}
