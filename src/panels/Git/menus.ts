// What's *in* each right-click menu (G3) — one builder per row type, kept out of
// `index.tsx` because the panel file is long enough already and because these are
// plain data: a target plus a bag of callbacks in, a `MenuEntry[]` out. Nothing
// here renders or holds state, so the contents of a menu can be read in one place
// rather than reconstructed from JSX.
//
// A deliberate share with the hover actions: every item routes through the same
// callbacks the row's own glyph buttons use, so the confirm path for a destructive
// action is the one that already exists (`Confirm` in `index.tsx`) rather than a
// second, quieter one that skips it.
//
// G3 landed several items present but disabled, each carrying in `title` the
// reason its backend hadn't arrived yet. **G7 was the last of those steps** — the
// commit menu's revert / cherry-pick / reset / tag / compare, the file menu's
// history, and the branch menu's compare are all live now, and no item in this
// file is a placeholder any more. An item that can't run says why in terms of
// *this repo's state* (detached HEAD, nothing selected), never in terms of a step.

import type { MenuEntry } from "../../components/ContextMenu";
import type { Branch, Commit, MergeMode, Stash } from "../../ipc/git";

const SEP: MenuEntry = { kind: "separator" };

/** `n` files, or nothing when a menu is acting on the single row you clicked. */
const many = (n: number): string | undefined => (n > 1 ? `${n} files` : undefined);

// --- working-tree file row --------------------------------------------------

/**
 * What a working-tree menu acts on. `paths` is the *resolved* target: right-
 * clicking a row inside the selection acts on the whole selection, right-clicking
 * outside it acts on that row alone (the panel does that resolution before
 * calling in). The single-file items — open, copy, reveal, ignore — always mean
 * the row actually clicked.
 */
export interface FileTarget {
  /** The clicked row's repo-relative path. */
  path: string;
  /** Everything the bulk items act on (≥1, includes `path`). */
  paths: string[];
  /** Of `paths`, those with staged changes — all `unstage` can touch. */
  staged: string[];
  /** Discard splits: tracked revert to HEAD, untracked get deleted. */
  tracked: string[];
  untracked: string[];
  /** Of `paths`, those that are unmerged (G6) — all the resolve items can touch. */
  conflicted: string[];
  /** The clicked row is a deletion — there's no file on disk to open or reveal. */
  deleted: boolean;
  /** The clicked row is untracked, so ignoring it would actually take effect. */
  isUntracked: boolean;
  /** The clicked row is unmerged (G6) — the resolve items lead the menu. */
  isConflicted: boolean;
}

export interface FileActions {
  busy: boolean;
  stage: (paths: string[]) => void;
  unstage: (paths: string[]) => void;
  discard: (tracked: string[], untracked: string[]) => void;
  /** Take one whole side of the merge (G6) — confirmed by the panel. */
  resolve: (paths: string[], side: "ours" | "theirs") => void;
  /** Accept the file as it stands on disk (G6) — `git add` on an unmerged path. */
  markResolved: (paths: string[]) => void;
  copy: (text: string, what: string) => void;
  /** Repo-relative → absolute, forward-slashed. */
  abs: (rel: string) => string;
  openInEditor: (rel: string) => void;
  reveal: (rel: string) => void;
  ignore: (rel: string) => void;
  /** Show this one file's history in the History tab (G7). */
  fileHistory: (rel: string) => void;
}

