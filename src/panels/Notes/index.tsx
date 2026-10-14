// Notes panel (step N1) — a project's notes: the list on the left (new, rename,
// delete, filter), the open note on the right, edited as markdown with a preview
// beside or instead of the editor. Notes are files in the app data dir, read and
// written through the backend notes module (`ipc/notes`), which refuses a save
// based on a stale revision; the panel then offers to reload or overwrite.
//
// The open note's buffer lives in the notes store, so unsaved text survives a
// project swap. The list and the open note follow `notes-changed` — saves from
// this window and from the phone alike.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import {
  isStale,
  notesCreate,
  notesDelete,
  notesList,
  notesRead,
  notesRename,
  notesWrite,
  onNotesChanged,
  type NoteMeta,
} from "../../ipc/notes";
import {
  editBuffer,
  freshName,
  getBuffer,
  isDirty,
  moveBuffer,
  setActiveNote,
  setBuffer,
  useBuffer,
  useNotes,
  type NotesSession,
} from "../../state/notes";
import { reference } from "../../state/fileDrag";
import { useRegistry } from "../../state/registry";
import { detectLanguage } from "../Editor/language";
import CodeMirrorView from "../Editor/CodeMirrorView";
import PreviewPane from "../Editor/PreviewPane";
import Modal from "../InstanceManager/Modal";
import { confirmButtonStyle } from "../Git/format";
import { insertIntoConsole, promptTargetFor } from "../consoleInput";

export interface NotesPanelParams {
  notesId: string;
}

type ViewMode = "edit" | "split" | "preview";

const MARKDOWN = detectLanguage("note.md")?.extension ?? null;

export function NotesPanel(props: IDockviewPanelProps<NotesPanelParams>) {
  const { notesId } = props.params;
  const { open } = useNotes();
  const session = open.find((n) => n.notesId === notesId) ?? null;

  const title = session ? `notes · ${session.title}` : "notes";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!session) {
    return (
      <div style={centered}>
        <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} these notes are gone</div>
        <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close this panel</div>
      </div>
    );
  }
  return <NotesBody session={session} />;
}

/** Load a note into the store's buffer from disk. */
async function load(projectId: string, id: string): Promise<void> {
  const note = await notesRead(projectId, id);
  setBuffer(projectId, id, {
    content: note.content,
    baseline: note.content,
    revision: note.revision,
    path: note.path,
  });
}

