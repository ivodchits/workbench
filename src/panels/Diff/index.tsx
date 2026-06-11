// Diff / Review panel (step 2.7) — shows what an instance changed vs its branch
// base, with inline edit + save (design §5 Diff/Review). Bound to an instance via
// the diffs store; the binding (working dir, repo root) is all the state, so the
// panel re-fetches the diff from git on mount / refresh / save rather than caching.
//
// Layout: a changed-file list on the left; on the right, the selected file's diff.
// Each file has two views — a read-only unified diff (default) and an editable
// CodeMirror over the working-tree file. Saving writes to disk and refreshes the
// diff: the "tweak the files Claude edited, then re-review" loop the design calls for.

import { useCallback, useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import { instanceDiff, instanceFileDiff, type DiffFile, type FileDiff, type InstanceDiff } from "../../ipc/git";
import { readFile, writeFile } from "../../ipc/fs";
import { useDiffs, type DiffSession } from "../../state/diffs";
import { detectLanguage } from "../Editor/language";
import CodeMirrorView from "../Editor/CodeMirrorView";
import UnifiedDiff from "./UnifiedDiff";

export interface DiffPanelParams {
  diffId: string;
}

export function DiffPanel(props: IDockviewPanelProps<DiffPanelParams>) {
  const { diffId } = props.params;
  const { open } = useDiffs();
  const session = open.find((d) => d.diffId === diffId) ?? null;

  const title = session ? `diff · ${session.title}` : "diff";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!session) return <Missing />;
  return <DiffBody session={session} />;
}

type Mode = "diff" | "edit";

/** The local edit buffer for the selected file (only while in edit mode). */
interface EditBuffer {
  path: string;
  content: string;
  baseline: string;
}

