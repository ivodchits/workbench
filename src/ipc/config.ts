// Duck's prompts as data (step L3): the files in the workspace's `config/`, and each
// thread's pin on the prompts it started with. See `src-tauri/src/assistant/config.rs`.

import { invoke } from "@tauri-apps/api/core";

/** One config file as it is on disk. */
export interface ConfigFileRow {
  /** `system.md`. */
  file: string;
  /** `config/system.md`, relative to the workspace. */
  path: string;
  /** null: no file yet. */
  text: string | null;
  /** The hash Duck recorded when it last wrote the built-in default into it. */
  seed: string | null;
}

export function configRead(workspace: string | null): Promise<ConfigFileRow[]> {
  return invoke("assistant_config_read", { workspace });
}

/** Write over `expected` (what was read; null: no file) and commit with `message`;
 *  throws "stale: …" over a newer edit. `seed`: the default's hash, when Duck
 *  writes the default. */
export function configWrite(
  workspace: string | null,
  file: string,
  text: string,
  expected: string | null,
  message: string,
  seed: string | null = null,
): Promise<void> {
  return invoke("assistant_config_write", { workspace, file, text, expected, seed, message });
}

/** Pin a thread on `json` (its prompts, hashed as `hash`); a pinned thread keeps
 *  its pin. */
export function configPin(threadId: string, hash: string, json: string): Promise<void> {
  return invoke("assistant_config_pin", { threadId, hash, json });
}

export function configPinned(threadId: string): Promise<string | null> {
  return invoke("assistant_config_pinned", { threadId });
}
