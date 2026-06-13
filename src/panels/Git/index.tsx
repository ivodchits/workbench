// Git panel (step 3.11 — design §5 "Git" / §7). The repo-level counterpart to the
// instance-scoped Diff/Review panel (2.7): bound to a *project* via the git store,
// it answers "what's the state of the repo, and let me move around in it." Holds no
// buffer — re-fetches log / branches / status / stashes from the backend on mount,
// on refresh, and after every action.
//
// Three tabs: History (commit log → click a commit for its changed files + diff),
// Branches (local with ahead/behind + remotes; checkout / create / rename / delete),
// and Working tree (staged / unstaged / untracked with stage / unstage / discard,
// plus the stash list). The header shows the current branch + ahead/behind and the
// fetch / pull / push controls. Read-first; every state-rewriting op (force-push,
// branch delete, discard, clean, stash drop) sits behind an explicit confirm, and
// checking out under a live root instance surfaces the §6 shared-working-dir warning.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import {
  gitBranches,
  gitCheckout,
  gitClean,
  gitCommitFileDiff,
  gitCommitFiles,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiscard,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitRenameBranch,
  gitStage,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatusEntries,
  gitUnstage,
  instanceFileDiff,
  type Branch,
  type Branches,
  type Commit,
  type DiffFile,
  type Stash,
  type StatusEntry,
} from "../../ipc/git";
import { useGits, type GitSession } from "../../state/git";
import { getRegistry } from "../../state/registry";
import { getOpenConsoles } from "../../state/consoles";
import Modal from "../InstanceManager/Modal";
import UnifiedDiff from "../Diff/UnifiedDiff";

export interface GitPanelParams {
  gitId: string;
}

export function GitPanel(props: IDockviewPanelProps<GitPanelParams>) {
  const { gitId } = props.params;
  const { open } = useGits();
  const session = open.find((g) => g.gitId === gitId) ?? null;

  const title = session ? `git · ${session.title}` : "git";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!session) return <Missing />;
  return <GitBody session={session} />;
}

type Tab = "history" | "branches" | "status";

interface RepoData {
  branches: Branches;
  log: Commit[];
  status: StatusEntry[];
  stashes: Stash[];
}

/** A pending state-rewriting action awaiting confirmation (design: read-first). */
type Confirm =
  | { kind: "checkout"; reference: string; warnLive: boolean }
  | { kind: "deleteBranch"; name: string }
  | { kind: "discard"; tracked: string[]; untracked: string[] }
  | { kind: "stashDrop"; stash: Stash }
  | { kind: "push"; force: boolean };

