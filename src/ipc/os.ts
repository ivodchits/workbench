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
