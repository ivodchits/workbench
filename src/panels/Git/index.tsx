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
//
// G6 made conflicts a first-class state rather than a mis-classification. A
// conflicted file now has its own group in `StatusTab` (it used to render in the
// staged *and* unstaged ones at once), G4's banner counts what's still unmerged
// and says what the next step is, and taking a side of the merge — the only
// resolution that throws work away — is a confirm here beside the others.
//
// G7 finished the last tab (`HistoryTab.tsx`), and took the log read with it: the
// tab owns its own query, paging and refresh, so the shell no longer re-reads two
// hundred commits every time a file is staged. What stayed here is what the shell
// has always owned — the confirms. Revert, cherry-pick, the three resets, tag
// delete and every stopped-sequencer control are dialogs in this file, and the
// banner learned to drive a cherry-pick or revert now that there's something
// behind those buttons.
//
// G8 is about the panel's own upkeep, and it changes three habits.
//
// It *watches*. `git_watch_start` puts a filesystem watch on the repo and the
// backend says which slices went stale; an agent committing in a terminal now
// shows up here within about a second, unasked. Workbench exists to supervise
// things that write to this repo, so a panel that only updated on click was
// wrong by construction.
//
// It refreshes *narrowly*. `load` takes the slices it should re-read and merges
// them into what's already on screen, and every write says what it invalidated —
// staging a file re-reads the status and nothing else. The old `run()` reloaded
// the world after every click, which is also what made the history read
// expensive enough for G7 to move out.
//
// And it can be *got out of*. Every git invocation now goes through a hardened
// runner (`src-tauri/src/git/run.rs`) that refuses to prompt, has a deadline, and
// registers network children so Cancel can kill them — plus a command log this
// panel shows as a scrollback, which is where a multi-line git error is readable
// in full rather than clipped to a banner line.

import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import Spinner from "../../theme/Spinner";
import {
  ALL_SLICES,
  gitApplyPatch,
  gitBranches,
  gitCancel,
  gitCommandLog,
  gitCheckout,
  gitCherryPick,
  gitClean,
  gitCommit,
  gitCommitDetail,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitDiscard,
  gitFetch,
  gitHeadCommit,
  gitIgnoreAdd,
  gitMerge,
  gitMergeAbort,
  gitPull,
  gitPush,
  gitRebase,
  gitRebaseControl,
  gitRenameBranch,
  gitRepoState,
  gitResolve,
  gitReset,
  gitRevert,
  gitSequencerControl,
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
  gitTagCreate,
  gitTagDelete,
  gitTags,
  gitUnstage,
  gitWatchStart,
  gitWatchStop,
  onGitChanged,
  type Branch,
  type Branches,
  type Commit,
  type GitCommandRecord,
  type GitSlice,
  type HeadCommit,
  type MergeMode,
  type RepoState,
  type Stash,
  type StatusEntry,
  type Tag,
} from "../../ipc/git";
import { revealPath } from "../../ipc/os";
import { useGits, type GitSession } from "../../state/git";
import { getRegistry } from "../../state/registry";
import { getOpenConsoles } from "../../state/consoles";
import { openProjectFile } from "../../state/editors";
import { registerCommand } from "../../keyboard/bus";
import Modal from "../InstanceManager/Modal";
import UnifiedDiff from "../Diff/UnifiedDiff";
import BranchesTab from "./BranchesTab";
import type { CommitRequest } from "./CommitBox";
import HistoryTab, { type HistoryCommand } from "./HistoryTab";
import StatusTab, { type StatusCommand } from "./StatusTab";
import { clearDraft } from "./draft";
import type { BranchActions, ShellHistoryActions } from "./menus";
import { confirmButtonStyle, inputStyle, menuItemStyle } from "./format";
import { Empty, HeaderButton } from "./rows";
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
  status: StatusEntry[];
  stashes: Stash[];
  /** Every tag (G7) — the History tab's ref selector, and the model's first
   *  acquaintance with tags at all. */
  tags: Tag[];
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
interface PanelActions extends BranchActions, ShellHistoryActions {
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
  | { kind: "discardHunks"; patch: string; count: number }
  // G7. Revert and cherry-pick *add* a commit, so neither destroys anything — but
  // both can stop half-applied on a conflict, and that's worth saying first.
  // Reset is the sharp one: `--hard` is the only action in the panel that can
  // delete uncommitted work without naming a file.
  | { kind: "revert"; commit: Commit }
  | { kind: "cherryPick"; commit: Commit }
  | { kind: "reset"; commit: Commit; mode: "soft" | "mixed" | "hard"; head: string; warnLive: boolean }
  | { kind: "deleteTag"; name: string }
  | { kind: "sequencerAbort"; operation: "cherry-pick" | "revert" }
  | { kind: "sequencerSkip"; operation: "cherry-pick" | "revert" }
  // G6. Taking a side of a merge throws the other side's version of the file away
  // — and once it's staged, the index no longer holds the stages `checkout -m`
  // would need to put the conflict back. *Marking* resolved isn't here: it keeps
  // what's on disk and an unstage undoes it.
  | { kind: "resolve"; paths: string[]; side: "ours" | "theirs" };

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
  // G7: the same one-shot channel for the history tab — "show this file's history",
  // "compare these two" — both of which are asked for from a *different* tab.
  const [historyCommand, setHistoryCommand] = useState<HistoryCommand | null>(null);
  const clearHistoryCommand = useCallback(() => setHistoryCommand(null), []);
  // Bumped by every completed load. The History tab owns its own log read now, so
  // this is how it hears that the repo moved under it.
  const [reloadKey, setReloadKey] = useState(0);
  // The tag dialog (G7): which commit is about to be tagged.
  const [tagging, setTagging] = useState<{ commit: Commit } | null>(null);
  // G8: the network op in flight (its label), and whether the command scrollback
  // is open. `netOp` is what makes fetch/pull/push cancellable — everything else
  // is fast enough that `busy` disabling the buttons is the whole story.
  const [netOp, setNetOp] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // Bumped whenever a git command has probably just run, so the scrollback
  // re-reads without polling.
  const [cmdTick, setCmdTick] = useState(0);

