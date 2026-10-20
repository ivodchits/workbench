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

// --- for Duck (assistant plan W5) ---------------------------------------------------

/** The file as text: `text` and `revision` are null when there is none. */
export interface PluginsText {
  path: string;
  revision: string | null;
  text: string | null;
}

export function pluginsText(projectId: string): Promise<PluginsText> {
  return invoke("plugins_text", { projectId });
}

/** Everything wrong with `text` as a plugin file; empty when it would save. */
export function pluginsCheck(text: string): Promise<Problem[]> {
  return invoke("plugins_check", { text });
}

/** Delete the file if it is still at `baseRevision` (an error starting `stale:`
 *  when it isn't). */
export function pluginsRemove(projectId: string, baseRevision: string): Promise<void> {
  return invoke("plugins_remove", { projectId, baseRevision });
}

/** What running an action would spawn, without spawning it. `revision` pins the
 *  file: refused (`stale:`) when it changed since. */
export interface TaskPreview {
  argv: string[];
  cwd: string;
}

export function pluginsPreview(task: {
  projectId: string;
  pluginId: string;
  actionId: string;
  values: Record<string, string>;
  revision?: string;
}): Promise<TaskPreview> {
  return invoke("plugins_preview", { task });
}

/** A script in the project's `scripts/` folder (`{data}/scripts/<name>`); null
 *  when there is none. */
export function pluginsScriptRead(projectId: string, name: string): Promise<string | null> {
  return invoke("plugins_script_read", { projectId, name });
}

/** Write a script; `text: null` deletes it. */
export function pluginsScriptWrite(projectId: string, name: string, text: string | null): Promise<void> {
  return invoke("plugins_script_write", { projectId, name, text });
}

// --- toolbar drafts (W5, delegated edits) ------------------------------------------

/** A toolbar draft a drafting session left: its `plugins.json` (null when none)
 *  and the scripts in its `scripts/`. */
export interface PluginsDraft {
  path: string;
  text: string | null;
  scripts: { name: string; text: string }[];
}

/** Make a fresh draft (a copy of the live file and scripts) and register
 *  `instanceId` as its drafting session; returns the draft folder. */
export function pluginsDraftStart(projectId: string, instanceId: string): Promise<string> {
  return invoke("plugins_draft_start", { projectId, instanceId });
}

export function pluginsDraftRead(projectId: string): Promise<PluginsDraft> {
  return invoke("plugins_draft_read", { projectId });
}

/** Drop the draft, and launch its sessions as ordinary ones from then on. */
export function pluginsDraftClear(projectId: string): Promise<void> {
  return invoke("plugins_draft_clear", { projectId });
}
