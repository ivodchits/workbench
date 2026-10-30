// Project notes on the phone (step R8): a count per project on the dashboard, the
// list with a quick note, and one note — read as markdown through the desktop's
// sanitised renderer, edited as a plain field that suits the phone keyboard and
// dictation.
//
// Every read and save goes to the desktop's notes module (`/api/notes…`). A save
// names the revision it was edited from; when the note moved on meanwhile, the
// desktop answers with the note as it is now and this shows both — keep mine as a
// new note, overwrite, or drop mine. Nothing is overwritten unseen. Typed text is
// kept on the device until it is saved, and offered again after a reload.

import { renderMarkdown } from "../panels/Editor/markdown";
import type { RemoteSnapshot } from "../remote/protocol";
import { $, el } from "./dom";
import { projectLabel } from "./format";
import { action, api, ApiError } from "./net";
import { dropDraft, loadDraft, nameFromText, saveDraft } from "./noteText";

interface NoteMeta {
  id: string;
  modified: number;
  size: number;
}

interface Note {
  id: string;
  content: string;
  revision: string;
}

/** What the open note's save ran into: the desktop's version (null: deleted). */
interface Conflict {
  theirs: Note | null;
}

let snap: RemoteSnapshot | null = null;
let counts = new Map<string, number>();
let projectId: string | null = null;
let notes: NoteMeta[] = [];
let note: Note | null = null;
let editing = false;
let conflict: Conflict | null = null;

const dirty = () => editing && note !== null && $<HTMLTextAreaElement>("note-edit").value !== note.content;

function message(text: string): void {
  const box = $("notes-msg");
  box.textContent = text;
  box.classList.toggle("hidden", !text);
}

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Can’t reach Workbench — try again when it’s back.";
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// --- dashboard ------------------------------------------------------------------

async function refreshCounts(): Promise<void> {
  try {
    const list = await api<{ projectId: string; count: number }[]>("/api/notes");
    counts = new Map(list.map((c) => [c.projectId, c.count]));
  } catch {
    return; // offline: keep the last counts
  }
  renderBar();
}

function renderBar(): void {
  const projects = snap?.projects ?? [];
  $("notes-bar").classList.toggle("hidden", projects.length === 0);
  $("notes-projects").replaceChildren(
    ...projects.map((p) => {
      const b = el("button");
      b.type = "button";
      const n = counts.get(p.id);
      b.append(projectLabel(p), el("span", "count", n ? ` · ${n}` : ""));
      b.onclick = () => void openProject(p.id);
      return b;
    }),
  );
}

// --- the list -------------------------------------------------------------------

function projectName(id: string): string {
  const p = snap?.projects.find((x) => x.id === id);
  return p ? projectLabel(p) : "notes";
}

function showView(which: "list" | "note"): void {
  $("notes-list-view").classList.toggle("hidden", which !== "list");
  $("note-view").classList.toggle("hidden", which !== "note");
  $("notes-back").classList.toggle("hidden", which !== "note");
}

/** Open a project's notes over the dashboard (a card's pencil, or the notes bar). */
export function openNotes(id: string): void {
  void openProject(id);
}

async function openProject(id: string): Promise<void> {
  projectId = id;
  note = null;
  $("notes-overlay").classList.remove("hidden");
  $("notes-title").textContent = `${projectName(id)} · notes`;
  message("");
  showView("list");
  await loadList();
}

async function loadList(): Promise<void> {
  if (!projectId) return;
  try {
    notes = await api<NoteMeta[]>("/api/notes/list", { query: { project: projectId } });
  } catch (e) {
    message(errorText(e));
    return;
  }
  renderList();
}

function renderList(): void {
  const q = $<HTMLInputElement>("notes-filter").value.trim().toLowerCase();
  $("notes-filter").classList.toggle("hidden", notes.length <= 4);
  $("notes-empty").classList.toggle("hidden", notes.length > 0);
  $("notes-list").replaceChildren(
    ...notes
      .filter((n) => !q || n.id.toLowerCase().includes(q))
      .map((n) => {
        const b = el("button");
        b.type = "button";
        b.append(el("span", "name", n.id), el("span", "when", ago(n.modified)));
        b.onclick = () => void openNote(n.id);
        return b;
      }),
  );
}

async function addQuick(): Promise<void> {
  const field = $<HTMLTextAreaElement>("notes-quick");
  const text = field.value.trim();
  if (!projectId || !text) return;
  try {
    const made = await api<Note>("/api/notes/create", {
      body: { project: projectId, name: nameFromText(text), content: text + "\n" },
    });
    field.value = "";
    await openNote(made.id);
  } catch (e) {
    message(errorText(e));
  }
}

