//! Attachments (step G1): files you paste, drop or pick into Duck, stored once and
//! referenced by the messages that carry them.
//!
//! A file is copied to `<app data>/duck-attachments/<id>/<name>` (`duck-attachments.dev`
//! for a debug build), where the id is the first 32 hex digits of its SHA-256: the
//! same bytes are stored once, under each name they came with. What the engine
//! sends for it is worked out once ([`prepare`]) and kept beside it in `.duck/`:
//! an image downscaled to at most 1568 px on the long side, so a thread's history
//! sends the same bytes every time. Images get a small JPEG thumbnail, returned as
//! a data URL for the chips.
//!
//! Files no message or task refers to are pruned after a week ([`prune`]).

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// The longest side an image is sent at.
pub const API_SIDE: u32 = 1568;
/// The thumbnail's longest side.
const THUMB_SIDE: u32 = 160;
/// Text files up to this size are read by Duck as text.
pub const TEXT_MAX: u64 = 50 * 1024;
/// The API's limits for a PDF.
const PDF_MAX: u64 = 32 * 1024 * 1024;
const PDF_PAGES_MAX: usize = 100;
/// The biggest file Duck takes.
pub const FILE_MAX: u64 = 200 * 1024 * 1024;
/// Derived files, beside the stored ones.
const DERIVED: &str = ".duck";

/// A stored attachment, as the messages refer to it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// The file's full path (for the brief, the drag out and the model's ref).
    pub path: String,
    /// An image's thumbnail as a `data:image/jpeg;base64,…` URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
}

/// How the engine sends an attachment.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// `image`, `document` (a PDF), `text`, or `ref` (name, size and path only).
    #[serde(rename = "as")]
    pub kind: String,
    /// The image's or PDF's media type as sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// About how many input tokens reading it costs.
    pub tokens: u64,
    /// A text file's contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Why it's a `ref` when it isn't simply a kind Duck doesn't read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

pub fn root(app_data: &Path) -> PathBuf {
    app_data.join(if cfg!(debug_assertions) { "duck-attachments.dev" } else { "duck-attachments" })
}

fn check_id(id: &str) -> Result<(), String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(format!("not an attachment id: {id}"));
    }
    Ok(())
}

/// A file name that is safe as one path component: no folders, no characters
/// Windows refuses, no leading dot (`.duck` is ours), at most 120 characters.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out: String = base
        .chars()
        .map(|c| if c.is_control() || r#"<>:"|?*"#.contains(c) { '_' } else { c })
        .collect();
    out = out.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).to_string();
    if out.chars().count() > 120 {
        let (stem, ext) = match out.rfind('.') {
            Some(i) if out.len() - i <= 10 => (out[..i].to_string(), out[i..].to_string()),
            _ => (out.clone(), String::new()),
        };
        out = stem.chars().take(120 - ext.chars().count()).collect::<String>() + &ext;
    }
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2"];
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if out.is_empty() || reserved.contains(&stem.as_str()) {
        out = format!("file{}", if out.is_empty() { String::new() } else { format!("-{out}") });
    }
    out
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "xml",
    "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "java", "kt", "kts", "c", "h",
    "cpp", "hpp", "cc", "cs", "rb", "php", "sh", "bash", "ps1", "bat", "cmd", "sql", "swift", "lua", "r", "tex",
    "srt", "vtt", "gitignore", "env", "properties", "gradle", "vue", "svelte", "dart", "scala", "pl", "m", "el",
];

/// The media type, from the name, and from the bytes for images.
pub fn mime_of(name: &str, head: &[u8]) -> String {
    if let Ok(f) = image::guess_format(head) {
        let m = match f {
            image::ImageFormat::Png => Some("image/png"),
            image::ImageFormat::Jpeg => Some("image/jpeg"),
            image::ImageFormat::Gif => Some("image/gif"),
            image::ImageFormat::WebP => Some("image/webp"),
            image::ImageFormat::Bmp => Some("image/bmp"),
            _ => None,
        };
        if let Some(m) = m {
            return m.into();
        }
    }
    if head.starts_with(b"%PDF-") {
        return "application/pdf".into();
    }
    let ext = ext_of(name);
    let m = match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heic",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "zip" => "application/zip",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "json" | "jsonl" => "application/json",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        _ if TEXT_EXTS.contains(&ext.as_str()) => "text/plain",
        _ => "application/octet-stream",
    };
    m.into()
}