  // The panel measures itself, not the window — the same window can hold a wide
  // Git panel and a narrow one, and each lays out for the box it's actually in.
  const rootRef = useRef<HTMLDivElement>(null);
  const orientation = useOrientation(rootRef);

  // `load` reads a *subset*, so it needs to know whether there's anything to
  // merge into without taking `data` as a dependency (which would re-create it —
  // and re-fire the mount effect — on every refresh).
  const dataRef = useRef<RepoData | null>(null);
  dataRef.current = data;
  /** When the last read finished — the clock G8's refresh grace runs against. */
  const lastLoadRef = useRef(0);

  /**
   * Re-read the named slices and merge them into what's on screen (G8).
   *
   * The default is everything, which is what a manual refresh and an unscoped
   * write both want. Everything else says less: staging a file invalidates the
   * status and the in-progress state, and nothing at all about the branch list,
   * the tags, or the stash. The first read ignores the request and takes the lot
   * — there's nothing to merge into yet.
   */
  const load = useCallback(
    async (slices: GitSlice[] = ALL_SLICES) => {
      const first = dataRef.current == null;
      const full = first || slices.length === ALL_SLICES.length;
      const want = (s: GitSlice) => first || slices.includes(s);
      // A background refresh doesn't flash the header's spinner: it wasn't asked
      // for, and a light blinking on its own reads as an error.
      if (full) setLoading(true);
      try {
        // The stored splitter positions ride along with the first read, so the
        // tabs mount at the right sizes instead of snapping a beat after they
        // appear.
        //
        // The *log* is conspicuously absent (G7): the History tab reads it
        // itself, with whatever query and page it's on, so staging a file no
        // longer costs two hundred commits. `reloadKey` below is how it learns
        // to re-read.
        const [branches, status, stashes, tags, head, state] = await Promise.all([
          want("refs") ? gitBranches(repoRoot) : null,
          want("status") ? gitStatusEntries(repoRoot) : null,
          want("stashes") ? gitStashList(repoRoot) : null,
          want("tags") ? gitTags(repoRoot) : null,
          // HEAD's commit follows the refs — and the history, since committing is
          // the usual way it moves.
          want("refs") || want("history") ? gitHeadCommit(repoRoot) : null,
          want("state") ? gitRepoState(repoRoot) : null,
          first ? hydrateGitLayout() : null,
        ]);
        setData((prev) =>
          prev == null
            ? // Only reachable on the first read, where every slice was fetched.
              { branches: branches!, status: status!, stashes: stashes!, tags: tags!, head: head!, state: state! }
            : {
                branches: branches ?? prev.branches,
                status: status ?? prev.status,
                stashes: stashes ?? prev.stashes,
                tags: tags ?? prev.tags,
                head: head ?? prev.head,
                state: state ?? prev.state,
              },
        );
        if (want("refs") || want("history")) setReloadKey((n) => n + 1);
        setLoadError(null);
      } catch (err) {
        const text = String(err instanceof Error ? err.message : err);
        // A *full* read that fails means we have nothing trustworthy to show. A
        // targeted one that fails is a blip against a repo we're already showing
        // — git briefly holding a lock mid-rebase, say — and throwing the whole
        // view away over it would be a worse answer than a stale row.
        if (full) {
          setLoadError(text);
          setData(null);
        } else {
          setNotice({ kind: "err", text });
        }
      } finally {
        if (full) setLoading(false);
        lastLoadRef.current = Date.now();
        setCmdTick((n) => n + 1);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // --- staying fresh (G8) ----------------------------------------------------
  // The backend watches the repo and names the slices that went stale. Two things
  // stand between that event and a re-read. Our *own* writes trip the same watch,
  // so a reload that just happened makes the next one redundant — hence the grace
  // period. And a write in flight is about to reload what it invalidated anyway,
  // so we wait it out rather than reading the repo mid-operation.

  /** Slices seen since the last read, waiting for the timer below to fire. */
  const pendingRef = useRef<Set<GitSlice>>(new Set());
  const timerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const scheduleRefresh = useCallback(
    (slices: GitSlice[]) => {
      for (const s of slices) pendingRef.current.add(s);
      if (timerRef.current != null) return;
      const wait = Math.max(0, 600 - (Date.now() - lastLoadRef.current));
      const fire = () => {
        timerRef.current = null;
        // Deliberately *not* dropped: an outside change that lands during our own
        // write still has to be read, so it waits for the write instead.
        if (busyRef.current) {
          timerRef.current = window.setTimeout(fire, 300);
          return;
        }
        const slices = [...pendingRef.current];
        pendingRef.current.clear();
        if (slices.length > 0) void load(slices);
      };
      timerRef.current = window.setTimeout(fire, wait);
    },
    [load],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let live = true;
    // A repo we can't watch (a network share, an exotic filesystem) just doesn't
    // auto-refresh. That's a quieter panel, not a broken one, so it isn't an
    // error worth putting on screen.
    void gitWatchStart(repoRoot).catch(() => {});
    void onGitChanged((change) => {
      if (change.repoRoot === repoRoot) scheduleRefresh(change.slices);
    }).then((fn) => {
      if (live) unlisten = fn;
      else fn();
    });
    return () => {
      live = false;
      unlisten?.();
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      void gitWatchStop(repoRoot).catch(() => {});
    };
  }, [repoRoot, scheduleRefresh]);

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
    setTagging(null);
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
  //
  // `slices` (G8) is the op declaring what it invalidated. Leave it off and the
  // panel re-reads everything, which is the right default for anything that
  // moves HEAD; pass a narrower set and staging a file stops re-reading the
  // branch list, the tags and the stash to learn that one file is staged.
  const run = useCallback(
    async (
      op: () => Promise<string>,
      okText?: string | ((out: string) => string),
      failTitle?: string,
      slices: GitSlice[] = ALL_SLICES,
    ) => {
      setBusy(true);
      setNotice(null);
      try {
        const out = await op();
        closeDialogs();
        await load(slices);
        if (okText) setNotice({ kind: "ok", text: typeof okText === "function" ? okText(out) : okText });
      } catch (err) {
        const text = String(err instanceof Error ? err.message : err);
        if (failTitle) {
          closeDialogs();
          await load(slices);
          setOutput({ title: failTitle, text });
        } else {
          setNotice({ kind: "err", text });
        }
      } finally {
        setBusy(false);
        setCmdTick((n) => n + 1);
      }
    },
    [load, closeDialogs],
  );

  /**
   * `run` for the three ops that talk to a remote (G8).
   *
   * They're the only ones that can take long enough to need saying so, and the
   * only ones that can fail to finish at all. `label` drives a progress strip
   * with a Cancel on it — the backend registered the child process under this
   * repo, so Cancel kills the git that's actually hanging rather than just
   * abandoning the promise and leaving it running.
   */
  const runNet = useCallback(
    async (
      label: string,
      op: () => Promise<string>,
      okText?: string | ((out: string) => string),
      failTitle?: string,
      slices: GitSlice[] = ALL_SLICES,
    ) => {
      setNetOp(label);
      try {
        await run(op, okText, failTitle, slices);
      } finally {
        setNetOp(null);
      }
    },
    [run],
  );

  const cancelNet = useCallback(() => {
    void gitCancel(repoRoot)
      .then((n) => {
        if (n === 0) setNotice({ kind: "ok", text: "it had already finished" });
      })
      .catch((err) => setNotice({ kind: "err", text: String(err instanceof Error ? err.message : err) }));
  }, [repoRoot]);

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

  /** Show the History tab and hand it a one-shot instruction (G7). The nonce is
   *  what makes the same request twice run twice — and what lets a request made
   *  from another tab run as History mounts. */
  const inHistory = (cmd: Omit<HistoryCommand, "n">) => {
    setTab("history");
    setHistoryCommand((prev) => ({ ...cmd, n: (prev?.n ?? 0) + 1 }));
  };

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
  //
  // Commit-and-push goes through `runNet` (G8) — the push is the half that can
  // sit there waiting on a remote, and it's the half worth being able to cancel.
  const doCommit = useCallback(
    (req: CommitRequest, amendPushed: boolean) => {
      const go: typeof run = req.push
        ? (op, ok, fail, slices) => runNet(canPublish ? "publishing" : "pushing", op, ok, fail, slices)
        : run;
      void go(
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
    [run, runNet, repoRoot, canPublish],
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
    ignore: (rel) => void run(() => gitIgnoreAdd(repoRoot, [rel]), (out) => out, undefined, ["status"]),
    // G7 cross-tab jumps: both of these are asked for from a row in one tab and
    // answered by another, so they switch tabs and hand over a one-shot command.
    fileHistory: (rel) => inHistory({ kind: "fileHistory", path: rel }),
    compare: (reference) =>
      inHistory({ kind: "compare", from: reference, to: headBranch?.name ?? "HEAD" }),
    // A commit's body isn't in the log read — the detail command is the only
    // place it exists, so copying it is a fetch first.
    copyMessage: (c) => {
      void gitCommitDetail(repoRoot, c.sha)
        .then((d) => actions.copy(d.body.trim() === "" ? d.subject : `${d.subject}\n\n${d.body}`, "message"))
        .catch((err) => setNotice({ kind: "err", text: String(err instanceof Error ? err.message : err) }));
    },
    revert: (commit) => setConfirm({ kind: "revert", commit }),
    cherryPick: (commit) => setConfirm({ kind: "cherryPick", commit }),
    reset: (commit, mode) =>
      setConfirm({
        kind: "reset",
        commit,
        mode,
        head: headBranch?.name ?? "HEAD",
        // Only `--hard` rewrites the working tree; the other two leave whatever a
        // live agent is editing exactly where it is.
        warnLive: mode === "hard" && liveRootInstances() > 0,
      }),
    tagAt: (commit) => setTagging({ commit }),
    deleteTag: (name) => setConfirm({ kind: "deleteTag", name }),
    checkout: requestCheckout,
    branchFrom: (startPoint) => setCreating({ startPoint }),
    rename: setRenaming,
    deleteBranch: (name) => setConfirm({ kind: "deleteBranch", name }),
    push: requestPush,
    pull: () => void runNet("pulling", () => gitPull(repoRoot), "pulled"),
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
    stashApply: (reference) =>
      void run(() => gitStashApply(repoRoot, reference), "applied (stash kept)", undefined, [
        "status",
        "stashes",
      ]),
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
      // A fetch only moves remote-tracking refs — it can't touch the working
      // tree, the stash or the tags you have.
      fetch: () => void runNet("fetching", () => gitFetch(repoRoot), "fetched", undefined, ["refs", "history"]),
      pull: () => void runNet("pulling", () => gitPull(repoRoot), "pulled"),
      push: requestPush,
      stageAll: () => {
        const dirty = paths(data?.status.filter((e) => e.worktree !== " " || e.untracked) ?? []);
        if (dirty.length === 0) setNotice({ kind: "ok", text: "nothing to stage" });
        else void run(() => gitStage(repoRoot, dirty), undefined, undefined, ["status", "state"]);
      },
      unstageAll: () => {
        const staged = paths(data?.status.filter((e) => e.index !== " " && e.index !== "?") ?? []);
        if (staged.length === 0) setNotice({ kind: "ok", text: "nothing staged" });
        else void run(() => gitUnstage(repoRoot, staged), undefined, undefined, ["status", "state"]);
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
        onFetch={() => void runNet("fetching", () => gitFetch(repoRoot), "fetched", undefined, ["refs", "history"])}
        onPull={() => void runNet("pulling", () => gitPull(repoRoot), "pulled")}
        onPush={requestPush}
        canPublish={canPublish}
        onRefresh={() => void load()}
      />

      <TabBar tab={tab} onTab={setTab} counts={data} orientation={orientation} />

      {data?.state.operation && (
        <OperationBanner
          operation={data.state.operation}
          conflicts={data.status.filter((e) => e.conflicted).length}
          busy={busy}
          onContinue={() => {
            const op = data.state.operation;
            if (op === "rebase")
              void run(() => gitRebaseControl(repoRoot, "continue"), "rebase continued", "rebase");
            else if (op === "cherry-pick" || op === "revert")
              void run(() => gitSequencerControl(repoRoot, op, "continue"), `${op} continued`, op);
          }}
          onSkip={() => {
            const op = data.state.operation;
            if (op === "cherry-pick" || op === "revert")
              setConfirm({ kind: "sequencerSkip", operation: op });
            else setConfirm({ kind: "rebaseSkip" });
          }}
          onAbort={() => {
            const op = data.state.operation;
            if (op === "rebase")
              void run(() => gitRebaseControl(repoRoot, "abort"), "rebase aborted", "rebase");
            else if (op === "cherry-pick" || op === "revert")
              setConfirm({ kind: "sequencerAbort", operation: op });
            else void run(() => gitMergeAbort(repoRoot), "merge aborted", "merge");
          }}
        />
      )}

      {netOp && <NetProgress label={netOp} onCancel={cancelNet} />}

      {notice && (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "5px 12px",
            font: "11px var(--wb-mono)",
            color: notice.kind === "ok" ? "var(--wb-done)" : "var(--wb-needs)",
            borderBottom: "1px solid var(--wb-border)",
          }}
        >
          {/* A long error scrolls in place rather than pushing the tabs off the
              panel; the whole message, and what led to it, is one click away in
              the scrollback below. */}
          <div style={{ flex: 1, minWidth: 0, maxHeight: 66, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {notice.kind === "ok" ? GLYPH.ok : GLYPH.fail} {notice.text}
          </div>
          {notice.kind === "err" && !logOpen && (
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              style={{
                flex: "0 0 auto",
                background: "none",
                border: "1px solid var(--wb-border)",
                borderRadius: 2,
                color: "var(--wb-textDim2)",
                font: "10px var(--wb-mono)",
                padding: "1px 6px",
                cursor: "pointer",
              }}
            >
              details
            </button>
          )}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="dismiss"
            style={{
              flex: "0 0 auto",
              background: "none",
              border: "none",
              color: "var(--wb-textFaint)",
              font: "11px var(--wb-mono)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            ×
          </button>
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
          <HistoryTab
            repoRoot={repoRoot}
            orientation={orientation}
            actions={actions}
            branches={data.branches}
            tags={data.tags}
            dirtyCount={data.status.length}
            onWorkingTree={() => setTab("status")}
            reloadKey={reloadKey}
            command={historyCommand}
            onCommandDone={clearHistoryCommand}
          />
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
            // The file-level ops all declare what they touched (G8): the index
            // and, because staging the last conflicted file ends a merge, the
            // in-progress state. Never the branch list, the tags or the log.
            onStage={(paths) => void run(() => gitStage(repoRoot, paths), undefined, undefined, ["status", "state"])}
            onUnstage={(paths) => void run(() => gitUnstage(repoRoot, paths), undefined, undefined, ["status", "state"])}
            onDiscard={(tracked, untracked) => setConfirm({ kind: "discard", tracked, untracked })}
            onStashPush={(msg, untracked) =>
              void run(() => gitStashPush(repoRoot, msg, untracked), "stashed", undefined, ["status", "stashes"])
            }
            onStashPop={(ref) =>
              void run(() => gitStashPop(repoRoot, ref), "popped", undefined, ["status", "stashes"])
            }
            onStashDrop={(stash) => setConfirm({ kind: "stashDrop", stash })}
            onStageHunks={(patch, n) =>
              void run(() => gitApplyPatch(repoRoot, patch, true, false), hunkNotice("staged", n), undefined, [
                "status",
              ])
            }
            onUnstageHunks={(patch, n) =>
              void run(() => gitApplyPatch(repoRoot, patch, true, true), hunkNotice("unstaged", n), undefined, [
                "status",
              ])
            }
            onDiscardHunks={(patch, count) => setConfirm({ kind: "discardHunks", patch, count })}
            onResolve={(paths, side) => setConfirm({ kind: "resolve", paths, side })}
            onMarkResolved={(paths) =>
              void run(
                () => gitStage(repoRoot, paths),
                `marked ${paths.length} ${paths.length === 1 ? "file" : "files"} resolved`,
                undefined,
                ["status", "state"],
              )
            }
            command={statusCommand}
            onCommandDone={clearStatusCommand}
          />
        )}
      </div>

      <CommandConsole
        repoRoot={repoRoot}
        open={logOpen}
        onToggle={() => setLogOpen((v) => !v)}
        tick={cmdTick}
      />

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
                }, undefined, undefined, ["status"]);
                break;
              }
              case "stashDrop":
                void run(() => gitStashDrop(repoRoot, confirm.stash.reference), undefined, undefined, [
                  "stashes",
                ]);
                break;
              case "push":
                void runNet("pushing", () => gitPush(repoRoot, confirm.force), "pushed", undefined, ["refs"]);
                break;
              case "publish":
                void runNet("publishing", () => gitPush(repoRoot, false, true), `published ${confirm.branch}`, undefined, ["refs"]);
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
                  undefined,
                  ["status"],
                );
                break;
              }
              case "resolve": {
                const { paths, side } = confirm;
                // The backend's own summary — it knows which paths it checked out
                // and which it removed, and a stale row silently dropping out of
                // the batch is exactly the thing worth reading back.
                void run(() => gitResolve(repoRoot, paths, side), (out) => out, undefined, ["status", "state"]);
                break;
              }
              case "deleteRemoteBranch": {
                const { remote, branch } = confirm;
                void runNet(
                  "deleting on remote",
                  () => gitDeleteRemoteBranch(repoRoot, remote, branch),
                  `deleted ${remote}/${branch}`,
                  `delete ${remote}/${branch}`,
                  ["refs"],
                );
                break;
              }
              case "revert": {
                const { commit } = confirm;
                // `failTitle`, like G4's: a conflicting revert has already touched
                // the tree, and which files it stopped on is the whole message.
                void run(
                  () => gitRevert(repoRoot, commit.sha),
                  `reverted ${commit.short}`,
                  `revert ${commit.short}`,
                );
                break;
              }
              case "cherryPick": {
                const { commit } = confirm;
                void run(
                  () => gitCherryPick(repoRoot, commit.sha),
                  `cherry-picked ${commit.short}`,
                  `cherry-pick ${commit.short}`,
                );
                break;
              }
              case "reset": {
                const { commit, mode } = confirm;
                void run(
                  () => gitReset(repoRoot, commit.sha, mode),
                  `reset ${mode} to ${commit.short}`,
                  `reset ${mode}`,
                );
                break;
              }
              case "deleteTag": {
                const { name } = confirm;
                void run(() => gitTagDelete(repoRoot, name), `deleted tag ${name}`, undefined, ["tags"]);
                break;
              }
              case "sequencerAbort": {
                const { operation } = confirm;
                void run(
                  () => gitSequencerControl(repoRoot, operation, "abort"),
                  `${operation} aborted`,
                  operation,
                );
                break;
              }
              case "sequencerSkip": {
                const { operation } = confirm;
                void run(
                  () => gitSequencerControl(repoRoot, operation, "skip"),
                  "commit skipped",
                  operation,
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

      {tagging && (
        <TagDialog
          commit={tagging.commit}
          busy={busy}
          onClose={() => setTagging(null)}
          onCreate={(name, message) =>
            void run(
              () => gitTagCreate(repoRoot, name, tagging.commit.sha, message),
              `tagged ${tagging.commit.short} as ${name}`,
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
    case "resolve": {
      const only = c.paths.length === 1 ? c.paths[0] : null;
      const kept = c.side === "ours" ? "this branch's" : "the incoming";
      const lost = c.side === "ours" ? "the incoming" : "this branch's";
      return {
        title: `use ${c.side}`,
        label: `${c.side === "ours" ? "◧" : "◨"} use ${c.side}`,
        danger: true,
        body: (
          <>
            Take {kept} version of{" "}
            {only ? <Ref>{only}</Ref> : <Ref>{c.paths.length} conflicted files</Ref>} whole?{" "}
            {lost.charAt(0).toUpperCase() + lost.slice(1)} version is discarded, and where that
            side deleted the file, taking it deletes the file. Once it's staged the index no
            longer holds both sides, so this isn't undoable short of aborting the merge.
          </>
        ),
      };
    }
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
    case "revert":
      return {
        title: "revert",
        label: "↶ revert",
        danger: false,
        body: (
          <>
            Add a commit that undoes <Ref>{c.commit.short}</Ref> — “{c.commit.subject}”? The
            original stays in the history; this is the undo that doesn't rewrite anything. If it
            can't apply cleanly it stops with the conflicts marked up, the same as a merge.
          </>
        ),
      };
    case "cherryPick":
      return {
        title: "cherry-pick",
        label: "⑃ cherry-pick",
        danger: false,
        body: (
          <>
            Apply <Ref>{c.commit.short}</Ref> — “{c.commit.subject}” — on top of the current
            branch as a new commit? The original is untouched, and a conflict stops it partway
            for you to resolve.
          </>
        ),
      };
    case "reset": {
      const { mode, commit, head } = c;
      // The three modes differ in exactly one way that matters — what happens to
      // work you haven't committed — so each says that, in that many words.
      const what =
        mode === "soft" ? (
          <>
            Everything that was in the index and the working tree stays exactly where it is, so
            the commits between here and there come back as staged changes.
          </>
        ) : mode === "mixed" ? (
          <>
            The index is reset too, so those changes come back as <em>unstaged</em> edits. Nothing
            on disk is touched.
          </>
        ) : (
          <>
            The index <strong>and the working tree</strong> are reset with it. Anything
            uncommitted — staged or not — is gone, and it isn't in the history for you to get
            back.
          </>
        );
      return {
        title: `reset ${mode}`,
        label: `↺ reset ${mode}`,
        danger: mode === "hard",
        body: (
          <>
            Move <Ref>{head}</Ref> to <Ref>{commit.short}</Ref> — “{commit.subject}”? {what}
            {c.warnLive && <LiveWarning />}
          </>
        ),
      };
    }
    case "deleteTag":
      return {
        title: "delete tag",
        label: `${GLYPH.fail} delete`,
        danger: true,
        body: (
          <>
            Delete the tag <Ref>{c.name}</Ref>? Only locally — if it's been pushed, the remote
            keeps its copy and a fetch will bring it back.
          </>
        ),
      };
    case "sequencerAbort":
      return {
        title: `abort ${c.operation}`,
        label: "⨯ abort",
        danger: true,
        body: (
          <>
            Stop the {c.operation} and put the branch back where it started? Anything it has
            applied so far is undone.
          </>
        ),
      };
    case "sequencerSkip":
      return {
        title: "skip this commit",
        label: `${GLYPH.warn} skip`,
        danger: true,
        body: (
          <>
            Drop the commit the {c.operation} stopped on and carry on with the rest? Its changes
            won't be applied at all.
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
 * A network op is in flight (G8) — the strip that makes "waiting" visible and,
 * more to the point, escapable.
 *
 * Disabled buttons were the panel's only sign that a fetch or push was running,
 * which conveys that something is happening but not *what*, and offers no way
 * out of a push to a remote that will never answer. Cancel kills the git process
 * itself (the backend registered it against this repo), so the wait ends in a
 * reported failure rather than a panel that stays greyed out until it's closed.
 */
function NetProgress({ label, onCancel }: { label: string; onCancel: () => void }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
        font: "11px var(--wb-mono)",
        color: "var(--wb-working)",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
      }}
    >
      <Spinner size={11} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {GLYPH.remote} {label}…
      </span>
      <button
        type="button"
        onClick={onCancel}
        style={{
          flex: "0 0 auto",
          background: "none",
          border: "1px solid var(--wb-border)",
          borderRadius: 2,
          color: "var(--wb-textDim2)",
          font: "10px var(--wb-mono)",
          padding: "1px 8px",
          cursor: "pointer",
        }}
      >
        cancel
      </button>
    </div>
  );
}

/**
 * The scrollback of git commands this panel ran (G8).
 *
 * The panel used to report failures as one line of stderr on a banner, which is
 * fine for "branch already exists" and useless for the multi-line messages git
 * reserves for the situations you most need to read: a rejected push naming the
 * ref and the fix, an apply that says which line of the patch didn't fit. And
 * the *sequence* matters too — an error is often explained by the command
 * before it, which the panel simply never showed.
 *
 * So: a permanent footer showing the last command, expanding to the recent ones
 * with their output. It's deliberately a console, not a log viewer — the point
 * is to see that this panel is a thing that runs `git` commands, and which.
 */
function CommandConsole({
  repoRoot,
  open,
  onToggle,
  tick,
}: {
  repoRoot: string;
  open: boolean;
  onToggle: () => void;
  /** Bumped when a command has probably run, so this re-reads without polling. */
  tick: number;
}) {
  const [entries, setEntries] = useState<GitCommandRecord[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void gitCommandLog(repoRoot)
      .then((e) => {
        if (live) setEntries(e);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repoRoot, tick]);

  // Newest at the bottom, like every other console: follow it.
  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, entries]);

  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  const failed = entries.filter((e) => !e.ok).length;

  return (
    <div style={{ flex: "0 0 auto", borderTop: "1px solid var(--wb-border)", background: "var(--wb-panel)" }}>
      {open && (
        <div
          ref={scrollRef}
          style={{ maxHeight: 168, overflowY: "auto", padding: "4px 0", borderBottom: "1px solid var(--wb-border)" }}
        >
          {entries.length === 0 ? (
            <div style={{ padding: "3px 12px", font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
              nothing run yet
            </div>
          ) : (
            entries.map((e) => (
              <div key={e.id} style={{ padding: "2px 12px", font: "10.5px var(--wb-mono)" }}>
                <div style={{ display: "flex", gap: 6, color: e.ok ? "var(--wb-textDim2)" : "var(--wb-needs)" }}>
                  <span style={{ flex: "0 0 auto" }}>{e.ok ? GLYPH.ok : GLYPH.fail}</span>
                  <span style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>{e.argv}</span>
                  <span style={{ flex: "0 0 auto", color: "var(--wb-textFaint)" }}>{formatMs(e.ms)}</span>
                </div>
                {e.output !== "" && (
                  <div
                    style={{
                      margin: "1px 0 2px 16px",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      color: e.ok ? "var(--wb-textFaint)" : "var(--wb-needs)",
                    }}
                  >
                    {e.output}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        title={open ? "hide the git command log" : "show the git command log"}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "none",
          border: "none",
          padding: "3px 12px",
          font: "10.5px var(--wb-mono)",
          color: "var(--wb-textFaint)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ flex: "0 0 auto" }}>{open ? "▾" : "▸"}</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: last && !last.ok ? "var(--wb-needs)" : "var(--wb-textFaint)",
          }}
        >
          {last ? `${last.ok ? GLYPH.ok : GLYPH.fail} ${last.argv}` : "git"}
        </span>
        {failed > 0 && !open && (
          <span style={{ flex: "0 0 auto", color: "var(--wb-needs)" }}>
            {failed} failed
          </span>
        )}
      </button>
    </div>
  );
}

/** Durations as a console shows them: milliseconds until they stop being small. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The repo is mid-merge / mid-rebase / mid-cherry-pick / mid-revert (G4). Until
 * now the panel gave no sign of this at all: a conflicted merge just looked like
 * a working tree with odd files in it, and the way out was to leave for a shell.
 *
 * Rebase gets the full set of controls, since a stopped rebase is *only*
 * escapable through them. A merge gets abort — its "continue" is an ordinary
 * commit, which the commit box below already is.
 *
 * G6 gave it the conflict count, which turns it from a label into an instruction:
 * *how many files are still unmerged* is the difference between "go resolve them"
 * and "you're done, commit" — and once it reaches zero the banner says so instead
 * of leaving you to work out that the next step changed.
 *
 * G7 gave cherry-pick and revert their buttons. Until now the banner could name
 * them and nothing else: they could only have been started from outside the
 * panel, and there was no command here to finish or undo one. Now the panel
 * starts them, and `git_sequencer_control` is the rebase controls' counterpart —
 * so they get the same three, and the "started elsewhere" wording is left for
 * whatever genuinely was.
 */
function OperationBanner({
  operation,
  conflicts,
  busy,
  onContinue,
  onSkip,
  onAbort,
}: {
  operation: string;
  /** Files still unmerged (G6) — 0 means the operation is ready to finish. */
  conflicts: number;
  busy: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}) {
  const rebase = operation === "rebase";
  const merge = operation === "merge";
  // Cherry-pick and revert are sequencer operations: same three controls as a
  // rebase, driven by `git_sequencer_control` instead (G7).
  const sequencer = operation === "cherry-pick" || operation === "revert";
  const left =
    conflicts === 0
      ? null
      : `${conflicts} ${conflicts === 1 ? "file is" : "files are"} still conflicted`;
  const what = merge
    ? left
      ? `merge stopped — ${left}; resolve and stage them, then commit`
      : "merge stopped — nothing is conflicted any more, so commit to finish it"
    : rebase || sequencer
      ? left
        ? `${operation} stopped — ${left}; resolve and stage them, then continue`
        : `${operation} stopped — nothing is conflicted any more, so continue`
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
        {(rebase || sequencer) && (
          <>
            <HeaderButton onClick={onContinue} disabled={busy} accent title={`git ${operation} --continue`}>
              ▸ continue
            </HeaderButton>
            <HeaderButton onClick={onSkip} disabled={busy} title="drop the stopped commit and carry on">
              ↷ skip
            </HeaderButton>
          </>
        )}
        {(rebase || merge || sequencer) && (
          <HeaderButton
            onClick={onAbort}
            disabled={busy}
            danger
            title={merge ? "restore the pre-merge state" : `put the branch back where the ${operation} started`}
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
 * Name a tag for a commit (G7). Not a confirm: nothing is destroyed or moved, and
 * the choice that matters — lightweight ref or annotated object — is made by
 * whether you write a message, which is the same rule `git tag` itself uses.
 */
function TagDialog({
  commit,
  busy,
  onClose,
  onCreate,
}: {
  commit: Commit;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, message: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const trimmed = name.trim();
  const note = message.trim();
  const create = () => onCreate(trimmed, note === "" ? null : note);
  return (
    <Modal title="tag" onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
          on <span style={{ color: "var(--wb-accent)" }}>{commit.short}</span> — {commit.subject}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !busy) create();
          }}
          placeholder="tag name (v1.2.0)"
          autoFocus
          spellCheck={false}
          style={inputStyle}
        />
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !busy) create();
          }}
          placeholder="message (optional)"
          spellCheck={false}
          style={inputStyle}
        />
        <div style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
          {note === ""
            ? "no message — a lightweight tag, which is just a name pointing at the commit"
            : "with a message it's an annotated tag: its own object, carrying you and the date"}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={create}
          disabled={busy || !trimmed}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : "⌂ tag"}
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
