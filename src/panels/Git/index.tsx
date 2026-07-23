// Git panel (step 3.11 — design §5 "Git" / §7). The repo-level counterpart to the
// instance-scoped Diff/Review panel (2.7): bound to a *project* via the git store,
// it answers "what's the state of the repo, and let me move around in it." Holds no
// buffer — re-fetches log / branches / status / stashes from the backend on mount,
// on refresh, and after every action.
//
// Three tabs: History (commit log → click a commit for its changed files + diff),
// Branches (local with ahead/behind + remotes; checkout / create / rename / delete),
// and Working tree (staged / unstaged / untracked with stage / unstage / discard,
// the stash list, and — since G1 — the commit composer). The header shows the
// current branch + ahead/behind and the fetch / pull / push (or *publish*) controls.
// Read-first; every state-rewriting op (force-push, branch delete, discard, clean,
// stash drop, amending a pushed commit) sits behind an explicit confirm, and
// checking out under a live root instance surfaces the §6 shared-working-dir warning.
//
// Since G2 every split is a draggable, persisted `Splitter` rather than a fixed
// pixel pane, and the whole panel reads its own width (`useOrientation`): below
// ~560px it stacks list-over-diff, folds the header to glyphs + an overflow menu,
// and shows the tab bar as glyph + count, so it stays usable docked in a narrow
// column. Above it, the side-by-side layout is the one it always had.
//
// G3 gave every row type a right-click menu (`components/ContextMenu`, the app's
// first). The hover glyphs stay as the fast path for the one or two things you do
// most; the menu is where everything else lives, including the items whose
// backends land in later steps — present, disabled, and carrying the reason. What
// each menu holds is in `menus.ts`; the actions they call are the same ones the
// hover buttons call, so nothing routes around an existing confirm.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import {
  gitBranches,
  gitCheckout,
  gitClean,
  gitCommit,
  gitCommitFileDiff,
  gitCommitFiles,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiscard,
  gitFetch,
  gitHeadCommit,
  gitIgnoreAdd,
  gitLog,
  gitPull,
  gitPush,
  gitRenameBranch,
  gitStage,
  gitStashApply,
  gitStashBranch,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStashShow,
  gitStatusEntries,
  gitUnstage,
  instanceFileDiff,
  type Branch,
  type Branches,
  type Commit,
  type DiffFile,
  type HeadCommit,
  type Stash,
  type StatusEntry,
} from "../../ipc/git";
import { revealPath } from "../../ipc/os";
import { useGits, type GitSession } from "../../state/git";
import { getRegistry } from "../../state/registry";
import { getOpenConsoles } from "../../state/consoles";
import { openProjectFile } from "../../state/editors";
import ContextMenu from "../../components/ContextMenu";
import { useContextMenu } from "../../components/useContextMenu";
import Modal from "../InstanceManager/Modal";
import UnifiedDiff from "../Diff/UnifiedDiff";
import CommitBox, { type CommitRequest } from "./CommitBox";
import { clearDraft } from "./draft";
import {
  commitFileRowMenu,
  commitRowMenu,
  fileRowMenu,
  localBranchMenu,
  remoteBranchMenu,
  stashRowMenu,
  type FileActions,
} from "./menus";
import {
  confirmButtonStyle,
  inputStyle,
  menuItemStyle,
  miniActionStyle,
  relativeDate,
  statusCharColor,
  statusColor,
  STATUS_GLYPH,
} from "./format";
import { Empty, HeaderButton, RowAction, SectionHead } from "./rows";
import Splitter from "./Splitter";
import { hydrateGitLayout, readSection, writeSection } from "./layout";
import { useOrientation, type Orientation } from "./useOrientation";

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
  /** HEAD's commit — the amend prefill; null in a repo with no commits yet. */
  head: HeadCommit | null;
}

/**
 * What the row context menus (G3) need from the panel shell: the clipboard and OS
 * shims, plus the same confirm/dialog plumbing the hover actions already go
 * through. Built once in `GitBody` and handed to each tab, so a menu item and the
 * glyph button beside it can't drift into two different code paths — in
 * particular, the destructive ones stay behind the confirms that already exist.
 */