function GitBody({ session }: { session: GitSession }) {
  const { repoRoot } = session;
  const [data, setData] = useState<RepoData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("history");
  const [busy, setBusy] = useState(false);
  // A transient banner for action results (errors stick; "done" auto-reads as the
  // refreshed view, so we only surface failures + a couple of explicit notices).
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [creating, setCreating] = useState<{ startPoint: string | null } | null>(null);
  const [renaming, setRenaming] = useState<Branch | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [branches, log, status, stashes] = await Promise.all([
        gitBranches(repoRoot),
        gitLog(repoRoot),
        gitStatusEntries(repoRoot),
        gitStashList(repoRoot),
      ]);
      setData({ branches, log, status, stashes });
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  // Run a write op, then refresh. A failure surfaces git's message and leaves the
  // view as-is; success reloads (and clears any open confirm/dialog).
  const run = useCallback(
    async (op: () => Promise<string>, okText?: string) => {
      setBusy(true);
      setNotice(null);
      try {
        await op();
        setConfirm(null);
        setCreating(null);
        setRenaming(null);
        await load();
        if (okText) setNotice({ kind: "ok", text: okText });
      } catch (err) {
        setNotice({ kind: "err", text: String(err instanceof Error ? err.message : err) });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // Instances of this project running live in the repo root (not a worktree) —
  // checking out moves HEAD under them (design §6 shared-working-dir warning).
  const liveRootInstances = useCallback((): number => {
    const { instances } = getRegistry();
    const live = new Set(
      getOpenConsoles().filter((c) => c.status !== "dormant").map((c) => c.instanceId),
    );
    return instances.filter(
      (i) => i.projectId === session.projectId && !i.worktreeOn && live.has(i.id),
    ).length;
  }, [session.projectId]);

  const requestCheckout = (reference: string) =>
    setConfirm({ kind: "checkout", reference, warnLive: liveRootInstances() > 0 });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}>
      <Header
        branches={data?.branches ?? null}
        loading={loading}
        busy={busy}
        onFetch={() => void run(() => gitFetch(repoRoot), "fetched")}
        onPull={() => void run(() => gitPull(repoRoot), "pulled")}
        onPush={() => setConfirm({ kind: "push", force: false })}
        onRefresh={() => void load()}
      />

      <TabBar tab={tab} onTab={setTab} counts={data} />

      {notice && (
        <div
          style={{
            flex: "0 0 auto",
            padding: "5px 12px",
            font: "11px var(--wb-mono)",
            color: notice.kind === "ok" ? "var(--wb-done)" : "var(--wb-needs)",
            borderBottom: "1px solid var(--wb-border)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {notice.kind === "ok" ? GLYPH.ok : GLYPH.fail} {notice.text}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {loadError ? (
          <div style={{ padding: "12px 14px", color: "var(--wb-needs)", font: "11.5px var(--wb-mono)" }}>
            {GLYPH.warn} {loadError}
          </div>
        ) : !data ? (
          <div style={{ padding: "12px 14px", color: "var(--wb-textFaint)", font: "11.5px var(--wb-mono)" }}>
            reading repo…
          </div>
        ) : tab === "history" ? (
          <HistoryTab repoRoot={repoRoot} commits={data.log} />
        ) : tab === "branches" ? (
          <BranchesTab
            branches={data.branches}
            busy={busy}
            onCheckout={requestCheckout}
            onCreate={(startPoint) => setCreating({ startPoint })}
            onRename={setRenaming}
            onDelete={(name) => setConfirm({ kind: "deleteBranch", name })}
          />
        ) : (
          <StatusTab
            repoRoot={repoRoot}
            status={data.status}
            stashes={data.stashes}
            busy={busy}
            onStage={(paths) => void run(() => gitStage(repoRoot, paths))}
            onUnstage={(paths) => void run(() => gitUnstage(repoRoot, paths))}
            onDiscard={(tracked, untracked) => setConfirm({ kind: "discard", tracked, untracked })}
            onStashPush={(msg, untracked) => void run(() => gitStashPush(repoRoot, msg, untracked), "stashed")}
            onStashPop={(ref) => void run(() => gitStashPop(repoRoot, ref), "popped")}
            onStashDrop={(stash) => setConfirm({ kind: "stashDrop", stash })}
          />
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          confirm={confirm}
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            switch (confirm.kind) {
              case "checkout":
                void run(() => gitCheckout(repoRoot, confirm.reference));
                break;
              case "deleteBranch":
                void run(() => gitDeleteBranch(repoRoot, confirm.name, true));
                break;
              case "discard": {
                const { tracked, untracked } = confirm;
                void run(async () => {
                  const parts: string[] = [];
                  if (tracked.length) parts.push(await gitDiscard(repoRoot, tracked));
                  if (untracked.length) parts.push(await gitClean(repoRoot, untracked));
                  return parts.join("\n");
                });
                break;
              }
              case "stashDrop":
                void run(() => gitStashDrop(repoRoot, confirm.stash.reference));
                break;
              case "push":
                void run(() => gitPush(repoRoot, confirm.force), "pushed");
                break;
            }
          }}
        />
      )}

      {creating && (
        <BranchCreateDialog
          startPoint={creating.startPoint}
          busy={busy}
          onClose={() => setCreating(null)}
          onCreate={(name, checkout) =>
            void run(() => gitCreateBranch(repoRoot, name, creating.startPoint, checkout))
          }
        />
      )}

      {renaming && (
        <BranchRenameDialog
          branch={renaming}
          busy={busy}
          onClose={() => setRenaming(null)}
          onRename={(next) => void run(() => gitRenameBranch(repoRoot, renaming.name, next))}
        />
      )}
    </div>
  );
}

// --- header + tabs ----------------------------------------------------------

function Header({
  branches,
  loading,
  busy,
  onFetch,
  onPull,
  onPush,
  onRefresh,
}: {
  branches: Branches | null;
  loading: boolean;
  busy: boolean;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
}) {
  const current = branches?.detached ? "detached HEAD" : branches?.current ?? "—";
  const head = branches?.local.find((b) => b.isHead) ?? null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-accent)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        ⎇{" "}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current}</span>
      </span>
      {head && (head.ahead > 0 || head.behind > 0) && (
        <span style={{ flex: "0 0 auto", display: "flex", gap: 6 }}>
          {head.ahead > 0 && <span style={{ color: "var(--wb-done)" }}>↑{head.ahead}</span>}
          {head.behind > 0 && <span style={{ color: "var(--wb-working)" }}>↓{head.behind}</span>}
        </span>
      )}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <HeaderButton onClick={onFetch} disabled={busy}>
          ↡ fetch
        </HeaderButton>
        <HeaderButton onClick={onPull} disabled={busy}>
          ⇣ pull
        </HeaderButton>
        <HeaderButton onClick={onPush} disabled={busy} accent>
          ⇡ push
        </HeaderButton>
        <HeaderButton onClick={onRefresh} disabled={loading}>
          ↻ refresh
        </HeaderButton>
      </span>
    </div>
  );
}

