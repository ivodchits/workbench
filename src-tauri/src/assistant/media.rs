//! What's playing on this PC, and the media keys (step H2), for Duck's `pc` tools.
//!
//! Windows' media sessions (`GlobalSystemMediaTransportControlsSessionManager`)
//! are what the volume flyout shows: one per app that plays (a browser tab's
//! YouTube Music, Spotify, a video player), each with its title, artist and
//! state, and its own play, pause, next and previous. A control goes to the
//! session that's playing; with none playing, to the one Windows calls current.

use serde::{Deserialize, Serialize};

/// One app's media session.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// The app, as a person would name it ("Firefox", "Spotify").
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// `playing`, `paused`, `stopped`, `changing`, `opened`, `closed`.
    pub status: String,
    /// The one Windows calls current.
    pub current: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
}

/// An app's name from its AppUserModelID: a browser by its known id, else the id
/// without `.exe` or a package's publisher hash.
pub fn app_name(aumid: &str) -> String {
    let lower = aumid.to_ascii_lowercase();
    let known = [
        ("308046b0af4a39cb", "Firefox"),
        ("firefox", "Firefox"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("spotify", "Spotify"),
        ("zunemusic", "Media Player"),
        ("vlc", "VLC"),
    ];
    if let Some((_, n)) = known.iter().find(|(k, _)| lower.contains(k)) {
        return (*n).to_string();
    }
    // `Publisher.App_hash!App` → `App`; `C:\…\app.exe` → `app`.
    let base = aumid.rsplit(['\\', '/']).next().unwrap_or(aumid);
    let base = base.split('!').next().unwrap_or(base);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.rsplit('.').find(|s| !s.eq_ignore_ascii_case("exe")).unwrap_or(base);
    base.to_string()
}

/// Which session a control goes to: the first that plays, else the current one,
/// else the first.
pub fn target(sessions: &[Session]) -> Option<usize> {
    sessions
        .iter()
        .position(|s| s.status == "playing")
        .or_else(|| sessions.iter().position(|s| s.current))
        .or(if sessions.is_empty() { None } else { Some(0) })
}

#[cfg(windows)]
mod imp {
    use super::{app_name, target, Action, Session};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Gsmtc,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    fn err(e: windows::core::Error) -> String {
        format!("Windows' media sessions: {}", e.message())
    }

    fn status(s: Status) -> &'static str {
        match s {
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Stopped => "stopped",
            Status::Changing => "changing",
            Status::Opened => "opened",
            _ => "closed",
        }
    }

    fn sessions() -> Result<Vec<(Gsmtc, Session)>, String> {
        // SAFETY: joins this thread to the MTA; a thread already in one is fine.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let manager = Manager::RequestAsync().map_err(err)?.get().map_err(err)?;
        let current = manager.GetCurrentSession().ok().and_then(|s| s.SourceAppUserModelId().ok());
        let mut out = Vec::new();
        for s in manager.GetSessions().map_err(err)? {
            let id = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
            let props = s.TryGetMediaPropertiesAsync().and_then(|p| p.get()).ok();
            let text = |f: fn(&windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> windows::core::Result<windows::core::HSTRING>| {
                props.as_ref().and_then(|p| f(p).ok()).map(|h| h.to_string()).unwrap_or_default()
            };
            let st = s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map(status).unwrap_or("closed");
            let info = Session {
                app: app_name(&id),
                title: text(|p| p.Title()),
                artist: text(|p| p.Artist()),
                album: text(|p| p.AlbumTitle()),
                status: st.to_string(),
                current: current.as_ref().is_some_and(|c| c.to_string() == id),
            };
            out.push((s, info));
        }
        Ok(out)
    }

    pub fn now_playing() -> Result<Vec<Session>, String> {
        Ok(sessions()?.into_iter().map(|(_, i)| i).collect())
    }

    pub fn control(action: Action) -> Result<Session, String> {
        let all = sessions()?;
        let infos: Vec<Session> = all.iter().map(|(_, i)| i.clone()).collect();
        let i = target(&infos).ok_or("nothing is playing or paused on the PC")?;
        let (s, info) = &all[i];
        let op = match action {
            Action::Play => s.TryPlayAsync(),
            Action::Pause => s.TryPauseAsync(),
            Action::Toggle => s.TryTogglePlayPauseAsync(),
            Action::Next => s.TrySkipNextAsync(),
            Action::Previous => s.TrySkipPreviousAsync(),
        };
        let done = op.map_err(err)?.get().map_err(err)?;
        if !done {
            return Err(format!("{} didn't take it", info.app));
        }
        Ok(info.clone())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Action, Session};
    pub fn now_playing() -> Result<Vec<Session>, String> {
        Err("media sessions are only read on Windows".into())
    }
    pub fn control(_: Action) -> Result<Session, String> {
        Err("media sessions are only read on Windows".into())
    }
}

/// Every app's media session.
#[tauri::command]
pub async fn assistant_media_now_playing() -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(imp::now_playing).await.map_err(|e| e.to_string())?
}

/// Play, pause, toggle, next or previous on the session that plays (or the
/// current one); the session it went to, as it was before.
#[tauri::command]
pub async fn assistant_media_control(action: Action) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || imp::control(action)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(status: &str, current: bool) -> Session {
        Session { app: "x".into(), title: String::new(), artist: String::new(), album: String::new(), status: status.into(), current }
    }

    #[test]
    fn names_the_app_a_session_belongs_to() {
        assert_eq!(app_name("308046B0AF4A39CB"), "Firefox");
        assert_eq!(app_name("MSEdge"), "Edge");
        assert_eq!(app_name("Chrome"), "Chrome");
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name(r"C:\Program Files\Foo\foobar2000.exe"), "foobar2000");
        assert_eq!(app_name("Acme.Player_abc!App"), "Player");
    }

    #[test]
    fn a_control_goes_to_what_plays_then_the_current_session() {
        assert_eq!(target(&[s("paused", true), s("playing", false)]), Some(1));
        assert_eq!(target(&[s("paused", false), s("stopped", true)]), Some(1));
        assert_eq!(target(&[s("paused", false)]), Some(0));
        assert_eq!(target(&[]), None);
    }
}

/// By hand, on a PC with something playing: `cargo test media::live -- --ignored --nocapture`.
#[cfg(all(test, windows))]
mod live {
    #[test]
    #[ignore]
    fn lists_this_pcs_sessions() {
        println!("{:#?}", super::imp::now_playing());
    }
}
