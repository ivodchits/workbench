// Project notes (step N1) — typed wrappers over the backend notes module
// (`src-tauri/src/notes`). A note is addressed by project id and note id (its
// name), never by a path. Reads carry a revision; a write names the revision it
// was edited from and is refused (an error starting `stale:`) if the note moved.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface NoteMeta {
  id: string;
  /** Last modified, ms since the epoch. */
  modified: number;
  size: number;
}

export interface Note {
  id: string;
  content: string;
  revision: string;
  /** The file on disk — for an `@path` reference only. */
  path: string;
}

/** A refused write: the note changed (or went away) since it was read. */
export function isStale(err: unknown): boolean {
  return String(err).startsWith("stale:");
}

export function notesList(projectId: string): Promise<NoteMeta[]> {
  return invoke("notes_list", { projectId });
}

export function notesRead(projectId: string, id: string): Promise<Note> {
  return invoke("notes_read", { projectId, id });
}

/** Save `content`. `baseRevision` null overwrites whatever is there. Resolves
 *  with the new revision. */
export function notesWrite(
  projectId: string,
  id: string,
  content: string,
  baseRevision: string | null,
): Promise<string> {
  return invoke("notes_write", { projectId, id, content, baseRevision });
}

export function notesCreate(projectId: string, id: string): Promise<Note> {
  return invoke("notes_create", { projectId, id });
}

/** Make a note holding `content`, named `name` or "name 2", "name 3", … when taken. */
export function notesCreateWith(projectId: string, name: string, content: string): Promise<Note> {
  return invoke("notes_create_with", { projectId, name, content });
}

export function notesRename(projectId: string, id: string, to: string): Promise<void> {
  return invoke("notes_rename", { projectId, id, to });
}

export function notesDelete(projectId: string, id: string): Promise<void> {
  return invoke("notes_delete", { projectId, id });
}

/** Fired after any change to a project's notes, from this window or the phone. */
export function onNotesChanged(cb: (projectId: string) => void): Promise<UnlistenFn> {
  return listen<{ projectId: string }>("notes-changed", (e) => cb(e.payload.projectId));
}
