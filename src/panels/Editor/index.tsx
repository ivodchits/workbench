// Editor panel (step 1.8) — a themed CodeMirror 6 editor with a file tree scoped
// to a project's working dir, file tabs with dirty indicators, and save (design
// §5 Editor, §9). Bound to a *project* like the Shell panel: one editor per
// project, reused on reopen.
//
// Layout: file tree on the left, a tab strip + CodeMirror + status footer on the
// right. Buffer state (open files, unsaved text) lives in the editors store, not
// here, so the panel survives dockview detaching it on a project swap — this
// component is the view; the store is the model. IO (read on open, write on save)
// happens here and reports back through the store actions.

import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import { readFile, writeFile, type DirEntry } from "../../ipc/fs";
import {
  closeFile,
  consumeRestore,
  focusFile,
  markSaved,
  openFile,
  updateContent,
  useEditors,
  type EditorSession,
  type OpenFile,
} from "../../state/editors";
import { detectLanguage, previewKind } from "./language";
import FileTree from "./FileTree";
import CodeMirrorView from "./CodeMirrorView";
import PreviewPane from "./PreviewPane";
import { type PreviewPanelParams } from "../PreviewPanel";

/** Deterministic id for a file's preview panel — reused so reopening focuses it. */
function previewPanelId(ownerEditorId: string, path: string): string {
  return `preview:${ownerEditorId}:${path}`;
}