interface PanelActions {
  busy: boolean;
  /** Copy to the clipboard and say so on the notice line. */
  copy: (text: string, what: string) => void;
  /** Repo-relative path → absolute, forward-slashed. */
  abs: (rel: string) => string;
  openInEditor: (rel: string) => void;
  reveal: (rel: string) => void;
  ignore: (rel: string) => void;
  checkout: (reference: string) => void;
  branchFrom: (startPoint: string) => void;
  rename: (branch: Branch) => void;
  deleteBranch: (name: string) => void;
  push: () => void;
  pull: () => void;
  stashApply: (reference: string) => void;
  stashShow: (stash: Stash) => void;
  stashBranch: (stash: Stash) => void;
}

/** A repo-relative path made absolute. Forward slashes throughout (Windows-first
 *  guardrail): every consumer is either git, which speaks `/` on all platforms, or
 *  a Rust `Path::join`, which is happy with either. */
function absoluteIn(repoRoot: string, rel: string): string {
  return `${repoRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel}`;
}

/** A pending state-rewriting action awaiting confirmation (design: read-first). */
type Confirm =
  | { kind: "checkout"; reference: string; warnLive: boolean }
  | { kind: "deleteBranch"; name: string }
  | { kind: "discard"; tracked: string[]; untracked: string[] }
  | { kind: "stashDrop"; stash: Stash }
  | { kind: "push"; force: boolean }
  | { kind: "publish"; branch: string }
  | { kind: "amendPushed"; req: CommitRequest; head: HeadCommit };

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
  // Bumped on every landed commit; the commit box watches it to clear itself.
  const [committedAt, setCommittedAt] = useState(0);
  // G3 stash extras: the read-only "what's in this stash" viewer, and the
  // name prompt for branching off one.
  const [stashDiff, setStashDiff] = useState<{ stash: Stash; text: string | null; error: string | null } | null>(null);
  const [stashBranching, setStashBranching] = useState<{ stash: Stash; warnLive: boolean } | null>(null);

  // The panel measures itself, not the window — the same window can hold a wide
  // Git panel and a narrow one, and each lays out for the box it's actually in.
  const rootRef = useRef<HTMLDivElement>(null);
  const orientation = useOrientation(rootRef);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The stored splitter positions ride along with the first read, so the tabs
      // mount at the right sizes instead of snapping a beat after they appear.
      const [branches, log, status, stashes, head] = await Promise.all([
        gitBranches(repoRoot),
        gitLog(repoRoot),
        gitStatusEntries(repoRoot),
        gitStashList(repoRoot),
        gitHeadCommit(repoRoot),
        hydrateGitLayout(),
      ]);
      setData({ branches, log, status, stashes, head });
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
  // view as-is; success reloads (and clears any open confirm/dialog). `okText` may
  // be a function so a notice can quote what git returned (e.g. the new short SHA).
  const run = useCallback(
    async (op: () => Promise<string>, okText?: string | ((out: string) => string)) => {
      setBusy(true);
      setNotice(null);
      try {
        const out = await op();
        setConfirm(null);
        setCreating(null);
        setRenaming(null);
        setStashBranching(null);
        await load();
        if (okText) setNotice({ kind: "ok", text: typeof okText === "function" ? okText(out) : okText });
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

  // The checked-out branch, when HEAD isn't detached — its `upstream` decides
  // whether pushing is a push or a *publish* (`push -u`).
  const headBranch = data?.branches.local.find((b) => b.isHead) ?? null;
  const canPublish = headBranch != null && headBranch.upstream == null;

  const requestPush = () =>
    setConfirm(
      canPublish && headBranch ? { kind: "publish", branch: headBranch.name } : { kind: "push", force: false },
    );

  // Commit (+ an optional explicit push), then refresh. `amendPushed` means we're
  // rewriting a commit the upstream already has, so the follow-up push must be
  // forced — with lease, and only after the confirm the user just cleared.
  const doCommit = useCallback(
    (req: CommitRequest, amendPushed: boolean) => {
      void run(
        async () => {
          const short = await gitCommit(repoRoot, req.message, {
            amend: req.amend,
            stageAll: req.stageAll,
          });
          setCommittedAt((n) => n + 1);
          clearDraft(repoRoot);
          if (req.push) await gitPush(repoRoot, amendPushed, canPublish);
          return short;
        },
        (short) => `committed ${short}${req.push ? (canPublish ? " · published" : " · pushed") : ""}`,
      );
    },
    [run, repoRoot, canPublish],
  );

  const requestCommit = (req: CommitRequest) => {
    const head = data?.head ?? null;
    if (req.amend && head?.pushed) setConfirm({ kind: "amendPushed", req, head });
    else doCommit(req, false);
  };

  // Read a stash's patch into the viewer. Not a `run()` — it changes nothing, so
  // it neither refreshes the repo nor blocks the panel; the guard on the reference
  // drops a slow read whose modal has already been replaced or closed.
  const showStash = (stash: Stash) => {
    setStashDiff({ stash, text: null, error: null });
    const settle = (patch: Partial<{ text: string; error: string }>) =>
      setStashDiff((prev) => (prev && prev.stash.reference === stash.reference ? { ...prev, ...patch } : prev));
    void gitStashShow(repoRoot, stash.reference)
      .then((text) => settle({ text }))
      .catch((err) => settle({ error: String(err instanceof Error ? err.message : err) }));
  };

  // A plain object, rebuilt each render: the tabs aren't memoised, so a stable
  // identity would buy nothing and cost a dependency list that has to be kept
  // honest as menu items are added.
  const actions: PanelActions = {
    busy,
    copy: (text, what) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => setNotice({ kind: "ok", text: `copied ${what}` }))
        .catch((err) => setNotice({ kind: "err", text: `couldn't copy: ${String(err)}` }));
    },
    abs: (rel) => absoluteIn(repoRoot, rel),
    // The project's Editor panel, minted if it isn't open — the same door the
    // instance rail's "open editor" uses, so the file lands in one editor per
    // project rather than a new panel per click.
    openInEditor: (rel) =>
      openProjectFile(
        { projectId: session.projectId, rootPath: repoRoot, label: session.title },
        { path: absoluteIn(repoRoot, rel) },
      ),
    reveal: (rel) => {
      void revealPath(absoluteIn(repoRoot, rel)).catch((err) =>
        setNotice({ kind: "err", text: String(err instanceof Error ? err.message : err) }),
      );
    },
    // Through `run` so the status list refreshes: ignoring an untracked file is
    // supposed to make it leave the panel, and it should do that on its own.
    ignore: (rel) => void run(() => gitIgnoreAdd(repoRoot, [rel]), (out) => out),
    checkout: requestCheckout,
    branchFrom: (startPoint) => setCreating({ startPoint }),
    rename: setRenaming,
    deleteBranch: (name) => setConfirm({ kind: "deleteBranch", name }),
    push: requestPush,
    pull: () => void run(() => gitPull(repoRoot), "pulled"),
    stashApply: (reference) => void run(() => gitStashApply(repoRoot, reference), "applied (stash kept)"),
    stashShow: showStash,
    // Creates *and checks out* a branch, so it moves HEAD — the §6 shared-working-
    // dir warning belongs on it just as much as on a checkout.
    stashBranch: (stash) => setStashBranching({ stash, warnLive: liveRootInstances() > 0 }),
  };

  return (
    <div
      ref={rootRef}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, background: "var(--wb-bg)" }}
    >
      <Header
        branches={data?.branches ?? null}
        loading={loading}
        busy={busy}
        orientation={orientation}
        onFetch={() => void run(() => gitFetch(repoRoot), "fetched")}
        onPull={() => void run(() => gitPull(repoRoot), "pulled")}
        onPush={requestPush}
        canPublish={canPublish}
        onRefresh={() => void load()}
      />

      <TabBar tab={tab} onTab={setTab} counts={data} orientation={orientation} />

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

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
        {loadError ? (
          <div style={{ padding: "12px 14px", color: "var(--wb-needs)", font: "11.5px var(--wb-mono)" }}>
            {GLYPH.warn} {loadError}
          </div>
        ) : !data ? (
          <div style={{ padding: "12px 14px", color: "var(--wb-textFaint)", font: "11.5px var(--wb-mono)" }}>
            reading repo…
          </div>
        ) : tab === "history" ? (
          <HistoryTab repoRoot={repoRoot} commits={data.log} orientation={orientation} actions={actions} />
        ) : tab === "branches" ? (
          <BranchesTab
            branches={data.branches}
            busy={busy}
            actions={actions}
            onCheckout={requestCheckout}
            onCreate={(startPoint) => setCreating({ startPoint })}
            onRename={setRenaming}
            onDelete={(name) => setConfirm({ kind: "deleteBranch", name })}
          />
        ) : (
          <StatusTab
            repoRoot={repoRoot}
            orientation={orientation}
            actions={actions}
            status={data.status}
            stashes={data.stashes}
            head={data.head}
            hasUpstream={headBranch?.upstream != null}
            committedAt={committedAt}
            onCommit={requestCommit}
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
              case "publish":
                void run(() => gitPush(repoRoot, false, true), `published ${confirm.branch}`);
                break;
              case "amendPushed":
                doCommit(confirm.req, true);
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

      {stashDiff && (
        <StashDiffDialog
          stash={stashDiff.stash}
          text={stashDiff.text}
          error={stashDiff.error}
          onClose={() => setStashDiff(null)}
        />
      )}

      {stashBranching && (
        <StashBranchDialog
          stash={stashBranching.stash}
          warnLive={stashBranching.warnLive}
          busy={busy}
          onClose={() => setStashBranching(null)}
          onCreate={(name) =>
            void run(
              () => gitStashBranch(repoRoot, name, stashBranching.stash.reference),
              `branched ${name} from ${stashBranching.stash.reference}`,
            )
          }
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
  orientation,
  onFetch,
  onPull,
  onPush,
  canPublish,
  onRefresh,
}: {
  branches: Branches | null;
  loading: boolean;
  busy: boolean;
  orientation: Orientation;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  /** The current branch has no upstream — pushing it *publishes* it (`push -u`). */
  canPublish: boolean;
  onRefresh: () => void;
}) {
  const current = branches?.detached ? "detached HEAD" : branches?.current ?? "—";
  const head = branches?.local.find((b) => b.isHead) ?? null;
  const narrow = orientation === "narrow";
  const pushTitle = canPublish
    ? "no upstream yet — push -u to publish this branch"
    : "push to the upstream";
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: narrow ? 7 : 10,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-accent)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        ⎇{" "}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={current}>
          {current}
        </span>
      </span>
      {head && (head.ahead > 0 || head.behind > 0) && (
        <span style={{ flex: "0 0 auto", display: "flex", gap: 6 }}>
          {head.ahead > 0 && <span style={{ color: "var(--wb-done)" }}>↑{head.ahead}</span>}
          {head.behind > 0 && <span style={{ color: "var(--wb-working)" }}>↓{head.behind}</span>}
        </span>
      )}
      {/* Narrow keeps only push (the one gesture you can't undo by waiting) and
          refresh as glyphs; fetch and pull keep their words inside the overflow,
          so nothing loses its name — it just moves one click away. */}
      <span style={{ marginLeft: "auto", flex: "0 0 auto", display: "flex", alignItems: "center", gap: narrow ? 9 : 10 }}>
        {!narrow && (
          <>
            <HeaderButton onClick={onFetch} disabled={busy}>
              ↡ fetch
            </HeaderButton>
            <HeaderButton onClick={onPull} disabled={busy}>
              ⇣ pull
            </HeaderButton>
          </>
        )}
        <HeaderButton onClick={onPush} disabled={busy} accent title={pushTitle}>
          {narrow ? "⇡" : canPublish ? "⇡ publish" : "⇡ push"}
        </HeaderButton>
        <HeaderButton onClick={onRefresh} disabled={loading} title={narrow ? "re-read the repo" : undefined}>
          {narrow ? "↻" : "↻ refresh"}
        </HeaderButton>
        {narrow && (
          <OverflowMenu
            items={[
              { label: "↡ fetch", onClick: onFetch, disabled: busy },
              { label: "⇣ pull", onClick: onPull, disabled: busy },
              {
                label: canPublish ? "⇡ publish branch" : "⇡ push",
                onClick: onPush,
                disabled: busy,
                title: pushTitle,
              },
            ]}
          />
        )}
      </span>
    </div>
  );
}