export function fileRowMenu(t: FileTarget, a: FileActions): MenuEntry[] {
  const cut = t.path.lastIndexOf("/");
  const folder = cut > 0 ? t.path.slice(0, cut) : null;
  const n = many(t.paths.length);
  const gone = t.deleted ? "the file was deleted — there's nothing on disk to open" : undefined;
  const stuck = many(t.conflicted.length);

  return [
    // The resolve block leads on a conflict and is absent everywhere else: these
    // items only mean anything against a file with three stages in the index, and
    // a permanently disabled trio on every ordinary row would be noise.
    ...(t.isConflicted
      ? [
          {
            label: "◧ use ours",
            hint: stuck,
            onClick: () => a.resolve(t.conflicted, "ours"),
            disabled: a.busy,
            title: "take this branch's version whole — asks first",
          } satisfies MenuEntry,
          {
            label: "◨ use theirs",
            hint: stuck,
            onClick: () => a.resolve(t.conflicted, "theirs"),
            disabled: a.busy,
            title: "take the incoming version whole — asks first",
          } satisfies MenuEntry,
          {
            label: "✓ mark resolved",
            hint: stuck,
            onClick: () => a.markResolved(t.conflicted),
            disabled: a.busy,
            title: "accept the file as it stands on disk and clear the conflict",
          } satisfies MenuEntry,
          SEP,
        ]
      : []),
    {
      // Offered even on a staged row: a file can be staged *and* modified again
      // since, and `git add` on it stages the newer contents. Disabling it there
      // would refuse the one case where it's the thing you wanted.
      label: "+ stage",
      hint: n,
      onClick: () => a.stage(t.paths),
      disabled: a.busy,
      title: "git add — stages what's in the working tree now",
    },
    {
      label: "− unstage",
      hint: many(t.staged.length),
      onClick: () => a.unstage(t.staged),
      disabled: a.busy || t.staged.length === 0,
      title: t.staged.length === 0 ? "nothing staged in the selection" : "git restore --staged",
    },
    {
      label: t.tracked.length === 0 ? "⨯ delete untracked" : "⨯ discard changes",
      hint: n,
      danger: true,
      // The conflicted paths are held out rather than passed and rejected: `git
      // restore` refuses an unmerged path outright ("path 'x' is unmerged"), and
      // one conflict in a wide selection would take the whole discard down with it.
      onClick: () =>
        a.discard(
          t.tracked.filter((p) => !t.conflicted.includes(p)),
          t.untracked,
        ),
      disabled: a.busy || t.tracked.length + t.untracked.length === t.conflicted.length,
      title:
        t.conflicted.length > 0
          ? "a conflicted file can't be discarded — resolve it, or abort the merge from the banner"
          : "revert tracked files to HEAD, delete untracked ones — asks first",
    },
    SEP,
    {
      label: "+ stage this folder",
      hint: folder ?? undefined,
      onClick: () => folder && a.stage([folder]),
      disabled: a.busy || !folder,
      title: folder
        ? `git add ${folder}`
        : "this file is at the repo root — staging its folder would stage everything",
    },
    SEP,
    { label: "⎘ copy path", onClick: () => a.copy(t.path, "path") },
    { label: "⎘ copy absolute path", onClick: () => a.copy(a.abs(t.path), "absolute path") },
    SEP,
    {
      label: "✎ open in editor",
      onClick: () => a.openInEditor(t.path),
      disabled: t.deleted,
      title: gone ?? "open this file in the project's Editor panel",
    },
    {
      label: "⇱ reveal in file manager",
      onClick: () => a.reveal(t.path),
      disabled: t.deleted,
      title: gone ?? "show the file in Explorer",
    },
    {
      label: "⊘ add to .gitignore",
      onClick: () => a.ignore(t.path),
      disabled: a.busy || !t.isUntracked,
      title: t.isUntracked
        ? "append this path to the repo's .gitignore"
        : "already tracked — ignoring it has no effect until it's removed from the index",
    },
    SEP,
    {
      label: "≡ file history",
      onClick: () => a.fileHistory(t.path),
      title: "every commit that touched this file, followed through renames",
    },
  ];
}

// --- a commit's changed-file row --------------------------------------------

/** The history tab's file rows are read-only — there's nothing to stage in a
 *  commit that already happened — so they get the navigation half of the menu. */
export function commitFileRowMenu(
  path: string,
  a: Pick<FileActions, "copy" | "abs" | "openInEditor" | "reveal" | "fileHistory">,
): MenuEntry[] {
  return [
    { label: "⎘ copy path", onClick: () => a.copy(path, "path") },
    { label: "⎘ copy absolute path", onClick: () => a.copy(a.abs(path), "absolute path") },
    SEP,
    {
      label: "✎ open in editor",
      onClick: () => a.openInEditor(path),
      title: "open the *current* file — this is the version on disk, not the one in the commit",
    },
    { label: "⇱ reveal in file manager", onClick: () => a.reveal(path) },
    SEP,
    {
      label: "≡ file history",
      onClick: () => a.fileHistory(path),
      title: "every commit that touched this file, followed through renames",
    },
  ];
}

// --- commit row -------------------------------------------------------------

