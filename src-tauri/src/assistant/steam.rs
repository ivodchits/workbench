//! Steam on this PC (step H2), for Duck's `pc` tools (`src/assistant/tools/pc.ts`).
//!
//! - The library is read from disk: Steam's folder from the registry
//!   (`HKCU\Software\Valve\Steam\SteamPath`), its libraries from
//!   `steamapps/libraryfolders.vdf`, each installed game from its
//!   `appmanifest_<id>.acf` (name, size, last played).
//! - A game is launched or installed through Steam's own links
//!   (`steam://rungameid/<id>`, `steam://install/<id>`), so Steam does the work and
//!   shows what it's doing. A game that isn't installed is found by name in the
//!   store's search, which needs no key.
//! - The optional Steam Web API key (`duck/steam-api-key` in Credential Manager)
//!   adds your activity: playtime, recently played, achievements, friends online.
//!   Your account is the one that last signed in (`config/loginusers.vdf`).
//! - [`assistant_pc_open`] is `open_on_pc`: a web link in your browser, or one of
//!   Steam's links above.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use super::google::form_body;
use super::key;

/// Steamworks Common Redistributables: installed with every library, never a game.
const REDIST: u32 = 228980;

/// A Valve KeyValues file (`.vdf`, `.acf`): quoted keys, each with a quoted string
/// or a `{ … }` block.
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

impl Vdf {
    /// The value under `key`, its case ignored as Steam does.
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Map(m) => m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Vdf::Str(s) => Some(s),
            Vdf::Map(_) => None,
        }
    }
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Map(m) => m,
            Vdf::Str(_) => &[],
        }
    }
}

/// Parse a KeyValues text into the map of its top-level keys. `//` comments and
/// `[$WIN32]`-style conditions are skipped; an unclosed block ends at the file's end.
pub fn parse(text: &str) -> Result<Vdf, String> {
    let mut tokens = Tokens { s: text.as_bytes(), i: 0 };
    let map = block(&mut tokens, false)?;
    Ok(Vdf::Map(map))
}

enum Tok {
    Str(String),
    Open,
    Close,
}

struct Tokens<'a> {
    s: &'a [u8],
    i: usize,
}

impl Tokens<'_> {
    fn next(&mut self) -> Result<Option<Tok>, String> {
        loop {
            while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
                self.i += 1;
            }
            if self.s[self.i..].starts_with(b"//") {
                while self.i < self.s.len() && self.s[self.i] != b'\n' {
                    self.i += 1;
                }
                continue;
            }
            if self.i < self.s.len() && self.s[self.i] == b'[' {
                while self.i < self.s.len() && self.s[self.i] != b']' {
                    self.i += 1;
                }
                self.i += 1;
                continue;
            }
            break;
        }
        let Some(&c) = self.s.get(self.i) else { return Ok(None) };
        self.i += 1;
        match c {
            b'{' => Ok(Some(Tok::Open)),
            b'}' => Ok(Some(Tok::Close)),
            b'"' => {
                let mut out = Vec::new();
                loop {
                    let Some(&c) = self.s.get(self.i) else { return Err("a string runs to the end".into()) };
                    self.i += 1;
                    match c {
                        b'"' => break,
                        b'\\' => {
                            let e = self.s.get(self.i).copied().unwrap_or(b'\\');
                            self.i += 1;
                            out.push(match e {
                                b'n' => b'\n',
                                b't' => b'\t',
                                other => other,
                            });
                        }
                        _ => out.push(c),
                    }
                }
                Ok(Some(Tok::Str(String::from_utf8_lossy(&out).into_owned())))
            }
            _ => {
                // An unquoted token, as some files have: up to whitespace or a brace.
                let start = self.i - 1;
                while self.i < self.s.len() && !self.s[self.i].is_ascii_whitespace() && !b"{}\"".contains(&self.s[self.i]) {
                    self.i += 1;
                }
                Ok(Some(Tok::Str(String::from_utf8_lossy(&self.s[start..self.i]).into_owned())))
            }
        }
    }
}

