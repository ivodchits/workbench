// Diff / Review panel (step 2.7) — shows what an instance changed vs its branch
// base, with inline edit + save (design §5 Diff/Review). Bound to an instance via
// the diffs store; the binding (working dir, repo root) is all the state, so the
// panel re-fetches the diff from git on mount / refresh / save rather than caching.
//
// Layout: a changed-file list on the left; on the right, the selected file's diff.
// Since step V1 that is a merge view of the file at the base against the working
// tree (`MergeDiff`), unified or side by side, whose working-tree side is editable:
// Ctrl+S saves and refreshes the counts — the "tweak the files Claude edited, then
// re-review" loop the design calls for, without leaving the diff. A file too large
// for it falls back to git's unified diff (`UnifiedDiff`).

import { useCallback, useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import {
  instanceDiff,
  instanceFileDiff,
  instanceFileVersions,
  type DiffFile,
  type FileDiff,
  type FileVersions,
  type InstanceDiff,
} from "../../ipc/git";
import { writeFile } from "../../ipc/fs";
import type { DiffLayout } from "../../ipc/prefs";
import { useDiffs, type DiffSession } from "../../state/diffs";
import { setDiffLayout, useDiffLayout } from "../../state/diffLayout";
import { setDragPaths } from "../../state/fileDrag";
import { detectLanguage } from "../Editor/language";
import MergeDiff from "./MergeDiff";
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

/** The selected file's two versions, and the working-tree side as edited here. */
interface Loaded {
  path: string;
  versions: FileVersions;
  /** The working-tree text in the editor, with `\n` line ends. */
  content: string;
  /** `content` as last read or saved. */
  baseline: string;
}

/** Line ends aside, the two texts are the same: nothing for the merge view to show. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

function DiffBody({ session }: { session: DiffSession }) {
  const { repoRoot, workingDir } = session;
  const [summary, setSummary] = useState<InstanceDiff | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** Git's unified diff, for a file too large for the merge view. */
  const [fallback, setFallback] = useState<FileDiff | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped to re-read the selected file's versions (and rebuild its view). */
  const [reread, setReread] = useState(0);
  const layout = useDiffLayout();

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

  // Read the selected file's two versions — on selection, on a base or status
  // change, and on refresh. Not after a save: the editor already holds the text.
  const base = summary?.base ?? "HEAD";
  const untracked = selectedFile?.status === "untracked";
  const binary = selectedFile?.binary ?? false;
  useEffect(() => {
    setNotice(null);
    setFallback(null);
    if (!selected || binary) {
      setLoaded(null);
      return;
    }
    let alive = true;
    void instanceFileVersions(workingDir, base, selected, untracked)
      .then((versions) => {
        if (!alive) return;
        const content = (versions.current ?? "").replace(/\r\n/g, "\n");
        setLoaded({ path: selected, versions, content, baseline: content });
        if (versions.tooLarge) {
          return instanceFileDiff(workingDir, base, selected, untracked).then((d) => alive && setFallback(d));
        }
      })
      .catch((err) => {
        if (!alive) return;
        setLoaded(null);
        setNotice(String(err));
      });
    return () => {
      alive = false;
    };
  }, [selected, untracked, binary, workingDir, base, reread]);

  const current = loaded && loaded.path === selected ? loaded : null;
  const dirty = current ? current.content !== current.baseline : false;
  const editable = !!selectedFile?.absPath && current?.versions.current != null;

  const refresh = useCallback(() => {
    void loadSummary();
    // Unsaved edits stay; the file is re-read once they're saved or dropped.
    if (!dirty) setReread((n) => n + 1);
  }, [loadSummary, dirty]);

  // Save the working-tree side, keeping the file's own line ends, then refresh the
  // file list so its counts follow.
  const save = useCallback(
    async (content: string) => {
      const target = selectedFile?.absPath;
      if (!current || !target || !editable) return;
      try {
        await writeFile(target, current.versions.crlf ? content.replace(/\n/g, "\r\n") : content);
        setLoaded((l) => (l && l.path === current.path ? { ...l, content, baseline: content } : l));
        setNotice("saved");
        await loadSummary();
      } catch (err) {
        setNotice(String(err));
      }
    },
    [current, selectedFile, editable, loadSummary],
  );

  const lang = selectedFile ? detectLanguage(selectedFile.path) : null;

  let view: React.ReactNode;
  if (!selectedFile) {
    view = <Empty base={base} />;
  } else if (selectedFile.binary || current?.versions.binary) {
    view = <Note>{GLYPH.warn} binary file — no textual diff</Note>;
  } else if (!current) {
    view = <Note>{notice && notice !== "saved" ? `${GLYPH.warn} ${notice}` : "reading diff…"}</Note>;
  } else if (current.versions.tooLarge) {
    view = !fallback ? (
      <Note>reading diff…</Note>
    ) : (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "4px 12px", color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)" }}>
          too large to show whole — git's diff instead
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <UnifiedDiff text={fallback.text} />
        </div>
      </div>
    );
  } else if (!dirty && sameText(current.versions.original ?? "", current.versions.current ?? "")) {
    view = <Note>no line changes (mode or line endings only)</Note>;
  } else {
    view = (
      <MergeDiff
        key={`${current.path}\n${layout}\n${reread}`}
        layout={layout}
        original={current.versions.original ?? ""}
        doc={current.content}
        editable={editable}
        language={lang?.extension ?? null}
        scrollKey={`diff:${session.diffId}:${current.path}:${layout}`}
        onChange={(content) =>
          setLoaded((l) => (l && l.path === current.path ? { ...l, content } : l))
        }
        onSave={(content) => void save(content)}
      />
    );
  }

  return (
    // `data-wb-panel` lets the keyboard layer (state/dock) focus this panel's
    // CodeMirror, the same way it focuses the Editor panel.
    <div
      data-wb-panel={session.diffId}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}
    >
      <Header summary={summary} loading={loading} onRefresh={refresh} />

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
                layout={layout}
                editable={editable}
                dirty={dirty}
                notice={current ? notice : null}
                onLayout={setDiffLayout}
                onSave={current ? () => void save(current.content) : undefined}
              />
            )}
            <div style={{ flex: 1, minHeight: 0 }}>{view}</div>
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
            // Onto a console, to reference the file (step D1) — unless it is gone.
            draggable={f.absPath !== null}
            onDragStart={(e) => f.absPath && setDragPaths(e.dataTransfer, [f.absPath])}
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
  layout,
  editable,
  dirty,
  notice,
  onLayout,
  onSave,
}: {
  file: DiffFile;
  layout: DiffLayout;
  editable: boolean;
  dirty: boolean;
  notice: string | null;
  onLayout: (layout: DiffLayout) => void;
  onSave?: () => void;
}) {
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
      {dirty && <span style={{ color: "var(--wb-working)", flex: "0 0 auto" }}>● unsaved</span>}
      {notice && !dirty && (
        <span style={{ color: notice === "saved" ? "var(--wb-done)" : "var(--wb-needs)", flex: "0 0 auto" }}>
          {notice === "saved" ? `${GLYPH.ok} saved` : notice}
        </span>
      )}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
        <BarButton active={layout === "unified"} onClick={() => onLayout("unified")}>
          unified
        </BarButton>
        <BarButton active={layout === "split"} onClick={() => onLayout("split")}>
          side by side
        </BarButton>
        {editable && (
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