function NotesBody({ session }: { session: NotesSession }) {
  const { notesId, projectId, activeNote } = session;
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** The note on screen changed elsewhere while it had unsaved edits here. */
  const [conflict, setConflict] = useState(false);
  const [mode, setMode] = useState<ViewMode>("edit");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Bumped when the open note is re-read from disk, to rebuild the editor on it. */
  const [reloads, setReloads] = useState(0);
  const buffer = useBuffer(projectId, activeNote);
  const { instances } = useRegistry();

  const refreshList = useCallback(async () => {
    try {
      setNotes(await notesList(projectId));
    } catch (err) {
      setNotice(String(err));
    }
  }, [projectId]);

  // Open the active note: read it unless its buffer is already here (a remount).
  useEffect(() => {
    setConflict(false);
    if (!activeNote || getBuffer(projectId, activeNote)) return;
    load(projectId, activeNote).catch((err) => {
      setNotice(String(err));
      setActiveNote(notesId, null);
    });
  }, [projectId, activeNote, notesId]);

  // Follow changes from anywhere: re-list, and bring the open note up to date
  // unless that would drop unsaved edits.
  const activeRef = useRef(activeNote);
  activeRef.current = activeNote;
  const sync = useCallback(async () => {
    await refreshList();
    const id = activeRef.current;
    const held = id ? getBuffer(projectId, id) : undefined;
    if (!id || !held) return;
    try {
      const note = await notesRead(projectId, id);
      if (note.revision === held.revision) return;
      if (isDirty(getBuffer(projectId, id))) {
        setConflict(true);
        return;
      }
      setBuffer(projectId, id, { content: note.content, baseline: note.content, revision: note.revision, path: note.path });
      setReloads((n) => n + 1);
    } catch {
      // Gone (deleted or renamed elsewhere). Keep unsaved text on screen; else close it.
      if (isDirty(getBuffer(projectId, id))) setConflict(true);
      else {
        moveBuffer(projectId, id, null);
        setActiveNote(notesId, null);
      }
    }
  }, [projectId, notesId, refreshList]);

  useEffect(() => {
    void sync();
    let unlisten: (() => void) | null = null;
    let live = true;
    void onNotesChanged((changed) => {
      if (changed === projectId) void sync();
    }).then((fn) => {
      if (live) unlisten = fn;
      else fn();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [projectId, sync]);

  const ids = useMemo(() => (notes ?? []).map((n) => n.id), [notes]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (notes ?? []).filter((n) => !q || n.id.toLowerCase().includes(q));
  }, [notes, filter]);

  /** A new note's name being typed, before it exists. */
  const [naming, setNaming] = useState<string | null>(null);
  const create = async (name: string) => {
    setNaming(null);
    if (!name.trim()) return;
    try {
      const note = await notesCreate(projectId, name.trim());
      setBuffer(projectId, note.id, { content: "", baseline: "", revision: note.revision, path: note.path });
      setActiveNote(notesId, note.id);
      setNotice(null);
    } catch (err) {
      setNotice(String(err));
    }
  };

  const rename = async (id: string, to: string) => {
    setRenaming(null);
    const name = to.trim();
    if (!name || name === id) return;
    try {
      await notesRename(projectId, id, name);
      moveBuffer(projectId, id, name);
      // The buffer's path moved with the file.
      const moved = getBuffer(projectId, name);
      if (moved) {
        const path = moved.path.replace(/[^\\/]+\.md$/, `${name}.md`);
        setBuffer(projectId, name, { ...moved, path });
      }
      if (activeNote === id) setActiveNote(notesId, name);
      setNotice(null);
    } catch (err) {
      setNotice(String(err));
    }
  };

  const remove = async (id: string) => {
    setDeleting(null);
    try {
      await notesDelete(projectId, id);
      moveBuffer(projectId, id, null);
      if (activeNote === id) setActiveNote(notesId, null);
    } catch (err) {
      setNotice(String(err));
    }
  };

  /** Save the open note. `force` overwrites a version saved elsewhere. */
  const save = async (content: string, force = false) => {
    const id = activeNote;
    const held = id ? getBuffer(projectId, id) : undefined;
    if (!id || !held) return;
    try {
      const revision = await notesWrite(projectId, id, content, force ? null : held.revision);
      setBuffer(projectId, id, { ...held, content: getBuffer(projectId, id)?.content ?? content, baseline: content, revision });
      setConflict(false);
      setNotice(null);
    } catch (err) {
      if (isStale(err)) setConflict(true);
      else setNotice(String(err));
    }
  };

  const reload = async () => {
    if (!activeNote) return;
    try {
      await load(projectId, activeNote);
      setReloads((n) => n + 1);
      setConflict(false);
    } catch (err) {
      setNotice(String(err));
    }
  };

  // Send to the agent: the project's last focused Claude console, unsent.
  const target = promptTargetFor(projectId);
  const targetTitle = target ? (instances.find((i) => i.id === target.instanceId)?.title ?? "console") : null;
  const sendToAgent = (as: "text" | "reference") => {
    if (!buffer) return;
    if (!target) {
      setNotice("no running Claude console in this project to send it to");
      return;
    }
    const text = as === "text" ? buffer.content : `${reference(buffer.path, target.cwd)} `;
    if (!insertIntoConsole(target.instanceId, text)) setNotice("that console isn't running here");
  };

  const dirty = isDirty(buffer);

  return (
    <div data-wb-panel={notesId} style={{ height: "100%", display: "flex", minHeight: 0, minWidth: 0 }}>
      <NoteList
        notes={shown}
        total={notes?.length ?? null}
        filter={filter}
        active={activeNote}
        dirtyId={dirty ? activeNote : null}
        renaming={renaming}
        naming={naming}
        onFilter={setFilter}
        onOpen={(id) => setActiveNote(notesId, id)}
        onStartCreate={() => setNaming(freshName(ids))}
        onCreate={(name) => void create(name)}
        onCancelCreate={() => setNaming(null)}
        onStartRename={setRenaming}
        onRename={(id, to) => void rename(id, to)}
        onCancelRename={() => setRenaming(null)}
        onDelete={setDeleting}
      />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {activeNote && buffer && (
          <Bar
            name={activeNote}
            dirty={dirty}
            mode={mode}
            target={targetTitle}
            onMode={setMode}
            onSave={() => void save(buffer.content)}
            onSendText={() => sendToAgent("text")}
            onSendReference={() => sendToAgent("reference")}
          />
        )}
        {conflict && (
          <Banner>
            {GLYPH.warn} this note changed elsewhere since you opened it
            <BarButton onClick={() => void reload()}>reload — drops your edits</BarButton>
            <BarButton onClick={() => buffer && void save(buffer.content, true)}>overwrite with yours</BarButton>
          </Banner>
        )}
        {notice && (
          <Banner>
            {GLYPH.warn} {notice}
            <BarButton onClick={() => setNotice(null)}>dismiss</BarButton>
          </Banner>
        )}
        <div style={{ flex: 1, minHeight: 0, background: "var(--wb-bg)", display: "flex" }}>
          {!activeNote ? (
            <Empty hasNotes={(notes?.length ?? 0) > 0} onCreate={() => setNaming(freshName(ids))} />
          ) : !buffer ? (
            <div style={centered}>
              <span style={{ color: "var(--wb-textFaint)", font: "12px var(--wb-mono)" }}>reading…</span>
            </div>
          ) : (
            <>
              {mode !== "preview" && (
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    ...(mode === "split" ? { borderRight: "1px solid var(--wb-border)" } : {}),
                  }}
                >
                  <CodeMirrorView
                    key={`${activeNote}\n${reloads}`}
                    path={`${projectId}/${activeNote}`}
                    scrollKey={`note:${projectId}:${activeNote}`}
                    initialDoc={buffer.content}
                    language={MARKDOWN}
                    onChange={(content) => editBuffer(projectId, activeNote, content)}
                    onSave={(content) => void save(content)}
                    onSaveAll={() => void save(buffer.content)}
                  />
                </div>
              )}
              {mode !== "edit" && (
                <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                  <PreviewPane kind="markdown" source={buffer.content} scrollKey={`note-preview:${projectId}:${activeNote}`} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {deleting && (
        <Modal title="delete note" onClose={() => setDeleting(null)} width={400}>
          <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
            Delete the note “{deleting}”? It isn&apos;t kept anywhere else, so this can&apos;t be undone.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button onClick={() => setDeleting(null)} style={confirmButtonStyle}>
              cancel
            </button>
            <button
              onClick={() => void remove(deleting)}
              style={{ ...confirmButtonStyle, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}
            >
              {GLYPH.fail} delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NoteList({
  notes,
  total,
  filter,
  active,
  dirtyId,
  renaming,
  naming,
  onFilter,
  onOpen,
  onStartCreate,
  onCreate,
  onCancelCreate,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  notes: NoteMeta[];
  /** All notes (before the filter); null while the first read runs. */
  total: number | null;
  filter: string;
  active: string | null;
  /** The open note when it has unsaved edits. */
  dirtyId: string | null;
  renaming: string | null;
  /** The name proposed for a new note, while it is being typed. */
  naming: string | null;
  onFilter: (q: string) => void;
  onOpen: (id: string) => void;
  onStartCreate: () => void;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
  onStartRename: (id: string) => void;
  onRename: (id: string, to: string) => void;
  onCancelRename: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 200px",
        minWidth: 0,
        borderRight: "1px solid var(--wb-border)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--wb-panel)",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          padding: "4px 6px 4px 11px",
          borderBottom: "1px solid var(--wb-border)",
          background: "var(--wb-titlebar)",
          font: "10px var(--wb-mono)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--wb-textFaint)",
        }}
      >
        notes{total ? ` · ${total}` : ""}
        <button
          onClick={onStartCreate}
          title="new note"
          aria-label="new note"
          style={{ ...plainButton, marginLeft: "auto", color: "var(--wb-accent)", font: "12px var(--wb-mono)" }}
        >
          + new
        </button>
      </div>
      {(total ?? 0) > 4 && (
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="filter…"
          style={{
            margin: 6,
            padding: "3px 6px",
            background: "var(--wb-bg)",
            color: "var(--wb-text)",
            border: "1px solid var(--wb-border)",
            outline: "none",
            font: "11px var(--wb-mono)",
          }}
        />
      )}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {naming !== null && (
          <div style={{ display: "flex", padding: "0 6px 0 9px" }}>
            <RenameField name={naming} onDone={onCreate} onCancel={onCancelCreate} />
          </div>
        )}
        {notes.map((n) => {
          const on = n.id === active;
          return (
            <div
              key={n.id}
              className="wb-note-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 6px 0 9px",
                borderLeft: `2px solid ${on ? "var(--wb-selBar)" : "transparent"}`,
                background: on ? "var(--wb-sel)" : "transparent",
              }}
            >
              {renaming === n.id ? (
                <RenameField name={n.id} onDone={(to) => onRename(n.id, to)} onCancel={onCancelRename} />
              ) : (
                <>
                  <button
                    onClick={() => onOpen(n.id)}
                    onDoubleClick={() => onStartRename(n.id)}
                    title={`${n.id} — double-click to rename`}
                    style={{
                      ...plainButton,
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                      padding: "5px 0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      font: "11.5px var(--wb-mono)",
                      color: on ? "var(--wb-text)" : "var(--wb-textDim2)",
                    }}
                  >
                    {dirtyId === n.id && <span style={{ color: "var(--wb-working)" }}>● </span>}
                    {n.id}
                  </button>
                  <span className="wb-note-actions" style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => onStartRename(n.id)} title="rename" aria-label={`rename ${n.id}`} style={rowAction}>
                      ✎
                    </button>
                    <button onClick={() => onDelete(n.id)} title="delete — asks first" aria-label={`delete ${n.id}`} style={rowAction}>
                      {GLYPH.fail}
                    </button>
                  </span>
                </>
              )}
            </div>
          );
        })}
        {total !== null && total > 0 && notes.length === 0 && (
          <div style={{ padding: "8px 11px", color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>no match</div>
        )}
      </div>
    </div>
  );
}

function RenameField({ name, onDone, onCancel }: { name: string; onDone: (to: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  // Settled once: Enter, Esc or clicking away — not twice when Esc's unmount also
  // blurs it.
  const settled = useRef(false);
  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onDone(value);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      // Leaving the field for elsewhere in the app commits; the window losing focus
      // (alt-tab) doesn't — the field still has the keyboard when it comes back.
      onBlur={() => {
        if (document.hasFocus()) settle(true);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") settle(true);
        else if (e.key === "Escape") settle(false);
      }}
      style={{
        flex: 1,
        minWidth: 0,
        margin: "3px 0",
        padding: "2px 4px",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        border: "1px solid var(--wb-borderActive)",
        outline: "none",
        font: "11.5px var(--wb-mono)",
      }}
    />
  );
}

function Bar({
  name,
  dirty,
  mode,
  target,
  onMode,
  onSave,
  onSendText,
  onSendReference,
}: {
  name: string;
  dirty: boolean;
  mode: ViewMode;
  /** The console "send" goes to, by title; null when there is none. */
  target: string | null;
  onMode: (mode: ViewMode) => void;
  onSave: () => void;
  onSendText: () => void;
  onSendReference: () => void;
}) {
  const to = target ? `the console “${target}”` : "this project's console (none is running)";
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        rowGap: 3,
        padding: "4px 10px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10.5px var(--wb-mono)",
      }}
    >
      <span style={{ color: "var(--wb-text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <span style={{ color: dirty ? "var(--wb-working)" : "var(--wb-done)", flex: "0 0 auto" }}>
        {dirty ? "● unsaved" : "○ saved"}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
        <BarButton onClick={onSendText} disabled={!target} title={`put the note's text in ${to}, unsent`}>
          ⏎ text to agent
        </BarButton>
        <BarButton onClick={onSendReference} disabled={!target} title={`put an @reference to the note in ${to}, unsent`}>
          @ to agent
        </BarButton>
        {(["edit", "split", "preview"] as const).map((m) => (
          <BarButton key={m} active={mode === m} onClick={() => onMode(m)}>
            {m}
          </BarButton>
        ))}
        <BarButton onClick={onSave} disabled={!dirty} accent>
          ⌃S save
        </BarButton>
      </span>
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-needs)",
        background: "var(--wb-accentSoft)",
        color: "var(--wb-needs)",
        font: "11px var(--wb-mono)",
      }}
    >
      {children}
    </div>
  );
}

function BarButton({
  children,
  onClick,
  active,
  disabled,
  accent,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  accent?: boolean;
  title?: string;
}) {
  const color = disabled
    ? "var(--wb-textFaint)"
    : active || accent
      ? "var(--wb-accent)"
      : "var(--wb-textDim2)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: active ? "var(--wb-accentSoft)" : "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color,
        font: "10.5px var(--wb-mono)",
        padding: "2px 7px",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

function Empty({ hasNotes, onCreate }: { hasNotes: boolean; onCreate: () => void }) {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "12.5px var(--wb-mono)" }}>
        {GLYPH.prompt} {hasNotes ? "pick a note" : "no notes yet"}
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360, textAlign: "center" }}>
        notes are markdown, kept on this machine per project — not in the repo
      </div>
      <button onClick={onCreate} style={{ ...confirmButtonStyle, marginTop: 6 }}>
        + new note
      </button>
    </div>
  );
}

const plainButton: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
};

const rowAction: React.CSSProperties = {
  ...plainButton,
  color: "var(--wb-textFaint)",
  font: "11px var(--wb-mono)",
};

const centered: React.CSSProperties = {
  flex: 1,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 24,
  background: "var(--wb-bg)",
};

export default NotesPanel;
