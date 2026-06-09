// Typed wrappers over the Editor's filesystem commands (step 1.8). The backend
// (`src-tauri/src/fs`) routes through std::fs rather than `tauri-plugin-fs` for
// the same reason as `sys::open_path`: the editor browses arbitrary registered
// working dirs, which a fixed front-end ACL scope can't enumerate ahead of time.

import { invoke } from "@tauri-apps/api/core";

/** One entry in a directory listing — a folder (expandable) or a file (openable). */
export interface DirEntry {
  /** Final path component — the tree label. */
  name: string;
  /** Absolute path — the stable key, and what we read/expand. */
  path: string;
  /** Directory vs. file. */
  isDir: boolean;
}

/** List the immediate children of `path` (dirs first, then files, name-sorted). */
export function readDir(path: string): Promise<DirEntry[]> {
  return invoke("read_dir", { path });
}

/** Read a UTF-8 text file. Rejects oversized or binary files (see the backend). */
export function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

/** Overwrite an existing file with `content`. */
export function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}