export interface CommitActions {
  busy: boolean;
  /** The checked-out branch, or null when HEAD is detached. Revert, cherry-pick
   *  and reset all move *it*, so each names it and refuses without one. */
  head: string | null;
  copy: (text: string, what: string) => void;
  /** Detached checkout of a SHA — routed through the panel's confirm. */
  checkout: (reference: string) => void;
  /** Open the new-branch dialog with this commit as the start point. */
  branchFrom: (startPoint: string) => void;
  /** Read the commit's whole message and copy it (G7) — the log row only holds
   *  the subject, so this is a fetch rather than a clipboard write. */
  copyMessage: (c: Commit) => void;
  /** The three rewrite ops (G7). Each opens its own confirm in the shell. */
  revert: (c: Commit) => void;
  cherryPick: (c: Commit) => void;
  reset: (c: Commit, mode: "soft" | "mixed" | "hard") => void;
  /** Open the tag dialog with this commit as the target (G7). */
  tagAt: (c: Commit) => void;
  /** Comparison (G7), owned by the History tab rather than the shell — it changes
   *  what the tab is *showing*, not what the repo holds. */
  compareWorkingTree: (c: Commit) => void;
  compareWith: (c: Commit) => void;
  /** The commit a "compare with selected" would measure against, or null when the
   *  clicked row *is* the selection and there's nothing to compare it to. */
  compareBase: Commit | null;
}

/**
 * A commit's menu. The plan lists reset's three modes as one item; they're three
 * here because `ContextMenu` has no submenus and the modes aren't variations on a
 * theme — `--soft` keeps your work and `--hard` destroys it, and a menu that
 * makes you pick that in a second dialog hides the difference at the moment it
 * matters most.
 */
export function commitRowMenu(c: Commit, a: CommitActions): MenuEntry[] {
  const head = a.head;
  const detached = head == null;
  const onHead = detached ? "HEAD is detached — check out a branch first" : undefined;
  return [
    { label: "⎘ copy sha", hint: c.short, onClick: () => a.copy(c.sha, "sha") },
    { label: "⎘ copy subject", onClick: () => a.copy(c.subject, "subject") },
    {
      label: "⎘ copy full message",
      onClick: () => a.copyMessage(c),
      title: "read this commit's whole message and copy it",
    },
    SEP,
    {
      label: "⇄ checkout (detached)",
      onClick: () => a.checkout(c.sha),
      disabled: a.busy,
      title: "move HEAD to this commit — detached, asks first",
    },
    {
      label: "⎇ branch from here",
      onClick: () => a.branchFrom(c.sha),
      disabled: a.busy,
      title: "create a branch starting at this commit",
    },
    {
      label: "⌂ tag here",
      onClick: () => a.tagAt(c),
      disabled: a.busy,
      title: "put a tag on this commit — lightweight, or annotated with a message",
    },
    SEP,
    {
      label: "↶ revert",
      onClick: () => a.revert(c),
      disabled: a.busy || detached,
      title: onHead ?? "commit this commit's inverse — the undo that keeps the history",
    },
    {
      label: "⑃ cherry-pick",
      onClick: () => a.cherryPick(c),
      disabled: a.busy || detached,
      title: onHead ?? `apply this commit on top of ${head}`,
    },
    SEP,
    {
      label: "↺ reset soft — keep everything",
      onClick: () => a.reset(c, "soft"),
      disabled: a.busy || detached,
      title: onHead ?? `move ${head} here; the index and working tree are untouched`,
    },
    {
      label: "↺ reset mixed — unstage",
      onClick: () => a.reset(c, "mixed"),
      disabled: a.busy || detached,
      title: onHead ?? `move ${head} here and reset the index; your edits stay on disk`,
    },
    {
      label: "↺ reset hard — discard",
      danger: true,
      onClick: () => a.reset(c, "hard"),
      disabled: a.busy || detached,
      title: onHead ?? `move ${head} here and throw away everything uncommitted`,
    },
    SEP,
    {
      label: "± compare with working tree",
      onClick: () => a.compareWorkingTree(c),
      title: "everything that changed between this commit and what's on disk now",
    },
    {
      label: "± compare with selected commit",
      hint: a.compareBase?.short,
      onClick: () => a.compareWith(c),
      disabled: a.compareBase == null,
      title:
        a.compareBase == null
          ? "select another commit first — this one is the selection"
          : `diff ${a.compareBase.short} → ${c.short}`,
    },
  ];
}

/** Everything the History tab hands its menus (G7). `head` and `busy` come from
 *  `BranchActions`, which the shell already builds. */
export interface HistoryActions
  extends CommitActions,
    Pick<FileActions, "copy" | "abs" | "openInEditor" | "reveal" | "fileHistory"> {
  deleteTag: (name: string) => void;
}

/**
 * The half of `HistoryActions` the panel *shell* supplies. Comparison is the
 * exception: it changes what the History tab is showing rather than what the repo
 * holds, so the tab fills those three in itself — including `compareBase`, which
 * is its own selection and something the shell can't see.
 */