function TabBar({ tab, onTab, counts }: { tab: Tab; onTab: (t: Tab) => void; counts: RepoData | null }) {
  const dirty = counts?.status.length ?? 0;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "history", label: "history" },
    { id: "branches", label: "branches", badge: counts?.branches.local.length },
    { id: "status", label: "working tree", badge: dirty || undefined },
  ];
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        gap: 0,
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
      }}
    >
      {tabs.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            style={{
              background: active ? "var(--wb-sel)" : "transparent",
              border: "none",
              borderBottom: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
              cursor: "pointer",
              color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
              font: "11px var(--wb-mono)",
              padding: "6px 13px",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span style={{ color: "var(--wb-textFaint)", font: "10px var(--wb-mono)" }}>{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- history tab ------------------------------------------------------------

function HistoryTab({ repoRoot, commits }: { repoRoot: string; commits: Commit[] }) {
  const [selected, setSelected] = useState<string | null>(commits[0]?.sha ?? null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  // Keep a valid selection as the log refreshes.
  useEffect(() => {
    if (selected && commits.some((c) => c.sha === selected)) return;
    setSelected(commits[0]?.sha ?? null);
  }, [commits, selected]);

  // Load the selected commit's changed-file list; auto-pick the first file.
  useEffect(() => {
    if (!selected) {
      setFiles(null);
      setSelectedFile(null);
      return;
    }
    let alive = true;
    void gitCommitFiles(repoRoot, selected)
      .then((f) => {
        if (!alive) return;
        setFiles(f);
        setSelectedFile(f[0]?.path ?? null);
      })
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [repoRoot, selected]);

  // Load the selected file's diff within the commit.
  useEffect(() => {
    if (!selected || !selectedFile) {
      setDiff(null);
      return;
    }
    let alive = true;
    void gitCommitFileDiff(repoRoot, selected, selectedFile)
      .then((d) => alive && setDiff(d.binary ? "" : d.text))
      .catch((err) => alive && setDiff(String(err)));
    return () => {
      alive = false;
    };
  }, [repoRoot, selected, selectedFile]);

  if (commits.length === 0) {
    return <Empty>no commits yet</Empty>;
  }

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div style={{ flex: "0 0 300px", borderRight: "1px solid var(--wb-border)", overflow: "auto", background: "var(--wb-panel)" }}>
        {commits.map((c) => (
          <CommitRow key={c.sha} commit={c} active={c.sha === selected} onSelect={() => setSelected(c.sha)} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <CommitFileList files={files} selected={selectedFile} onSelect={setSelectedFile} />
        <div style={{ flex: 1, minHeight: 0 }}>
          {!selectedFile ? (
            <Empty>select a file</Empty>
          ) : diff === null ? (
            <Empty>reading diff…</Empty>
          ) : diff.trim() === "" ? (
            <Empty>{GLYPH.warn} binary file — no textual diff</Empty>
          ) : (
            <UnifiedDiff text={diff} />
          )}
        </div>
      </div>
    </div>
  );
}

function CommitRow({ commit, active, onSelect }: { commit: Commit; active: boolean; onSelect: () => void }) {
  const merge = commit.parents.length > 1;
  return (
    <button
      onClick={onSelect}
      title={commit.sha}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        width: "100%",
        textAlign: "left",
        padding: "6px 11px",
        border: "none",
        borderLeft: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
        background: active ? "var(--wb-sel)" : "transparent",
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
        <span style={{ color: merge ? "var(--wb-working)" : "var(--wb-textFaint)", flex: "0 0 auto", font: "10px var(--wb-mono)" }}>
          {merge ? "⑃" : "●"}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            font: "11.5px var(--wb-mono)",
            color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {commit.subject}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 7, paddingLeft: 17, font: "9.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
        <span style={{ color: "var(--wb-accent)" }}>{commit.short}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{commit.author}</span>
        <span style={{ flex: "0 0 auto" }}>{relativeDate(commit.date)}</span>
      </span>
      {commit.refs.length > 0 && (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 17, marginTop: 1 }}>
          {commit.refs.map((r) => (
            <span
              key={r}
              style={{
                font: "9px var(--wb-mono)",
                color: "var(--wb-accent)",
                border: "1px solid var(--wb-border)",
                borderRadius: 3,
                padding: "0 4px",
              }}
            >
              {r.replace(/^HEAD -> /, "")}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function CommitFileList({
  files,
  selected,
  onSelect,
}: {
  files: DiffFile[] | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        maxHeight: 140,
        overflow: "auto",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
      }}
    >
      {files == null ? (
        <div style={{ padding: "6px 12px", font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>reading…</div>
      ) : files.length === 0 ? (
        <div style={{ padding: "6px 12px", font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>no file changes</div>
      ) : (
        files.map((f) => {
          const active = f.path === selected;
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
                padding: "3px 12px",
                border: "none",
                background: active ? "var(--wb-sel)" : "transparent",
                cursor: "pointer",
                font: "10.5px var(--wb-mono)",
              }}
            >
              <span style={{ color: statusColor(f.status), flex: "0 0 auto", width: 9 }}>{STATUS_GLYPH[f.status] ?? "•"}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: active ? "var(--wb-text)" : "var(--wb-textDim2)" }}>
                {f.path}
              </span>
              <span style={{ flex: "0 0 auto", font: "9.5px var(--wb-mono)" }}>
                {f.insertions > 0 && <span style={{ color: "var(--wb-done)" }}>+{f.insertions} </span>}
                {f.deletions > 0 && <span style={{ color: "var(--wb-needs)" }}>−{f.deletions}</span>}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

// --- branches tab -----------------------------------------------------------

function BranchesTab({
  branches,
  busy,
  onCheckout,
  onCreate,
  onRename,
  onDelete,
}: {
  branches: Branches;
  busy: boolean;
  onCheckout: (reference: string) => void;
  onCreate: (startPoint: string | null) => void;
  onRename: (branch: Branch) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
      <SectionHead>
        local
        <button onClick={() => onCreate(null)} disabled={busy} style={miniActionStyle}>
          + new branch
        </button>
      </SectionHead>
      {branches.local.map((b) => (
        <LocalBranchRow
          key={b.name}
          branch={b}
          busy={busy}
          onCheckout={() => onCheckout(b.name)}
          onRename={() => onRename(b)}
          onDelete={() => onDelete(b.name)}
        />
      ))}

      {branches.remote.length > 0 && (
        <>
          <SectionHead>remote</SectionHead>
          {branches.remote.map((r) => (
            <RemoteBranchRow key={r} name={r} busy={busy} onCheckout={() => onCheckout(r)} />
          ))}
        </>
      )}
    </div>
  );
}

function LocalBranchRow({
  branch,
  busy,
  onCheckout,
  onRename,
  onDelete,
}: {
  branch: Branch;
  busy: boolean;
  onCheckout: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => !branch.isHead && !busy && onCheckout()}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 14px", font: "12px var(--wb-mono)" }}
    >
      <span style={{ flex: "0 0 auto", width: 10, color: branch.isHead ? "var(--wb-done)" : "transparent" }}>●</span>
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span
            style={{
              color: branch.isHead ? "var(--wb-text)" : "var(--wb-textDim2)",
              fontWeight: branch.isHead ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {branch.name}
          </span>
          {branch.ahead > 0 && <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-done)" }}>↑{branch.ahead}</span>}
          {branch.behind > 0 && <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-working)" }}>↓{branch.behind}</span>}
        </span>
        {branch.upstream && (
          <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>→ {branch.upstream}</span>
        )}
      </span>
      <span style={{ flex: "0 0 auto", font: "9.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>{branch.short}</span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 9, visibility: hover ? "visible" : "hidden" }}>
        {!branch.isHead && (
          <RowAction onClick={onCheckout} label="checkout" disabled={busy}>
            ⇄
          </RowAction>
        )}
        <RowAction onClick={onRename} label="rename branch" disabled={busy}>
          ✎
        </RowAction>
        {!branch.isHead && (
          <RowAction onClick={onDelete} label="delete branch" disabled={busy} danger>
            {GLYPH.fail}
          </RowAction>
        )}
      </span>
    </div>
  );
}

function RemoteBranchRow({ name, busy, onCheckout }: { name: string; busy: boolean; onCheckout: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => !busy && onCheckout()}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 14px 4px 24px", font: "12px var(--wb-mono)" }}
    >
      <span style={{ minWidth: 0, flex: 1, color: "var(--wb-textDim2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <span style={{ flex: "0 0 auto", visibility: hover ? "visible" : "hidden" }}>
        <RowAction onClick={onCheckout} label="checkout (detached / tracking)" disabled={busy}>
          ⇄
        </RowAction>
      </span>
    </div>
  );
}

// --- working tree tab -------------------------------------------------------

type Grp = "staged" | "unstaged" | "untracked";

/** A displayed status row: its `rowId` is `<group>:<path>` so a file modified both
 *  staged and unstaged is two distinct selectable rows (and Shift-range stays in
 *  visual order). Selection is over these ids; actions resolve them back to paths. */
interface StatusRowItem {
  rowId: string;
  entry: StatusEntry;
  group: Grp;
}

function StatusTab({
  repoRoot,
  status,
  stashes,
  busy,
  onStage,
  onUnstage,
  onDiscard,
  onStashPush,
  onStashPop,
  onStashDrop,
}: {
  repoRoot: string;
  status: StatusEntry[];
  stashes: Stash[];
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (tracked: string[], untracked: string[]) => void;
  onStashPush: (message: string | null, includeUntracked: boolean) => void;
  onStashPop: (reference: string) => void;
  onStashDrop: (stash: Stash) => void;
}) {
  // The lead row drives the diff pane (the last-clicked file). `selected` holds the
  // multi-selection (rowIds); `anchor` is the pivot for Shift-range.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  const { staged, unstaged, untracked, rows } = useMemo(() => {
    const staged = status.filter((e) => e.index !== " " && e.index !== "?");
    const unstaged = status.filter((e) => e.worktree !== " " && e.index !== "?");
    const untracked = status.filter((e) => e.untracked);
    const rows: StatusRowItem[] = [];
    for (const e of staged) rows.push({ rowId: `staged:${e.path}`, entry: e, group: "staged" });
    for (const e of unstaged) rows.push({ rowId: `unstaged:${e.path}`, entry: e, group: "unstaged" });
    for (const e of untracked) rows.push({ rowId: `untracked:${e.path}`, entry: e, group: "untracked" });
    return { staged, unstaged, untracked, rows };
  }, [status]);

  // As status refreshes (e.g. after staging), prune the selection/anchor/lead to
  // rows that still exist; default the lead to the first row so the diff pane fills.
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.rowId));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
    setAnchor((prev) => (prev && ids.has(prev) ? prev : null));
    setLead((prev) => (prev && ids.has(prev) ? prev : rows[0]?.rowId ?? null));
  }, [rows]);

  const leadEntry = rows.find((r) => r.rowId === lead)?.entry ?? null;
  const leadPath = leadEntry?.path ?? null;
  const leadUntracked = leadEntry?.untracked ?? false;

  // The lead file's diff vs HEAD (combined staged+unstaged — the review view).
  useEffect(() => {
    if (!leadPath) {
      setDiff(null);
      return;
    }
    let alive = true;
    void instanceFileDiff(repoRoot, "HEAD", leadPath, leadUntracked)
      .then((d) => alive && setDiff(d.binary ? "" : d.text))
      .catch((err) => alive && setDiff(String(err)));
    return () => {
      alive = false;
    };
  }, [repoRoot, leadPath, leadUntracked]);

  // Click selection with Ctrl (toggle one) / Shift (range from the anchor) / plain
  // (select just this row). All three set the lead to the clicked row.
  const onRowClick = (rowId: string, e: React.MouseEvent) => {
    const ids = rows.map((r) => r.rowId);
    if (e.shiftKey && anchor && ids.includes(anchor)) {
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(rowId);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(ids.slice(lo, hi + 1)));
      setLead(rowId);
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      });
      setAnchor(rowId);
      setLead(rowId);
    } else {
      setSelected(new Set([rowId]));
      setAnchor(rowId);
      setLead(rowId);
    }
  };

  // The selection resolved to paths, bucketed for the action bar. Unstage only
  // targets staged rows; discard splits tracked (→ revert) from untracked (→ clean).
  const selRows = rows.filter((r) => selected.has(r.rowId));
  const selPaths = [...new Set(selRows.map((r) => r.entry.path))];
  const selStaged = [...new Set(selRows.filter((r) => r.group === "staged").map((r) => r.entry.path))];
  const selUntracked = [...new Set(selRows.filter((r) => r.entry.untracked).map((r) => r.entry.path))];
  const untrackedSet = new Set(selUntracked);
  const selTracked = selPaths.filter((p) => !untrackedSet.has(p));

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div style={{ flex: "0 0 280px", borderRight: "1px solid var(--wb-border)", background: "var(--wb-panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {selected.size > 0 && (
          <SelectionBar
            count={selected.size}
            busy={busy}
            canUnstage={selStaged.length > 0}
            onStage={() => onStage(selPaths)}
            onUnstage={() => onUnstage(selStaged)}
            onDiscard={() => onDiscard(selTracked, selUntracked)}
            onClear={() => {
              setSelected(new Set());
              setAnchor(null);
            }}
          />
        )}
        <div style={{ flex: 1, overflow: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {status.length === 0 ? (
            <div style={{ padding: "10px 12px", font: "11px var(--wb-mono)", color: "var(--wb-done)" }}>
              {GLYPH.ok} working tree clean
            </div>
          ) : (
            <>
              {staged.length > 0 && (
                <StatusGroup
                  label="staged"
                  group="staged"
                  entries={staged}
                  selected={selected}
                  lead={lead}
                  onRowClick={onRowClick}
                  busy={busy}
                  actionLabel="unstage"
                  onAction={(e) => onUnstage([e.path])}
                  onBulk={() => onUnstage(staged.map((e) => e.path))}
                />
              )}
              {unstaged.length > 0 && (
                <StatusGroup
                  label="unstaged"
                  group="unstaged"
                  entries={unstaged}
                  selected={selected}
                  lead={lead}
                  onRowClick={onRowClick}
                  busy={busy}
                  actionLabel="stage"
                  onAction={(e) => onStage([e.path])}
                  onBulk={() => onStage(unstaged.map((e) => e.path))}
                  onDiscardEntry={(e) => onDiscard([e.path], [])}
                />
              )}
              {untracked.length > 0 && (
                <StatusGroup
                  label="untracked"
                  group="untracked"
                  entries={untracked}
                  selected={selected}
                  lead={lead}
                  onRowClick={onRowClick}
                  busy={busy}
                  actionLabel="stage"
                  onAction={(e) => onStage([e.path])}
                  onBulk={() => onStage(untracked.map((e) => e.path))}
                  onDiscardEntry={(e) => onDiscard([], [e.path])}
                />
              )}
            </>
          )}
          <StashSection
            stashes={stashes}
            busy={busy}
            hasChanges={status.length > 0}
            onStashPush={onStashPush}
            onStashPop={onStashPop}
            onStashDrop={onStashDrop}
          />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {!lead ? (
          <Empty>select a file</Empty>
        ) : diff === null ? (
          <Empty>reading diff…</Empty>
        ) : diff.trim() === "" ? (
          <Empty>{GLYPH.warn} no textual diff</Empty>
        ) : (
          <UnifiedDiff text={diff} />
        )}
      </div>
    </div>
  );
}

/** The bulk-action bar shown above the file list once ≥1 file is selected — the
 *  obvious path for acting on a Ctrl/Shift multi-selection. */
function SelectionBar({
  count,
  busy,
  canUnstage,
  onStage,
  onUnstage,
  onDiscard,
  onClear,
}: {
  count: number;
  busy: boolean;
  canUnstage: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10.5px var(--wb-mono)",
      }}
    >
      <span style={{ color: "var(--wb-text)" }}>{count} selected</span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 11 }}>
        <HeaderButton onClick={onStage} disabled={busy} accent>
          + stage
        </HeaderButton>
        <HeaderButton onClick={onUnstage} disabled={busy || !canUnstage}>
          − unstage
        </HeaderButton>
        <HeaderButton onClick={onDiscard} disabled={busy} danger>
          ⨯ discard
        </HeaderButton>
        <HeaderButton onClick={onClear} disabled={busy}>
          clear
        </HeaderButton>
      </span>
    </div>
  );
}

function StatusGroup({
  label,
  group,
  entries,
  selected,
  lead,
  onRowClick,
  busy,
  actionLabel,
  onAction,
  onBulk,
  onDiscardEntry,
}: {
  label: string;
  group: Grp;
  entries: StatusEntry[];
  selected: Set<string>;
  lead: string | null;
  onRowClick: (rowId: string, e: React.MouseEvent) => void;
  busy: boolean;
  actionLabel: string;
  onAction: (entry: StatusEntry) => void;
  onBulk: () => void;
  onDiscardEntry?: (entry: StatusEntry) => void;
}) {
  return (
    <div>
      <SectionHead>
        {label} <span style={{ color: "var(--wb-textFaint)" }}>{entries.length}</span>
        <button onClick={onBulk} disabled={busy} style={miniActionStyle}>
          {actionLabel} all
        </button>
      </SectionHead>
      {entries.map((e) => {
        const rowId = `${group}:${e.path}`;
        return (
          <StatusRow
            key={rowId}
            entry={e}
            picked={selected.has(rowId)}
            lead={rowId === lead}
            onClick={(ev) => onRowClick(rowId, ev)}
            busy={busy}
            actionLabel={actionLabel}
            onAction={() => onAction(e)}
            onDiscard={onDiscardEntry ? () => onDiscardEntry(e) : undefined}
          />
        );
      })}
    </div>
  );
}

function StatusRow({
  entry,
  picked,
  lead,
  onClick,
  busy,
  actionLabel,
  onAction,
  onDiscard,
}: {
  entry: StatusEntry;
  /** In the multi-selection (highlighted background). */
  picked: boolean;
  /** The lead row driving the diff pane (highlighted left bar). */
  lead: boolean;
  onClick: (e: React.MouseEvent) => void;
  busy: boolean;
  actionLabel: string;
  onAction: () => void;
  onDiscard?: () => void;
}) {
  const [hover, setHover] = useState(false);
  // The most telling status char for the glyph: staged side if present, else worktree.
  const ch = entry.untracked ? "?" : entry.index !== " " ? entry.index : entry.worktree;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 12px",
        borderLeft: `2px solid ${lead ? "var(--wb-selBar)" : "transparent"}`,
        background: picked ? "var(--wb-sel)" : "transparent",
        cursor: "pointer",
        font: "11px var(--wb-mono)",
        // Stop Shift-click from text-selecting the file names as a range is picked.
        userSelect: "none",
      }}
    >
      <span style={{ flex: "0 0 auto", width: 9, color: statusCharColor(ch) }}>{ch}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: picked || lead ? "var(--wb-text)" : "var(--wb-textDim2)" }} title={entry.path}>
        {entry.path}
      </span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 8, visibility: hover ? "visible" : "hidden" }}>
        <RowAction onClick={(ev) => { ev?.stopPropagation(); onAction(); }} label={actionLabel} disabled={busy}>
          {actionLabel === "stage" ? "+" : "−"}
        </RowAction>
        {onDiscard && (
          <RowAction onClick={(ev) => { ev?.stopPropagation(); onDiscard(); }} label="discard changes" disabled={busy} danger>
            ⨯
          </RowAction>
        )}
      </span>
    </div>
  );
}

function StashSection({
  stashes,
  busy,
  hasChanges,
  onStashPush,
  onStashPop,
  onStashDrop,
}: {
  stashes: Stash[];
  busy: boolean;
  hasChanges: boolean;
  onStashPush: (message: string | null, includeUntracked: boolean) => void;
  onStashPop: (reference: string) => void;
  onStashDrop: (stash: Stash) => void;
}) {
  return (
    <div style={{ marginTop: "auto", borderTop: "1px solid var(--wb-border)" }}>
      <SectionHead>
        stashes <span style={{ color: "var(--wb-textFaint)" }}>{stashes.length}</span>
        <button onClick={() => onStashPush(null, true)} disabled={busy || !hasChanges} style={miniActionStyle} title="stash all changes (incl. untracked)">
          stash
        </button>
      </SectionHead>
      {stashes.length === 0 ? (
        <div style={{ padding: "3px 14px 8px", font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>no stashes</div>
      ) : (
        stashes.map((s) => <StashRow key={s.reference} stash={s} busy={busy} onPop={() => onStashPop(s.reference)} onDrop={() => onStashDrop(s)} />)
      )}
    </div>
  );
}

function StashRow({ stash, busy, onPop, onDrop }: { stash: Stash; busy: boolean; onPop: () => void; onDrop: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 12px", font: "10.5px var(--wb-mono)" }}
    >
      <span style={{ flex: "0 0 auto", color: "var(--wb-accent)" }}>{stash.reference}</span>
      <span style={{ flex: 1, minWidth: 0, color: "var(--wb-textDim2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={stash.message}>
        {stash.message}
      </span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 8, visibility: hover ? "visible" : "hidden" }}>
        <RowAction onClick={onPop} label="pop stash" disabled={busy}>
          ⇣
        </RowAction>
        <RowAction onClick={onDrop} label="drop stash" disabled={busy} danger>
          {GLYPH.fail}
        </RowAction>
      </span>
    </div>
  );
}

// --- dialogs ----------------------------------------------------------------

function ConfirmDialog({
  confirm,
  busy,
  onClose,
  onConfirm,
}: {
  confirm: Confirm;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { title, body, label, danger } = describeConfirm(confirm);
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>{body}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          style={{
            ...confirmButtonStyle,
            borderColor: danger ? "var(--wb-needs)" : "var(--wb-borderActive)",
            color: danger ? "var(--wb-needs)" : "var(--wb-text)",
          }}
        >
          {busy ? "working…" : label}
        </button>
      </div>
    </Modal>
  );
}

function describeConfirm(c: Confirm): { title: string; body: React.ReactNode; label: string; danger: boolean } {
  switch (c.kind) {
    case "checkout":
      return {
        title: "checkout",
        label: "checkout",
        danger: false,
        body: (
          <>
            Check out{" "}
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{c.reference}</strong>?
            {c.warnLive && (
              <div style={{ marginTop: 8, color: "var(--wb-working)" }}>
                {GLYPH.warn} A live agent is running in this project's root — checking out moves HEAD under
                it. Consider isolating it in a worktree first.
              </div>
            )}
          </>
        ),
      };
    case "deleteBranch":
      return {
        title: "delete branch",
        label: `${GLYPH.fail} delete`,
        danger: true,
        body: (
          <>
            Force-delete branch{" "}
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{c.name}</strong>? Unmerged
            commits on it will be lost.
          </>
        ),
      };
    case "discard": {
      const total = c.tracked.length + c.untracked.length;
      const only = total === 1 ? [...c.tracked, ...c.untracked][0] : null;
      return {
        title: "discard changes",
        label: `${GLYPH.fail} discard`,
        danger: true,
        body: only ? (
          <>
            Discard changes to{" "}
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{only}</strong>?{" "}
            {c.untracked.length ? "The untracked file will be deleted." : "It will be reverted to HEAD."} This can't be
            undone.
          </>
        ) : (
          <>
            Discard changes to{" "}
            <strong style={{ color: "var(--wb-accent)" }}>{total} files</strong>? Tracked files revert to HEAD
            {c.untracked.length > 0 && <> and {c.untracked.length} untracked file{c.untracked.length === 1 ? "" : "s"} {c.untracked.length === 1 ? "is" : "are"} deleted</>}.
            This can't be undone.
          </>
        ),
      };
    }
    case "stashDrop":
      return {
        title: "drop stash",
        label: `${GLYPH.fail} drop`,
        danger: true,
        body: (
          <>
            Drop{" "}
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{c.stash.reference}</strong>{" "}
            without applying it? The stashed changes will be lost.
          </>
        ),
      };
    case "push":
      return {
        title: c.force ? "force push" : "push",
        label: c.force ? `${GLYPH.warn} force push` : "⇡ push",
        danger: c.force,
        body: c.force ? (
          <>Force-push the current branch (with lease)? This can overwrite remote history.</>
        ) : (
          <>Push the current branch to its upstream?</>
        ),
      };
  }
}

function BranchCreateDialog({
  startPoint,
  busy,
  onClose,
  onCreate,
}: {
  startPoint: string | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, checkout: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const trimmed = name.trim();
  return (
    <Modal title="new branch" onClose={onClose} width={400}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {startPoint && (
          <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
            from <span style={{ color: "var(--wb-accent)" }}>{startPoint}</span>
          </div>
        )}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !busy) onCreate(trimmed, checkout);
          }}
          placeholder="branch name"
          autoFocus
          spellCheck={false}
          style={inputStyle}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 7, font: "11.5px var(--wb-mono)", color: "var(--wb-textDim2)", cursor: "pointer" }}>
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
          check out after creating
        </label>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => onCreate(trimmed, checkout)}
          disabled={busy || !trimmed}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : "create"}
        </button>
      </div>
    </Modal>
  );
}