fn block(t: &mut Tokens, nested: bool) -> Result<Vec<(String, Vdf)>, String> {
    let mut out = Vec::new();
    loop {
        let key = match t.next()? {
            None => return Ok(out),
            Some(Tok::Close) if nested => return Ok(out),
            Some(Tok::Close) => return Err("a } with no {".into()),
            Some(Tok::Open) => return Err("a { with no key".into()),
            Some(Tok::Str(k)) => k,
        };
        let value = match t.next()? {
            Some(Tok::Str(v)) => Vdf::Str(v),
            Some(Tok::Open) => Vdf::Map(block(t, true)?),
            _ => return Err(format!("\"{key}\" has no value")),
        };
        out.push((key, value));
    }
}

/// An installed game.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub appid: u32,
    pub name: String,
    /// On disk, bytes.
    pub size: u64,
    /// Unix seconds; 0 if never played.
    pub last_played: u64,
    /// Fully installed (not downloading or waiting for an update).
    pub ready: bool,
}

/// A game from its `appmanifest_*.acf`; `None` for the redistributables or a file
/// that isn't one.
pub fn game_of(acf: &str) -> Option<Game> {
    let v = parse(acf).ok()?;
    let s = v.get("AppState")?;
    let appid: u32 = s.str("appid")?.parse().ok()?;
    if appid == REDIST {
        return None;
    }
    let num = |k: &str| s.str(k).and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    Some(Game {
        appid,
        name: s.str("name").unwrap_or("").to_string(),
        size: num("SizeOnDisk"),
        last_played: num("LastPlayed"),
        // StateFlags 4 is "fully installed".
        ready: num("StateFlags") == 4,
    })
}

/// The library folders `libraryfolders.vdf` lists, or Steam's own folder alone.
pub fn libraries(root: &Path) -> Vec<PathBuf> {
    let file = root.join("steamapps").join("libraryfolders.vdf");
    let mut out: Vec<PathBuf> = std::fs::read_to_string(file)
        .ok()
        .and_then(|t| parse(&t).ok())
        .and_then(|v| {
            let lf = v.get("libraryfolders")?;
            Some(lf.entries().iter().filter_map(|(_, f)| f.str("path").map(PathBuf::from)).collect())
        })
        .unwrap_or_default();
    if !out.iter().any(|p| same_dir(p, root)) {
        out.insert(0, root.to_path_buf());
    }
    out
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// Every installed game across `root`'s libraries, the last played first.
pub fn installed(root: &Path) -> Vec<Game> {
    let mut games: Vec<Game> = Vec::new();
    for lib in libraries(root) {
        let Ok(dir) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for e in dir.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
                continue;
            }
            if let Some(g) = std::fs::read_to_string(e.path()).ok().as_deref().and_then(game_of) {
                if !games.iter().any(|x| x.appid == g.appid) {
                    games.push(g);
                }
            }
        }
    }
    games.sort_by(|a, b| b.last_played.cmp(&a.last_played).then_with(|| a.name.cmp(&b.name)));
    games
}

/// Steam's folder, from the registry.
#[cfg(windows)]
pub fn steam_root() -> Option<PathBuf> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `size` bytes, and RegGetValueW NUL-terminates what it writes.
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(r"Software\Valve\Steam"),
            &HSTRING::from("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let p = PathBuf::from(String::from_utf16_lossy(&buf[..len]));
    p.is_dir().then_some(p)
}

#[cfg(not(windows))]
pub fn steam_root() -> Option<PathBuf> {
    None
}

fn root() -> Result<PathBuf, String> {
    steam_root().ok_or_else(|| "Steam isn't installed on this PC".to_string())
}

