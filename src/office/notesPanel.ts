// The sidebar's project notes: what opens when you click a bookshelf. A project
// picker, its notes newest first with a new one, and a note to edit — a plain field,
// saved a moment after you stop typing (or with Ctrl+S, or on leaving it), or read as
// markdown.
//
// It's the desktop's notes module, through the phone's notes API on the office's
// listener (`/office/api/notes…`, `remote/office/notes.rs`). A save names the revision
// it was edited from; when the note moved on meanwhile (edited at the desk or on the
// phone), nothing is overwritten unseen: the edit waits, and you keep yours or take
// theirs. A change made elsewhere comes as a `notes` frame (`changed`): the list and an
// unedited note follow it.

import "../theme/markdown.css";
import { renderMarkdown } from "../panels/Editor/markdown";
import type { RemoteProject } from "../remote/protocol";
import { el } from "../pwa/dom";
import type { Link } from "./net";

/** Saved this long after the last keystroke. */
const SAVE_AFTER_MS = 1200;
/** The project last open, for the next time. */
const PROJECT_KEY = "wb-office-notes-project";
/** "delete" asks again for this long. */
const CONFIRM_MS = 3000;

interface NoteMeta {
  id: string;
  modified: number;
}

interface Note {
  id: string;
  content: string;
  revision: string;
}

export interface NotesPanel {
  /** Open (reading the notes afresh) or close; closing saves an edit first. */
  show(open: boolean): void;
  readonly open: boolean;
  /** The projects there are, from each snapshot. */
  update(projects: readonly RemoteProject[]): void;
  /** A project's notes changed somewhere. */
  changed(projectId: string): void;
}

function remembered(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // No storage: the first project next time.
  }
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** What a failed call says, from the error Workbench gave or the status. */
async function why(res: Response | null): Promise<string> {
  if (!res) return "Workbench can't be reached.";
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // no body
  }
  return `failed (${res.status})`;
}

