//! What voice downloads on first use (step V1): ONNX Runtime with DirectML, the
//! Parakeet model and Silero VAD. Nothing is bundled with the app. Everything goes
//! under `<app local data>/models/` (`models.dev/` in a debug build), each file
//! pinned by URL, size and SHA-256.
//!
//! - **Runtime:** `onnxruntime.dll` 1.24.2 (the version `ort` rc.12 is built
//!   against) and `DirectML.dll`, taken from PyPI's `onnxruntime-directml` wheel:
//!   one 25 MB download, where NuGet's DirectML package alone is 200 MB.
//! - **Parakeet** from `istupakov/parakeet-tdt-0.6b-v3-onnx` at a pinned commit: the
//!   int8 encoder and decoder for the CPU (~670 MB), fp32 for the GPU (~2.5 GB).
//! - **Silero VAD** v6.2.1, the model X0 measured.
//! - **Smart Turn** v3.2 (fp32) for conversation mode (step V4), from
//!   `pipecat-ai/smart-turn-v3` at a pinned commit.
//!
//! A download goes to `<file>.part` and resumes from there (HTTP `Range`), and only
//! a file whose hash matches is renamed into place. A file already in place is
//! trusted by its size.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub struct Asset {
    /// Its path under the models folder.
    pub path: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}



pub const PARAKEET_DIR: &str = "parakeet-tdt-0.6b-v3";
pub const RUNTIME_DIR: &str = "onnxruntime-1.24.2-directml";

macro_rules! hf {
    ($file:literal, $size:literal, $sha:literal) => {
        Asset { path: concat!("parakeet-tdt-0.6b-v3/", $file), url: concat!("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/", $file), size: $size, sha256: $sha }
    };
}