/// The account that last signed in, as its 64-bit Steam id.
pub fn steam_id(loginusers: &str) -> Option<String> {
    let v = parse(loginusers).ok()?;
    let users = v.get("users")?.entries();
    users
        .iter()
        .find(|(_, u)| u.str("MostRecent") == Some("1"))
        .or_else(|| users.first())
        .map(|(id, _)| id.clone())
}

/// Installed games, the last played first.
#[tauri::command]
pub async fn assistant_steam_library() -> Result<Vec<Game>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(installed(&root()?)))
        .await
        .map_err(|e| e.to_string())?
}

/// A game in the store's search.
#[derive(Debug, Serialize)]
pub struct StoreHit {
    pub appid: u32,
    pub name: String,
}

/// The store's search for `term`: the first few apps it names.
#[tauri::command]
pub async fn assistant_steam_store_search(term: String) -> Result<Vec<StoreHit>, String> {
    let v: Value = reqwest::Client::new()
        .get(format!(
            "https://store.steampowered.com/api/storesearch/?{}",
            form_body(&[("term", term.as_str()), ("l", "english"), ("cc", "US")])
        ))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Steam's store search: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Steam's store search: {e}"))
        .and_then(|t| serde_json::from_str(&t).map_err(|e| format!("Steam's store search: {e}")))?;
    Ok(v["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|i| {
                    Some(StoreHit { appid: u32::try_from(i["id"].as_u64()?).ok()?, name: i["name"].as_str()?.to_string() })
                })
                .take(8)
                .collect()
        })
        .unwrap_or_default())
}

/// The Steam Web API key, or how to store one.
fn api_key() -> Result<String, String> {
    key::steam_api().ok_or_else(|| {
        "no Steam Web API key: get one at https://steamcommunity.com/dev/apikey and store it with \
         `cmdkey /generic:duck/steam-api-key /user:duck /pass:<key>`"
            .to_string()
    })
}

async fn web_api(client: &reqwest::Client, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let r = client
        .get(format!("https://api.steampowered.com/{path}?{}", form_body(query)))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        // The key is in the URL: never let it into an error.
        .map_err(|e| format!("the Steam Web API ({path}): {}", e.without_url()))?;
    let text = r.text().await.map_err(|e| format!("the Steam Web API ({path}): {}", e.without_url()))?;
    serde_json::from_str(&text).map_err(|e| format!("the Steam Web API ({path}): {e}"))
}