export interface EditorPanelParams {
  editorId: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function EditorPanel(props: IDockviewPanelProps<EditorPanelParams>) {
  const { editorId } = props.params;
  const { open } = useEditors();
  const session = open.find((e) => e.editorId === editorId) ?? null;

  // Keep the tab label in sync with the editor label.
  const title = session ? `editor · ${session.label}` : "editor";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  // Open (or focus) a standalone Preview panel beside this editor, bound to the
  // given file's live buffer. Reuses the deterministic id so re-triggering focuses
  // the existing pane rather than stacking duplicates.
  const openPreviewPanel = useCallback(
    (path: string) => {
      const id = previewPanelId(editorId, path);
      const existing = props.containerApi.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const params: PreviewPanelParams = { ownerEditorId: editorId, path };
      props.containerApi.addPanel({
        id,
        component: "preview",
        params,
        position: { referencePanel: props.api.id, direction: "right" },
      });
    },
    [editorId, props.containerApi, props.api.id],
  );

  if (!session) return <MissingEditor />;
  return <EditorBody session={session} onPopOutPreview={openPreviewPanel} />;
}

function EditorBody({
  session,
  onPopOutPreview,
}: {
  session: EditorSession;
  onPopOutPreview: (path: string) => void;
}) {
  const { editorId, rootPath, files, activePath } = session;
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // In-panel markdown preview split (editor | preview). Persisted only in component
  // state; gated by the active file actually being markdown.
  const [showPreview, setShowPreview] = useState(false);
  const activeFile = files.find((f) => f.path === activePath) ?? null;

  // Read a file from disk and open it, surfacing read failures (binary / too
  // large / gone) as a transient notice rather than throwing.
  const openPath = useCallback(
    async (path: string, name: string) => {
      try {
        const content = await readFile(path);
        openFile(editorId, { path, name, content });
        setNotice(null);
      } catch (err) {
        setNotice(String(err));
      }
    },
    [editorId],
  );

  // Restore tabs from a saved layout exactly once (the store hands us the plan).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const plan = consumeRestore(editorId);
    if (!plan) return;
    void (async () => {
      for (const path of plan.paths) await openPath(path, basename(path));
      if (plan.activePath) focusFile(editorId, plan.activePath);
    })();
  }, [editorId, openPath]);

  // Clicking a tree file opens it — or just focuses it if already open, so a
  // stray click never clobbers unsaved edits with the on-disk copy.
  const onOpenFromTree = (entry: DirEntry) => {
    if (files.some((f) => f.path === entry.path)) focusFile(editorId, entry.path);
    else void openPath(entry.path, entry.name);
  };

  // Save `content` to the active file's path, then baseline it (so dirty clears).
  const save = useCallback(
    async (path: string, content: string) => {
      try {
        await writeFile(path, content);
        markSaved(editorId, path, content);
        setNotice(null);
      } catch (err) {
        setNotice(String(err));
      }
    },
    [editorId],
  );

  // Save every dirty tab (Ctrl/Cmd+Shift+S). Store content stays current via
  // `onChange` on each keystroke, so we can save inactive tabs straight from it.
  const saveAll = useCallback(async () => {
    for (const f of files) {
      if (f.content !== f.baseline) await save(f.path, f.content);
    }
  }, [files, save]);

  const lang = activeFile ? detectLanguage(activeFile.name) : null;
  const kind = activeFile ? previewKind(activeFile.name) : null;
  const splitPreview = kind !== null && showPreview;

  return (
    // `data-wb-panel` lets the keyboard layer (state/dock) find this panel's
    // CodeMirror to focus it when you cycle/focus to it (an editor owns no pooled
    // terminal, so it can't be focused by id the way consoles/shells are).
    <div data-wb-panel={editorId} style={{ height: "100%", display: "flex", minHeight: 0, minWidth: 0 }}>
      {/* file tree — collapsible to a slim strip like the app rail */}
      {treeCollapsed ? (
        <button
          onClick={() => setTreeCollapsed(false)}
          aria-label="expand file tree"
          title="expand file tree"
          style={{
            flex: "0 0 24px",
            width: 24,
            background: "var(--wb-panel)",
            border: "none",
            borderRight: "1px solid var(--wb-border)",
            color: "var(--wb-textDim2)",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "9px 0",
            font: "10px var(--wb-mono)",
          }}
        >
          <span style={{ color: "var(--wb-accent)" }}>▸</span>
          <span
            style={{
              writingMode: "vertical-rl",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            files
          </span>
        </button>
      ) : (
        <div
          style={{
            flex: "0 0 180px",
            minWidth: 0,
            borderRight: "1px solid var(--wb-border)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
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
            files
            <button
              onClick={() => setTreeCollapsed(true)}
              aria-label="collapse file tree"
              title="collapse file tree"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                lineHeight: 1,
                font: "11px var(--wb-mono)",
                color: "var(--wb-textDim2)",
              }}
            >
              ◂
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <FileTree rootPath={rootPath} activePath={activePath} onOpenFile={onOpenFromTree} />
          </div>
        </div>
      )}

      {/* tabs + editor + footer */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <TabStrip
          files={files}
          activePath={activePath}
          languageLabel={lang?.label ?? null}
          previewable={kind !== null}
          previewOn={showPreview}
          onTogglePreview={() => setShowPreview((v) => !v)}
          onPopOutPreview={activeFile ? () => onPopOutPreview(activeFile.path) : undefined}
          onFocus={(p) => focusFile(editorId, p)}
          onClose={(p) => closeFile(editorId, p)}
        />

        {notice && (
          <div
            style={{
              padding: "5px 12px",
              borderBottom: "1px solid var(--wb-needs)",
              background: "var(--wb-accentSoft)",
              color: "var(--wb-needs)",
              font: "11px var(--wb-mono)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={notice}
          >
            {GLYPH.warn} {notice}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, background: "var(--wb-bg)" }}>
          {activeFile ? (
            // Keep CodeMirror's wrapper stable across the preview toggle so the
            // editor isn't remounted (which would drop undo history + cursor);
            // toggling only adds/removes the sibling preview pane.
            <div style={{ height: "100%", display: "flex", minHeight: 0, minWidth: 0 }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  ...(splitPreview ? { borderRight: "1px solid var(--wb-border)" } : {}),
                }}
              >
                <CodeMirrorView
                  key={activeFile.path}
                  path={activeFile.path}
                  initialDoc={activeFile.content}
                  language={lang?.extension ?? null}
                  onChange={(content) => updateContent(editorId, activeFile.path, content)}
                  onSave={(content) => void save(activeFile.path, content)}
                  onSaveAll={() => void saveAll()}
                  onCursor={(line, col) => setCursor({ line, col })}
                />
              </div>
              {splitPreview && kind && (
                <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                  <PreviewPane kind={kind} source={activeFile.content} />
                </div>
              )}
            </div>
          ) : (
            <EmptyState hasFiles={files.length > 0} />
          )}
        </div>

        <Footer
          file={activeFile}
          cursor={cursor}
          dirtyCount={files.reduce((n, f) => (f.content !== f.baseline ? n + 1 : n), 0)}
          onSave={save}
          onSaveAll={() => void saveAll()}
        />
      </div>
    </div>
  );
}

function TabStrip({
  files,
  activePath,
  languageLabel,
  previewable,
  previewOn,
  onTogglePreview,
  onPopOutPreview,
  onFocus,
  onClose,
}: {
  files: OpenFile[];
  activePath: string | null;
  languageLabel: string | null;
  /** True when the active file can be previewed (markdown/html) — gates the controls. */
  previewable: boolean;
  /** Whether the in-panel preview split is currently on. */
  previewOn: boolean;
  onTogglePreview: () => void;
  /** Open the preview as a separate dockable panel; undefined when no file is open. */
  onPopOutPreview?: () => void;
  onFocus: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        overflowX: "auto",
      }}
    >
      {files.map((f) => {
        const active = f.path === activePath;
        const dirty = f.content !== f.baseline;
        return (
          <div
            key={f.path}
            onClick={() => onFocus(f.path)}
            title={f.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 9px 6px 13px",
              cursor: "pointer",
              font: "11px var(--wb-mono)",
              color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
              background: active ? "var(--wb-panel)" : "transparent",
              borderBottom: `1px solid ${active ? "var(--wb-borderActive)" : "transparent"}`,
              whiteSpace: "nowrap",
            }}
          >
            {f.name}
            {dirty && <span style={{ color: "var(--wb-working)", fontSize: 13, lineHeight: 0 }}>●</span>}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(f.path);
              }}
              aria-label="close tab"
              title="close tab"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--wb-textFaint)",
                font: "11px var(--wb-mono)",
                padding: "0 2px",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
      <span style={{ flex: 1 }} />
      {previewable && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 6px", flex: "0 0 auto" }}>
          <button
            onClick={onTogglePreview}
            aria-label="toggle preview"
            aria-pressed={previewOn}
            title="toggle preview (in-panel)"
            style={tabStripButton(previewOn)}
          >
            ▤ preview
          </button>
          <button
            onClick={onPopOutPreview}
            disabled={!onPopOutPreview}
            aria-label="open preview in a side panel"
            title="open preview in a side panel"
            style={tabStripButton(false, !onPopOutPreview)}
          >
            ⇲
          </button>
        </div>
      )}
      {languageLabel && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 11px",
            font: "10px var(--wb-mono)",
            color: "var(--wb-textFaint)",
            flex: "0 0 auto",
          }}
        >
          {languageLabel}
        </div>
      )}
    </div>
  );
}