/** The `⋯` menu that holds the header actions there's no room to spell out. Not
 *  the shared right-click `ContextMenu` — that's G3, and this is a button menu. */
function OverflowMenu({
  items,
}: {
  items: { label: string; onClick: () => void; disabled?: boolean; title?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} style={{ position: "relative", display: "flex" }}>
      <HeaderButton onClick={() => setOpen((v) => !v)} title="more git actions">
        ⋯
      </HeaderButton>
      {open && (
        <span
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 30,
            minWidth: 140,
            display: "flex",
            flexDirection: "column",
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-borderActive)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                if (item.disabled) return;
                setOpen(false);
                item.onClick();
              }}
              disabled={item.disabled}
              title={item.title}
              style={{
                ...menuItemStyle,
                color: item.disabled ? "var(--wb-textFaint)" : "var(--wb-textDim2)",
                cursor: item.disabled ? "default" : "pointer",
              }}
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Tab identity at a glance when there's no room for the word (§5.x vocabulary). */
const TAB_GLYPH: Record<Tab, string> = { history: "≡", branches: "⎇", status: "±" };

function TabBar({
  tab,
  onTab,
  counts,
  orientation,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  counts: RepoData | null;
  orientation: Orientation;
}) {
  const narrow = orientation === "narrow";
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
            title={narrow ? t.label : undefined}
            style={{
              background: active ? "var(--wb-sel)" : "transparent",
              border: "none",
              borderBottom: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
              cursor: "pointer",
              color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
              font: "11px var(--wb-mono)",
              padding: narrow ? "6px 14px" : "6px 13px",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {narrow ? TAB_GLYPH[t.id] : t.label}
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

function HistoryTab({
  repoRoot,
  commits,
  orientation,
  actions,
}: {
  repoRoot: string;
  commits: Commit[];
  orientation: Orientation;
  actions: PanelActions;
}) {
  const { anchor, openMenu, closeMenu } = useContextMenu();
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

  const narrow = orientation === "narrow";

  return (
    <>
    <Splitter
      id="history.log"
      orientation={orientation}
      direction={narrow ? "column" : "row"}
      defaultSize={narrow ? 200 : 300}
      minFirst={narrow ? 80 : 170}
      minSecond={narrow ? 120 : 220}
      first={
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--wb-panel)" }}>
          {commits.map((c) => (
            <CommitRow
              key={c.sha}
              commit={c}
              active={c.sha === selected}
              onSelect={() => setSelected(c.sha)}
              // Right-click selects too: the menu's checkout / branch-from read
              // better next to the commit's own file list than against whatever
              // was selected before.
              onMenu={(e) => {
                setSelected(c.sha);
                openMenu(e, commitRowMenu(c, actions));
              }}
            />
          ))}
        </div>
      }
      second={
        // Always stacked: the commit's file list reads as a header over its diff at
        // any width. Collapsible so a big commit's file list can take the whole box.
        <Splitter
          id="history.files"
          orientation={orientation}
          direction="column"
          defaultSize={140}
          minFirst={52}
          minSecond={90}
          collapsible
          secondLabel="diff"
          first={
            <CommitFileList
              files={files}
              selected={selectedFile}
              onSelect={setSelectedFile}
              onMenu={(path, e) => openMenu(e, commitFileRowMenu(path, actions))}
            />
          }
          second={
            !selectedFile ? (
              <Empty>select a file</Empty>
            ) : diff === null ? (
              <Empty>reading diff…</Empty>
            ) : diff.trim() === "" ? (
              <Empty>{GLYPH.warn} binary file — no textual diff</Empty>
            ) : (
              <UnifiedDiff text={diff} />
            )
          }
        />
      }
    />
    {anchor && <ContextMenu {...anchor} onClose={closeMenu} />}
    </>
  );
}

function CommitRow({
  commit,
  active,
  onSelect,
  onMenu,
}: {
  commit: Commit;
  active: boolean;
  onSelect: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const merge = commit.parents.length > 1;
  return (
    <button
      onClick={onSelect}
      onContextMenu={onMenu}
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
  onMenu,
}: {
  files: DiffFile[] | null;
  selected: string | null;
  onSelect: (path: string) => void;
  onMenu: (path: string, e: React.MouseEvent) => void;
}) {
  // Sized by its splitter now, not a `maxHeight: 140` cap — a 30-file commit used
  // to be read four rows at a time no matter how much room the panel had.
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--wb-titlebar)" }}>
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
              onContextMenu={(e) => {
                onSelect(f.path);
                onMenu(f.path, e);
              }}
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
  actions,
  onCheckout,
  onCreate,
  onRename,
  onDelete,
}: {
  branches: Branches;
  busy: boolean;
  actions: PanelActions;
  onCheckout: (reference: string) => void;
  onCreate: (startPoint: string | null) => void;
  onRename: (branch: Branch) => void;
  onDelete: (name: string) => void;
}) {
  const { anchor, openMenu, closeMenu } = useContextMenu();
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
          onMenu={(e) => openMenu(e, localBranchMenu(b, actions))}
        />
      ))}

      {branches.remote.length > 0 && (
        <>
          <SectionHead>remote</SectionHead>
          {branches.remote.map((r) => (
            <RemoteBranchRow
              key={r}
              name={r}
              busy={busy}
              onCheckout={() => onCheckout(r)}
              onMenu={(e) => openMenu(e, remoteBranchMenu(r, actions))}
            />
          ))}
        </>
      )}

      {anchor && <ContextMenu {...anchor} onClose={closeMenu} />}
    </div>
  );
}

