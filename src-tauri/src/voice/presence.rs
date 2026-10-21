//! Are you at the PC? (step V5) What Duck's announcements need to pick where and
//! whether to speak: how long since the last keyboard or mouse input
//! (`GetLastInputInfo`), whether the session is locked or a full-screen app or
//! presentation is in front (`SHQueryUserNotificationState`), and Windows' Focus /
//! Do Not Disturb (the shell's quiet-hours WNF state, which Focus Assist and Win11's
//! Do Not Disturb set; undocumented, so null when it can't be read).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    /// Milliseconds since the last keyboard or mouse input.
    pub idle_ms: u64,
    /// Locked, or the screensaver is on.
    pub locked: bool,
    /// A full-screen app (a game, a video) or a presentation is in front.
    pub full_screen: bool,
    /// Windows Focus / Do Not Disturb is on; null when unknown.
    pub focus: Option<bool>,
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHQueryUserNotificationState(state: *mut i32) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryWnfStateData(
            state_name: *const u64,
            type_id: *const c_void,
            scope: *const c_void,
            change_stamp: *mut u32,
            buffer: *mut c_void,
            buffer_size: *mut u32,
        ) -> i32;
    }

    /// WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: 0 off, else the profile in force
    /// (priority only, alarms only). The older QUIET_MOMENT_SHELL_MODE_CHANGED isn't
    /// there on this Windows 11 build (STATUS_OBJECT_NAME_NOT_FOUND).
    const QUIET_MOMENT: u64 = 0x0D83_063E_A3BF_1C75;

    pub fn idle_ms() -> u64 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a valid LASTINPUTINFO with its size set.
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return 0;
        }
        // Both are 32-bit tick counts; the wrapping difference is right across a wrap.
        // SAFETY: no arguments.
        u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime))
    }

    /// (locked, full screen)
    pub fn notification_state() -> (bool, bool) {
        let mut s = 0i32;
        // SAFETY: `s` is a valid out pointer.
        if unsafe { SHQueryUserNotificationState(&mut s) } != 0 {
            return (false, false);
        }
        // QUNS_NOT_PRESENT 1, QUNS_BUSY 2, QUNS_RUNNING_D3D_FULL_SCREEN 3,
        // QUNS_PRESENTATION_MODE 4.
        (s == 1, matches!(s, 2..=4))
    }

    pub fn focus() -> Option<bool> {
        let mut stamp = 0u32;
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: the buffer is a u32 and `size` says so; the other pointers are
        // valid or null as the call allows.
        let status = unsafe {
            NtQueryWnfStateData(
                &QUIET_MOMENT,
                std::ptr::null(),
                std::ptr::null(),
                &mut stamp,
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0 && size >= 4).then_some(value != 0)
    }
}

#[cfg(windows)]
pub fn now() -> Presence {
    let (locked, full_screen) = win::notification_state();
    let p = Presence { idle_ms: win::idle_ms(), locked, full_screen, focus: win::focus() };
    // A dev build can act as if you were away, to try what Duck does then.
    #[cfg(debug_assertions)]
    if std::env::var("WB_FAKE_PRESENCE").as_deref() == Ok("away") {
        return Presence { idle_ms: 3_600_000, ..p };
    }
    p
}

#[cfg(not(windows))]
pub fn now() -> Presence {
    Presence::default()
}

#[tauri::command]
pub fn assistant_presence() -> Presence {
    now()
}

#[cfg(test)]
mod tests {
    /// Reads this PC: `cargo test presence_reads -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn presence_reads() {
        println!("{:?}", super::now());
    }
}