export type ShellHistoryActions = Omit<
  HistoryActions,
  "compareBase" | "compareWorkingTree" | "compareWith"
>;

/** A tag chip in the commit-detail pane (G7). Small on purpose: creating one is a
 *  commit action, and this is the only place the tag you're looking at *is* the
 *  subject. */
export function tagMenu(name: string, a: Pick<HistoryActions, "busy" | "copy" | "deleteTag">): MenuEntry[] {
  return [
    { label: "⎘ copy tag name", onClick: () => a.copy(name, "tag name") },
    {
      label: "✗ delete tag",
      danger: true,
      onClick: () => a.deleteTag(name),
      disabled: a.busy,
      title: "delete it locally — asks first; the remote's copy, if any, stays",
    },
  ];
}

// --- branch rows ------------------------------------------------------------

export interface BranchActions {
  busy: boolean;
  /** The checked-out branch, or null when HEAD is detached. Merge, rebase and
   *  fast-forward all act *on* it, so they name it and refuse without one. */
  head: string | null;
  copy: (text: string, what: string) => void;
  checkout: (reference: string) => void;
  branchFrom: (startPoint: string) => void;
  rename: (branch: Branch) => void;
  deleteBranch: (name: string) => void;
  /** Repo-level push/pull — they act on HEAD, so they're only offered on it. */
  push: () => void;
  pull: () => void;
  /** Opens the merge dialog with this ref and a starting mode (G4). */
  merge: (reference: string, mode: MergeMode) => void;
  rebase: (onto: string) => void;
  setUpstream: (branch: Branch) => void;
  /** `origin/topic` — split into remote + branch by the panel. */
  deleteRemote: (remoteBranch: string) => void;
  /** Show the diff from this ref to the current branch in the History tab (G7). */
  compare: (reference: string) => void;
}

/** Why merge / rebase / fast-forward can't run against this row, or null when
 *  they can. All three move the *current* branch onto or over another ref, so
 *  they need one — and pointing them at the branch you're already on is a no-op
 *  git would reject anyway. */
function noIntegration(b: Branch | null, head: string | null): string | null {
  if (!head) return "HEAD is detached — check out a branch first";
  if (b?.isHead) return `${b.name} is the current branch`;
  return null;
}

export function localBranchMenu(b: Branch, a: BranchActions): MenuEntry[] {
  // push/pull here are the header's repo-level commands: git pushes the *current*
  // branch. Offering them on a branch that isn't checked out would quietly act on
  // a different one, so they're disabled there and say so.
  const notHead = "only the checked-out branch can be pushed or pulled from here";
  // Git refuses to check out — or delete — a branch another worktree holds. The
  // row says so up front rather than letting the click come back with a raw error.
  const held = b.worktree ? `checked out in another worktree: ${b.worktree}` : null;
  const blocked = noIntegration(b, a.head);
  const into = a.head ? ` into ${a.head}` : "";
  return [
    {
      label: "⇄ checkout",
      onClick: () => a.checkout(b.name),
      disabled: a.busy || b.isHead || held != null,
      title: b.isHead ? "already checked out" : held ?? "switch HEAD to this branch — asks first",
    },
    {
      label: "⎇ merge into current",
      hint: a.head ?? undefined,
      onClick: () => a.merge(b.name, "merge"),
      disabled: a.busy || blocked != null,
      title: blocked ?? `merge ${b.name}${into} — asks first, and offers no-ff / squash`,
    },
    {
      label: "↳ rebase current onto",
      hint: a.head ?? undefined,
      onClick: () => a.rebase(b.name),
      disabled: a.busy || blocked != null,
      title: blocked ?? `replay ${a.head ?? "the current branch"}'s commits on top of ${b.name} — asks first`,
    },
    {
      label: "⇉ fast-forward current to here",
      onClick: () => a.merge(b.name, "ffOnly"),
      disabled: a.busy || blocked != null,
      title: blocked ?? `advance ${a.head ?? "the current branch"} to ${b.name}, or refuse if that isn't a fast-forward`,
    },
    SEP,
    {
      label: b.upstream ? "⇡ push" : "⇡ publish",
      hint: b.ahead > 0 ? `↑${b.ahead}` : undefined,
      onClick: a.push,
      disabled: a.busy || !b.isHead,
      title: b.isHead ? (b.upstream ? "push to the upstream" : "push -u and set an upstream") : notHead,
    },
    {
      label: "⇣ pull",
      hint: b.behind > 0 ? `↓${b.behind}` : undefined,
      onClick: a.pull,
      disabled: a.busy || !b.isHead,
      title: b.isHead ? "pull the current branch" : notHead,
    },
    {
      label: "→ set upstream",
      hint: b.upstream ?? undefined,
      onClick: () => a.setUpstream(b),
      disabled: a.busy,
      title: "choose which remote branch this one tracks — config only, nothing is pushed",
    },
    SEP,
    {
      label: "✎ rename",
      onClick: () => a.rename(b),
      disabled: a.busy,
      title: "git branch -m",
    },
    {
      label: "✗ delete",
      danger: true,
      onClick: () => a.deleteBranch(b.name),
      disabled: a.busy || b.isHead || held != null,
      title: b.isHead
        ? "can't delete the branch you're on"
        : held ?? "force-delete this branch — asks first",
    },
    {
      label: "⎇ create branch from",
      onClick: () => a.branchFrom(b.name),
      disabled: a.busy,
      title: "start a new branch at this branch's tip",
    },
    SEP,
    {
      label: "± compare against current",
      hint: a.head ?? undefined,
      onClick: () => a.compare(b.name),
      disabled: blocked != null,
      title: blocked ?? `everything that differs between ${b.name} and ${a.head}`,
    },
    { label: "⎘ copy name", onClick: () => a.copy(b.name, "branch name") },
  ];
}

