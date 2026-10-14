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
//
// Step V2 made it follow the agent and walkable from the keyboard: the repo watcher
// re-reads the list as files change (the open file updates in place), each file can
// be marked viewed until it changes again, and the `diff…` commands step through
// changes and files.

import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import {
  instanceDiff,
  instanceFileDiff,
  instanceFileVersions,
  gitWatchStart,
  gitWatchStop,
  onGitChanged,
  type DiffFile,
  type FileDiff,
  type FileVersions,
  type InstanceDiff,
} from "../../ipc/git";
import { writeFile } from "../../ipc/fs";
import type { DiffLayout } from "../../ipc/prefs";
import { registerCommand } from "../../keyboard/bus";
import { useDiffs, type DiffSession } from "../../state/diffs";
import { setDiffLayout, useDiffLayout } from "../../state/diffLayout";
import { isViewed, toggleViewed, useViewed } from "../../state/diffViewed";
import { setDragPaths } from "../../state/fileDrag";
import { detectLanguage } from "../Editor/language";
import MergeDiff, { type MergeDiffHandle } from "./MergeDiff";
import UnifiedDiff from "./UnifiedDiff";

export interface DiffPanelParams {
  diffId: string;
}

export function DiffPanel(props: IDockviewPanelProps<DiffPanelParams>) {
  const { diffId } = props.params;
  const { api } = props;
  const { open } = useDiffs();
  const session = open.find((d) => d.diffId === diffId) ?? null;

  const title = session ? `diff · ${session.title}` : "diff";
  const setTitle = api.setTitle.bind(api);
  useEffect(() => setTitle(title), [setTitle, title]);

  // Which review panel the keyboard's review commands drive: the one last active.
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    const sub = api.onDidActiveChange((e) => setActive(e.isActive));
    return () => sub.dispose();
  }, [api]);
  const activate = useCallback(() => api.setActive(), [api]);

  if (!session) return <Missing />;
  return <DiffBody session={session} active={active} activate={activate} />;
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

/** After the repo watcher speaks, wait this long for more before re-reading: an
 *  agent's edit is often several writes. */
const WATCH_SETTLE_MS = 300;

/** Shown when the file changed on disk while it had unsaved edits here. */
const CHANGED_ON_DISK = "changed on disk — saving overwrites that";

