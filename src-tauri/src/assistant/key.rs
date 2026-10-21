//! The Anthropic API key in Windows Credential Manager (step A1).
//!
//! A generic credential, `duck/anthropic-api-key` (`duck-dev/…` for a debug build, a
//! separate Console key). The recommended way to store it is `cmdkey` in your own
//! terminal, so the key never passes through the app:
//!
//! ```text
//! cmdkey /generic:duck/anthropic-api-key /user:duck /pass:<key>
//! ```
//!
//! `cmdkey` stores the secret as UTF-16LE, and [`set`] writes the same format. The key
//! is read on each proxied request rather than held in memory, so a change made with
//! `cmdkey` takes effect immediately. It never goes into prefs, the DB, logs, a child
//! process's environment or the webview.

/// The credential target for this build.
pub const TARGET: &str = if cfg!(debug_assertions) {
    "duck-dev/anthropic-api-key"
} else {
    "duck/anthropic-api-key"
};

/// The key, or `None` when no credential is stored (or it can't be decoded).
pub fn get() -> Option<String> {
    imp::read(TARGET).filter(|k| !k.is_empty())
}

/// Step V2: the Google Cloud key for Chirp speech, `duck/google-tts-key` (one
/// credential for both builds: it bills nothing within the free tier). Stored the
/// same way, with `cmdkey /generic:duck/google-tts-key /user:duck /pass:<key>`.
pub fn google_tts() -> Option<String> {
    imp::read("duck/google-tts-key").filter(|k| !k.is_empty())
}

pub fn set(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("the key is empty".into());
    }
    imp::write(TARGET, key)
}

pub fn clear() -> Result<(), String> {
    imp::delete(TARGET)
}

/// Decode a credential blob: UTF-16LE as `cmdkey` writes it, UTF-8 as a fallback.
fn decode(blob: &[u8]) -> Option<String> {
    let s = if blob.len() >= 2 && blob.len().is_multiple_of(2) && blob[1] == 0 {
        let wide: Vec<u16> = blob
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&wide).ok()?
    } else {
        String::from_utf8(blob.to_vec()).ok()?
    };
    Some(s.trim().to_string())
}

#[cfg(windows)]
mod imp {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read(target: &str) -> Option<String> {
        let target = wide(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `p` is filled by CredReadW on success and freed with CredFree; the
        // blob is copied out before the free.
        unsafe {
            CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut p).ok()?;
            let c = &*p;
            let blob = if c.CredentialBlob.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
            };
            CredFree(p as *const _);
            super::decode(&blob)
        }
    }

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let mut target = wide(target);
        let mut user = wide("duck");
        let mut blob: Vec<u8> = secret.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            // Not roamed to other machines: each one gets its own key.
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        // SAFETY: every pointer in `cred` points into a buffer that outlives the call.
        unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("storing the key: {e}"))
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let target = wide(target);
        // SAFETY: a NUL-terminated wide string that outlives the call.
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
            Err(e) => Err(format!("removing the key: {e}")),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read(_target: &str) -> Option<String> {
        None
    }
    pub fn write(_target: &str, _secret: &str) -> Result<(), String> {
        Err("the key store is only implemented on Windows".into())
    }
    pub fn delete(_target: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_utf16le_and_utf8() {
        let utf16: Vec<u8> = "sk-ant-x\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(decode(&utf16).as_deref(), Some("sk-ant-x"));
        assert_eq!(decode(b"sk-ant-y").as_deref(), Some("sk-ant-y"));
        assert_eq!(decode(&[]).as_deref(), Some(""));
    }
}