// --- one note -------------------------------------------------------------------

async function openNote(id: string): Promise<void> {
  if (!projectId) return;
  let read: Note;
  try {
    read = await api<Note>("/api/notes/read", { query: { project: projectId, id } });
  } catch (e) {
    message(errorText(e));
    return;
  }
  note = read;
  editing = false;
  conflict = null;
  message("");
  $("notes-title").textContent = read.id;
  showView("note");
  renderNote();
  // An edit left unsaved earlier (a dropped link, a closed tab): offer it back.
  const draft = loadDraft(projectId, id);
  if (draft && draft.content !== read.content) {
    banner("An edit of yours from earlier wasn’t saved.", "restore", "discard", () => {
      startEdit(draft.content, draft.base);
    }, () => projectId && dropDraft(projectId, id));
  } else if (draft) dropDraft(projectId, id);
}

/** A choice above the note; either answer hides it. */
function banner(text: string, yes: string, no: string, onYes: () => void, onNo: () => void): void {
  $("note-banner-text").textContent = text;
  const y = $("note-banner-yes");
  const n = $("note-banner-no");
  y.textContent = yes;
  n.textContent = no;
  const hide = () => $("note-banner").classList.add("hidden");
  y.onclick = () => {
    hide();
    onYes();
  };
  n.onclick = () => {
    hide();
    onNo();
  };
  $("note-banner").classList.remove("hidden");
}

function renderNote(): void {
  if (!note) return;
  const read = $("note-read");
  read.innerHTML = note.content.trim() ? renderMarkdown(note.content) : "";
  if (!note.content.trim()) read.append(el("span", "muted", "empty — tap edit"));
  read.classList.toggle("hidden", editing);
  $("note-edit").classList.toggle("hidden", !editing);
  $("note-edit-btn").textContent = editing ? "cancel" : "edit";
  $("note-save").classList.toggle("hidden", !editing);
  $("note-conflict").classList.toggle("hidden", conflict === null);
  if (conflict) {
    const theirs = $("note-theirs");
    if (conflict.theirs) theirs.innerHTML = renderMarkdown(conflict.theirs.content);
    else theirs.replaceChildren(el("span", "muted", "deleted on the desktop"));
    $("note-overwrite").textContent = conflict.theirs ? "overwrite with mine" : "save mine again";
  }
}

/** Edit `text` (the note's, or a kept draft), based on revision `base`. */
function startEdit(text?: string, base?: string): void {
  if (!note || !projectId) return;
  editing = true;
  const field = $<HTMLTextAreaElement>("note-edit");
  field.value = text ?? note.content;
  if (base && base !== note.revision) {
    // A draft from an older version: saving it will meet the newer one and ask.
    note = { ...note, revision: base };
  }
  renderNote();
  field.focus();
}

function stopEdit(): void {
  if (note && projectId) dropDraft(projectId, note.id);
  editing = false;
  renderNote();
}

/** Save the edit. `overwrite` writes over whatever the desktop has (after the
 *  conflict showed it). Resolves true when saved. */
async function save(overwrite = false): Promise<boolean> {
  if (!note || !projectId) return true;
  const content = $<HTMLTextAreaElement>("note-edit").value;
  try {
    const { revision } = await api<{ revision: string }>("/api/notes/save", {
      body: { project: projectId, id: note.id, content, base: overwrite ? null : note.revision },
    });
    note = { ...note, content, revision };
    conflict = null;
    dropDraft(projectId, note.id);
    editing = false;
    renderNote();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      conflict = { theirs: (e.body.current as Note | null) ?? null };
      message(""); // the conflict says it, with the versions
      renderNote();
    } else message(errorText(e));
    return false;
  }
}

async function keepMineAsNew(): Promise<void> {
  if (!note || !projectId) return;
  const content = $<HTMLTextAreaElement>("note-edit").value;
  const old = note.id;
  try {
    const made = await api<Note>("/api/notes/create", {
      body: { project: projectId, name: `${old} (phone)`, content },
    });
    dropDraft(projectId, old);
    await openNote(made.id);
  } catch (e) {
    message(errorText(e));
  }
}

async function dropMine(): Promise<void> {
  if (!note || !projectId) return;
  dropDraft(projectId, note.id);
  editing = false;
  conflict = null;
  if (await exists(note.id)) await openNote(note.id);
  else await back();
}

async function exists(id: string): Promise<boolean> {
  if (!projectId) return false;
  try {
    await api<Note>("/api/notes/read", { query: { project: projectId, id } });
    return true;
  } catch {
    return false;
  }
}