function DiffBody({
  session,
  active,
  activate,
}: {
  session: DiffSession;
  active: boolean;
  activate: () => void;
}) {
  const { repoRoot, workingDir, diffId } = session;
  const [summary, setSummary] = useState<InstanceDiff | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** Git's unified diff, for a file too large for the merge view. */
  const [fallback, setFallback] = useState<FileDiff | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped by the refresh button to re-read the selected file's versions. */
  const [reread, setReread] = useState(0);
  /** Where a file reached by keyboard navigation puts its cursor once shown. */
  const [startAt, setStartAt] = useState<{ path: string; at: "first" | "last" } | null>(null);
  const layout = useDiffLayout();
  const viewed = useViewed(diffId);
  const mergeRef = useRef<MergeDiffHandle>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const files = summary?.files ?? EMPTY_FILES;
  const selectedFile = files.find((f) => f.path === selected) ?? null;

  // Fetch the changed-file list. Preserve the current selection when it survives
  // the refresh; otherwise fall back to the first changed file. One read at a time:
  // a call while one is running asks for one more read after it.
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const loadSummary = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      do {
        again.current = false;
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
        }
      } while (again.current);
    })();
    inFlight.current = run;
    setLoading(true);
    try {
      await run;
    } finally {
      inFlight.current = null;
      setLoading(false);
    }
  }, [repoRoot, workingDir]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // Follow the repo (step V2): the watcher that drives the Git panel also says when
  // the working tree, the index or a ref moved. Re-read the list then; the selected
  // file follows through its stamp below.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let live = true;
    let timer: number | null = null;
    // An unwatchable folder just doesn't auto-refresh; the button still works.
    void gitWatchStart(workingDir).catch(() => {});
    void onGitChanged((change) => {
      if (change.repoRoot !== workingDir) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadSummary();
      }, WATCH_SETTLE_MS);
    }).then((fn) => {
      if (live) unlisten = fn;
      else fn();
    });
    return () => {
      live = false;
      unlisten?.();
      if (timer != null) window.clearTimeout(timer);
      void gitWatchStop(workingDir).catch(() => {});
    };
  }, [workingDir, loadSummary]);

  // Read the selected file's two versions — on selection, when its stamp moves (it
  // changed on disk, or its counts did), and on refresh. A newer version of the file
  // already shown patches the open view in place, keeping cursor and scroll; it is
  // never applied over unsaved edits.
  const base = summary?.base ?? "HEAD";
  const untracked = selectedFile?.status === "untracked";
  const binary = selectedFile?.binary ?? false;
  const stamp = selectedFile?.stamp;
  const shownPath = useRef<string | null>(null);
  useEffect(() => {
    if (shownPath.current !== selected) {
      shownPath.current = selected;
      setNotice(null);
      setFallback(null);
    }
    if (!selected || binary) {
      setLoaded(null);
      return;
    }
    let alive = true;
    void instanceFileVersions(workingDir, base, selected, untracked)
      .then((versions) => {
        if (!alive) return;
        const content = (versions.current ?? "").replace(/\r\n/g, "\n");
        const prev = loadedRef.current;
        if (prev && prev.path === selected) {
          if (prev.content !== prev.baseline) {
            if (content !== prev.baseline) setNotice(CHANGED_ON_DISK);
            return;
          }
          setLoaded({ path: selected, versions, content, baseline: content });
          mergeRef.current?.update(versions.original ?? "", versions.current ?? "");
        } else {
          setLoaded({ path: selected, versions, content, baseline: content });
        }
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
  }, [selected, untracked, binary, workingDir, base, stamp, reread]);

  const current = loaded && loaded.path === selected ? loaded : null;
  const dirty = current ? current.content !== current.baseline : false;
  const editable = !!selectedFile?.absPath && current?.versions.current != null;

  const refresh = useCallback(() => {
    void loadSummary();
    setReread((n) => n + 1);
  }, [loadSummary]);

  /** A file picked by hand opens at the top (or where it was last scrolled). */
  const pick = useCallback((path: string) => {
    setStartAt(null);
    setSelected(path);
  }, []);

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

  // Keyboard review (step V2), through refs so the registrations below needn't
  // churn on every render.
  // `reading`: the selected file's versions haven't arrived, so there is no view to
  // step through yet. A change key pressed then waits rather than skipping the file
  // (keys repeat faster than a file loads).
  const reading = !!selectedFile && !selectedFile.binary && !current;
  const nav = useRef({ files, selected, selectedFile, reading });
  nav.current = { files, selected, selectedFile, reading };
  const goFile = useCallback((dir: 1 | -1, at: "first" | "last"): boolean => {
    const { files, selected } = nav.current;
    const i = files.findIndex((f) => f.path === selected);
    const next = files[i + dir];
    if (!next) return false;
    setStartAt({ path: next.path, at });
    setSelected(next.path);
    return true;
  }, []);
  useEffect(() => {
    const surface = () => {
      if (!active) activate();
    };
    const on = (id: Parameters<typeof registerCommand>[0], go: () => void) =>
      registerCommand(id, () => {
        surface();
        go();
      });
    const disposers = [
      // Past a file's last change, on to the next file's first (and back).
      on("diffNextChange", () => {
        if (!nav.current.reading && !mergeRef.current?.step(1)) goFile(1, "first");
      }),
      on("diffPrevChange", () => {
        if (!nav.current.reading && !mergeRef.current?.step(-1)) goFile(-1, "last");
      }),
      on("diffNextFile", () => void goFile(1, "first")),
      on("diffPrevFile", () => void goFile(-1, "first")),
      on("diffToggleViewed", () => {
        const file = nav.current.selectedFile;
        if (file) toggleViewed(diffId, file);
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [active, activate, goFile, diffId]);

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
        ref={mergeRef}
        key={`${current.path}\n${layout}`}
        start={startAt?.path === current.path ? startAt.at : undefined}
        layout={layout}
        original={current.versions.original ?? ""}
        doc={current.content}
        editable={editable}
        language={lang?.extension ?? null}
        scrollKey={`diff:${diffId}:${current.path}:${layout}`}
        onChange={(content) =>
          setLoaded((l) => (l && l.path === current.path ? { ...l, content } : l))
        }
        onSave={(content) => void save(content)}
      />
    );
  }

  const viewedCount = files.filter((f) => isViewed(viewed, f)).length;

  return (
    // `data-wb-panel` lets the keyboard layer (state/dock) focus this panel's
    // CodeMirror, the same way it focuses the Editor panel.
    <div
      data-wb-panel={diffId}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}
    >
      <Header summary={summary} loading={loading} viewed={viewedCount} onRefresh={refresh} />

      {loadError ? (
        <div style={{ padding: "10px 14px", color: "var(--wb-needs)", font: "11.5px var(--wb-mono)" }}>
          {GLYPH.warn} {loadError}
        </div>
      ) : summary && summary.files.length === 0 ? (
        <Empty base={summary.base} />
      ) : (
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <FileList
            files={files}
            selected={selected}
            isViewed={(f) => isViewed(viewed, f)}
            onSelect={pick}
            onToggleViewed={(f) => toggleViewed(diffId, f)}
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

const EMPTY_FILES: DiffFile[] = [];

function Header({
  summary,
  loading,
  viewed,
  onRefresh,
}: {
  summary: InstanceDiff | null;
  loading: boolean;
  /** Files marked viewed and unchanged since. */
  viewed: number;
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
        <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 8, minWidth: 0 }}>
          <span style={{ color: "var(--wb-text)" }}>
            {summary.filesChanged} file{summary.filesChanged === 1 ? "" : "s"}
          </span>
          {summary.insertions > 0 && <span style={{ color: "var(--wb-done)" }}>+{summary.insertions}</span>}
          {summary.deletions > 0 && <span style={{ color: "var(--wb-needs)" }}>−{summary.deletions}</span>}
          <span style={{ color: "var(--wb-textFaint)" }}>vs {summary.base}</span>
          {summary.filesChanged > 0 && (
            <span
              style={{ color: viewed === summary.filesChanged ? "var(--wb-done)" : "var(--wb-textFaint)" }}
              title="files marked viewed (Ctrl+Alt+Enter) and unchanged since"
            >
              {viewed}/{summary.filesChanged} viewed
            </span>
          )}
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
          flex: "0 0 auto",
          whiteSpace: "nowrap",
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
  isViewed,
  onSelect,
  onToggleViewed,
}: {
  files: DiffFile[];
  selected: string | null;
  isViewed: (file: DiffFile) => boolean;
  onSelect: (path: string) => void;
  onToggleViewed: (file: DiffFile) => void;
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
        const seen = isViewed(f);
        return (
          <div
            key={f.path}
            style={{
              display: "flex",
              alignItems: "baseline",
              borderLeft: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
              background: active ? "var(--wb-sel)" : "transparent",
              opacity: seen && !active ? 0.55 : 1,
            }}
          >
            <button
              onClick={() => onToggleViewed(f)}
              role="checkbox"
              aria-checked={seen}
              aria-label={`viewed: ${f.path}`}
              title={seen ? "viewed — unmark" : "mark viewed (clears when the file changes)"}
              style={{
                flex: "0 0 auto",
                background: "transparent",
                border: "none",
                padding: "5px 0 5px 9px",
                cursor: "pointer",
                font: "11px var(--wb-mono)",
                color: seen ? "var(--wb-done)" : "var(--wb-textFaint)",
              }}
            >
              {seen ? "▣" : "▢"}
            </button>
            <button
              // Onto a console, to reference the file (step D1) — unless it is gone.
              draggable={f.absPath !== null}
              onDragStart={(e) => f.absPath && setDragPaths(e.dataTransfer, [f.absPath])}
              onClick={() => onSelect(f.path)}
              title={f.path}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 7,
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                padding: "5px 10px 5px 7px",
                border: "none",
                background: "transparent",
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
          </div>
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
      {notice && (!dirty || notice === CHANGED_ON_DISK) && (
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