function BranchRenameDialog({
  branch,
  busy,
  onClose,
  onRename,
}: {
  branch: Branch;
  busy: boolean;
  onClose: () => void;
  onRename: (next: string) => void;
}) {
  const [name, setName] = useState(branch.name);
  const trimmed = name.trim();
  const changed = trimmed !== "" && trimmed !== branch.name;
  return (
    <Modal title="rename branch" onClose={onClose} width={400}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && changed && !busy) onRename(trimmed);
        }}
        autoFocus
        spellCheck={false}
        style={inputStyle}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => onRename(trimmed)}
          disabled={busy || !changed}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : "rename"}
        </button>
      </div>
    </Modal>
  );
}

// --- shared bits ------------------------------------------------------------

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

function statusCharColor(ch: string): string {
  if (ch === "A" || ch === "?") return "var(--wb-done)";
  if (ch === "D") return "var(--wb-needs)";
  if (ch === "M" || ch === "R" || ch === "C") return "var(--wb-working)";
  return "var(--wb-textDim2)";
}

/** Compact relative date from an epoch-seconds timestamp ("3d", "2h", "5m", "now"). */
function relativeDate(epochSeconds: number): string {
  if (!epochSeconds) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "7px 14px 4px",
        font: "600 10px var(--wb-mono)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--wb-accent)",
      }}
    >
      {children}
    </div>
  );
}