/// Your Steam activity through the Web API: the last two weeks, the most played,
/// friends online, and with `appid` that game's achievements.
#[tauri::command]
pub async fn assistant_steam_activity(appid: Option<u32>) -> Result<Value, String> {
    let key = api_key()?;
    let root = root()?;
    let users = std::fs::read_to_string(root.join("config").join("loginusers.vdf"))
        .map_err(|_| "no Steam account has signed in on this PC".to_string())?;
    let id = steam_id(&users).ok_or("no Steam account has signed in on this PC")?;
    let client = reqwest::Client::new();
    let q = |extra: &[(&'static str, String)]| {
        let mut v: Vec<(&str, String)> = vec![("key", key.clone()), ("steamid", id.clone()), ("format", "json".into())];
        v.extend(extra.iter().cloned());
        v
    };
    let call = |path: &'static str, query: Vec<(&'static str, String)>| {
        let client = client.clone();
        async move {
            let pairs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
            web_api(&client, path, &pairs).await
        }
    };

    let recent = call("IPlayerService/GetRecentlyPlayedGames/v1/", q(&[("count", "10".into())])).await?;
    let owned = call("IPlayerService/GetOwnedGames/v1/", q(&[("include_appinfo", "1".into())])).await?;
    let hours = |m: &Value| (m.as_f64().unwrap_or(0.0) / 6.0).round() / 10.0;
    let recent: Vec<Value> = recent["response"]["games"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| json!({"appid": g["appid"], "name": g["name"], "hoursTwoWeeks": hours(&g["playtime_2weeks"]), "hoursTotal": hours(&g["playtime_forever"])}))
        .collect();
    let mut games: Vec<&Value> = owned["response"]["games"].as_array().into_iter().flatten().collect();
    let owned_count = games.len();
    games.sort_by_key(|g| std::cmp::Reverse(g["playtime_forever"].as_u64().unwrap_or(0)));
    let most: Vec<Value> = games
        .iter()
        .take(10)
        .map(|g| json!({"appid": g["appid"], "name": g["name"], "hoursTotal": hours(&g["playtime_forever"])}))
        .collect();

    // Friends: a private friends list is no error, just none.
    let friends = call("ISteamUser/GetFriendList/v1/", q(&[("relationship", "friend".into())])).await.ok();
    let ids: Vec<String> = friends
        .as_ref()
        .and_then(|f| f["friendslist"]["friends"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|f| f["steamid"].as_str().map(str::to_string))
        .take(100)
        .collect();
    let mut online = Vec::new();
    if !ids.is_empty() {
        let s = call("ISteamUser/GetPlayerSummaries/v2/", vec![("key", key.clone()), ("steamids", ids.join(","))]).await?;
        for p in s["response"]["players"].as_array().into_iter().flatten() {
            if p["personastate"].as_u64().unwrap_or(0) != 0 {
                online.push(json!({"name": p["personaname"], "playing": p["gameextrainfo"]}));
            }
        }
    }

    let achievements = match appid {
        None => Value::Null,
        Some(app) => match call("ISteamUserStats/GetPlayerAchievements/v1/", q(&[("appid", app.to_string()), ("l", "english".into())])).await {
            Ok(a) => {
                let list = a["playerstats"]["achievements"].as_array().cloned().unwrap_or_default();
                let got: Vec<&Value> = list.iter().filter(|x| x["achieved"].as_u64() == Some(1)).collect();
                let mut latest = got.clone();
                latest.sort_by_key(|x| std::cmp::Reverse(x["unlocktime"].as_u64().unwrap_or(0)));
                json!({
                    "game": a["playerstats"]["gameName"],
                    "unlocked": got.len(),
                    "of": list.len(),
                    "latest": latest.iter().take(5).map(|x| x["name"].clone()).collect::<Vec<_>>(),
                })
            }
            Err(_) => json!({"error": "that game has no achievements, or your game details are private"}),
        },
    };

    Ok(json!({
        "recentlyPlayed": recent,
        "mostPlayed": most,
        "gamesOwned": owned_count,
        "friendsOnline": online,
        "achievements": achievements,
    }))
}

/// What `open_on_pc` may open: a web link, or Steam's run, install and store page
/// for a game by id. Any other `steam://` link is refused: some take arguments
/// that reach the game.
pub fn may_open(url: &str) -> bool {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return url.len() > lower.find("://").unwrap_or(0) + 3;
    }
    ["steam://rungameid/", "steam://install/", "steam://store/"].iter().any(|p| {
        lower.strip_prefix(p).is_some_and(|id| !id.is_empty() && id.len() <= 10 && id.bytes().all(|b| b.is_ascii_digit()))
    })
}