function DiffBody({ session }: { session: DiffSession }) {
  const { repoRoot, workingDir } = session;
  const [summary, setSummary] = useState<InstanceDiff | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [mode, setMode] = useState<Mode>("diff");
  const [edit, setEdit] = useState<EditBuffer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedFile = summary?.files.find((f) => f.path === selected) ?? null;

  // Fetch the changed-file list. Preserve the current selection when it survives
  // the refresh; otherwise fall back to the first changed file.
  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const next = await instanceDiff(repoRoot, workingDir);
      setSummary(next);
      setLoadError(null);
      setSelected((prev) => {
        if (prev && next.files.some((f) => f.path === prev)) return prev;
        return next.files[0]?.path ?? null;
      });
    } catch (err) {
      setLoadError(String(err));
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [repoRoot, workingDir]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // Switching to a different file resets to the read-only diff view and drops any
  // stale edit buffer. Keyed on the *path* (not the derived file object) so a save's
  // summary refresh doesn't kick the user out of edit mode on the same file.
  const base = summary?.base ?? "HEAD";
  useEffect(() => {
    setMode("diff");
    setEdit(null);
    setNotice(null);
  }, [selected]);

  // Load the selected file's unified diff — on selection, on working-dir/base change,
  // and whenever the summary refreshes (after a save) so the updated diff shows.
  useEffect(() => {
    const file = summary?.files.find((f) => f.path === selected) ?? null;
    if (!file) {
      setFileDiff(null);
      return;
    }
    let alive = true;
    void instanceFileDiff(workingDir, base, file.path, file.status === "untracked")
      .then((d) => alive && setFileDiff(d))
      .catch((err) => alive && setFileDiff({ path: file.path, base, text: String(err), binary: false, untracked: false }));
    return () => {
      alive = false;
    };
  }, [selected, workingDir, base, summary]);

  // Enter edit mode: read the working-tree file into a local buffer. Disabled for
  // deleted (gone) and binary files.
  const enterEdit = useCallback(async () => {
    if (!selectedFile?.absPath || selectedFile.binary) return;
    try {
      const content = await readFile(selectedFile.absPath);
      setEdit({ path: selectedFile.absPath, content, baseline: content });
      setMode("edit");
      setNotice(null);
    } catch (err) {
      setNotice(String(err));
    }
  }, [selectedFile]);

  // Save the edit buffer to disk, then refresh the file list — which, via the diff
  // effect above, re-fetches this file's diff so the review reflects the tweak.
  const save = useCallback(
    async (content: string) => {
      if (!edit) return;
      try {
        await writeFile(edit.path, content);
        setEdit({ ...edit, content, baseline: content });
        setNotice("saved");
        await loadSummary();
      } catch (err) {
        setNotice(String(err));
      }
    },
    [edit, loadSummary],
  );

  const lang = selectedFile ? detectLanguage(selectedFile.path) : null;
  const dirty = edit ? edit.content !== edit.baseline : false;

  return (
    // `data-wb-panel` lets the keyboard layer (state/dock) focus this panel's
    // CodeMirror when it's in edit mode, the same way it focuses the Editor panel.
    <div
      data-wb-panel={session.diffId}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}
    >
      <Header summary={summary} loading={loading} onRefresh={() => void loadSummary()} />

      {loadError ? (
        <div style={{ padding: "10px 14px", color: "var(--wb-needs)", font: "11.5px var(--wb-mono)" }}>
          {GLYPH.warn} {loadError}
        </div>
      ) : summary && summary.files.length === 0 ? (
        <Empty base={summary.base} />
      ) : (
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <FileList
            files={summary?.files ?? []}
            selected={selected}
            onSelect={setSelected}
          />
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {selectedFile && (
              <FileBar
                file={selectedFile}
                mode={mode}
                dirty={dirty}
                notice={notice}
                onShowDiff={() => setMode("diff")}
                onEdit={() => void enterEdit()}
                onSave={edit ? () => void save(edit.content) : undefined}
              />
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              {!selectedFile ? (
                <Empty base={base} />
              ) : mode === "edit" && edit ? (
                <CodeMirrorView
                  key={edit.path}
                  path={edit.path}
                  initialDoc={edit.content}
                  language={lang?.extension ?? null}
                  onChange={(content) => setEdit((e) => (e ? { ...e, content } : e))}
                  onSave={(content) => void save(content)}
                  onSaveAll={() => edit && void save(edit.content)}
                />
              ) : selectedFile.binary ? (
                <Note>{GLYPH.warn} binary file — no textual diff</Note>
              ) : !fileDiff ? (
                <Note>reading diff…</Note>
              ) : fileDiff.text.trim() === "" ? (
                <Note>no line changes (mode or whitespace only)</Note>
              ) : (
                <UnifiedDiff text={fileDiff.text} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Header({
  summary,
  loading,
  onRefresh,
}: {
  summary: InstanceDiff | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      {summary ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ color: "var(--wb-text)" }}>
            {summary.filesChanged} file{summary.filesChanged === 1 ? "" : "s"}
          </span>
          {summary.insertions > 0 && <span style={{ color: "var(--wb-done)" }}>+{summary.insertions}</span>}
          {summary.deletions > 0 && <span style={{ color: "var(--wb-needs)" }}>−{summary.deletions}</span>}
          <span style={{ color: "var(--wb-textFaint)" }}>vs {summary.base}</span>
        </span>
      ) : (
        <span style={{ color: "var(--wb-textFaint)" }}>{loading ? "reading changes…" : "—"}</span>
      )}
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="refresh diff"
        title="refresh diff"
        style={{
          marginLeft: "auto",
          background: "transparent",
          border: "none",
          cursor: loading ? "default" : "pointer",
          color: loading ? "var(--wb-textFaint)" : "var(--wb-accent)",
          font: "11px var(--wb-mono)",
          padding: 0,
        }}
      >
        ↻ refresh
      </button>
    </div>
  );
}

const STATUS_GLYPH: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  typechange: "T",
  untracked: "?",
};

function statusColor(status: string): string {
  if (status === "added" || status === "untracked") return "var(--wb-done)";
  if (status === "deleted") return "var(--wb-needs)";
  if (status === "modified") return "var(--wb-working)";
  return "var(--wb-textDim2)";
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: DiffFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 220px",
        minWidth: 0,
        borderRight: "1px solid var(--wb-border)",
        overflow: "auto",
        background: "var(--wb-panel)",
      }}
    >
      {files.map((f) => {
        const active = f.path === selected;
        const name = f.path.split("/").pop() || f.path;
        const dir = f.path.slice(0, f.path.length - name.length);
        return (
          <button
            key={f.path}
            onClick={() => onSelect(f.path)}
            title={f.path}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 7,
              width: "100%",
              textAlign: "left",
              padding: "5px 10px 5px 11px",
              border: "none",
              borderLeft: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
              background: active ? "var(--wb-sel)" : "transparent",
              cursor: "pointer",
              font: "11px var(--wb-mono)",
            }}
          >
            <span style={{ color: statusColor(f.status), flex: "0 0 auto", width: 9 }} title={f.status}>
              {STATUS_GLYPH[f.status] ?? "•"}
            </span>
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {dir && <span style={{ color: "var(--wb-textFaint)" }}>{dir}</span>}
              <span style={{ color: active ? "var(--wb-text)" : "var(--wb-textDim2)" }}>{name}</span>
            </span>
            <span style={{ flex: "0 0 auto", font: "10px var(--wb-mono)" }}>
              {f.insertions > 0 && <span style={{ color: "var(--wb-done)" }}>+{f.insertions} </span>}
              {f.deletions > 0 && <span style={{ color: "var(--wb-needs)" }}>−{f.deletions}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FileBar({
  file,
  mode,
  dirty,
  notice,
  onShowDiff,
  onEdit,
  onSave,
}: {
  file: DiffFile;
  mode: Mode;
  dirty: boolean;
  notice: string | null;
  onShowDiff: () => void;
  onEdit: () => void;
  onSave?: () => void;
}) {
  const editable = !!file.absPath && !file.binary;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10.5px var(--wb-mono)",
      }}
    >
      <span style={{ color: statusColor(file.status), flex: "0 0 auto" }}>{STATUS_GLYPH[file.status] ?? "•"}</span>
      <span
        style={{
          color: "var(--wb-textDim2)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={file.path}
      >
        {file.path}
      </span>
      {notice && (
        <span style={{ color: notice === "saved" ? "var(--wb-done)" : "var(--wb-needs)", flex: "0 0 auto" }}>
          {notice === "saved" ? `${GLYPH.ok} saved` : notice}
        </span>
      )}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
        <BarButton active={mode === "diff"} onClick={onShowDiff}>
          diff
        </BarButton>
        <BarButton active={mode === "edit"} onClick={onEdit} disabled={!editable}>
          ✎ edit
        </BarButton>
        {mode === "edit" && (
          <BarButton onClick={onSave} disabled={!dirty} accent>
            ⌃S save
          </BarButton>
        )}
      </span>
    </div>
  );
}

function BarButton({
  children,
  onClick,
  active,
  disabled,
  accent,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  accent?: boolean;
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...centered, color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{children}</div>
  );
}

function Empty({ base }: { base: string }) {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-done)", font: "13px var(--wb-mono)" }}>{GLYPH.ok} no changes</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>
        nothing differs vs {base}
      </div>
    </div>
  );
}

function Missing() {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} this diff is gone</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close this panel</div>
    </div>
  );
}

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 24,
  background: "var(--wb-bg)",
};

export default DiffPanel;