export function remoteBranchMenu(name: string, a: BranchActions): MenuEntry[] {
  const blocked = noIntegration(null, a.head);
  return [
    {
      label: "⇄ checkout",
      onClick: () => a.checkout(name),
      disabled: a.busy,
      title: "check out this remote branch (tracking, or detached) — asks first",
    },
    {
      label: "⎇ create branch from",
      onClick: () => a.branchFrom(name),
      disabled: a.busy,
      title: "start a local branch at this remote's tip",
    },
    SEP,
    {
      label: "⎇ merge into current",
      hint: a.head ?? undefined,
      onClick: () => a.merge(name, "merge"),
      disabled: a.busy || blocked != null,
      title: blocked ?? `merge ${name} into ${a.head} — asks first, and offers no-ff / squash`,
    },
    {
      label: "⇉ fast-forward current to here",
      onClick: () => a.merge(name, "ffOnly"),
      disabled: a.busy || blocked != null,
      title:
        blocked ??
        `advance ${a.head} to ${name} — the fetch-then-catch-up move, without a merge commit`,
    },
    {
      label: "↳ rebase current onto",
      hint: a.head ?? undefined,
      onClick: () => a.rebase(name),
      disabled: a.busy || blocked != null,
      title: blocked ?? `replay ${a.head}'s commits on top of ${name} — asks first`,
    },
    {
      label: "✗ delete on remote",
      onClick: () => a.deleteRemote(name),
      disabled: a.busy,
      danger: true,
      title: "delete this branch on the remote — asks first, and can't be undone from here",
    },
    SEP,
    {
      label: "± compare against current",
      hint: a.head ?? undefined,
      onClick: () => a.compare(name),
      disabled: blocked != null,
      title: blocked ?? `everything that differs between ${name} and ${a.head}`,
    },
    { label: "⎘ copy name", onClick: () => a.copy(name, "branch name") },
  ];
}

// --- stash row --------------------------------------------------------------

export interface StashActions {
  busy: boolean;
  pop: (reference: string) => void;
  apply: (reference: string) => void;
  show: (stash: Stash) => void;
  branch: (stash: Stash) => void;
  drop: (stash: Stash) => void;
  copy: (text: string, what: string) => void;
}

export function stashRowMenu(s: Stash, a: StashActions): MenuEntry[] {
  return [
    {
      label: "⇣ pop",
      onClick: () => a.pop(s.reference),
      disabled: a.busy,
      title: "apply these changes and remove the stash",
    },
    {
      label: "⇘ apply (keep)",
      onClick: () => a.apply(s.reference),
      disabled: a.busy,
      title: "apply these changes but leave the stash in the list",
    },
    {
      label: "± show diff",
      onClick: () => a.show(s),
      disabled: a.busy,
      title: "read what this stash holds before deciding",
    },
    {
      label: "⎇ branch from stash",
      onClick: () => a.branch(s),
      disabled: a.busy,
      title: "check out a new branch where the stash was made and apply it there",
    },
    SEP,
    { label: "⎘ copy message", onClick: () => a.copy(s.message, "stash message") },
    {
      label: "✗ drop",
      danger: true,
      onClick: () => a.drop(s),
      disabled: a.busy,
      title: "discard the stash without applying it — asks first",
    },
  ];
}