async function rename(): Promise<void> {
  if (!note || !projectId) return;
  const to = window.prompt("Rename the note", note.id)?.trim();
  if (!to || to === note.id) return;
  try {
    await api("/api/notes/rename", { body: { project: projectId, id: note.id, to } });
    dropDraft(projectId, note.id);
    await openNote(to);
  } catch (e) {
    message(errorText(e));
  }
}

async function remove(): Promise<void> {
  if (!note || !projectId) return;
  if (!window.confirm(`Delete the note “${note.id}”? It can’t be undone.`)) return;
  try {
    await api("/api/notes/delete", { body: { project: projectId, id: note.id } });
    dropDraft(projectId, note.id);
    note = null;
    await back();
  } catch (e) {
    message(errorText(e));
  }
}

/** Send the note to one of the project's sessions as a prompt. */
function toggleSend(): void {
  const box = $("note-sendto");
  const open = box.classList.contains("hidden");
  if (open) {
    const sessions = (snap?.instances ?? []).filter((i) => i.projectId === projectId);
    if (sessions.length === 0) {
      message("No session in this project to send it to.");
      return;
    }
    $("note-target").replaceChildren(
      ...sessions.map((i) => {
        const o = el("option", "", i.title || "(untitled)");
        o.value = i.id;
        return o;
      }),
    );
  }
  box.classList.toggle("hidden", !open);
}

function sendNow(): void {
  const target = $<HTMLSelectElement>("note-target").value;
  const text = editing ? $<HTMLTextAreaElement>("note-edit").value : note?.content;
  if (!target || !text?.trim()) return;
  action({ type: "prompt", instanceId: target, text: text.trim() });
  $("note-sendto").classList.add("hidden");
  message("Sent to the session.");
}

/** Leave the note for the list, saving an edit first. Stays when the save didn't
 *  go through (a conflict to settle, or no link). */
async function back(): Promise<boolean> {
  if (dirty() && !(await save())) return false;
  note = null;
  editing = false;
  conflict = null;
  $("note-sendto").classList.add("hidden");
  $("note-banner").classList.add("hidden");
  if (projectId) $("notes-title").textContent = `${projectName(projectId)} · notes`;
  showView("list");
  await loadList();
  return true;
}

async function close(): Promise<void> {
  if (note && !(await back())) return;
  projectId = null;
  $("notes-overlay").classList.add("hidden");
}

// --- live -----------------------------------------------------------------------

/** A project's notes changed somewhere: follow it. */
async function changed(id: string): Promise<void> {
  void refreshCounts();
  if (id !== projectId) return;
  if (!note) {
    await loadList();
    return;
  }
  if (editing) {
    // Saving will meet the newer version and ask; nothing to do until then.
    message("This note changed elsewhere — saving will show both versions.");
    return;
  }
  try {
    const fresh = await api<Note>("/api/notes/read", { query: { project: id, id: note.id } });
    if (fresh.revision !== note.revision) {
      note = fresh;
      renderNote();
    }
  } catch {
    message("This note was deleted or renamed elsewhere.");
    await back();
  }
}

/** Wire the notes screens; returns what the snapshot and the socket feed. */
export function initNotes(): {
  snapshot: (s: RemoteSnapshot) => void;
  changed: (projectId: string) => void;
  connected: () => void;
} {
  $("notes-close").onclick = () => void close();
  $("notes-back").onclick = () => void back();
  $("notes-add").onclick = () => void addQuick();
  $("notes-filter").oninput = renderList;
  $("note-edit-btn").onclick = () => (editing ? stopEdit() : startEdit());
  $("note-save").onclick = () => void save();
  $("note-rename").onclick = () => void rename();
  $("note-delete").onclick = () => void remove();
  $("note-send").onclick = toggleSend;
  $("note-send-go").onclick = sendNow;
  $("note-keep-new").onclick = () => void keepMineAsNew();
  $("note-overwrite").onclick = () => void save(true);
  $("note-drop").onclick = () => void dropMine();
  // Every keystroke is kept on the device until it is saved.
  $<HTMLTextAreaElement>("note-edit").oninput = () => {
    if (note && projectId) {
      saveDraft(projectId, note.id, { content: $<HTMLTextAreaElement>("note-edit").value, base: note.revision });
    }
  };
  return {
    snapshot: (s) => {
      const first = snap === null;
      snap = s;
      renderBar();
      if (first) void refreshCounts();
    },
    changed: (id) => void changed(id),
    connected: () => void refreshCounts(),
  };
}