/** The notes in `root`; ✕ calls `onClose`. */
export function createNotesPanel(root: HTMLElement, link: Link, onClose: () => void): NotesPanel {
  const get = (path: string, params: Record<string, string>) => link.request(`notes/${path}?${new URLSearchParams(params)}`);
  const post = (path: string, body: unknown) =>
    link.request(`notes/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const close = el("button", "close", "✕");
  close.title = "close (Esc)";
  const pick = el("select", "projects");
  pick.title = "Project";
  const head = el("header");
  head.append(close, el("h2", "", "Notes"), pick);
  const error = el("p", "error");

  // The list.
  const listView = el("div", "list-view");
  const newName = el("input");
  newName.placeholder = "new note…";
  const add = el("button", "", "add");
  const adder = el("form", "adder");
  adder.append(newName, add);
  const list = el("ul", "notes");
  const empty = el("p", "muted", "No notes for this project yet.");
  listView.append(adder, list, empty);

  // A note.
  const noteView = el("div", "note-view");
  const back = el("button", "", "← notes");
  const name = el("input", "name");
  name.title = "rename";
  const view = el("button", "", "preview");
  const remove = el("button", "delete", "delete");
  const bar = el("div", "bar");
  bar.append(back, name, view, remove);
  const conflict = el("div", "conflict");
  const conflictText = el("span", "", "Changed elsewhere since you started editing.");
  const keepMine = el("button", "", "keep mine");
  const takeTheirs = el("button", "", "take theirs");
  conflict.append(conflictText, keepMine, takeTheirs);
  const text = el("textarea");
  text.spellcheck = true;
  const preview = el("div", "wb-md preview scroll");
  const status = el("p", "status muted");
  noteView.append(bar, conflict, text, preview, status);

  root.append(head, error, listView, noteView);

  let isOpen = false;
  let projects: readonly RemoteProject[] = [];
  let project: string | null = null;
  let notes: NoteMeta[] = [];
  let note: Note | null = null;
  /** The note as it is elsewhere, when a save met a newer one (null: deleted). */
  let theirs: Note | null | undefined;
  let previewing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | null = null;
  /** Bumped whenever what's shown changes, so a late answer for the old one is dropped. */
  let epoch = 0;

  const dirty = () => note !== null && text.value !== note.content;
  const say = (msg: string) => {
    error.textContent = msg;
    error.hidden = !msg;
  };
  const showStatus = () => {
    status.textContent = theirs !== undefined ? "not saved" : saving ? "saving…" : dirty() ? "edited" : "saved";
  };

  function paint(): void {
    root.hidden = !isOpen;
    listView.hidden = note !== null;
    noteView.hidden = note === null;
    conflict.hidden = theirs === undefined;
    text.hidden = previewing;
    preview.hidden = !previewing;
    view.textContent = previewing ? "edit" : "preview";
    if (!note) {
      empty.hidden = notes.length > 0 || !project;
      list.replaceChildren(
        ...notes.map((n) => {
          const li = el("li");
          const b = el("button");
          b.type = "button";
          b.append(el("span", "title", n.id), el("span", "muted", ago(n.modified)));
          b.onclick = () => void openNote(n.id);
          li.append(b);
          return li;
        }),
      );
    }
    showStatus();
  }

  function fillProjects(): void {
    const key = JSON.stringify(projects.map((p) => [p.id, p.name]));
    if (pick.dataset.key === key) return;
    pick.dataset.key = key;
    pick.replaceChildren(...projects.map((p) => new Option(p.name, p.id, false, p.id === project)));
  }

  async function loadList(): Promise<void> {
    if (!project) return;
    const at = epoch;
    const res = await get("list", { project });
    if (at !== epoch) return;
    if (!res?.ok) return say(await why(res));
    say("");
    notes = ((await res.json()) as NoteMeta[]).sort((a, b) => b.modified - a.modified);
    paint();
  }

  /** Saves the edit, if there is one and nothing's in the way. */
  async function save(overwrite = false): Promise<void> {
    clearTimeout(timer);
    if (saving) await saving;
    if (!note || !project || (!dirty() && !overwrite) || (theirs !== undefined && !overwrite)) return;
    const n = note;
    const content = text.value;
    const run = (async () => {
      const res = await post("save", { project, id: n.id, content, ...(overwrite ? {} : { base: n.revision }) });
      if (res?.status === 409) {
        const body = (await res.json()) as { current: Note | null };
        if (note === n) theirs = body.current;
        return;
      }
      if (!res?.ok) return say(await why(res));
      say("");
      const { revision } = (await res.json()) as { revision: string };
      // The same note still open: it's at the new revision now.
      if (note?.id === n.id) {
        note = { ...note, content, revision };
        theirs = undefined;
      }
    })();
    saving = run;
    showStatus();
    await run;
    saving = null;
    paint();
  }

  async function openNote(id: string): Promise<void> {
    if (!project) return;
    await save();
    const at = ++epoch;
    const res = await get("read", { project, id });
    if (at !== epoch) return;
    if (!res?.ok) return say(await why(res));
    say("");
    note = (await res.json()) as Note;
    theirs = undefined;
    text.value = note.content;
    previewing = false;
    name.value = note.id;
    paint();
    text.focus();
  }

  async function toList(): Promise<void> {
    await save();
    if (theirs !== undefined) return; // settle it first
    note = null;
    epoch++;
    paint();
    await loadList();
  }

  async function chooseProject(id: string): Promise<void> {
    await save();
    if (theirs !== undefined) {
      pick.value = project ?? "";
      return;
    }
    project = id;
    remember(id);
    note = null;
    notes = [];
    epoch++;
    paint();
    await loadList();
  }

  close.onclick = onClose;
  pick.onchange = () => void chooseProject(pick.value);
  back.onclick = () => void toList();
  view.onclick = () => {
    previewing = !previewing;
    if (previewing) preview.innerHTML = renderMarkdown(text.value);
    paint();
    if (!previewing) text.focus();
  };
  text.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_AFTER_MS);
    showStatus();
  };
  text.onblur = () => void save();
  text.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };
  keepMine.onclick = () => void save(true);
  takeTheirs.onclick = () => {
    const t = theirs;
    theirs = undefined;
    if (!t) {
      // Deleted elsewhere.
      note = null;
      void loadList();
    } else {
      note = t;
      text.value = t.content;
    }
    paint();
  };

  adder.onsubmit = async (e) => {
    e.preventDefault();
    const wanted = newName.value.trim();
    if (!wanted || !project) return;
    const res = await post("create", { project, name: wanted, content: "" });
    if (!res?.ok) return say(await why(res));
    newName.value = "";
    const made = (await res.json()) as Note;
    await openNote(made.id);
  };

  const renameTo = async () => {
    const to = name.value.trim();
    if (!note || !project || !to || to === note.id) {
      if (note) name.value = note.id;
      return;
    }
    await save();
    const res = await post("rename", { project, id: note.id, to });
    if (!res?.ok) {
      name.value = note.id;
      return say(await why(res));
    }
    say("");
    note = { ...note, id: to };
  };
  name.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      text.focus();
    } else if (e.key === "Escape" && note) {
      e.stopPropagation();
      name.value = note.id;
      text.focus();
    }
  };
  name.onchange = () => void renameTo();

  let confirmUntil = 0;
  remove.onclick = async () => {
    if (!note || !project) return;
    if (Date.now() > confirmUntil) {
      confirmUntil = Date.now() + CONFIRM_MS;
      remove.textContent = "really delete?";
      setTimeout(() => (remove.textContent = "delete"), CONFIRM_MS);
      return;
    }
    confirmUntil = 0;
    remove.textContent = "delete";
    clearTimeout(timer);
    const res = await post("delete", { project, id: note.id });
    if (!res?.ok) return say(await why(res));
    note = null;
    theirs = undefined;
    epoch++;
    paint();
    await loadList();
  };

  say("");
  paint();

  return {
    get open() {
      return isOpen;
    },
    show(open) {
      if (open === isOpen) return;
      if (!open) void save();
      isOpen = open;
      if (open) {
        const saved = remembered();
        project = projects.find((p) => p.id === project)?.id ?? projects.find((p) => p.id === saved)?.id ?? projects[0]?.id ?? null;
        fillProjects();
        if (project) pick.value = project;
        // Back on the note left open, or the list, read afresh.
        if (note) void openNote(note.id);
        else void loadList();
      }
      paint();
    },
    update(next) {
      projects = next;
      fillProjects();
      if (!project && isOpen && projects[0]) void chooseProject(projects[0].id);
      else if (project) pick.value = project;
    },
    changed(id) {
      if (!isOpen || id !== project) return;
      if (!note) return void loadList();
      // An unedited note follows the change; an edit finds out when it's saved.
      if (dirty() || saving || theirs !== undefined) return;
      const n = note;
      void get("read", { project: id, id: n.id }).then(async (res) => {
        if (note !== n || dirty()) return;
        if (res?.status === 404) {
          note = null;
          paint();
          return loadList();
        }
        if (!res?.ok) return;
        const fresh = (await res.json()) as Note;
        if (note !== n || dirty() || fresh.revision === n.revision) return;
        note = fresh;
        text.value = fresh.content;
        if (previewing) preview.innerHTML = renderMarkdown(fresh.content);
        paint();
      });
    },
  };
}
