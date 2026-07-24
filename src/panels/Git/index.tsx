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
//
// G4 filled in the branch operations §5 always promised: merge (plain / no-ff /
// squash), fast-forward, rebase-onto, set-upstream, and delete-on-remote, all
// from the branch tab's menu and all behind a confirm. Because those are the
// commands that *fail productively* — a conflict is an outcome, not a bug — their
// failure doesn't go to the one-line notice: it opens a scrollable output dialog
// with git's whole message, and the panel picks up a banner (fed by
// `git_repo_state`) offering continue / skip / abort until the repo is idle again.
// The branch tab itself moved to `BranchesTab.tsx` on the way through.
//
// G5 did the same for the working tree (`StatusTab.tsx`), which is where the
// keyboard-first requirement and the selection work landed: a focusable file list
// with real arrow/Space/Enter navigation, checkboxes, a filter, a folder tree, and
// hunk-level staging. Two things it needed from the shell are here — the confirm
// on *discarding* a hunk (it's the one hunk action that destroys work), and the
// command-palette registration: the panel claims the `git…` commands on mount and
// again whenever it's activated, so the most recently focused Git panel is the one
// the palette talks to.

import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import {
  gitApplyPatch,
  gitBranches,
  gitCheckout,
  gitClean,
  gitCommit,
  gitCommitFileDiff,
  gitCommitFiles,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitDiscard,
  gitFetch,
  gitHeadCommit,
  gitIgnoreAdd,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitPull,
  gitPush,
  gitRebase,
  gitRebaseControl,
  gitRenameBranch,
  gitRepoState,
  gitSetUpstream,
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
  type Branch,
  type Branches,
  type Commit,
  type DiffFile,
  type HeadCommit,
  type MergeMode,
  type RepoState,
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
import { registerCommand } from "../../keyboard/bus";
import Modal from "../InstanceManager/Modal";
import UnifiedDiff from "../Diff/UnifiedDiff";
import BranchesTab from "./BranchesTab";
import type { CommitRequest } from "./CommitBox";
import StatusTab, { type StatusCommand } from "./StatusTab";
import { clearDraft } from "./draft";
import {
  commitFileRowMenu,
  commitRowMenu,
  type BranchActions,
} from "./menus";
import {
  confirmButtonStyle,
  inputStyle,
  menuItemStyle,
  relativeDate,
  statusColor,
  STATUS_GLYPH,
} from "./format";
import { Empty, HeaderButton } from "./rows";
import Splitter from "./Splitter";
import { hydrateGitLayout } from "./layout";
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

  // Which Git panel the palette's `git…` commands talk to (G5). The command bus
  // holds one handler per command, so "most recently activated wins" is the rule
  // that makes two open Git panels behave the way you'd expect.
  const { api } = props;
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    const sub = api.onDidActiveChange((e) => setActive(e.isActive));
    return () => sub.dispose();
  }, [api]);
  const activate = useCallback(() => api.setActive(), [api]);

  if (!session) return <Missing />;
  return <GitBody session={session} active={active} activate={activate} />;
}

type Tab = "history" | "branches" | "status";

interface RepoData {
  branches: Branches;
  log: Commit[];
  status: StatusEntry[];
  stashes: Stash[];
  /** HEAD's commit — the amend prefill; null in a repo with no commits yet. */
  head: HeadCommit | null;
  /** Mid-merge / mid-rebase / … (G4) — what the operation banner reads. */
  state: RepoState;
}

/**
 * What the row context menus (G3) need from the panel shell: the clipboard and OS
 * shims, plus the same confirm/dialog plumbing the hover actions already go
 * through. Built once in `GitBody` and handed to each tab, so a menu item and the
 * glyph button beside it can't drift into two different code paths — in
 * particular, the destructive ones stay behind the confirms that already exist.
 */
interface PanelActions extends BranchActions {
  /** Copy to the clipboard and say so on the notice line. */
  copy: (text: string, what: string) => void;
  /** Repo-relative path → absolute, forward-slashed. */
  abs: (rel: string) => string;
  openInEditor: (rel: string) => void;
  reveal: (rel: string) => void;
  ignore: (rel: string) => void;
  stashApply: (reference: string) => void;
  stashShow: (stash: Stash) => void;
  stashBranch: (stash: Stash) => void;
}

/** The notice a hunk action leaves behind — the panel refreshes under you, so
 *  without a word saying what happened it can be hard to tell that it did (G5). */