function tabStripButton(active: boolean, disabled = false): React.CSSProperties {
  return {
    background: active ? "var(--wb-accentSoft)" : "transparent",
    border: "none",
    cursor: disabled ? "default" : "pointer",
    color: disabled ? "var(--wb-textFaint)" : active ? "var(--wb-accent)" : "var(--wb-textDim2)",
    font: "10px var(--wb-mono)",
    padding: "3px 7px",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
}

function Footer({
  file,
  cursor,
  dirtyCount,
  onSave,
  onSaveAll,
}: {
  file: OpenFile | null;
  cursor: { line: number; col: number } | null;
  dirtyCount: number;
  onSave: (path: string, content: string) => Promise<void>;
  onSaveAll: () => void;
}) {
  const dirty = file ? file.content !== file.baseline : false;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "5px 13px",
        borderTop: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10px var(--wb-mono)",
        color: "var(--wb-textFaint)",
        whiteSpace: "nowrap",
      }}
    >
      {file ? (
        <>
          <span style={{ color: dirty ? "var(--wb-working)" : "var(--wb-done)" }}>
            {dirty ? "● unsaved" : "○ saved"}
          </span>
          {cursor && <span>Ln {cursor.line}, Col {cursor.col}</span>}
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {dirtyCount >= 2 && (
              <button onClick={onSaveAll} style={footerButton("var(--wb-accent)")}>
                ⌃⇧S save all ({dirtyCount})
              </button>
            )}
            <button
              onClick={() => void onSave(file.path, file.content)}
              disabled={!dirty}
              style={footerButton(dirty ? "var(--wb-accent)" : "var(--wb-textFaint)", !dirty)}
            >
              ⌃S save
            </button>
          </span>
        </>
      ) : (
        <span>no file open</span>
      )}
    </div>
  );
}

function EmptyState({ hasFiles }: { hasFiles: boolean }) {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "12.5px var(--wb-mono)" }}>
        {GLYPH.prompt} {hasFiles ? "select a tab" : "open a file"}
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360, textAlign: "center" }}>
        pick a file from the tree to edit it — markdown and common code are
        highlighted; ⌃S saves
      </div>
    </div>
  );
}

function MissingEditor() {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>
        {GLYPH.warn} this editor is gone
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close this panel</div>
    </div>
  );
}

function footerButton(color: string, disabled = false): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    cursor: disabled ? "default" : "pointer",
    color,
    font: "10px var(--wb-mono)",
    padding: 0,
  };
}

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  padding: 24,
  background: "var(--wb-bg)",
};

export default EditorPanel;