function RowAction({
  children,
  onClick,
  label,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        if (disabled) return;
        onClick(e);
      }}
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        lineHeight: 1,
        font: "12px var(--wb-mono)",
        color: disabled ? "var(--wb-textFaint)" : danger ? "var(--wb-needs)" : "var(--wb-accent)",
      }}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--wb-textFaint)",
        font: "12px var(--wb-mono)",
        padding: 24,
        textAlign: "center",
        background: "var(--wb-bg)",
      }}
    >
      {children}
    </div>
  );
}

function Missing() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "var(--wb-bg)",
      }}
    >
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} this panel is gone</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close it</div>
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  accent,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const color = disabled
    ? "var(--wb-textFaint)"
    : danger
      ? "var(--wb-needs)"
      : accent
        ? "var(--wb-accent)"
        : "var(--wb-textDim2)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color,
        font: "11px var(--wb-mono)",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

const miniActionStyle: CSSProperties = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--wb-textDim2)",
  font: "9.5px var(--wb-mono)",
  textTransform: "none",
  letterSpacing: 0,
  padding: 0,
};

const inputStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-borderActive)",
  padding: "7px 9px",
  fontFamily: "var(--wb-mono)",
  fontSize: 12.5,
  outline: "none",
};

const confirmButtonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default GitPanel;