/// Both precisions need these.
pub const COMMON: &[Asset] = &[
    hf!("nemo128.onnx", 139_764, "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
    hf!("vocab.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
    Asset {
        path: "silero_vad.onnx",
        url: "https://github.com/snakers4/silero-vad/raw/v6.2.1/src/silero_vad/data/silero_vad.onnx",
        size: 2_327_524,
        sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    },
];

pub const INT8: &[Asset] = &[
    hf!("encoder-model.int8.onnx", 652_183_999, "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
    hf!("decoder_joint-model.int8.onnx", 18_202_004, "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
];

pub const FP32: &[Asset] = &[
    hf!("encoder-model.onnx", 41_770_866, "98a74b21b4cc0017c1e7030319a4a96f4a9506e50f0708f3a516d02a77c96bb1"),
    hf!("encoder-model.onnx.data", 2_435_420_160, "9a22d372c51455c34f13405da2520baefb7125bd16981397561423ed32d24f36"),
    hf!("decoder_joint-model.onnx", 72_520_893, "e978ddf6688527182c10fde2eb4b83068421648985ef23f7a86be732be8706c1"),
];

/// Conversation mode's turn detector (step V4), fp32 (see `turn.rs` for why not
/// int8). Not needed for push-to-talk, so a missing one doesn't stop it.
pub const TURN: &[Asset] = &[Asset {
    path: "smart-turn-v3.2-gpu.onnx",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-gpu.onnx",
    size: 32_411_198,
    sha256: "ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be",
}];

/// The wheel the runtime comes from, and the files taken out of it.
pub const RUNTIME_WHEEL: Asset = Asset {
    path: "onnxruntime_directml-1.24.2-cp312-cp312-win_amd64.whl",
    url: "https://files.pythonhosted.org/packages/02/38/89409f547cbd8bdbb2ed43f020532ebbff7279ba0ee41fb2c8be4172eead/onnxruntime_directml-1.24.2-cp312-cp312-win_amd64.whl",
    size: 24_997_869,
    sha256: "a762ca15eed486374d90f1aad5dabd20ab285210c7d422773f263a52f1fe2bf9",
};
pub const RUNTIME_FILES: &[&str] = &["onnxruntime.dll", "DirectML.dll", "onnxruntime_providers_shared.dll"];

/// Is `asset` in place (by its size)?
pub fn present(root: &Path, asset: &Asset) -> bool {
    fs::metadata(root.join(asset.path)).is_ok_and(|m| m.len() == asset.size)
}

/// Is the runtime unpacked?
pub fn runtime_present(root: &Path) -> bool {
    RUNTIME_FILES.iter().all(|f| root.join(RUNTIME_DIR).join(f).is_file())
}

/// Bytes still to download for these assets (and the runtime, when `runtime`).
pub fn missing_bytes(root: &Path, sets: &[&[Asset]], runtime: bool) -> u64 {
    let assets: u64 = sets.iter().flat_map(|s| s.iter()).filter(|a| !present(root, a)).map(|a| a.size).sum();
    assets + if runtime && !runtime_present(root) { RUNTIME_WHEEL.size } else { 0 }
}

/// Download `asset` into `root` unless it's there. `progress(bytes)` hears each
/// chunk written.
pub fn fetch(root: &Path, asset: &Asset, progress: &mut dyn FnMut(u64)) -> Result<PathBuf, String> {
    let dest = root.join(asset.path);
    if present(root, asset) {
        return Ok(dest);
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    let part = dest.with_extension(format!("{}.part", dest.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > asset.size {
        let _ = fs::remove_file(&part);
        have = 0;
    }
    if have < asset.size {
        let mut req = ureq::get(asset.url);
        if have > 0 {
            req = req.header("Range", &format!("bytes={have}-"));
        }
        let resp = req.call().map_err(|e| format!("downloading {}: {e}", asset.path))?;
        // A server that ignores the range sends it all again.
        if have > 0 && resp.status() != 206 {
            have = 0;
        }
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .append(have > 0)
            .truncate(have == 0)
            .open(&part)
            .map_err(|e| format!("writing {}: {e}", part.display()))?;
        if have > 0 {
            progress(have);
        }
        let mut body = resp.into_body().into_reader();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = body.read(&mut buf).map_err(|e| format!("downloading {}: {e}", asset.path))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| format!("writing {}: {e}", part.display()))?;
            progress(n as u64);
        }
        out.flush().map_err(|e| e.to_string())?;
    }
    let got = sha256_file(&part)?;
    if got != asset.sha256 {
        let _ = fs::remove_file(&part);
        return Err(format!("{} didn't match its checksum (got {got}); it was deleted, try again", asset.path));
    }
    fs::rename(&part, &dest).map_err(|e| format!("placing {}: {e}", dest.display()))?;
    Ok(dest)
}

/// Download the wheel and unpack the runtime from it; the wheel is deleted after.
pub fn fetch_runtime(root: &Path, progress: &mut dyn FnMut(u64)) -> Result<PathBuf, String> {
    let dir = root.join(RUNTIME_DIR);
    if runtime_present(root) {
        return Ok(dir);
    }
    let wheel = fetch(root, &RUNTIME_WHEEL, progress)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(File::open(&wheel).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for name in RUNTIME_FILES {
        let mut entry = zip
            .by_name(&format!("onnxruntime/capi/{name}"))
            .map_err(|e| format!("the runtime wheel has no {name}: {e}"))?;
        let tmp = dir.join(format!("{name}.part"));
        let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_file(&wheel);
    Ok(dir)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pins_are_consistent() {
        for a in COMMON.iter().chain(INT8).chain(FP32).chain(TURN) {
            assert_eq!(a.sha256.len(), 64, "{}", a.path);
            if a.url.contains("istupakov") {
                assert!(a.path.starts_with(PARAKEET_DIR) && a.url.ends_with(a.path.trim_start_matches("parakeet-tdt-0.6b-v3/")));
            }
        }
    }

    /// The pinned URLs and hashes of the small files, over the network, with a
    /// resumed download (`cargo test voice_download -- --ignored`).
    #[test]
    #[ignore]
    fn voice_download_small_files() {
        let root = std::env::temp_dir().join(format!("wb-voice-dl-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(PARAKEET_DIR)).unwrap();
        // Half of the vocabulary already there, as an interrupted download leaves it.
        let vocab = &COMMON[1];
        let full = ureq::get(vocab.url).call().unwrap().into_body().read_to_vec().unwrap();
        fs::write(root.join(format!("{}.part", vocab.path)), &full[..full.len() / 2]).unwrap();
        for a in COMMON {
            let mut got = 0;
            fetch(&root, a, &mut |n| got += n).unwrap();
            assert!(present(&root, a), "{}", a.path);
            assert_eq!(got, a.size, "{}", a.path);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_present_file_is_trusted_by_size() {
        let root = std::env::temp_dir().join(format!("wb-voice-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(PARAKEET_DIR)).unwrap();
        let vocab = &COMMON[1];
        fs::write(root.join(vocab.path), vec![0u8; vocab.size as usize]).unwrap();
        assert!(present(&root, vocab));
        assert_eq!(missing_bytes(&root, &[&COMMON[..2]], false), COMMON[0].size);
        // Already there: no download.
        assert_eq!(fetch(&root, vocab, &mut |_| {}).unwrap(), root.join(vocab.path));
        let _ = fs::remove_dir_all(&root);
    }
}
