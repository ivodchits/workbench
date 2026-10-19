// Typed wrappers over OS-integration commands (step 1.4). Currently just
// "open a working directory in the OS file manager" for the instance rail's
// row action. The backend (`sys::open_path`) routes through `tauri-plugin-
// opener`, so this is platform-agnostic (Explorer on Windows, the desktop file
// manager on Linux).

import { invoke } from "@tauri-apps/api/core";

/** Open a directory (or file) in the OS file manager. */
export function openPath(path: string): Promise<void> {
  return invoke("open_path", { path });
}

/**
 * Reveal a path in the OS file manager with the item itself selected (step G3 —
 * the Git panel's "reveal in Explorer"). Prefer this over `openPath` for a *file*:
 * `openPath` would launch it in its default application instead of showing it.
 */
export function revealPath(path: string): Promise<void> {
  return invoke("reveal_path", { path });
}

/** Open the project's Claude Code scratchpad folder (under `%TEMP%\claude`) in the
 *  OS file manager. Rejects with a readable message when no session made one yet. */
export function openScratchpad(rootPath: string): Promise<void> {
  return invoke("open_scratchpad", { rootPath });
}

/** The folder images pasted into the composer are saved in. */
export function pastedImageDir(): Promise<string> {
  return invoke("pasted_image_dir");
}

/** Save a pasted image (`subtype` as in its MIME type: `png`, `jpeg`, …) and
 *  resolve with its file name in `pastedImageDir`. Rejects for a non-image type. */
export function savePastedImage(data: Uint8Array, subtype: string): Promise<string> {
  return invoke("save_pasted_image", { data: Array.from(data), subtype });
}

/** Delete pasted images by file name (a sent prompt's). */
export function deletePastedImages(names: string[]): Promise<void> {
  return invoke("delete_pasted_images", { names });
}

/** Delete every pasted image but the named ones. */
export function prunePastedImages(keep: string[]): Promise<void> {
  return invoke("prune_pasted_images", { keep });
}

/** Open a web or mail link in the user's browser (step T3). The backend refuses
 *  every other scheme — links come from untrusted transcript text. */
export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}