fn sha_id(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// A small JPEG of an image, as a data URL; `None` for what isn't one.
fn thumbnail(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let small = img.thumbnail(THUMB_SIDE, THUMB_SIDE).into_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 70).encode_image(&small).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

/// Store `bytes` as `name`.
pub fn store_bytes(root: &Path, name: &str, bytes: &[u8]) -> Result<Stored, String> {
    if bytes.len() as u64 > FILE_MAX {
        return Err(format!("{name} is over {} MB", FILE_MAX / (1024 * 1024)));
    }
    let id = sha_id(bytes);
    let name = clean_name(name);
    let folder = root.join(&id);
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create {}: {e}", folder.display()))?;
    let path = folder.join(&name);
    if !path.exists() {
        let tmp = folder.join(format!("{DERIVED}.tmp-{}", std::process::id()));
        std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    let mime = mime_of(&name, &bytes[..bytes.len().min(64)]);
    let thumb = if mime.starts_with("image/") { thumbnail(bytes) } else { None };
    Ok(Stored { id, name, mime, size: bytes.len() as u64, path: path.to_string_lossy().into_owned(), thumb })
}

/// Store the file at `path` (a drop or the picker).
pub fn store_path(root: &Path, path: &Path) -> Result<Stored, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder: drop the files in it", path.display()));
    }
    if meta.len() > FILE_MAX {
        return Err(format!("{} is over {} MB", path.display(), FILE_MAX / (1024 * 1024)));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    store_bytes(root, &name, &bytes)
}

/// The stored file `id` / `name`.
pub fn file_of(root: &Path, id: &str, name: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    let path = root.join(id).join(clean_name(name));
    if !path.is_file() {
        return Err(format!("the attachment {name} is gone"));
    }
    Ok(path)
}

/// About how many tokens an image of `w` × `h` costs.
fn image_tokens(w: u32, h: u32) -> u64 {
    ((w as u64 * h as u64) / 750).max(1)
}

/// How many pages a PDF has, counted from its page objects (a guess, never 0).
fn pdf_pages(bytes: &[u8]) -> usize {
    let needle = b"/Type";
    let mut n = 0;
    let mut i = 0;
    while i + needle.len() < bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let mut j = i + needle.len();
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\r' || bytes[j] == b'\n') {
                j += 1;
            }
            if bytes[j..].starts_with(b"/Page") && !bytes[j..].starts_with(b"/Pages") {
                n += 1;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    n.max(1)
}

/// The image as it's sent: at most [`API_SIDE`] on the long side; a JPEG stays a
/// JPEG, anything else becomes a PNG (a JPEG when that's over 3.5 MB). Kept in
/// `.duck/` so it's made once. Returns the file and its media type.
fn api_image(folder: &Path, src: &Path) -> Result<(PathBuf, String, u32, u32), String> {
    let derived = folder.join(DERIVED);
    for (file, mime) in [("api.jpg", "image/jpeg"), ("api.png", "image/png")] {
        let p = derived.join(file);
        if p.is_file() {
            let (w, h) = image::image_dimensions(&p).map_err(|e| e.to_string())?;
            return Ok((p, mime.into(), w, h));
        }
    }
    let bytes = std::fs::read(src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("not an image Duck can read: {e}"))?;
    let img = if img.width().max(img.height()) > API_SIDE { img.resize(API_SIDE, API_SIDE, image::imageops::FilterType::Lanczos3) } else { img };
    let jpeg = |img: &image::DynamicImage| -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
            .encode_image(&img.to_rgb8())
            .map_err(|e| e.to_string())?;
        Ok(out)
    };
    let was_jpeg = matches!(image::guess_format(&bytes), Ok(image::ImageFormat::Jpeg));
    let (out, file, mime) = if was_jpeg {
        (jpeg(&img)?, "api.jpg", "image/jpeg")
    } else {
        let mut png = Vec::new();
        img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| e.to_string())?;
        if png.len() > 3_500_000 { (jpeg(&img)?, "api.jpg", "image/jpeg") } else { (png, "api.png", "image/png") }
    };
    std::fs::create_dir_all(&derived).map_err(|e| e.to_string())?;
    let p = derived.join(file);
    std::fs::write(&p, out).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
    Ok((p, mime.into(), img.width(), img.height()))
}