function hunkNotice(what: string, n: number): string {
  return `${what} ${n} ${n === 1 ? "hunk" : "hunks"}`;
}

/** What a palette command can ask this panel to do (G5) — panel-level actions
 *  only, since the palette can't see (or mean) a row selection. */
interface GitCommandPort {
  refresh: () => void;
  fetch: () => void;
  pull: () => void;
  push: () => void;
  stageAll: () => void;
  unstageAll: () => void;
  /** Show the working tree and run a one-shot instruction there. */
  status: (kind: StatusCommand["kind"]) => void;
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
  | { kind: "amendPushed"; req: CommitRequest; head: HeadCommit }
  // G4. Rebase rewrites the current branch's commits, so it's a confirm even
  // though nothing is destroyed; `rebaseSkip` throws one commit away outright.
  | { kind: "rebase"; onto: string; head: string; warnLive: boolean }
  | { kind: "rebaseSkip" }
  | { kind: "deleteRemoteBranch"; remote: string; branch: string }
  // G5. Staging and unstaging a hunk are reversible from the panel; discarding one
  // throws away work that was never committed anywhere, so it asks.
  | { kind: "discardHunks"; patch: string; count: number };

function GitBody({
  session,
  active,
  activate,
}: {
  session: GitSession;
  /** This panel has the dock's focus — it re-claims the palette's git commands. */
  active: boolean;
  /** Bring this panel forward, for a command run from somewhere else. */
  activate: () => void;
}) {
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
  // G4: the merge composer (ref + how to merge it), the upstream picker, and the
  // full-output surface a conflicting merge/rebase lands in.
  const [merging, setMerging] = useState<{ reference: string; mode: MergeMode; warnLive: boolean } | null>(null);
  const [upstreaming, setUpstreaming] = useState<Branch | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  // G5: a one-shot instruction for the working-tree tab, carried as a nonce so the
  // same command twice runs twice — and so one issued while another tab was
  // showing runs as that tab mounts.
  const [statusCommand, setStatusCommand] = useState<StatusCommand | null>(null);
  const clearStatusCommand = useCallback(() => setStatusCommand(null), []);

  // The panel measures itself, not the window — the same window can hold a wide
  // Git panel and a narrow one, and each lays out for the box it's actually in.
  const rootRef = useRef<HTMLDivElement>(null);
  const orientation = useOrientation(rootRef);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The stored splitter positions ride along with the first read, so the tabs
      // mount at the right sizes instead of snapping a beat after they appear.
      const [branches, log, status, stashes, head, state] = await Promise.all([
        gitBranches(repoRoot),
        gitLog(repoRoot),
        gitStatusEntries(repoRoot),
        gitStashList(repoRoot),
        gitHeadCommit(repoRoot),
        gitRepoState(repoRoot),
        hydrateGitLayout(),
      ]);
      setData({ branches, log, status, stashes, head, state });
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

  /** Dismiss every open confirm/dialog. Once an op has actually run, whatever
   *  asked for it is answered — leaving it on screen behind the result is how a
   *  panel ends up offering to do the thing it just did. */
  const closeDialogs = useCallback(() => {
    setConfirm(null);
    setCreating(null);
    setRenaming(null);
    setStashBranching(null);
    setMerging(null);
    setUpstreaming(null);
  }, []);

  // Run a write op, then refresh. Success reloads and clears any open
  // confirm/dialog; `okText` may be a function so a notice can quote what git
  // returned (e.g. the new short SHA).
  //
  // A failure normally surfaces git's message on the one-line banner and leaves
  // the view as-is. `failTitle` (G4) is for the commands whose failure is a real
  // outcome rather than a rejected call — a conflicting merge or rebase has
  // *changed the working tree* on its way to failing — so those reload as well
  // and put git's whole multi-line message in a scrollable dialog, where the
  // banner would have shown one line of it.
  const run = useCallback(
    async (
      op: () => Promise<string>,
      okText?: string | ((out: string) => string),
      failTitle?: string,
    ) => {
      setBusy(true);
      setNotice(null);
      try {
        const out = await op();
        closeDialogs();
        await load();
        if (okText) setNotice({ kind: "ok", text: typeof okText === "function" ? okText(out) : okText });
      } catch (err) {
        const text = String(err instanceof Error ? err.message : err);
        if (failTitle) {
          closeDialogs();
          await load();
          setOutput({ title: failTitle, text });
        } else {
          setNotice({ kind: "err", text });
        }
      } finally {
        setBusy(false);
      }
    },
    [load, closeDialogs],
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
    head: data?.branches.detached ? null : data?.branches.current ?? null,
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
    // Merge, fast-forward and rebase all rewrite the working tree under whatever
    // is running in it, so each carries the §6 shared-working-dir warning. Merge
    // opens a dialog rather than a plain confirm: the choice between a merge
    // commit, a forced one, and a squash belongs at the moment you merge.
    merge: (reference, mode) => setMerging({ reference, mode, warnLive: liveRootInstances() > 0 }),
    rebase: (onto) =>
      setConfirm({
        kind: "rebase",
        onto,
        head: headBranch?.name ?? "HEAD",
        warnLive: liveRootInstances() > 0,
      }),
    setUpstream: setUpstreaming,
    deleteRemote: (remoteBranch) => {
      // `origin/topic` → remote `origin`, branch `topic`. Longest name first, so a
      // remote called `origin` can't claim a branch on `origin2`.
      const remote = [...(data?.branches.remotes ?? [])]
        .sort((a, b) => b.length - a.length)
        .find((r) => remoteBranch.startsWith(`${r}/`));
      if (!remote) {
        setNotice({ kind: "err", text: `can't tell which remote ${remoteBranch} belongs to` });
        return;
      }
      setConfirm({ kind: "deleteRemoteBranch", remote, branch: remoteBranch.slice(remote.length + 1) });
    },
    stashApply: (reference) => void run(() => gitStashApply(repoRoot, reference), "applied (stash kept)"),
    stashShow: showStash,
    // Creates *and checks out* a branch, so it moves HEAD — the §6 shared-working-
    // dir warning belongs on it just as much as on a checkout.
    stashBranch: (stash) => setStashBranching({ stash, warnLive: liveRootInstances() > 0 }),
  };

  // --- command palette (G5) --------------------------------------------------
  // §5 asks for the git actions to be reachable from the palette with their
  // bindings. The commands the palette can sensibly run are the *panel-level*
  // ones — the ones that don't depend on what happens to be selected in a list it
  // can't see; per-row work is what the in-panel keyboard is for.

  /** The current render's handlers, read by the (stable) bus registration below. */
  const portRef = useRef<GitCommandPort | null>(null);
  useEffect(() => {
    /** Switch to the working tree and hand it a one-shot instruction. */
    const inStatus = (kind: StatusCommand["kind"]) => {
      setTab("status");
      setStatusCommand((prev) => ({ kind, n: (prev?.n ?? 0) + 1 }));
    };
    const paths = (entries: StatusEntry[]) => [...new Set(entries.map((e) => e.path))];
    portRef.current = {
      refresh: () => void load(),
      fetch: () => void run(() => gitFetch(repoRoot), "fetched"),
      pull: () => void run(() => gitPull(repoRoot), "pulled"),
      push: requestPush,
      stageAll: () => {
        const dirty = paths(data?.status.filter((e) => e.worktree !== " " || e.untracked) ?? []);
        if (dirty.length === 0) setNotice({ kind: "ok", text: "nothing to stage" });
        else void run(() => gitStage(repoRoot, dirty));
      },
      unstageAll: () => {
        const staged = paths(data?.status.filter((e) => e.index !== " " && e.index !== "?") ?? []);
        if (staged.length === 0) setNotice({ kind: "ok", text: "nothing staged" });
        else void run(() => gitUnstage(repoRoot, staged));
      },
      status: inStatus,
    };
  });

  useEffect(() => {
    // A command run from elsewhere brings this panel forward first — the result of
    // a fetch or a filter is only useful if you can see it. Re-registering when
    // `active` flips is what makes the Git panel you last touched the one the
    // palette drives; the bus keeps a single handler per command, and the mount
    // registration means one unfocused Git panel still answers.
    const surface = () => {
      if (!active) activate();
    };
    const on = (id: Parameters<typeof registerCommand>[0], go: (p: GitCommandPort) => void) =>
      registerCommand(id, () => {
        surface();
        const port = portRef.current;
        if (port) go(port);
      });
    const disposers = [
      on("gitRefresh", (p) => p.refresh()),
      on("gitFetch", (p) => p.fetch()),
      on("gitPull", (p) => p.pull()),
      on("gitPush", (p) => p.push()),
      on("gitStageAll", (p) => p.stageAll()),
      on("gitUnstageAll", (p) => p.unstageAll()),
      on("gitCommitFocus", (p) => p.status("commit")),
      on("gitFilterFiles", (p) => p.status("filter")),
      on("gitToggleTree", (p) => p.status("tree")),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [active, activate]);

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

      {data?.state.operation && (
        <OperationBanner
          operation={data.state.operation}
          busy={busy}
          onContinue={() =>
            void run(() => gitRebaseControl(repoRoot, "continue"), "rebase continued", "rebase")
          }
          onSkip={() => setConfirm({ kind: "rebaseSkip" })}
          onAbort={() =>
            data.state.operation === "rebase"
              ? void run(() => gitRebaseControl(repoRoot, "abort"), "rebase aborted", "rebase")
              : void run(() => gitMergeAbort(repoRoot), "merge aborted", "merge")
          }
        />
      )}

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
            actions={actions}
            onNewBranch={() => setCreating({ startPoint: null })}
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
            onStageHunks={(patch, n) =>
              void run(() => gitApplyPatch(repoRoot, patch, true, false), hunkNotice("staged", n))
            }
            onUnstageHunks={(patch, n) =>
              void run(() => gitApplyPatch(repoRoot, patch, true, true), hunkNotice("unstaged", n))
            }
            onDiscardHunks={(patch, count) => setConfirm({ kind: "discardHunks", patch, count })}
            command={statusCommand}
            onCommandDone={clearStatusCommand}
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
              case "rebase": {
                const { onto } = confirm;
                void run(() => gitRebase(repoRoot, onto), `rebased onto ${onto}`, `rebase onto ${onto}`);
                break;
              }
              case "rebaseSkip":
                void run(() => gitRebaseControl(repoRoot, "skip"), "commit skipped", "rebase");
                break;
              case "discardHunks": {
                const { patch, count } = confirm;
                void run(
                  () => gitApplyPatch(repoRoot, patch, false, true),
                  hunkNotice("discarded", count),
                );
                break;
              }
              case "deleteRemoteBranch": {
                const { remote, branch } = confirm;
                void run(
                  () => gitDeleteRemoteBranch(repoRoot, remote, branch),
                  `deleted ${remote}/${branch}`,
                  `delete ${remote}/${branch}`,
                );
                break;
              }
            }
          }}
        />
      )}

      {merging && (
        <MergeDialog
          reference={merging.reference}
          into={headBranch?.name ?? null}
          mode={merging.mode}
          warnLive={merging.warnLive}
          busy={busy}
          onClose={() => setMerging(null)}
          onMerge={(mode) =>
            void run(
              () => gitMerge(repoRoot, merging.reference, mode),
              mode === "squash"
                ? `squashed ${merging.reference} into the index — commit to finish`
                : mode === "ffOnly"
                  ? `fast-forwarded to ${merging.reference}`
                  : `merged ${merging.reference}`,
              `merge ${merging.reference}`,
            )
          }
        />
      )}

      {upstreaming && (
        <SetUpstreamDialog
          branch={upstreaming}
          candidates={data?.branches.remote ?? []}
          busy={busy}
          onClose={() => setUpstreaming(null)}
          onSet={(upstream) =>
            void run(
              () => gitSetUpstream(repoRoot, upstreaming.name, upstream),
              upstream
                ? `${upstreaming.name} now tracks ${upstream}`
                : `${upstreaming.name} no longer tracks anything`,
            )
          }
        />
      )}

      {output && (
        <OutputDialog title={output.title} text={output.text} onClose={() => setOutput(null)} />
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
    case "discardHunks":
      return {
        title: "discard hunks",
        label: `${GLYPH.fail} discard`,
        danger: true,
        body: (
          <>
            Discard {c.count === 1 ? "this hunk" : `these ${c.count} hunks`} from the working tree? The
            lines go back to what the index holds — they aren't committed anywhere, so this can't be
            undone.
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
    case "rebase":
      return {
        title: "rebase",
        label: "↳ rebase",
        danger: false,
        body: (
          <>
            Replay <Ref>{c.head}</Ref>'s commits on top of <Ref>{c.onto}</Ref>? Every commit that
            isn't already on <Ref>{c.onto}</Ref> is rewritten, so anyone who has pulled this branch
            will have to reconcile — and a conflict stops the rebase partway for you to resolve.
            {c.warnLive && <LiveWarning />}
          </>
        ),
      };
    case "rebaseSkip":
      return {
        title: "skip this commit",
        label: `${GLYPH.warn} skip`,
        danger: true,
        body: (
          <>
            Drop the commit the rebase stopped on and carry on with the rest? Its changes won't be
            in the rebased branch at all.
          </>
        ),
      };
    case "deleteRemoteBranch":
      return {
        title: "delete on remote",
        label: `${GLYPH.fail} delete`,
        danger: true,
        body: (
          <>
            Delete <Ref>{c.branch}</Ref> on <Ref>{c.remote}</Ref>? This deletes it for everyone
            using that remote; the local branch, if you have one, stays.
          </>
        ),
      };
  }
}

/** A ref name in dialog prose — the panel's accent + monospace, in one place
 *  because half the confirms name one. */
function Ref({ children }: { children: React.ReactNode }) {
  return (
    <strong style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>{children}</strong>
  );
}

/** The §6 shared-working-dir warning, shown by every dialog that moves HEAD or
 *  rewrites the working tree under a live agent. */
function LiveWarning() {
  return (
    <div style={{ marginTop: 8, color: "var(--wb-working)" }}>
      {GLYPH.warn} A live agent is running in this project's root — this rewrites the working tree
      under it. Consider isolating it in a worktree first.
    </div>
  );
}

/**
 * The repo is mid-merge / mid-rebase / mid-cherry-pick / mid-revert (G4). Until
 * now the panel gave no sign of this at all: a conflicted merge just looked like
 * a working tree with odd files in it, and the way out was to leave for a shell.
 *
 * Rebase gets the full set of controls, since a stopped rebase is *only*
 * escapable through them. A merge gets abort — its "continue" is an ordinary
 * commit, which the commit box below already is. Cherry-pick and revert can't be
 * started from the panel yet (G7), so if one is in flight it came from elsewhere
 * and the banner says so rather than offering half a set of buttons.
 */
function OperationBanner({
  operation,
  busy,
  onContinue,
  onSkip,
  onAbort,
}: {
  operation: string;
  busy: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}) {
  const rebase = operation === "rebase";
  const merge = operation === "merge";
  const what = rebase
    ? "rebase in progress — resolve the conflicts and stage them, then continue"
    : merge
      ? "merge in progress — resolve the conflicts, stage them, and commit"
      : `${operation} in progress — started outside the panel; finish it in the Project Shell`;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-working)",
      }}
    >
      <span style={{ minWidth: 0 }}>
        {GLYPH.warn} {what}
      </span>
      <span style={{ marginLeft: "auto", flex: "0 0 auto", display: "flex", gap: 12 }}>
        {rebase && (
          <>
            <HeaderButton onClick={onContinue} disabled={busy} accent title="git rebase --continue">
              ▸ continue
            </HeaderButton>
            <HeaderButton onClick={onSkip} disabled={busy} title="drop the stopped commit and carry on">
              ↷ skip
            </HeaderButton>
          </>
        )}
        {(rebase || merge) && (
          <HeaderButton
            onClick={onAbort}
            disabled={busy}
            danger
            title={rebase ? "put the branch back where the rebase started" : "restore the pre-merge state"}
          >
            ⨯ abort
          </HeaderButton>
        )}
      </span>
    </div>
  );
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

