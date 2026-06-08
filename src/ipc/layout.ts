// Typed wrappers over the Rust layout commands (step 1.6). The dock tree is an
// opaque JSON string to the backend — the frontend owns its shape (see
// `state/layout`), so the dockview serialization format can change without a
// schema migration.

import { invoke } from "@tauri-apps/api/core";

/** Read the saved dock tree for a workspace key, or null if none stored yet. */
export function getLayout(key: string): Promise<string | null> {
  return invoke("get_layout", { key });
}

/** Persist the dock tree for a workspace key. */
export function setLayout(key: string, tree: string): Promise<void> {
  return invoke("set_layout", { key, tree });
}