/// `open_on_pc`, and how `steam_launch` and `steam_install` start Steam.
#[tauri::command]
pub fn assistant_pc_open(app: AppHandle, url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !may_open(&url) {
        return Err(format!("won't open {url}: only web links and Steam's run, install and store links"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keyvalues_with_comments_escapes_and_conditions() {
        let v = parse(
            r#"// a comment
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "620" "123" }
	}
	"1" { "path" "D:\\Games\\SteamLibrary" "label" "say \"hi\"" }
	"cond" "x" [$WIN32]
}"#,
        )
        .unwrap();
        let lf = v.get("LibraryFolders").unwrap();
        assert_eq!(lf.get("0").unwrap().str("path"), Some(r"C:\Program Files (x86)\Steam"));
        assert_eq!(lf.get("0").unwrap().get("apps").unwrap().str("620"), Some("123"));
        assert_eq!(lf.get("1").unwrap().str("label"), Some(r#"say "hi""#));
        assert_eq!(lf.str("cond"), Some("x"));
        assert!(parse(r#""a" { "b" "c" } }"#).is_err());
        assert!(parse(r#""a" "b"#).is_err());
    }

    #[test]
    fn reads_a_game_from_its_manifest() {
        let g = game_of(
            r#""AppState" { "appid" "1145360" "name" "Hades" "StateFlags" "4" "SizeOnDisk" "15032385536" "LastPlayed" "1760000000" }"#,
        )
        .unwrap();
        assert_eq!(g, Game { appid: 1145360, name: "Hades".into(), size: 15032385536, last_played: 1760000000, ready: true });
        assert!(game_of(r#""AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" }"#).is_none());
        assert!(!game_of(r#""AppState" { "appid" "1" "name" "x" "StateFlags" "1026" }"#).unwrap().ready);
    }

    #[test]
    fn finds_the_games_in_every_library_last_played_first() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("wb-steam-{nanos}"));
        let root = base.join("Steam");
        let other = base.join("Library");
        std::fs::create_dir_all(root.join("steamapps")).unwrap();
        std::fs::create_dir_all(other.join("steamapps")).unwrap();
        let path = |p: &Path| p.to_string_lossy().replace('\\', "\\\\");
        std::fs::write(
            root.join("steamapps/libraryfolders.vdf"),
            format!(r#""libraryfolders" {{ "0" {{ "path" "{}" }} "1" {{ "path" "{}" }} }}"#, path(&root), path(&other)),
        )
        .unwrap();
        let acf = |id: u32, name: &str, played: u64| {
            format!(r#""AppState" {{ "appid" "{id}" "name" "{name}" "StateFlags" "4" "LastPlayed" "{played}" }}"#)
        };
        std::fs::write(root.join("steamapps/appmanifest_10.acf"), acf(10, "Old", 100)).unwrap();
        std::fs::write(other.join("steamapps/appmanifest_20.acf"), acf(20, "New", 200)).unwrap();
        std::fs::write(other.join("steamapps/appmanifest_228980.acf"), acf(228980, "Redist", 300)).unwrap();
        std::fs::write(other.join("steamapps/notes.txt"), "x").unwrap();
        let names: Vec<String> = installed(&root).into_iter().map(|g| g.name).collect();
        assert_eq!(names, ["New", "Old"]);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_account_is_the_one_that_signed_in_last() {
        let users = r#""users" { "7656119800000001" { "AccountName" "a" "MostRecent" "0" } "7656119800000002" { "AccountName" "b" "MostRecent" "1" } }"#;
        assert_eq!(steam_id(users).as_deref(), Some("7656119800000002"));
        assert_eq!(steam_id(r#""users" { "1" { } }"#).as_deref(), Some("1"));
        assert_eq!(steam_id(r#""users" { }"#), None);
    }

    #[test]
    fn opens_only_web_links_and_steams_game_links() {
        assert!(may_open("https://music.youtube.com/watch?v=abc"));
        assert!(may_open("steam://rungameid/1145360"));
        assert!(may_open("STEAM://install/620"));
        assert!(may_open("steam://store/620"));
        assert!(!may_open("https://"));
        assert!(!may_open("steam://run/620//-console"));
        assert!(!may_open("steam://rungameid/620 -x"));
        assert!(!may_open("steam://rungameid/"));
        assert!(!may_open("file:///C:/Windows/System32/calc.exe"));
        assert!(!may_open("ms-settings:"));
        assert!(!may_open("https://example.com/\n--flag"));
    }

    /// By hand, on a PC with Steam: `cargo test steam::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_library() {
        let root = steam_root().expect("Steam's folder");
        for g in installed(&root).iter().take(10) {
            println!("{} {} {:.1} GB played {} ready {}", g.appid, g.name, g.size as f64 / 1e9, g.last_played, g.ready);
        }
    }
}
