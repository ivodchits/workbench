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

// --- which notes a project uses (step N3) -----------------------------------------

/** An unlinked notes folder a project could take. */
export interface NotesCandidate {
  folder: string;
  name: string;
  origin: string | null;
  notes: number;
}

/** Where a project's notes stand. `linkedTo` is set when this call linked it to
 *  notes found by its repo's origin; `candidates` when the panel has to ask. */
export interface LinkStatus {
  linked: boolean;
  linkedTo: string | null;
  candidates: NotesCandidate[];
}

export function notesLinkStatus(projectId: string): Promise<LinkStatus> {
  return invoke("notes_link_status", { projectId });
}

export function notesLink(projectId: string, folder: string): Promise<void> {
  return invoke("notes_link", { projectId, folder });
}

export function notesStartNew(projectId: string): Promise<void> {
  return invoke("notes_start_new", { projectId });
}

// --- notes sync (step N3) -----------------------------------------------------------

export interface SyncStatus {
  /** This build may sync (the installed app, or a debug build with its own root). */
  available: boolean;
  remote: string | null;
  state: "off" | "idle" | "syncing" | "failing";
  /** ms since the epoch. */
  lastSync: number | null;
  error: string | null;
  machine: string;
}

/** Something to know about a sync: a conflict copy, a restored note, a link, or
 *  an hour of failing. */
export interface SyncNotice {
  at: number;
  kind: "conflict" | "restored" | "linked" | "failing";
  text: string;
}

export function notesSyncStatus(): Promise<{ status: SyncStatus; notices: SyncNotice[] }> {
  return invoke("notes_sync_status");
}

/** Create a private GitHub repo for the notes (with `gh`) and start syncing. */
export function notesSyncCreate(name: string): Promise<void> {
  return invoke("notes_sync_create", { name });
}

/** Join an existing notes repo; this machine's notes are merged in. */
export function notesSyncJoin(url: string): Promise<void> {
  return invoke("notes_sync_join", { url });
}

export function notesSyncDisable(): Promise<void> {
  return invoke("notes_sync_disable");
}

export function notesSyncNow(): Promise<void> {
  return invoke("notes_sync_now");
}

/** The window came back; the backend pulls if the last pull is 5 minutes old. */
export function notesSyncFocus(): Promise<void> {
  return invoke("notes_sync_focus");
}

export function onSyncStatus(cb: (s: SyncStatus) => void): Promise<UnlistenFn> {
  return listen<SyncStatus>("notes-sync-status", (e) => cb(e.payload));
}

export function onSyncNotice(cb: (n: SyncNotice) => void): Promise<UnlistenFn> {
  return listen<SyncNotice>("notes-sync-notice", (e) => cb(e.payload));
}
