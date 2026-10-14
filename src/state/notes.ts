// Notes store (step N1) — the runtime registry of Notes panels, one per project,
// keyed `notes:<projectId>` so reopening focuses the existing panel. Sibling of
// the skills/git stores; like them the binding is persisted in the layout, plus
// which note the panel had open.
//
// It also holds the open notes' buffers: a project swap unmounts the dock's
// panels, and unsaved text must outlive that the way an editor's does. A buffer
// remembers the revision it was read at, which every save hands back to the
// backend so a note changed elsewhere (the phone) is never silently overwritten.

import { useSyncExternalStore } from "react";

export interface NotesSession {
  /** Deterministic `notes:<projectId>` — the dock panel id + reconcile key. */
  notesId: string;
  projectId: string;
  /** Display label — the project name. */
  title: string;
  /** The note shown, by id, or null. */
  activeNote: string | null;
}

/** A persisted notes panel: its binding and the note it showed. */
export type NotesDescriptor = NotesSession;

interface NotesState {
  open: NotesSession[];
  /** The panel to bring to front, or null. Only a *new* value triggers focus. */
  activeId: string | null;
}

let state: NotesState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: NotesState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getOpenNotes(): NotesSession[] {
  return state.open;
}

export function getActiveNotesId(): string | null {
  return state.activeId;
}

export function notesIdFor(projectId: string): string {
  return `notes:${projectId}`;
}

/** Open (or focus) a project's notes panel. */
export function openNotes(target: { projectId: string; title: string }): void {
  const notesId = notesIdFor(target.projectId);
  if (state.open.some((n) => n.notesId === notesId)) {
    const open = state.open.map((n) => (n.notesId === notesId ? { ...n, title: target.title } : n));
    emit({ open, activeId: notesId });
    return;
  }
  const session: NotesSession = { notesId, ...target, activeNote: null };
  emit({ open: [...state.open, session], activeId: notesId });
}

/** Seed panels a saved layout restores. Idempotent. */
export function hydrateNotes(descriptors: NotesDescriptor[]): void {
  const present = new Set(state.open.map((n) => n.notesId));
  const additions = descriptors
    .filter((d) => !present.has(d.notesId))
    .map((d) => ({ ...d, activeNote: d.activeNote ?? null }));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

export function closeNotes(notesId: string): void {
  if (!state.open.some((n) => n.notesId === notesId)) return;
  const open = state.open.filter((n) => n.notesId !== notesId);
  emit({ open, activeId: state.activeId === notesId ? null : state.activeId });
}

/** Show `noteId` (or nothing) in the panel. */
export function setActiveNote(notesId: string, noteId: string | null): void {
  const open = state.open.map((n) => (n.notesId === notesId ? { ...n, activeNote: noteId } : n));
  emit({ ...state, open });
}

export function useNotes(): NotesState {
  return useSyncExternalStore(subscribe, () => state);
}

// --- buffers -------------------------------------------------------------------

/** An open note's text as edited here. */
export interface NoteBuffer {
  content: string;
  /** The text as last read or saved. */
  baseline: string;
  /** The revision `baseline` was read or saved at. */
  revision: string;
  /** The file on disk, for an `@path` reference. */
  path: string;
}

let buffers: ReadonlyMap<string, NoteBuffer> = new Map();
const bufferListeners = new Set<() => void>();

const bufferKey = (projectId: string, noteId: string) => `${projectId}\n${noteId}`;

function putBuffers(next: Map<string, NoteBuffer>): void {
  buffers = next;
  for (const l of bufferListeners) l();
}

export function getBuffer(projectId: string, noteId: string): NoteBuffer | undefined {
  return buffers.get(bufferKey(projectId, noteId));
}

/** Set a buffer whole (after a read or a save). */
export function setBuffer(projectId: string, noteId: string, buffer: NoteBuffer): void {
  const next = new Map(buffers);
  next.set(bufferKey(projectId, noteId), buffer);
  putBuffers(next);
}

/** Record an edit. */
export function editBuffer(projectId: string, noteId: string, content: string): void {
  const prev = getBuffer(projectId, noteId);
  if (!prev || prev.content === content) return;
  setBuffer(projectId, noteId, { ...prev, content });
}

/** Forget a buffer (the note was deleted, or renamed: `to` takes it over). */
export function moveBuffer(projectId: string, noteId: string, to: string | null): void {
  const prev = getBuffer(projectId, noteId);
  if (!prev) return;
  const next = new Map(buffers);
  next.delete(bufferKey(projectId, noteId));
  if (to !== null) next.set(bufferKey(projectId, to), prev);
  putBuffers(next);
}

export function isDirty(buffer: NoteBuffer | undefined): boolean {
  return !!buffer && buffer.content !== buffer.baseline;
}

export function useBuffer(projectId: string, noteId: string | null): NoteBuffer | undefined {
  return useSyncExternalStore(
    (cb) => {
      bufferListeners.add(cb);
      return () => {
        bufferListeners.delete(cb);
      };
    },
    () => (noteId === null ? undefined : buffers.get(bufferKey(projectId, noteId))),
  );
}

/** A name for a new note not already taken: "untitled", "untitled 2", … */
export function freshName(taken: readonly string[], base = "untitled"): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base)) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`)) return `${base} ${n}`;
}
