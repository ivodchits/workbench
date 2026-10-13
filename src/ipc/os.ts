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

/** Open a web or mail link in the user's browser (step T3). The backend refuses
 *  every other scheme — links come from untrusted transcript text. */
export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}
