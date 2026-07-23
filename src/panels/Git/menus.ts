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
// Several items are present but disabled. That's the shape this step was asked to
// land in: the menu is the discoverable surface for what the panel *will* do, and
// an item that names itself and says why it can't run yet is more useful than one
// that appears out of nowhere three steps later. Each carries its reason in
// `title` — there are no silent dead rows.

import type { MenuEntry } from "../../components/ContextMenu";
import type { Branch, Commit, Stash } from "../../ipc/git";

/** Hover text for an item whose backend hasn't landed. Names what's missing in
 *  plain words: the tooltip is product text, not a reference to the plan. */
const soon = (what: string) => `${what} isn't wired up yet — it lands in a later Git step`;

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
  /** The clicked row is a deletion — there's no file on disk to open or reveal. */
  deleted: boolean;
  /** The clicked row is untracked, so ignoring it would actually take effect. */
  isUntracked: boolean;
  /** The clicked row is a conflict (`U` on either side). */
  conflicted: boolean;
}

export interface FileActions {
  busy: boolean;
  stage: (paths: string[]) => void;
  unstage: (paths: string[]) => void;
  discard: (tracked: string[], untracked: string[]) => void;
  copy: (text: string, what: string) => void;
  /** Repo-relative → absolute, forward-slashed. */
  abs: (rel: string) => string;
  openInEditor: (rel: string) => void;
  reveal: (rel: string) => void;
  ignore: (rel: string) => void;
}

export function fileRowMenu(t: FileTarget, a: FileActions): MenuEntry[] {
  const cut = t.path.lastIndexOf("/");
  const folder = cut > 0 ? t.path.slice(0, cut) : null;
  const n = many(t.paths.length);
  const gone = t.deleted ? "the file was deleted — there's nothing on disk to open" : undefined;

  return [
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
      onClick: () => a.discard(t.tracked, t.untracked),
      disabled: a.busy,
      title: "revert tracked files to HEAD, delete untracked ones — asks first",
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
      onClick: () => undefined,
      disabled: true,
      title: soon("history for a single file"),
    },
    // Only on a conflict: on every other row it would be a permanent dead item
    // for a state the file isn't in.
    ...(t.conflicted
      ? [
          {
            label: "✓ mark resolved",
            onClick: () => undefined,
            disabled: true,
            title: soon("conflict resolution"),
          } satisfies MenuEntry,
        ]
      : []),
  ];
}

// --- a commit's changed-file row --------------------------------------------

/** The history tab's file rows are read-only — there's nothing to stage in a
 *  commit that already happened — so they get the navigation half of the menu. */
export function commitFileRowMenu(
  path: string,
  a: Pick<FileActions, "copy" | "abs" | "openInEditor" | "reveal">,
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
      onClick: () => undefined,
      disabled: true,
      title: soon("history for a single file"),
    },
  ];
}

// --- commit row -------------------------------------------------------------

export interface CommitActions {
  busy: boolean;
  copy: (text: string, what: string) => void;
  /** Detached checkout of a SHA — routed through the panel's confirm. */
  checkout: (reference: string) => void;
  /** Open the new-branch dialog with this commit as the start point. */
  branchFrom: (startPoint: string) => void;
}

export function commitRowMenu(c: Commit, a: CommitActions): MenuEntry[] {
  return [
    { label: "⎘ copy sha", hint: c.short, onClick: () => a.copy(c.sha, "sha") },
    { label: "⎘ copy subject", onClick: () => a.copy(c.subject, "subject") },
    {
      label: "⎘ copy full message",
      onClick: () => undefined,
      disabled: true,
      title: soon("reading a commit's full body"),
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
    { label: "⌂ tag here", onClick: () => undefined, disabled: true, title: soon("tagging") },
    SEP,
    { label: "↶ revert", onClick: () => undefined, disabled: true, title: soon("revert") },
    { label: "⑃ cherry-pick", onClick: () => undefined, disabled: true, title: soon("cherry-pick") },
    {
      label: "↺ reset — soft / mixed / hard",
      onClick: () => undefined,
      disabled: true,
      title: soon("moving the branch tip with reset"),
    },
    SEP,
    {
      label: "± compare with working tree",
      onClick: () => undefined,
      disabled: true,
      title: soon("comparing a commit against the working tree"),
    },
    {
      label: "± compare with selected commit",
      onClick: () => undefined,
      disabled: true,
      title: soon("comparing two commits"),
    },
  ];
}

// --- branch rows ------------------------------------------------------------

export interface BranchActions {
  busy: boolean;
  copy: (text: string, what: string) => void;
  checkout: (reference: string) => void;
  branchFrom: (startPoint: string) => void;
  rename: (branch: Branch) => void;
  deleteBranch: (name: string) => void;
  /** Repo-level push/pull — they act on HEAD, so they're only offered on it. */
  push: () => void;
  pull: () => void;
}

export function localBranchMenu(b: Branch, a: BranchActions): MenuEntry[] {
  // push/pull here are the header's repo-level commands: git pushes the *current*
  // branch. Offering them on a branch that isn't checked out would quietly act on
  // a different one, so they're disabled there and say so.
  const notHead = "only the checked-out branch can be pushed or pulled from here";
  return [
    {
      label: "⇄ checkout",
      onClick: () => a.checkout(b.name),
      disabled: a.busy || b.isHead,
      title: b.isHead ? "already checked out" : "switch HEAD to this branch — asks first",
    },
    {
      label: "⎇ merge into current",
      onClick: () => undefined,
      disabled: true,
      title: soon("merging from the panel"),
    },
    {
      label: "↳ rebase current onto",
      onClick: () => undefined,
      disabled: true,
      title: soon("rebasing from the panel"),
    },
    {
      label: "⇉ fast-forward",
      onClick: () => undefined,
      disabled: true,
      title: soon("fast-forwarding a branch"),
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
      onClick: () => undefined,
      disabled: true,
      title: soon("choosing a branch's upstream"),
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
      disabled: a.busy || b.isHead,
      title: b.isHead ? "can't delete the branch you're on" : "force-delete this branch — asks first",
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
      onClick: () => undefined,
      disabled: true,
      title: soon("comparing two branches"),
    },
    { label: "⎘ copy name", onClick: () => a.copy(b.name, "branch name") },
  ];
}

export function remoteBranchMenu(name: string, a: BranchActions): MenuEntry[] {
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
      onClick: () => undefined,
      disabled: true,
      title: soon("merging from the panel"),
    },
    {
      label: "✗ delete on remote",
      onClick: () => undefined,
      disabled: true,
      danger: true,
      title: soon("deleting a remote branch"),
    },
    SEP,
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