/// How the engine sends the attachment `id` / `name`.
pub fn prepare(root: &Path, id: &str, name: &str) -> Result<Prepared, String> {
    let path = file_of(root, id, name)?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let mut head = vec![0u8; 64];
    let n = std::io::Read::read(&mut std::fs::File::open(&path).map_err(|e| e.to_string())?, &mut head).unwrap_or(0);
    head.truncate(n);
    let mime = mime_of(name, &head);
    let refd = |why: Option<String>| Prepared { kind: "ref".into(), media_type: None, tokens: 0, text: None, why };
    if matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp") {
        return Ok(match api_image(&root.join(id), &path) {
            Ok((_, media, w, h)) => Prepared { kind: "image".into(), media_type: Some(media), tokens: image_tokens(w, h), text: None, why: None },
            Err(e) => refd(Some(e)),
        });
    }
    if mime == "application/pdf" {
        if size > PDF_MAX {
            return Ok(refd(Some(format!("over {} MB, the API's limit for a PDF", PDF_MAX / (1024 * 1024)))));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let pages = pdf_pages(&bytes);
        if pages > PDF_PAGES_MAX {
            return Ok(refd(Some(format!("{pages} pages, over the API's {PDF_PAGES_MAX}"))));
        }
        // Each page is read as text and as an image.
        return Ok(Prepared { kind: "document".into(), media_type: Some(mime), tokens: pages as u64 * 2000, text: None, why: None });
    }
    let texty = mime.starts_with("text/") || mime == "application/json" || TEXT_EXTS.contains(&ext_of(name).as_str());
    if texty {
        if size > TEXT_MAX {
            return Ok(refd(Some(format!("over {} KB of text", TEXT_MAX / 1024))));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        return Ok(match std::str::from_utf8(bytes) {
            Ok(t) if !t.contains('\0') => {
                let text = t.replace("\r\n", "\n");
                Prepared { kind: "text".into(), media_type: None, tokens: (text.chars().count() as u64 / 4).max(1), text: Some(text), why: None }
            }
            _ => refd(Some("not UTF-8 text".into())),
        });
    }
    Ok(refd(None))
}

/// The bytes the engine sends for an `image` or `document`, base64.
pub fn data(root: &Path, id: &str, name: &str, kind: &str) -> Result<String, String> {
    let path = file_of(root, id, name)?;
    let send = match kind {
        "image" => api_image(&root.join(id), &path)?.0,
        "document" => path,
        _ => return Err(format!("{kind} isn't sent as data")),
    };
    let bytes = std::fs::read(&send).map_err(|e| format!("cannot read {}: {e}", send.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Copy attachments into `dest` (a task's `inputs/`), each under its name; a name
/// used twice gets ` (2)`. Returns the names as written.
pub fn copy_into(root: &Path, files: &[(String, String)], dest: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let mut names = Vec::new();
    for (id, name) in files {
        let src = file_of(root, id, name)?;
        let clean = clean_name(name);
        let mut out = clean.clone();
        let mut n = 2;
        while names.contains(&out) || dest.join(&out).exists() {
            out = match clean.rsplit_once('.') {
                Some((s, e)) => format!("{s} ({n}).{e}"),
                None => format!("{clean} ({n})"),
            };
            n += 1;
        }
        std::fs::copy(&src, dest.join(&out)).map_err(|e| format!("cannot copy {name}: {e}"))?;
        names.push(out);
    }
    Ok(names)
}

/// Store every file directly in `dir` (a task's `outputs/`), at most `max`.
pub fn store_folder(root: &Path, dir: &Path, max: usize) -> Result<Vec<Stored>, String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(Vec::new()) };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    paths.sort();
    paths.into_iter().take(max).map(|p| store_path(root, &p)).collect()
}

/// Remove stored attachments no longer referred to: each folder older than
/// `older_ms` for which `referred(id)` is false. Returns how many went.
pub fn prune(root: &Path, older_ms: u64, referred: impl Fn(&str) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut n = 0;
    for e in entries.flatten() {
        let id = e.file_name().to_string_lossy().into_owned();
        if check_id(&id).is_err() {
            continue;
        }
        let age = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok());
        if age.map(|a| a.as_millis() as u64) < Some(older_ms) || referred(&id) {
            continue;
        }
        if std::fs::remove_dir_all(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("duck-att-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img).write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    #[test]
    fn stores_once_by_content_under_each_name() {
        let root = tmp();
        let a = store_bytes(&root, "notes.txt", b"hello").unwrap();
        let b = store_bytes(&root, "copy.txt", b"hello").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.id.len(), 32);
        assert!(Path::new(&a.path).is_file() && Path::new(&b.path).is_file());
        assert_eq!(a.mime, "text/plain");
        assert_eq!(a.thumb, None);
        assert!(file_of(&root, &a.id, "../x").is_err());
        assert!(file_of(&root, "../../etc", "x").is_err());
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name(r"C:\x\a:b?.png"), "a_b_.png");
        assert_eq!(clean_name("../.duck"), "duck");
        assert_eq!(clean_name("CON.txt"), "file-CON.txt");
        assert_eq!(clean_name(""), "file");
        let long = format!("{}.csv", "a".repeat(200));
        let c = clean_name(&long);
        assert!(c.ends_with(".csv") && c.chars().count() == 120);
    }

    #[test]
    fn an_image_is_sent_downscaled_with_a_thumbnail() {
        let root = tmp();
        let s = store_bytes(&root, "shot.png", &png(3000, 1000)).unwrap();
        assert_eq!(s.mime, "image/png");
        assert!(s.thumb.as_deref().unwrap().starts_with("data:image/jpeg;base64,"));
        let p = prepare(&root, &s.id, &s.name).unwrap();
        assert_eq!(p.kind, "image");
        assert_eq!(p.media_type.as_deref(), Some("image/png"));
        let (w, h) = image::image_dimensions(root.join(&s.id).join(".duck/api.png")).unwrap();
        assert_eq!((w, h), (1568, 523));
        assert_eq!(p.tokens, 1568 * 523 / 750);
        // The same bytes every time.
        let d1 = data(&root, &s.id, &s.name, "image").unwrap();
        let d2 = data(&root, &s.id, &s.name, "image").unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn text_pdf_and_the_rest() {
        let root = tmp();
        let t = store_bytes(&root, "a.csv", b"\xEF\xBB\xBFx,y\r\n1,2\r\n").unwrap();
        let p = prepare(&root, &t.id, &t.name).unwrap();
        assert_eq!((p.kind.as_str(), p.text.as_deref()), ("text", Some("x,y\n1,2\n")));
        let big = store_bytes(&root, "big.log", &vec![b'a'; 60 * 1024]).unwrap();
        assert_eq!(prepare(&root, &big.id, &big.name).unwrap().kind, "ref");
        let pdf = store_bytes(&root, "doc.pdf", b"%PDF-1.4\n1 0 obj << /Type /Pages >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>").unwrap();
        let p = prepare(&root, &pdf.id, &pdf.name).unwrap();
        assert_eq!((p.kind.as_str(), p.tokens), ("document", 4000));
        let zip = store_bytes(&root, "a.zip", b"PK\x03\x04").unwrap();
        let p = prepare(&root, &zip.id, &zip.name).unwrap();
        assert_eq!((p.kind.as_str(), p.why), ("ref", None));
    }

    #[test]
    fn copies_into_a_task_and_stores_its_outputs() {
        let root = tmp();
        let a = store_bytes(&root, "a.csv", b"1").unwrap();
        let b = store_bytes(&root, "a.csv", b"2").unwrap();
        let dest = tmp().join("inputs");
        let names = copy_into(&root, &[(a.id.clone(), a.name.clone()), (b.id.clone(), b.name.clone())], &dest).unwrap();
        assert_eq!(names, vec!["a.csv", "a (2).csv"]);
        let out = dest.parent().unwrap().join("outputs");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("merged.xlsx"), b"PK\x03\x04xx").unwrap();
        let stored = store_folder(&root, &out, 20).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].name, "merged.xlsx");
        assert!(stored[0].mime.contains("spreadsheet"));
    }

    #[test]
    fn prunes_what_nothing_refers_to() {
        let root = tmp();
        let a = store_bytes(&root, "a.txt", b"a").unwrap();
        let b = store_bytes(&root, "b.txt", b"b").unwrap();
        assert_eq!(prune(&root, 60_000, |_| false), 0, "young files stay");
        assert_eq!(prune(&root, 0, |id| id == a.id), 1);
        assert!(root.join(&a.id).exists() && !root.join(&b.id).exists());
    }
}
