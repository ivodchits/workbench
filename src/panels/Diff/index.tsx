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
//
// Step V3 closed the loop back to the agent: comments on lines (the gutter's "+",
// or Ctrl+Shift+O on a selection) collect in a list under the diff and go to the
// instance as one prompt; "add to prompt" puts an `@path#L…` reference in its
// console unsent; and each change has a revert button, behind a confirm.
//
// Step A1: "review" starts a fresh agent in the same working dir with a review
// prompt; its findings come back as a list to tick, and the ticked ones are sent
// through the same comment path.

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
import { rangeReference, setDragPaths } from "../../state/fileDrag";
import { useConsoles } from "../../state/consoles";
import {
  addComment,
  clearComments,
  editComment,
  location,
  moveComments,
  removeComment,
  useComments,
  type ReviewComment,
} from "../../state/reviewComments";
import { insertIntoConsole } from "../consoleInput";
import { sendPendingComments } from "./sendComments";
import { ReviewDialog, ReviewStrip } from "./Review";
import { useRegistry } from "../../state/registry";
import Modal from "../InstanceManager/Modal";
import { confirmButtonStyle } from "../Git/format";
import { detectLanguage } from "../Editor/language";
import MergeDiff, { type MergeDiffHandle, type PendingRevert, type StartAt } from "./MergeDiff";
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
  const { repoRoot, workingDir, diffId, instanceId } = session;
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
  const [startAt, setStartAt] = useState<{ path: string; at: StartAt } | null>(null);
  const comments = useComments(instanceId);
  /** A comment being written, before it joins the list. */
  const [draft, setDraft] = useState<Omit<ReviewComment, "id"> | null>(null);
  /** A change's revert, waiting for the confirm. */
  const [pendingRevert, setPendingRevert] = useState<PendingRevert | null>(null);
  /** What the last comment action did ("sent", "no console", …). */
  const [toast, setToast] = useState<string | null>(null);
  const { open: consoles } = useConsoles();
  const { instances } = useRegistry();
  const impl = instances.find((i) => i.id === instanceId) ?? null;
  /** The "review with a fresh agent" dialog (A1). */
  const [reviewing, setReviewing] = useState(false);
  const live = consoles.some((c) => c.instanceId === instanceId && c.status === "running" && !c.tornOff);
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

  // --- review comments (V3) ---------------------------------------------------
  const startComment = useCallback(
    (fromLine: number, toLine: number, quote: string) => {
      if (!current) return;
      setToast(null);
      setDraft({ path: current.path, fromLine, toLine, quote, note: "" });
    },
    [current],
  );
  const commentSelection = () => {
    const sel = mergeRef.current?.selection();
    if (sel) startComment(sel.fromLine, sel.toLine, sel.text);
  };
  const addSelectionToPrompt = () => {
    const sel = mergeRef.current?.selection();
    const target = selectedFile?.absPath;
    if (!sel || !target) return;
    const text = `${rangeReference(target, workingDir, sel.fromLine, sel.toLine)} `;
    if (!insertIntoConsole(instanceId, text)) setToast(NO_CONSOLE);
  };
  const sendComments = () => {
    if (comments.length === 0) return;
    if (!live) {
      setToast(NO_CONSOLE);
      return;
    }
    const sent = sendPendingComments(instanceId);
    if (!sent) return;
    const { how, count: n } = sent;
    setToast(
      how === "sent"
        ? `${GLYPH.ok} sent ${n} comment${n === 1 ? "" : "s"}`
        : `queued ${n} comment${n === 1 ? "" : "s"} — sent when the agent finishes its turn`,
    );
  };
  /** Show a comment's lines: in the open file, or by opening its file there. */
  const showComment = (c: ReviewComment) => {
    if (current?.path === c.path) mergeRef.current?.goToLine(c.fromLine);
    else {
      setStartAt({ path: c.path, at: { line: c.fromLine } });
      setSelected(c.path);
    }
  };
  const confirmRevert = () => {
    const run = pendingRevert;
    setPendingRevert(null);
    if (!run) return;
    if (!run()) {
      setNotice("the file changed meanwhile — nothing reverted");
      return;
    }
    const text = mergeRef.current?.content();
    if (text != null) void save(text);
  };
  const commentActions = useRef({ commentSelection, sendComments, addSelectionToPrompt });
  commentActions.current = { commentSelection, sendComments, addSelectionToPrompt };

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
      on("diffAddComment", () => commentActions.current.commentSelection()),
      on("diffSendComments", () => commentActions.current.sendComments()),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [active, activate, goFile, diffId]);

  // "Add to prompt" takes the selection of whichever panel is active: this one
  // while it is, the editor's while that is.
  useEffect(() => {
    if (!active) return;
    return registerCommand("addToPrompt", () => commentActions.current.addSelectionToPrompt());
  }, [active]);

  const lang = selectedFile ? detectLanguage(selectedFile.path) : null;

  const fileComments = current ? comments.filter((c) => c.path === current.path) : EMPTY_COMMENTS;

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
        comments={fileComments}
        onAddComment={startComment}
        onCommentsMoved={(lines) => moveComments(instanceId, lines)}
        onRevert={(run) => setPendingRevert(() => run)}
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
      <Header
        summary={summary}
        loading={loading}
        viewed={viewedCount}
        onRefresh={refresh}
        onReview={impl && summary && summary.filesChanged > 0 ? () => setReviewing(true) : undefined}
      />

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
            commentCount={(f) => comments.filter((c) => c.path === f.path).length}
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
                onComment={current && !current.versions.tooLarge ? commentSelection : undefined}
                onAddToPrompt={current && !current.versions.tooLarge ? addSelectionToPrompt : undefined}
              />
            )}
            <div style={{ flex: 1, minHeight: 0 }}>{view}</div>
          </div>
        </div>
      )}

      {impl && (
        <ReviewStrip
          impl={impl}
          onShow={(f) => showComment({ id: "", path: f.path, fromLine: f.fromLine, toLine: f.toLine, quote: "", note: "" })}
          onSent={setToast}
        />
      )}

      {(comments.length > 0 || draft || toast) && (
        <Comments
          comments={comments}
          draft={draft}
          toast={toast}
          live={live}
          onDraft={(note) => setDraft((d) => (d ? { ...d, note } : d))}
          onAdd={() => {
            if (draft?.note.trim()) addComment(instanceId, { ...draft, note: draft.note.trim() });
            setDraft(null);
          }}
          onCancel={() => setDraft(null)}
          onEdit={(id, note) => editComment(instanceId, id, note)}
          onRemove={(id) => removeComment(instanceId, id)}
          onShow={showComment}
          onSend={sendComments}
          onClear={() => {
            clearComments(instanceId);
            setToast(null);
          }}
          onDismiss={() => setToast(null)}
        />
      )}

      {reviewing && impl && (
        <ReviewDialog
          impl={impl}
          base={base}
          onClose={() => setReviewing(false)}
          onStarted={(error) => {
            setReviewing(false);
            if (error) setToast(`${GLYPH.warn} ${error}`);
          }}
        />
      )}

      {pendingRevert && (
        <Modal title="revert change" onClose={() => setPendingRevert(null)} width={420}>
          <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
            Put this change back to the base version and save the file?{" "}
            {dirty && "Your unsaved edits to it are saved too. "}
            Ctrl+Z in the diff undoes it while the file stays open; then save again.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button onClick={() => setPendingRevert(null)} style={confirmButtonStyle}>
              cancel
            </button>
            <button
              onClick={confirmRevert}
              style={{ ...confirmButtonStyle, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}
            >
              ↶ revert
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const NO_CONSOLE = "this session has no running console here — open it first";
const EMPTY_COMMENTS: ReviewComment[] = [];

const EMPTY_FILES: DiffFile[] = [];

function Header({
  summary,
  loading,
  viewed,
  onRefresh,
  onReview,
}: {
  summary: InstanceDiff | null;
  loading: boolean;
  /** Files marked viewed and unchanged since. */
  viewed: number;
  onRefresh: () => void;
  /** Review with a fresh agent (A1); absent when there is nothing to review. */
  onReview?: () => void;
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
      {onReview && (
        <button
          onClick={onReview}
          title="have a fresh agent review these changes; its findings come back here to tick"
          style={{
            marginLeft: "auto",
            flex: "0 0 auto",
            whiteSpace: "nowrap",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--wb-accent)",
            font: "11px var(--wb-mono)",
            padding: 0,
          }}
        >
          ⌕ review
        </button>
      )}
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="refresh diff"
        title="refresh diff"
        style={{
          marginLeft: onReview ? 0 : "auto",
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
  commentCount,
  onSelect,
  onToggleViewed,
}: {
  files: DiffFile[];
  selected: string | null;
  isViewed: (file: DiffFile) => boolean;
  commentCount: (file: DiffFile) => number;
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
        const noted = commentCount(f);
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
                {noted > 0 && (
                  <span style={{ color: "var(--wb-working)" }} title={`${noted} pending comment${noted === 1 ? "" : "s"}`}>
                    ●{noted}{" "}
                  </span>
                )}
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
  onComment,
  onAddToPrompt,
}: {
  file: DiffFile;
  layout: DiffLayout;
  editable: boolean;
  dirty: boolean;
  notice: string | null;
  onLayout: (layout: DiffLayout) => void;
  onSave?: () => void;
  /** Comment on / reference the selected lines (V3); absent when there is no view. */
  onComment?: () => void;
  onAddToPrompt?: () => void;
}) {
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
        {onComment && (
          <BarButton onClick={onComment} title="comment on the selected lines (Ctrl+Shift+O) — or click + in the gutter">
            + comment
          </BarButton>
        )}
        {onAddToPrompt && (
          <BarButton
            onClick={onAddToPrompt}
            title="put an @reference to the selected lines in the session's prompt, unsent (Ctrl+Shift+B)"
          >
            @ to prompt
          </BarButton>
        )}
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

/** The pending review comments (V3), the one being written, and sending them. */
function Comments({
  comments,
  draft,
  toast,
  live,
  onDraft,
  onAdd,
  onCancel,
  onEdit,
  onRemove,
  onShow,
  onSend,
  onClear,
  onDismiss,
}: {
  comments: readonly ReviewComment[];
  draft: Omit<ReviewComment, "id"> | null;
  toast: string | null;
  /** The session has a running console to send to. */
  live: boolean;
  onDraft: (note: string) => void;
  onAdd: () => void;
  onCancel: () => void;
  onEdit: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  onShow: (comment: ReviewComment) => void;
  onSend: () => void;
  onClear: () => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const n = comments.length;
  return (
    <div
      style={{
        flex: "0 1 auto",
        maxHeight: "40%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderTop: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
        font: "11px var(--wb-mono)",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          padding: "4px 10px",
          background: "var(--wb-titlebar)",
          color: "var(--wb-textDim2)",
        }}
      >
        <span style={{ color: n ? "var(--wb-working)" : "var(--wb-textFaint)" }}>
          {n ? `${n} comment${n === 1 ? "" : "s"}` : "comments"}
        </span>
        {toast && (
          <button onClick={onDismiss} title="dismiss" style={{ ...linkButton, color: "var(--wb-textDim2)" }}>
            {toast}
          </button>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {n > 0 && (
            <BarButton onClick={onClear} title="drop every pending comment">
              clear
            </BarButton>
          )}
          {n > 0 && (
            <BarButton
              onClick={onSend}
              disabled={!live}
              accent
              title={
                live
                  ? "send them to the agent as one prompt — queued if it is mid-turn"
                  : "this session has no running console here"
              }
            >
              ⏎ send {n} to agent
            </BarButton>
          )}
        </span>
      </div>
      <div style={{ overflow: "auto", minHeight: 0 }}>
        {draft && (
          <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--wb-border)" }}>
            <div style={{ color: "var(--wb-text)" }}>{location(draft)}</div>
            <Quote text={draft.quote} />
            <NoteField
              value={draft.note}
              placeholder="what should change here? — Ctrl+Enter adds, Esc cancels"
              onChange={onDraft}
              onSubmit={onAdd}
              onCancel={onCancel}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <BarButton onClick={onAdd} disabled={!draft.note.trim()} accent>
                add comment
              </BarButton>
              <BarButton onClick={onCancel}>cancel</BarButton>
            </div>
          </div>
        )}
        {comments.map((c) => (
          <div
            key={c.id}
            style={{ display: "flex", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--wb-border)" }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <button onClick={() => onShow(c)} title="show these lines" style={linkButton}>
                {location(c)}
              </button>
              {editing?.id === c.id ? (
                <NoteField
                  value={editing.note}
                  onChange={(note) => setEditing({ id: c.id, note })}
                  onSubmit={() => {
                    onEdit(c.id, editing.note);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div
                  style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: "text" }}
                  onClick={() => setEditing({ id: c.id, note: c.note })}
                  title="click to edit"
                >
                  {c.note}
                </div>
              )}
            </div>
            <span style={{ flex: "0 0 auto", display: "flex", alignItems: "flex-start", gap: 4 }}>
              {editing?.id !== c.id && (
                <BarButton onClick={() => setEditing({ id: c.id, note: c.note })} title="edit the note">
                  edit
                </BarButton>
              )}
              <BarButton onClick={() => onRemove(c.id)} title="remove this comment">
                ×
              </BarButton>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Quote({ text }: { text: string }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, 3).join("\n") + (lines.length > 3 ? `\n… ${lines.length - 3} more` : "");
  return (
    <pre
      style={{
        margin: "3px 0",
        padding: "2px 6px",
        borderLeft: "2px solid var(--wb-border)",
        color: "var(--wb-textFaint)",
        font: "10.5px var(--wb-mono)",
        whiteSpace: "pre",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {shown}
    </pre>
  );
}

function NoteField({
  value,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <textarea
      autoFocus
      value={value}
      placeholder={placeholder}
      rows={3}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Stays here: Enter is a new line, and the panel's own keys mustn't fire.
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{
        width: "100%",
        boxSizing: "border-box",
        marginTop: 3,
        resize: "vertical",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        border: "1px solid var(--wb-borderActive)",
        outline: "none",
        padding: "4px 6px",
        font: "11.5px var(--wb-mono)",
      }}
    />
  );
}

const linkButton: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--wb-accent)",
  font: "11px var(--wb-mono)",
  textAlign: "left",
};

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
