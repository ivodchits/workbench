//! What the sound comes out of (step V4): headphones, or speakers the microphone
//! can hear. The default output's form factor (`PKEY_AudioEndpoint_FormFactor`),
//! read through Core Audio, and read again every few seconds by conversation mode,
//! so switching mid-conversation is followed.
//!
//! X0: headphones put no echo on the mic (-66 dBFS), laptop speakers ~-32 dBFS. So
//! with headphones you can talk over Duck; on speakers, until echo cancellation
//! comes, Duck doesn't listen while it speaks.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    Headphones,
    Speakers,
    /// A form factor that says neither (HDMI, S/PDIF, a line out), or none read:
    /// treated as speakers.
    Unknown,
}

#[cfg(windows)]
pub fn default_output() -> Output {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, EndpointFormFactor, Headphones, Headset, IMMDeviceEnumerator, MMDeviceEnumerator,
        PKEY_AudioEndpoint_FormFactor, Speakers,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantToUInt32;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    // SAFETY: plain Core Audio calls on this thread's COM apartment (joined as
    // multithreaded; a thread already in one keeps it, which is fine for these).
    let read = || -> windows::core::Result<u32> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let props = device.OpenPropertyStore(STGM_READ)?;
            let value = props.GetValue(&PKEY_AudioEndpoint_FormFactor)?;
            PropVariantToUInt32(&value)
        }
    };
    match read().map(|f| EndpointFormFactor(f as i32)) {
        Ok(f) if f == Headphones || f == Headset => Output::Headphones,
        Ok(f) if f == Speakers => Output::Speakers,
        _ => Output::Unknown,
    }
}

#[cfg(not(windows))]
pub fn default_output() -> Output {
    Output::Unknown
}

#[cfg(test)]
mod tests {
    /// This PC's default output (`cargo test default_output -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn reads_the_default_output() {
        println!("default output: {:?}", super::default_output());
    }
}
