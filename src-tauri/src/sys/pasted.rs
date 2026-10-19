//! Images pasted into the transcript view's composer.
//!
//! The composer hands prompts to the claude TUI as pasted text, so an image can't
//! travel as clipboard content. It is saved here, under `<temp>/workbench-paste`,
//! and its path is pasted into the TUI on its own when the prompt is sent — the
//! TUI turns a pasted image path into an `[Image #N]` attachment, reading the file
//! into memory there and then.
//!
//! So a file is needed only until its prompt is sent. The page deletes the files
//! of a prompt once their attachments have landed (`delete_pasted_images`), and at
//! startup prunes every file no saved draft still refers to (`prune_pasted_images`).

use std::path::PathBuf;

fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("workbench-paste")
}

/// The folder pasted images are saved in.
#[tauri::command]
pub fn pasted_image_dir() -> String {
    paste_dir().to_string_lossy().into_owned()
}

/// Save a pasted image (`subtype` as in its MIME type: `png`, `jpeg`, …) and
/// return its file name, which the composer keeps in the draft.
#[tauri::command]
pub fn save_pasted_image(data: Vec<u8>, subtype: String) -> Result<String, String> {
    let ext = image_ext(&subtype).ok_or_else(|| format!("not an image type: {subtype}"))?;
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("{}.{ext}", &id[..8]);
    std::fs::write(dir.join(&name), data).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Delete the named images (a sent prompt's). Names that aren't a bare file name
/// are skipped, so nothing outside the folder can be reached.
#[tauri::command]
pub fn delete_pasted_images(names: Vec<String>) {
    let dir = paste_dir();
    for name in names.iter().filter(|n| is_bare_name(n)) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Delete every image in the folder except the named ones (those a saved draft
/// still holds).
#[tauri::command]
pub fn prune_pasted_images(keep: Vec<String>) {
    let Ok(entries) = std::fs::read_dir(paste_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !keep.iter().any(|k| name == k.as_str()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The file extension for a pasted image's subtype, or `None` for anything
/// Claude can't read as an image.
fn image_ext(subtype: &str) -> Option<&'static str> {
    match subtype.to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpeg" | "jpg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        _ => None,
    }
}

fn is_bare_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':'])
}

#[cfg(test)]
mod tests {
    use super::{image_ext, is_bare_name};

    #[test]
    fn only_image_types_are_saved() {
        assert_eq!(image_ext("png"), Some("png"));
        assert_eq!(image_ext("JPEG"), Some("jpg"));
        assert_eq!(image_ext("svg+xml"), None);
        assert_eq!(image_ext("../x"), None);
    }

    #[test]
    fn deletes_stay_inside_the_folder() {
        assert!(is_bare_name("1a2b3c4d.png"));
        assert!(!is_bare_name("../x.png"));
        assert!(!is_bare_name("C:x.png"));
        assert!(!is_bare_name(".."));
    }
}
