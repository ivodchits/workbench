// Editors store (step 1.8) — the runtime registry of Editor panels and their open
// file buffers. Sibling of the `consoles`/`shells` stores, and bound like a shell
// to a *project* (its root working dir, design §5 Editor): one editor per project,
// minted `editorId`, reused on reopen.
//
// Unlike a console/shell, an editor owns no PTY — its precious state is the open
// *buffers* (path, current text, last-saved baseline). That state lives here, in
// the module-level store, rather than inside CodeMirror, for the same reason the
// terminal pool exists: when you switch projects the dockview `Workspace` detaches
// this project's panels, unmounting the editor component. Keeping buffers here lets
// the panel rebuild them on remount, so unsaved edits survive a project swap. (They
// are not persisted across an app *restart* — only the open file paths are, and the
// panel re-reads them from disk; that's session-restore territory, step 3.8.)
//
// Pure state, no IO: the hosting panel does the `readFile`/`writeFile` and reports
// back through `openFile` / `markSaved`. `dirty` is derived (`content !== baseline`).

import { useSyncExternalStore } from "react";

export interface OpenFile {
  /** Absolute path — the stable key and what we read/write. */
  path: string;
  /** Basename — the tab label. */
  name: string;
  /** Current buffer text (may differ from disk). */
  content: string;
  /** Last-saved text; `content !== baseline` ⇒ the tab is dirty. */
  baseline: string;
}

/** Open file paths to re-read after a layout restore (cleared once reopened). */
interface RestorePlan {
  paths: string[];
  activePath: string | null;
}

/**
 * A one-shot request to open a specific file in an editor (step 3.6 — the CLAUDE.md
 * quick-editor). Unlike `RestorePlan` (consumed once on mount), this fires whether
 * the editor was just minted or is already on screen: the panel watches it, reads
 * the file from disk, opens+focuses the tab, and clears it.
 */
export interface PendingOpen {
  /** Absolute path to read and open (the panel does the IO). */
  path: string;
  /** Turn on the in-panel markdown/html preview after opening (best-effort). */
  preview?: boolean;
}

export interface EditorSession {
  /** Minted, stable for the panel's life (the dock panel + reconcile key). */
  editorId: string;
  /** Project this editor belongs to (used to dedupe — one editor per project). */
  projectId: string;
  /** Root dir the file tree is scoped to. */
  rootPath: string;
  /** Display label — the project name. Shown in the tab + header. */
  label: string;
  /** Open file tabs, in tab order. */
  files: OpenFile[];
  /** Path of the focused tab, or null when no file is open. */
  activePath: string | null;
  /** Tabs to re-open from disk after a restore; null once consumed. */
  restore: RestorePlan | null;
  /** A specific file to open on next render, or null. Re-set on each request. */
  pendingOpen: PendingOpen | null;
}

/** Where an editor points: a project's root dir, with a display label. */
export interface EditorTarget {
  projectId: string;
  rootPath: string;
  label: string;
}

/** A persisted editor: its target + minted id + the tabs that were open. */
export interface EditorDescriptor extends EditorTarget {
  editorId: string;
  openPaths: string[];
  activePath: string | null;
}

interface EditorsState {
  /** Editor panels in creation order (stable render order). */
  open: EditorSession[];
  /** The editor to bring to front, or null. Only a *new* value triggers focus. */
  activeId: string | null;
}

let state: EditorsState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: EditorsState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): EditorsState {
  return state;
}

function patchEditor(editorId: string, patch: Partial<EditorSession>): void {
  const open = state.open.map((e) => (e.editorId === editorId ? { ...e, ...patch } : e));
  emit({ ...state, open });
}

/** Replace one editor's file list (helper for the file-mutating actions). */
function patchFiles(
  editorId: string,
  fn: (files: OpenFile[]) => OpenFile[],
  activePath?: string | null,
): void {
  const open = state.open.map((e) =>
    e.editorId === editorId
      ? { ...e, files: fn(e.files), ...(activePath !== undefined ? { activePath } : {}) }
      : e,
  );
  emit({ ...state, open });
}

/** Read the open editors outside React (used by the Workspace reconcile path). */
export function getOpenEditors(): EditorSession[] {
  return state.open;
}

/** The active editor id, read outside React (see `getOpenEditors`). */
export function getActiveEditorId(): string | null {
  return state.activeId;
}

/**
 * Open the editor for `target`'s project, focusing it if one already exists,
 * else minting a fresh empty editor.
 */
export function openEditor(target: EditorTarget): void {
  const existing = state.open.find((e) => e.projectId === target.projectId);
  if (existing) {
    emit({ ...state, activeId: existing.editorId });
    return;
  }
  const editorId = `editor:${crypto.randomUUID()}`;
  const session: EditorSession = {
    editorId,
    ...target,
    files: [],
    activePath: null,
    restore: null,
    pendingOpen: null,
  };
  emit({ open: [...state.open, session], activeId: editorId });
}

/**
 * Open `file` in the editor for `target`'s project — minting the editor if needed,
 * focusing it either way — by queuing a `pendingOpen` the panel fulfils on its next
 * render (read the file, open the tab, optionally show preview). Used by the
 * CLAUDE.md quick-editor (step 3.6); reusable for any "open this project file" action.
 */