/**
 * How to merge a ref into the current branch (G4). A confirm with a choice: the
 * difference between a merge commit, a forced one, and a squash is a decision
 * you make *at* the merge, and burying it in three near-identical menu items
 * would make the menu longer without making the choice any clearer.
 *
 * "fast-forward" arrives here too, with `ffOnly` preselected — it's the same
 * command with a mode that refuses to create a merge commit.
 */
function MergeDialog({
  reference,
  into,
  mode: initial,
  warnLive,
  busy,
  onClose,
  onMerge,
}: {
  reference: string;
  /** The current branch, or null when HEAD is detached (the menu blocks that). */
  into: string | null;
  mode: MergeMode;
  warnLive: boolean;
  busy: boolean;
  onClose: () => void;
  onMerge: (mode: MergeMode) => void;
}) {
  const [mode, setMode] = useState<MergeMode>(initial);
  const options: { id: MergeMode; label: string; note: string }[] = [
    { id: "merge", label: "merge", note: "fast-forward if it can, merge commit otherwise" },
    { id: "noFf", label: "no fast-forward", note: "always record a merge commit" },
    { id: "squash", label: "squash", note: "stage the changes as one, don't commit" },
    { id: "ffOnly", label: "fast-forward only", note: "advance, or refuse if that isn't possible" },
  ];
  return (
    <Modal title="merge" onClose={onClose} width={440}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Merge <Ref>{reference}</Ref> into <Ref>{into ?? "HEAD"}</Ref>?
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
        {options.map((o) => (
          <label
            key={o.id}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              font: "11.5px var(--wb-mono)",
              color: mode === o.id ? "var(--wb-text)" : "var(--wb-textDim2)",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="merge-mode"
              checked={mode === o.id}
              onChange={() => setMode(o.id)}
              style={{ margin: 0, cursor: "pointer" }}
            />
            <span>{o.label}</span>
            <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>{o.note}</span>
          </label>
        ))}
      </div>
      <div style={{ marginTop: 10, font: "11px var(--wb-mono)", color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
        A conflict stops here and leaves the files marked up for you to resolve — the panel keeps an
        abort within reach until it's finished.
        {mode === "squash" && (
          // A squash records no MERGE_HEAD, so there's no merge for `--abort` to
          // undo and no banner to hang it on. Say so before, not after.
          <> Not for a squash, though: git records no merge to abort, so a conflict there is
          resolved or discarded by hand.</>
        )}
      </div>
      {warnLive && (
        <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          <LiveWarning />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => onMerge(mode)}
          disabled={busy}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : "⎇ merge"}
        </button>
      </div>
    </Modal>
  );
}

/** Pick the remote branch a local branch tracks (G4) — config only, so there's no
 *  confirm: nothing is pushed, fetched, or moved, and it's reversible from the
 *  same dialog. */
function SetUpstreamDialog({
  branch,
  candidates,
  busy,
  onClose,
  onSet,
}: {
  branch: Branch;
  candidates: string[];
  busy: boolean;
  onClose: () => void;
  onSet: (upstream: string | null) => void;
}) {
  // Prefer a same-named remote branch when the branch has no upstream yet: that's
  // the one it almost always wants, and it saves reading a list of forty.
  const [pick, setPick] = useState(
    () => branch.upstream ?? candidates.find((c) => c.endsWith(`/${branch.name}`)) ?? "",
  );
  return (
    <Modal title="set upstream" onClose={onClose} width={420}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        What should <Ref>{branch.name}</Ref> track?
      </div>
      {candidates.length === 0 ? (
        <div style={{ marginTop: 10, font: "11px var(--wb-mono)", color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
          No remote branches are known yet. Fetch first, or publish this branch from the header —
          that sets an upstream on its way past.
        </div>
      ) : (
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          style={{ ...inputStyle, width: "100%", marginTop: 10 }}
        >
          <option value="">— none (stop tracking) —</option>
          {candidates.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      <div style={{ marginTop: 10, font: "11px var(--wb-mono)", color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
        Config only — this pushes and fetches nothing. It's what makes ahead/behind, plain{" "}
        <span style={{ fontFamily: "var(--wb-mono)" }}>push</span> and{" "}
        <span style={{ fontFamily: "var(--wb-mono)" }}>pull</span> know where to look.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => onSet(pick === "" ? null : pick)}
          disabled={busy || (pick === "" && branch.upstream == null)}
          title={pick === "" && branch.upstream == null ? "this branch already tracks nothing" : undefined}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : pick === "" ? "clear" : "set"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Git's whole output from an operation that failed productively (G4) — a merge
 * that conflicted, a rebase that stopped, a rejected remote delete. The panel's
 * notice line is one row of text; these messages are ten, and the important part
 * (*which files conflicted*) is never the first line. G8 replaces this with a
 * permanent expandable error surface plus a scrollback; until then this is the
 * one place output isn't truncated.
 */
function OutputDialog({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} width={680}>
      <pre
        style={{
          margin: 0,
          maxHeight: "min(50vh, 440px)",
          overflow: "auto",
          padding: "9px 11px",
          border: "1px solid var(--wb-border)",
          background: "var(--wb-bg)",
          color: "var(--wb-text)",
          font: "11.5px var(--wb-mono)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </pre>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          close
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