function LocalBranchRow({
  branch,
  busy,
  onCheckout,
  onRename,
  onDelete,
  onMenu,
}: {
  branch: Branch;
  busy: boolean;
  onCheckout: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => !branch.isHead && !busy && onCheckout()}
      onContextMenu={onMenu}
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

function RemoteBranchRow({
  name,
  busy,
  onCheckout,
  onMenu,
}: {
  name: string;
  busy: boolean;
  onCheckout: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => !busy && onCheckout()}
      onContextMenu={onMenu}
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
  orientation,
  actions,
  status,
  stashes,
  head,
  hasUpstream,
  committedAt,
  onCommit,
  busy,
  onStage,
  onUnstage,
  onDiscard,
  onStashPush,
  onStashPop,
  onStashDrop,
}: {
  repoRoot: string;
  orientation: Orientation;
  actions: PanelActions;
  status: StatusEntry[];
  stashes: Stash[];
  head: HeadCommit | null;
  hasUpstream: boolean;
  committedAt: number;
  onCommit: (req: CommitRequest) => void;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (tracked: string[], untracked: string[]) => void;
  onStashPush: (message: string | null, includeUntracked: boolean) => void;
  onStashPop: (reference: string) => void;
  onStashDrop: (stash: Stash) => void;
}) {
  // `menu` is the open context menu; the `anchor` below is the *selection* pivot,
  // an older and entirely separate thing.
  const { anchor: menu, openMenu, closeMenu } = useContextMenu();
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

  // The menu's file items go through the tab's own callbacks, which are the ones
  // the hover glyphs and the selection bar already use — so "discard" from a menu
  // is the same confirmed operation as "discard" from the row.
  const fileActions: FileActions = {
    busy,
    stage: onStage,
    unstage: onUnstage,
    discard: onDiscard,
    copy: actions.copy,
    abs: actions.abs,
    openInEditor: actions.openInEditor,
    reveal: actions.reveal,
    ignore: actions.ignore,
  };

  // Right-clicking *inside* the selection acts on all of it; right-clicking
  // outside replaces the selection with that one row first, so what the menu is
  // about to touch is always what's highlighted when it opens.
  const onRowMenu = (rowId: string, e: React.MouseEvent) => {
    const row = rows.find((r) => r.rowId === rowId);
    if (!row) return;
    const inSelection = selected.has(rowId);
    if (!inSelection) {
      setSelected(new Set([rowId]));
      setAnchor(rowId);
    }
    setLead(rowId);

    const target = inSelection ? rows.filter((r) => selected.has(r.rowId)) : [row];
    const paths = [...new Set(target.map((r) => r.entry.path))];
    const untracked = [...new Set(target.filter((r) => r.entry.untracked).map((r) => r.entry.path))];
    const untrackedInTarget = new Set(untracked);
    const { entry } = row;
    openMenu(
      e,
      fileRowMenu(
        {
          path: entry.path,
          paths,
          staged: [...new Set(target.filter((r) => r.group === "staged").map((r) => r.entry.path))],
          tracked: paths.filter((p) => !untrackedInTarget.has(p)),
          untracked,
          deleted: !entry.untracked && (entry.index === "D" || entry.worktree === "D"),
          isUntracked: entry.untracked,
          conflicted: entry.index === "U" || entry.worktree === "U",
        },
        fileActions,
      ),
    );
  };

  const narrow = orientation === "narrow";

  // `minWidth: 0` on the column: without it the diff pane's min-content width
  // inflates it, and the commit box — sized to it — runs its buttons off the right
  // edge of a narrow panel.
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
      <Splitter
        id="status.files"
        orientation={orientation}
        direction={narrow ? "column" : "row"}
        defaultSize={narrow ? 190 : 280}
        minFirst={narrow ? 70 : 160}
        minSecond={narrow ? 90 : 200}
        collapsible
        secondLabel="diff"
        first={
          <>
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
            <div style={{ flex: 1, overflow: "auto", minHeight: 0, background: "var(--wb-panel)" }}>
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
                      onRowMenu={onRowMenu}
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
                      onRowMenu={onRowMenu}
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
                      onRowMenu={onRowMenu}
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
                onStashMenu={(stash, e) =>
                  openMenu(
                    e,
                    stashRowMenu(stash, {
                      busy,
                      pop: onStashPop,
                      apply: actions.stashApply,
                      show: actions.stashShow,
                      branch: actions.stashBranch,
                      drop: onStashDrop,
                      copy: actions.copy,
                    }),
                  )
                }
              />
            </div>
          </>
        }
        second={
          !lead ? (
            <Empty>select a file</Empty>
          ) : diff === null ? (
            <Empty>reading diff…</Empty>
          ) : diff.trim() === "" ? (
            <Empty>{GLYPH.warn} no textual diff</Empty>
          ) : (
            <UnifiedDiff text={diff} />
          )
        }
      />
      {/* Docked full-width under both panes at every width: even wide, the file
          column is too narrow to write a commit message in, and stacking it under
          the diff would put it below the fold in a narrow column. */}
      <CommitBox
        repoRoot={repoRoot}
        stagedCount={new Set(staged.map((e) => e.path)).size}
        trackedDirtyCount={new Set(unstaged.map((e) => e.path)).size}
        head={head}
        hasUpstream={hasUpstream}
        busy={busy}
        committedAt={committedAt}
        onCommit={onCommit}
      />
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
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
        flexWrap: "wrap",
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
  onRowMenu,
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
  onRowMenu: (rowId: string, e: React.MouseEvent) => void;
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
            onMenu={(ev) => onRowMenu(rowId, ev)}
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
  onMenu,
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
  onMenu: (e: React.MouseEvent) => void;
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
      onContextMenu={onMenu}
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
  onStashMenu,
}: {
  stashes: Stash[];
  busy: boolean;
  hasChanges: boolean;
  onStashPush: (message: string | null, includeUntracked: boolean) => void;
  onStashPop: (reference: string) => void;
  onStashDrop: (stash: Stash) => void;
  onStashMenu: (stash: Stash, e: React.MouseEvent) => void;
}) {
  // A real collapsible section (G2) instead of the old `marginTop: auto`, which
  // pinned it to the bottom of the scroll box and fought the file list for height.
  // Until you toggle it, it follows its contents: open when there's a stash to see.
  const [open, setOpen] = useState(() => readSection("stash", stashes.length > 0));
  const toggle = () => {
    setOpen(!open);
    writeSection("stash", !open);
  };
  return (
    <div style={{ borderTop: "1px solid var(--wb-border)" }}>
      <SectionHead open={open} onToggle={toggle}>
        stashes <span style={{ color: "var(--wb-textFaint)" }}>{stashes.length}</span>
        <button onClick={() => onStashPush(null, true)} disabled={busy || !hasChanges} style={miniActionStyle} title="stash all changes (incl. untracked)">
          stash
        </button>
      </SectionHead>
      {open &&
        (stashes.length === 0 ? (
          <div style={{ padding: "3px 14px 8px", font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>no stashes</div>
        ) : (
          stashes.map((s) => (
            <StashRow
              key={s.reference}
              stash={s}
              busy={busy}
              onPop={() => onStashPop(s.reference)}
              onDrop={() => onStashDrop(s)}
              onMenu={(e) => onStashMenu(s, e)}
            />
          ))
        ))}
    </div>
  );
}

function StashRow({
  stash,
  busy,
  onPop,
  onDrop,
  onMenu,
}: {
  stash: Stash;
  busy: boolean;
  onPop: () => void;
  onDrop: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={onMenu}
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
    case "publish":
      return {
        title: "publish branch",
        label: "⇡ publish",
        danger: false,
        body: (
          <>
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{c.branch}</strong> has
            no upstream yet. Push it and set one (<span style={{ fontFamily: "var(--wb-mono)" }}>push -u</span>),
            so future pushes and pulls know where it lives?
          </>
        ),
      };
    case "amendPushed":
      return {
        title: "amend a pushed commit",
        label: `${GLYPH.warn} amend anyway`,
        danger: true,
        body: (
          <>
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{c.head.short}</strong> is
            already on{" "}
            <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{c.head.upstream}</strong>.
            Amending replaces it with a new commit, so the branch will only push again with a force-push
            (with lease) — and anyone who already pulled it will have to reconcile.
            {c.req.push && (
              <div style={{ marginTop: 8, color: "var(--wb-working)" }}>
                {GLYPH.warn} This action force-pushes right after the amend.
              </div>
            )}
          </>
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

/**
 * A stash's patch, read-only (G3). Until now the only way to find out what a
 * stash held was to pop it and look at the damage — which is exactly the move
 * you'd want to avoid making blind.
 */
function StashDiffDialog({
  stash,
  text,
  error,
  onClose,
}: {
  stash: Stash;
  /** The patch, or null while it's still being read. */
  text: string | null;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <Modal title={`${stash.reference} · ${stash.message}`} onClose={onClose} width={760}>
      <div
        style={{
          height: "min(56vh, 520px)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          border: "1px solid var(--wb-border)",
          background: "var(--wb-bg)",
        }}
      >
        {error ? (
          <Empty>
            {GLYPH.warn} {error}
          </Empty>
        ) : text === null ? (
          <Empty>reading stash…</Empty>
        ) : text.trim() === "" ? (
          // `git stash show -p` says nothing about untracked files it stashed
          // alongside, so an "empty" stash here usually isn't one.
          <Empty>no textual diff — an untracked-only stash reads as empty here</Empty>
        ) : (
          <UnifiedDiff text={text} />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          close
        </button>
      </div>
    </Modal>
  );
}

/** Name the branch `git stash branch` will create, check out, and apply the stash
 *  on (G3). It moves HEAD, so it carries the §6 shared-working-dir warning. */
function StashBranchDialog({
  stash,
  warnLive,
  busy,
  onClose,
  onCreate,
}: {
  stash: Stash;
  warnLive: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <Modal title="branch from stash" onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
          <span style={{ color: "var(--wb-accent)" }}>{stash.reference}</span> — {stash.message}
          <div style={{ marginTop: 6 }}>
            Checks out a new branch at the commit this stash was made on, applies it there, and drops
            the stash if that succeeds.
          </div>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !busy) onCreate(trimmed);
          }}
          placeholder="branch name"
          autoFocus
          spellCheck={false}
          style={inputStyle}
        />
        {warnLive && (
          <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-working)", lineHeight: 1.5 }}>
            {GLYPH.warn} A live agent is running in this project's root — this moves HEAD under it.
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => onCreate(trimmed)}
          disabled={busy || !trimmed}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : "create + apply"}
        </button>
      </div>
    </Modal>
  );
}

// --- shared bits ------------------------------------------------------------
// (the row/section/button primitives and the status glyph + colour maps live in
// `rows.tsx`, shared with the commit box)

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

export default GitPanel;
