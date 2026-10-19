// Project toolbar plugins (step K1) — typed wrappers over `src-tauri/src/plugins`.
// A project's plugins live in `plugins.json` in its notes folder. The backend parses
// and checks it; the toolbar only draws what comes back and names the action to run.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PluginFile {
  version: number;
  plugins: Plugin[];
}

export interface Plugin {
  id: string;
  label: string | null;
  controls: Control[];
  actions: PluginAction[];
}

export type Control =
  | { type: "select"; id: string; label: string | null; options: string[]; default: string }
  | {
      type: "text";
      id: string;
      label: string | null;
      placeholder: string | null;
      default: string;
      pattern: string | null;
    }
  | { type: "checkbox"; id: string; label: string | null; default: boolean; on: string; off: string }
  | { type: "button"; action: string };

export interface PluginAction {
  id: string;
  label: string;
  run: string[];
  cwd: string | null;
  env: Record<string, string>;
  confirm: string | null;
  long: boolean;
}

/** One thing wrong with the file, at its JSON path ("" = the file as a whole). */
export interface Problem {
  path: string;
  message: string;
}

/** A project's plugin file as read: absent (`revision` null), fine (`file`), or
 *  broken (`problems`). */
export interface PluginsView {
  path: string;
  revision: string | null;
  file: PluginFile | null;
  problems: Problem[];
}

export function pluginsRead(projectId: string): Promise<PluginsView> {
  return invoke("plugins_read", { projectId });
}

/** Replace the file. Refused when `text` doesn't parse, or (an error starting
 *  `stale:`) when the file moved on from `baseRevision`; null overwrites. */
export function pluginsWrite(projectId: string, text: string, baseRevision: string | null): Promise<string> {
  return invoke("plugins_write", { projectId, text, baseRevision });
}

/** Make the file (with a starter plugin) when there is none; returns its path. */
export function pluginsInit(projectId: string): Promise<string> {
  return invoke("plugins_init", { projectId });
}

/** Fired when a project's plugin file changes, however it was saved. */
export function onPluginsChanged(cb: (projectId: string) => void): Promise<UnlistenFn> {
  return listen<{ projectId: string }>("plugins-changed", (e) => cb(e.payload.projectId));
}