export function openProjectFile(target: EditorTarget, file: PendingOpen): void {
  const existing = state.open.find((e) => e.projectId === target.projectId);
  if (existing) {
    const open = state.open.map((e) =>
      e.editorId === existing.editorId ? { ...e, pendingOpen: file } : e,
    );
    emit({ ...state, open, activeId: existing.editorId });
    return;
  }
  const editorId = `editor:${crypto.randomUUID()}`;
  const session: EditorSession = {
    editorId,
    ...target,
    files: [],
    activePath: null,
    restore: null,
    pendingOpen: file,
  };
  emit({ open: [...state.open, session], activeId: editorId });
}

/**
 * Seed editor sessions for `descriptors` not already open — used by the Workspace
 * to back the editor panels a saved layout restores. Their open tabs come back as
 * a `restore` plan the panel re-reads from disk on mount. Idempotent (an editor
 * already live keeps its in-memory buffers, dirty edits and all).
 */
export function hydrateEditors(descriptors: EditorDescriptor[]): void {
  const present = new Set(state.open.map((e) => e.editorId));
  const additions = descriptors
    .filter((d) => !present.has(d.editorId))
    .map<EditorSession>((d) => ({
      editorId: d.editorId,
      projectId: d.projectId,
      rootPath: d.rootPath,
      label: d.label,
      files: [],
      activePath: null,
      restore: d.openPaths.length > 0 ? { paths: d.openPaths, activePath: d.activePath } : null,
      pendingOpen: null,
    }));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/**
 * Take and clear an editor's restore plan, so the panel reopens those tabs exactly
 * once. Returns null if there's nothing to restore.
 */
export function consumeRestore(editorId: string): RestorePlan | null {
  const session = state.open.find((e) => e.editorId === editorId);
  if (!session?.restore) return null;
  patchEditor(editorId, { restore: null });
  return session.restore;
}

/**
 * Take and clear an editor's pending-open request, so the panel fulfils it exactly
 * once. Returns null when there's nothing pending.
 */
export function consumePendingOpen(editorId: string): PendingOpen | null {
  const session = state.open.find((e) => e.editorId === editorId);
  if (!session?.pendingOpen) return null;
  patchEditor(editorId, { pendingOpen: null });
  return session.pendingOpen;
}

/**
 * Open a file as a tab (or focus it if already open, refreshing its baseline to
 * the freshly-read disk content). `content` is what the panel just read from disk.
 */
export function openFile(
  editorId: string,
  file: { path: string; name: string; content: string },
): void {
  const session = state.open.find((e) => e.editorId === editorId);
  if (!session) return;
  const exists = session.files.some((f) => f.path === file.path);
  patchFiles(
    editorId,
    (files) =>
      exists
        ? files.map((f) =>
            f.path === file.path ? { ...f, content: file.content, baseline: file.content } : f,
          )
        : [...files, { ...file, baseline: file.content }],
    file.path,
  );
}

/** Focus an already-open tab. */
export function focusFile(editorId: string, path: string): void {
  patchEditor(editorId, { activePath: path });
}

/** Record an edit to a tab's buffer (marks it dirty when it diverges from disk). */
export function updateContent(editorId: string, path: string, content: string): void {
  patchFiles(editorId, (files) =>
    files.map((f) => (f.path === path ? { ...f, content } : f)),
  );
}

/**
 * Record a successful save: set the tab's baseline to the text that was written.
 * Passing the saved snapshot (not reading `content` here) means edits made *during*
 * the async write correctly leave the tab dirty.
 */
export function markSaved(editorId: string, path: string, savedContent: string): void {
  patchFiles(editorId, (files) =>
    files.map((f) => (f.path === path ? { ...f, baseline: savedContent } : f)),
  );
}

/** Close a tab; focus falls back to the previous tab (or none). */
export function closeFile(editorId: string, path: string): void {
  const session = state.open.find((e) => e.editorId === editorId);
  if (!session) return;
  const idx = session.files.findIndex((f) => f.path === path);
  if (idx < 0) return;
  const files = session.files.filter((f) => f.path !== path);
  let activePath = session.activePath;
  if (activePath === path) {
    const fallback = files[idx - 1] ?? files[idx] ?? files[files.length - 1] ?? null;
    activePath = fallback ? fallback.path : null;
  }
  patchEditor(editorId, { files, activePath });
}

/** Close an editor panel entirely (drops all its buffers — unsaved edits lost). */
export function closeEditor(editorId: string): void {
  if (!state.open.some((e) => e.editorId === editorId)) return;
  const open = state.open.filter((e) => e.editorId !== editorId);
  const activeId = state.activeId === editorId ? null : state.activeId;
  emit({ open, activeId });
}

/** True if any open editor has an unsaved tab (for a future close-guard / palette). */
export function hasDirtyEditors(): boolean {
  return state.open.some((e) => e.files.some((f) => f.content !== f.baseline));
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the editors store. */
export function useEditors(): EditorsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
