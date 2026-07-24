# Git Panel — Improvement Plan

A standalone, step-by-step plan for bringing the Git panel (`src/panels/Git/`) from its
Step 3.11 state to something **comparable to a standalone git client** for everyday work:
commits, branches, history, working-tree management — usable on a **narrow/vertical
window**, with real selection flexibility and right-click context actions.

Companion to `claude-code-workbench-design.md` (§5 *Git*, §7) and
`claude-code-workbench-development-plan.md` (Step 3.11). Same working rules apply: **one
step per session**, respect **Depends on**, honor the Definition of Done.

> **This plan supersedes Step 3.11's "Out of scope: a full commit composer".** That
> exclusion assumed the Project Shell would cover committing. In practice the panel is the
> place you're already standing when you want to commit, and bouncing to a shell for the
> single most frequent git operation is the panel's biggest usability hole.

---

## Scope statement

**In scope:** everything you do daily — stage/commit/amend, branch, merge, rebase-onto,
history browsing and search, reset/revert/cherry-pick, conflict resolution, stash
management, and the layout/selection/context-menu work that makes all of it pleasant on a
vertical monitor.

**Out of scope:** interactive rebase (todo-list editing), submodules, LFS, GPG signing
config, PR/forge integration, bisect, reflog browsing, credential management. The Project
Shell stays the escape hatch for these — that's the §5 contract, and it still holds for the
long tail.

---

## Current state (audit, 2026-07-23)

**Backend** — `src-tauri/src/git/mod.rs` (1794 lines), 20 commands registered in
`src-tauri/src/lib.rs:116-135`. All shell-outs via `git_run` / `git_stdout` / `git_output`.
Read paths are single batched invocations (no per-row shelling), which is the right shape
and should be preserved.

| Present | Absent |
|---|---|
| `git_log`, `git_branches`, `git_status_entries`, `git_stash_list` | **commit**, amend, tags, remotes list |
| `git_commit_files`, `git_commit_file_diff` | merge, rebase, reset, revert, cherry-pick |
| `git_checkout`, `git_create_branch`, `git_rename_branch`, `git_delete_branch` | stash *apply*, stash show, branch-from-stash |
| `git_stage`, `git_unstage`, `git_discard`, `git_clean` | hunk-level staging, conflict resolution (`checkout --ours/--theirs`) |
| `git_stash_push`, `git_stash_pop`, `git_stash_drop` | set-upstream / publish, per-branch push/pull |
| `git_fetch`, `git_pull`, `git_push` | log search/pagination, file history, blame |

**Frontend** — `src/panels/Git/index.tsx` (1582 lines). Three tabs (`history`, `branches`,
`status`), all fixed-width horizontal splits. Known problems, by line:

| Where | Problem |
|---|---|
| everywhere | **No commit UI at all.** Stage → then leave the panel. |
| `index.tsx:450` | History split hardcoded `flex: "0 0 300px"`. |
| `index.tsx:847` | Working-tree split hardcoded `flex: "0 0 280px"`. |
| `index.tsx:551` | Commit file list capped `maxHeight: 140`. |
| `index.tsx:307` | Header is a single non-wrapping row (branch + 4 text buttons). |
| `index.tsx:1120` | Stash section pinned with `marginTop: auto`, fights the file list for height. |
| `index.tsx:766-834` | Selection is Ctrl/Shift-click only — no keyboard nav, no Ctrl+A, no checkboxes, no filter. |
| whole file | **Zero `onContextMenu` handlers** — in fact zero in all of `src/`. Every action is a hover-revealed glyph. |
| `index.tsx:772-774` | **Conflicted files (`UU`) land in *both* the staged and unstaged groups**; `statusCharColor` (`:1394`) has no `U` case so they render in the default dim colour; "stage" silently marks resolved. No mid-merge/mid-rebase indication anywhere. |
| `index.tsx:127-145` | Every write calls `load()` → re-fetches log + branches + status + stashes. Staging one file re-reads 200 commits. |
| `index.tsx:176` | Errors are a one-line banner; merge/rebase output is multi-line. |
| `index.tsx:398` | `gitLog` accepts a `limit` the panel never passes — fixed 200, no "load more". |
| `mod.rs:906` | `Commit.parents` is fetched *specifically* for a graph gutter and never used. |
| `mod.rs:851-862` | `git_run` uses `cmd.output()` with **no timeout** and doesn't set `GIT_TERMINAL_PROMPT=0`. A push/pull needing credentials blocks forever with the panel stuck at `busy: true` and no cancel. |
| `mod.rs:1347` | `git_push` has no `-u` path — pushing a branch with no upstream just fails. |
| `CommandPalette.tsx` | No git entries, despite §5 Git calling for keyboard-first + palette coverage. |

---

## Guardrails for this work (settled — don't violate)

- **Keep the §5 read-first / write-behind-confirm contract.** Anything that rewrites state
  (force-push, branch delete, discard, clean, `reset --hard`, stash drop, amend of a pushed
  commit) sits behind an explicit confirm with a plain-language consequence.
- **Never auto-push.** Including from "commit & push" — that's one user gesture, not an
  implicit one.
- **Preserve the batched-read shape.** New read paths run *one* git invocation, never one
  per row.
- **Stay shell-out.** `mod.rs:874-885` records the decision: one toolchain, shared
  `CREATE_NO_WINDOW` + error-capture helpers, no libgit2 build dep. Don't half-introduce
  `git2` for new commands.
- **Paths are NUL-separated.** Every new path-carrying read uses `-z` + `core.quotePath=false`
  for the reason at `mod.rs:1062-1066` (a path with a space would otherwise arrive C-quoted
  and be rejected as a pathspec). This has already bitten once — see commit `36db229`.
- **Worktree lifecycle stays an instance-card action** (2.4/2.5). The panel may *display*
  worktree branches and refuse to check them out, but never creates or removes worktrees.
- **The shared-working-dir warning stays** on any HEAD-moving op — checkout today, plus the
  new reset / merge / rebase / cherry-pick / stash-pop paths (`index.tsx:149-160` has the
  `liveRootInstances()` helper; reuse it, don't reimplement).
- **Windows first.** Forward-slash paths, no shell interpolation of user strings, keep
  `CREATE_NO_WINDOW`.

---

## Steps

### Step G1 — Commit composer + publish branch ✅ *(landed)*

- **Goal:** Commit from the panel. This is the blocking gap — everything else is polish on
  top of a panel you currently can't finish a workflow in.
- **Depends on:** nothing (3.11 is landed).
- **Design refs:** `§5` (Git → Working tree), `§7`.
- **Build:**
  - Backend: `git_commit(repoRoot, message, amend, signoff, allowEmpty, stageAll)` returning
    the new short SHA; `git_head_commit(repoRoot)` returning the current HEAD's full message
    + pushed-state, so amend can prefill and warn.
  - `git_push` gains a `setUpstream` path (`push -u <remote> <branch>`) used when
    `Branch.upstream == null` — surfaced as **publish branch** rather than a failing push.
  - UI: a commit box in the working-tree tab — subject line + body textarea, a soft 72-col
    guide on the subject, live count of what will be committed ("3 staged files"), and
    **Ctrl+Enter** to commit.
  - Buttons: **commit** (staged only; disabled with a reason when nothing is staged),
    **commit all** (`-a`, tracked only — never picks up untracked), **amend** (checkbox that
    prefills the previous message).
  - Amending a commit that's already pushed (`ahead == 0 && upstream != null`) goes behind a
    confirm explaining it will require a force-push.
  - **commit & push** as one explicit action.
  - Draft message persists per repo across tab switches and panel close/reopen (prefs store,
    keyed by `repoRoot`) — losing a half-written message to a mis-click is unacceptable.
- **Key files:** `src-tauri/src/git/mod.rs`, `src-tauri/src/lib.rs`, `src/ipc/git.ts`,
  `src/panels/Git/` (extract a `CommitBox.tsx`; `index.tsx` is already 1582 lines and this
  step should start splitting it).
- **Done when:** You can stage files, write a subject + body, commit, and see the commit
  appear at the top of the History tab; amend prefills and warns when pushed; a branch with
  no upstream offers *publish* and succeeds; a draft survives a tab switch.
- **Out of scope:** hunk staging (G5), signing config.
- **As built:** the composer is docked full-width under *both* panes of the working-tree tab
  (at 280px the file column is far too narrow to write in) — G2 places it per orientation.
  `signoff` / `allowEmpty` exist on `git_commit` + `gitCommit` but have no UI yet. Drafts
  live in `commitDrafts` (prefs), read synchronously from an in-memory cache so a tab switch
  restores instantly, mirrored to disk debounced. Decomposition: `CommitBox.tsx` plus a
  `rows.tsx` / `format.ts` split — one module exporting both components and non-literal
  constants trips `react-refresh/only-export-components`, so the value half is separate.

---

### Step G2 — Responsive layout: vertical/narrow windows ✅ *(landed)*

- **Goal:** The panel is fully usable in a tall, narrow window (~500-700px wide) — the
  primary reported failure mode. Commit, review, and stage without horizontal squeeze.
- **Depends on:** G1 (the commit box is the largest new consumer of space; build the layout
  around it, not before it).
- **Design refs:** `§5` (Git), `§5.x` (retro-console aesthetic — keep the box-drawing feel
  at every width).
- **Build:**
  - A `useOrientation()` hook: `ResizeObserver` on the panel root, returning
    `"wide" | "narrow"` at a ~560px threshold with hysteresis (don't thrash at the boundary).
    Precedent: `Console.tsx:55`, `InstanceManager.tsx:1054`.
  - **Narrow → stacked:** list on top, diff below, commit box docked at the bottom of the
    working-tree tab. **Wide → current side-by-side**, unchanged in feel.
  - Replace *both* hardcoded splits (`index.tsx:450`, `:847`) and the `maxHeight: 140` file
    list (`:551`) with a **draggable splitter** whose position persists per panel **per
    orientation** (prefs store). Fixed pixel panes are the root cause of the vertical
    failure; removing them is the substance of this step.
  - **Collapsible diff pane** — collapse to go full-list while staging, expand to go
    full-diff while reviewing. One click, remembered.
  - Header (`index.tsx:307`): below the threshold, collapse the four text buttons to glyphs
    plus a `⋯` overflow menu; branch name keeps its ellipsis and stays visible.
  - `StashSection` becomes a proper collapsible section (drop the `marginTop: auto`).
  - Tab bar: glyph + count below the threshold.
- **Key files:** `src/panels/Git/` (new `useOrientation.ts`, `Splitter.tsx` — check for a
  reusable splitter before adding one), `src/state/prefs` for persistence.
- **Done when:** Docked in a 560px-wide column you can select a file, read its diff, stage
  it, write a message and commit without horizontal scrolling or a squeezed diff; splitter
  positions survive a restart; the wide layout is visually unchanged from today.
- **Out of scope:** re-theming; the diff renderer itself.
- **As built:** one pass. No reusable splitter existed (dockview owns the *panel* splitters,
  which isn't the same concern), so `Splitter.tsx` is new: a two-pane split whose bar carries
  a grip, double-click-to-reset, and — where `collapsible` is set — a chevron pill that
  collapses the second pane to a 17px rail. Positions persist via `layout.ts` (same
  sync-cache + debounced-flush shape as `draft.ts`) under a new `gitLayout` pref, keyed
  `<split id>:<orientation>`; the shell folds `hydrateGitLayout()` into its first read so
  splits mount in place rather than snapping. Three splits: `history.log`,
  `history.files` (replacing `maxHeight: 140`), `status.files`. The first pane is
  `flex: 0 1 <size>px` with a floor on the second — a *fixed* pane reintroduces the exact
  bug this step removes as soon as the dock is dragged narrower than the stored split.
  The commit box stays docked full-width below both panes in **both** orientations: even
  wide, the file column is too narrow to write in, and stacking it under the diff in a
  narrow column puts it below the fold. Narrow header keeps ⇡ push + ↻ refresh as glyphs
  and moves fetch/pull (labelled) into a `⋯` menu — a button menu, not the shared
  right-click `ContextMenu`, which is still G3's to build.

---

### Step G3 — Context menus everywhere ✅ *(landed)*

- **Goal:** Right-click actions on every row type. Highest breadth-per-line in the plan —
  most of the "more options" ask is this one step.
- **Depends on:** G1 (some menu items are commit actions).
- **Design refs:** `§5` (Git), `§5.x` (menu chrome must match the console aesthetic).
- **Build:**
  - A shared `ContextMenu` component (there are **no** `onContextMenu` handlers anywhere in
    `src/` — this is new ground; build it generic enough for the Instance rail and Diff
    panel to adopt later). Keyboard-dismissable, viewport-clamped, disabled items carry a
    reason in their title.
  - **File row:** stage / unstage / discard; stage this folder; open in Editor panel; copy
    path / copy absolute path; add to `.gitignore`; file history; reveal in Explorer;
    *mark resolved* (G6).
  - **Commit row:** copy SHA / copy subject / copy full message; checkout (detached); branch
    from here; tag here; revert; cherry-pick; reset soft / mixed / hard; compare with working
    tree; compare with selected commit.
  - **Branch row:** checkout; merge into current; rebase current onto; fast-forward; push /
    pull / set upstream / publish; rename; delete; compare against current; copy name;
    create branch from.
  - **Stash row:** apply (keep) — *pop is currently the only option*; drop; show diff; branch
    from stash.
  - Destructive items keep the existing confirm path (`Confirm` union at `index.tsx:81-86`);
    extend it rather than adding a second confirm mechanism.
  - Menu items that don't yet have a backend command (merge, rebase, reset, revert,
    cherry-pick, tag) are wired in **G4/G7** — land the menu with those items present and
    disabled, or land the step after G4/G7 if that reads cleaner in one pass.
- **Key files:** `src/components/ContextMenu.tsx` (new, shared), `src/panels/Git/`.
- **Done when:** Every row type has a right-click menu; every item either performs its action
  or is visibly disabled with a reason; destructive items confirm.
- **Out of scope:** a global app-wide menu system.
- **As built:** one pass, five row types (working-tree file, a commit's changed-file,
  commit, local branch, remote branch, stash). `components/ContextMenu.tsx` portals onto
  `document.body` — every row it opens from sits inside a `Splitter` pane that clips its
  overflow, so a menu drawn in the tree would be cut off at the pane edge — clamps into the
  viewport after measuring, and dismisses on Escape / Tab / outside press / scroll / resize /
  window blur. Its state half is `components/useContextMenu.ts`, split for the same
  fast-refresh reason `format.ts` is split from `rows.tsx`. Menu *contents* went to
  `src/panels/Git/menus.ts` as pure builders (target + callbacks in, `MenuEntry[]` out) rather
  than into `index.tsx`, and every item routes through the callback its hover glyph already
  used, so no destructive action gained a second, unconfirmed path. Right-clicking a
  working-tree row inside the selection acts on the whole selection; outside it, the
  right-click replaces the selection first, so what the menu will touch is always what's
  highlighted. New backend: the three stash commands this step owns, plus `git_ignore_add`
  (appends + creates `.gitignore`, keeping the file's own line endings — `fs::write_file`
  refuses to create files) and `sys::reveal_path` (`reveal_item_in_dir`, which *selects* the
  file; `open_path` would have launched it in its default app). Disabled-with-a-reason
  covers merge / rebase / fast-forward / set-upstream (G4), revert / cherry-pick / reset /
  tag / compare / full commit body / file history (G7), and mark-resolved (G6) — the last of
  which appears only on a conflicted row, since anywhere else it's a permanent dead item for
  a state the file isn't in. Tooltips name what's missing in plain words, not step codes.
  Per-branch push/pull are offered only on the checked-out branch: `git push` acts on HEAD,
  and offering it elsewhere would quietly act on a different branch than the one clicked.

---

### Step G4 — Branch operations: merge, rebase, upstream ✅ *(landed)*

- **Goal:** Close the branch-tab parity gap. §5 Git already promises "fast-forward/merge from
  the panel" and it was never built.
- **Depends on:** G3 (these surface primarily as context-menu items).
- **Design refs:** `§5` (Git → Branches), `§6` (worktree relation).
- **Build:**
  - Backend: `git_merge(repoRoot, ref, noFf, squash)`, `git_rebase(repoRoot, onto)`,
    `git_rebase_control(repoRoot, action)` for `--continue` / `--abort` / `--skip`,
    `git_merge_abort`, `git_set_upstream(repoRoot, branch, upstream)`,
    `git_delete_remote_branch(repoRoot, remote, branch)`, `git_remotes(repoRoot)`.
  - Conflict-producing ops return git's full output; the UI routes it to the expandable
    error surface from **G8** (or a scrollable modal if G8 hasn't landed) and drops the panel
    into the conflict state from **G6**.
  - Branch tab: a **filter box**; group remotes **per remote** (not one flat "remote"
    heading — `Branches.remote` is currently `string[]`); per-branch last-commit
    subject + relative date; sort by recent / name.
  - **Mark branches checked out in another worktree** and disable their checkout with an
    explanatory tooltip — git refuses these, and today that surfaces as a raw error string.
    (Read `git worktree list --porcelain`; display only — worktree lifecycle stays in 2.4/2.5.)
  - Every HEAD-moving op runs through the existing `liveRootInstances()` shared-working-dir
    warning.
- **Key files:** `src-tauri/src/git/mod.rs`, `src/ipc/git.ts`, `src/panels/Git/BranchesTab.tsx`
  (extract).
- **Done when:** You can merge a branch into the current one, rebase onto another, set an
  upstream, and delete a remote branch; a conflicting merge leaves the panel in a clear
  conflicted state with abort available; worktree-held branches are marked and un-checkout-able.
- **Out of scope:** interactive rebase.
- **As built:** the branch tab moved to `BranchesTab.tsx` on the way through, and gained the
  filter, the recent/name sort (persisted through `layout.ts` like the section flags), a
  collapsible group *per remote*, and each branch's tip subject + age. Branches another worktree
  holds are marked `⧉ worktree`, and both actions git would refuse there — checkout and delete —
  are withheld rather than offered and then rejected; the mark comes from one
  `git worktree list --porcelain` folded into `git_branches`, and a branch is "held elsewhere"
  precisely when it appears in that map and *isn't* `isHead`, which needs no path comparison at
  all. `git_remotes` folded into `git_branches` for the same reason: it's the same read, and a
  second round trip would buy nothing.

  Three deviations worth naming. **`git_merge` takes one `mode`** (`merge` / `noFf` / `squash` /
  `ffOnly`) rather than two booleans — it makes the invalid `noFf + squash` pair unrepresentable
  and gives fast-forward somewhere to live. The choice is made in the merge dialog rather than in
  three near-identical menu items. **`git_repo_state` landed here, not in G6**: this step's
  definition of done needs an abort that survives a panel remount, and a banner fed only by the
  result of the command you just ran would claim a clean repo while it sat mid-merge. G6 still
  owns the conflicted-file grouping that goes beside it. **A new `git_run_full`** backs every one
  of these commands: a conflicting merge writes its `CONFLICT` lines to *stdout* and exits
  non-zero, so `git_run` — stderr-only — would have reported an empty error for the single most
  informative failure in the step. It also forces `GIT_EDITOR=true`, without which a merge or
  rebase wanting a message would block forever against a process with no terminal.

  Those failures don't go to the one-line notice: they reload the repo (the tree *changed* on the
  way to failing) and open a scrollable output dialog with git's whole message — the stand-in for
  G8's expandable error surface. A rebase banner offers continue / skip / abort, a merge banner
  offers abort (its "continue" is an ordinary commit, which the commit box below already is), and
  a cherry-pick or revert started elsewhere says so rather than offering half a set of buttons.
  Two honest gaps: a conflicting **squash** merge records no `MERGE_HEAD`, so there's nothing for
  `--abort` to undo and no banner — the dialog says so before you pick that mode; and a
  conflicted file still lands in both the staged and unstaged groups, which is **G6**'s
  classification bug, now much easier to reach from inside the panel.

---

### Step G5 — Selection flexibility + keyboard-first ✅ *(landed)*

- **Goal:** The flexibility ask, plus the §5 keyboard-first requirement that Step 3.11 left
  unbuilt.
- **Depends on:** G2 (selection UI must work in both orientations).
- **Design refs:** `§5` (Git → keyboard-first), `§5.y` (keybindings), Step 3.10 (palette).
- **Build:**
  - **Keyboard navigation** — currently *zero*: `↑`/`↓` move the lead row, `Shift+↑/↓` extend
    the selection, `Space` toggles staged/unstaged, `Enter` opens in the Editor panel,
    `Ctrl+A` selects all in the focused group, `Esc` clears. Focus ring visible.
  - **Checkboxes** on file rows, decoupling "what I've selected to act on" from "what diff
    I'm reading". The current `picked` background tint vs `lead` 2px bar
    (`index.tsx:1055-1058`) is too subtle to read at a glance.
  - **Filter box** over the file list, with *select all matching*.
  - **Select by status** — all modified / all deleted / all untracked / invert selection.
  - **Tree view toggle** — collapsible directory tree with *stage this folder*, alongside the
    current flat list.
  - **Hunk-level staging** — the single feature that most separates this from a real client.
    Backend `git_apply_patch(repoRoot, patch, cached, reverse)`; the UI reconstructs a
    minimal valid patch from the selected hunks in `UnifiedDiff` and applies it with
    `--cached`. Stage-hunk / unstage-hunk / discard-hunk. **Line-level staging is out of
    scope** — hunks first; revisit only if hunks prove insufficient in practice.
  - Group headers gain **unstage all** / **discard all** for symmetry with the existing
    "stage all", and whole-group actions respect an active selection when one exists.
  - Register the git actions in the **command palette** with their bindings (§5.y / 3.10).
- **Key files:** `src/panels/Git/StatusTab.tsx` (extract), `src/panels/Diff/UnifiedDiff.tsx`
  (hunk selection — shared with the Diff panel, so change it additively),
  `src/keyboard/keymap.ts`, `src/panels/CommandPalette.tsx`.
- **Done when:** The working-tree tab is fully operable from the keyboard without a mouse;
  a filter + select-all-matching stages a subset in two gestures; a single hunk can be staged
  while the rest of the file stays unstaged; git actions appear in the palette with bindings.
- **Out of scope:** line-level staging; drag-select.
- **As built:** the tab moved to `StatusTab.tsx` and `index.tsx` lost ~590 lines on the way.

  **One backend command more than planned.** Hunk staging forced a change the plan didn't
  name: the diff pane used to read `git diff HEAD` — both sides at once — and a hunk cut out
  of *that* describes a file that may already be half-staged, so `git apply --cached` would be
  applying it against an index it doesn't match. `git_file_diff(repoRoot, path, staged,
  untracked)` reads **one side** (index→worktree, or HEAD→index) and `git_apply_patch` feeds
  the picked hunks back to that same side, which is what makes the hunks applyable *verbatim*,
  headers and line numbers untouched — the renumbering that partial-staging implementations
  usually get wrong never happens. The visible consequence: clicking a file's staged row and
  its unstaged row now shows two different diffs, which is also the honest answer to "what
  will this commit take".

  Hunk actions are per-side, so nothing offers an impossible one: an unstaged hunk can be
  staged or discarded, a staged hunk can be unstaged, and an untracked file has no hunk layer
  at all (its "diff" is a synthesis with no blob for git to match). Discarding is the only one
  behind a confirm — it's the only one that destroys work that exists nowhere else.

  **Palette.** `CommandPalette.tsx` needed no change: it renders whatever the keymap holds, so
  nine `git…` bindings in `keymap.ts` were the whole job. Only two ship *bound*
  (`Ctrl+Shift+M` write a commit message, `Ctrl+Shift+F` filter the files) — global chords are
  a scarce shared resource with the terminal, and the keyboard that matters here is the local
  one on the file list. The rest are unbound and assignable. The commands are panel-level
  only: the palette can't see a row selection, so it doesn't pretend to act on one. The panel
  claims them on mount *and* on activation, so with two Git panels open the one you last
  touched answers; a command run from elsewhere brings its panel forward first.

  Two smaller judgement calls worth knowing: collapsing a folder in the tree hides rows
  without deselecting them (selection resolves against the filtered set, keyboard order
  against the visible one), and Space on a mixed selection **stages the part that isn't
  staged** rather than doing nothing — it only unstages when everything picked is already
  staged.

---

### Step G6 — Merge conflicts ✅ *(landed)*

- **Goal:** Fix a genuine mishandling and make conflicts resolvable in-panel.
- **Depends on:** G4 (merge/rebase are the main producers of conflicts).
- **Design refs:** `§5` (Git → Working tree).
- **Build:**
  - **Fix the classification bug.** A conflicted file (`UU`, `AA`, `DU`, `UD`, `AU`, `UA`)
    still satisfies *both* filters in the `groups` memo (now `StatusTab.tsx`, moved there by
    G5) and renders in the staged **and** unstaged groups, uncoloured (`statusCharColor` in
    `format.ts` has no `U` case), and staging it silently marks it resolved with no indication
    that's what happened. Add an explicit `conflicted` group that takes precedence over both,
    with its own colour. Note G5's side-scoped diff pane: a conflicted file's two rows now
    read the index and worktree sides separately, which is the right surface for this.
  - ~~**Repo-state banner**~~ — *landed in G4*, which needed an abort that survives a panel
    remount: `git_repo_state` reads the git dir for `MERGE_HEAD` / `rebase-merge` /
    `CHERRY_PICK_HEAD` / `REVERT_HEAD` and the banner offers continue / skip / abort. What's left
    here is extending it with the conflicted-file detail below, and giving cherry-pick / revert
    their controls once **G7** lands the commands that start them.
  - **Resolution actions** per conflicted file: *use ours* / *use theirs*
    (`checkout --ours/--theirs` + `add`), *mark resolved*, *open in Editor*.
  - Conflict markers highlighted in the diff view.
- **Key files:** `src-tauri/src/git/mod.rs`, `src/panels/Git/StatusTab.tsx`,
  `src/panels/Diff/UnifiedDiff.tsx`.
- **Done when:** A deliberately conflicted merge shows a conflicted group (and only that
  group), a state banner with working continue/abort, and per-file ours/theirs/resolved that
  drive the repo to a clean state.
- **Out of scope:** a three-way merge editor.
- **As built:** the classification rule moved to the **backend** rather than staying in the
  `groups` memo. `StatusEntry` gained a `conflicted` flag computed by `is_conflicted`, an
  explicit list of the seven unmerged pairs — because "either column is `U`" is *itself* half
  the bug: `AA` (both added) and `DD` (both deleted) carry no `U` at all, and both were being
  filed under staged *and* unstaged with no colour and no sign that staging one would mark it
  resolved. One rule, one place, and a Rust test that names the two cases the shortcut misses.

  **`git_resolve` needed the index stages, not just the flags the plan named.**
  `checkout --ours/--theirs` reads stages 2 and 3, and the conflicts that hurt most are the
  ones where the side you're choosing *has no stage*: on a modify/delete, `git checkout
  --theirs -- b.txt` fails outright with "path 'b.txt' does not have their version". Taking
  theirs there means *deleting the file*. So the command reads `ls-files -u -z` first and
  splits the batch — `checkout` + `add` for the paths with that stage, `rm -f` for the ones
  without — in at most three git invocations however many files are selected. Paths that are
  no longer unmerged are skipped rather than failing the batch, since a stale selection after
  a background refresh is an ordinary way to arrive here.

  **The diff pane needed no new command.** A conflicted row isn't in the staged group, so it
  already goes down the `staged: false` path, and `git diff` on an unmerged path answers with
  a *combined* `diff --cc` — the one view that shows the markers in context. (`--cached`
  would have answered `* Unmerged path …`, which is also what plain `diff` says for the
  shapes with nothing to merge; the panel detects that one line and explains the conflict in
  words instead of repeating git's shorthand back.) Combined diffs are why conflicted rows
  have **no hunk layer**: `@@@ … @@@` with two prefix columns is not something `git apply`
  takes, and the unit of action here is a whole file and a side.

  `UnifiedDiff` grew a second additive prop beside G5's `hunks`: `conflict`, which bands the
  `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` rows. It's opt-in rather than always-on
  because the marker regex has to tolerate the combined diff's two prefix columns
  (`++<<<<<<< HEAD`), and a loose enough pattern for that would band a `+=======` under a
  markdown heading in the Diff/Review panel, where there is no conflict to explain.

  Three judgement calls. **Only *ours* / *theirs* confirm** — they throw the other side away,
  and once the result is staged the index no longer holds the stages `checkout -m` would need
  to put the conflict back; *mark resolved* keeps what's on disk and an unstage undoes it, so
  it's as unconfirmed as staging is everywhere else. **A conflicted row shows `!`**, not one
  of its two chars: `AA`/`DD` have no `U` to borrow and picking half of a pair names one side
  of a two-sided state, so the glyph is an alarm and the *words* ("deleted by them") are in
  the row title and the conflict bar. **Discard is withheld, not offered and rejected** —
  `git restore` refuses an unmerged path, and conflicted paths are held out of a mixed
  selection's discard so one conflict can't take the whole batch down; the tooltip points at
  the banner's abort, which is the real "undo everything" here. The banner itself now counts
  what's still unmerged, which turns it from a label into an instruction — at zero it stops
  saying "resolve the conflicts" and says to commit.

---

### Step G7 — History parity: graph, search, navigation, rewrite ops

- **Goal:** Make History a real history browser rather than a fixed list of the last 200
  subjects.
- **Depends on:** G3 (commit actions are context-menu items).
- **Design refs:** `§5` (Git → History — *"graph view of branches/merges where it helps"*),
  `§5.x`.
- **Build:**
  - **Graph gutter.** `Commit.parents` is already fetched for exactly this
    (`mod.rs:905`) and is unused. A minimal lane renderer in the box-drawing aesthetic —
    "where it helps", not a full railway diagram.
  - **Search / filter:** by message, author, path, and date range — a `git log` argument
    passthrough on the backend, not client-side filtering of the fetched 200.
  - **Pagination:** `gitLog` already takes a `limit` the panel never passes
    (`index.tsx:297`). Add *load more* / infinite scroll, plus a **ref selector**
    (current branch / `--all` / a specific branch or tag).
  - **Commit detail pane:** full body, author *and* committer with dates, clickable parent
    SHAs for navigation, ref decorations. Today you get subject + file list only.
  - **Working tree as row zero** — an "uncommitted changes" pseudo-row at the top of the log
    so status and history read as one timeline (jumps to the working-tree tab).
  - **Range diff:** select two commits → diff between them.
  - **Rewrite ops** (all behind confirms, all through the shared-working-dir warning):
    `git_revert`, `git_cherry_pick`, `git_reset(mode)`, `git_tag_create`, `git_tag_delete`,
    `git_tags`. Tags are entirely absent from the model today.
  - **File history** — the log for a single path, reachable from the file-row context menu.
- **Key files:** `src-tauri/src/git/mod.rs`, `src/ipc/git.ts`,
  `src/panels/Git/HistoryTab.tsx` (extract), `src/panels/Git/Graph.tsx` (new).
- **Done when:** History shows a graph gutter for a repo with merges; you can search by
  author and by path; *load more* pages past 200; a commit's full body and parents are
  visible and navigable; revert / cherry-pick / reset / tag work behind confirms.
- **Out of scope:** blame (its own step if wanted), bisect, reflog.

---

### Step G8 — Freshness, targeted refresh, robustness

- **Goal:** The panel stops going stale, stops re-reading the world on every click, and stops
  being able to hang.
- **Depends on:** none strictly — but land it **last** so it covers every command the earlier
  steps added. Pull the `git_run` hardening forward if a hang is hit during G1-G7.
- **Design refs:** `§4` (the app is a supervisor of *concurrently mutating* agents), `§9`.
- **Build:**
  - **Filesystem watcher** on `.git/HEAD`, `.git/index`, `.git/refs/`, plus the working tree
    (debounced, ignoring `.git/objects` churn) → auto-refresh. This matters *more here than
    in a normal git client*: agents commit and mutate files under you continuously, and today
    the panel silently shows stale state until you hit ↻.
  - **Targeted refresh.** `run()` (`index.tsx:340`) currently reloads log + branches +
    status + stashes after *every* write — staging one file re-reads 200 commits. Each action
    declares which slices it invalidates.
  - **`git_run` hardening** (`mod.rs:853`): set `GIT_TERMINAL_PROMPT=0` and a no-op
    `GIT_ASKPASS`, add a timeout, and make network ops (fetch/pull/push) **cancellable**.
    Today `cmd.output()` on a credential-needing push blocks forever with the panel pinned at
    `busy: true` and no way out.
  - **Error surface:** replace the one-line banner (`index.tsx:602`) with an expandable
    output area, plus a small scrollback of recent git commands and their output — the
    honesty the §5 "keep the panel honest" note asks for.
  - **Progress affordance** on network ops beyond disabling buttons.
- **Key files:** `src-tauri/src/git/mod.rs`, a new watcher module, `src/panels/Git/`.
- **Done when:** Committing from an external terminal updates the panel within a second
  without a manual refresh; staging a file doesn't refetch the log; a push against an
  unreachable/auth-required remote fails or cancels within the timeout instead of hanging;
  a multi-line git error is readable in full.
- **Out of scope:** a general-purpose app-wide fs-watcher service.

---

## New backend command surface (cumulative)

| Command | Step | Notes |
|---|---|---|
| `git_commit` | G1 | message, amend, signoff, allowEmpty, stageAll |
| `git_head_commit` | G1 | prefill + pushed-state for amend |
| `git_push` *(extend)* | G1 | `setUpstream` → publish branch |
| `git_merge`, `git_merge_abort` | G4 | one `mode`: merge / noFf / squash / ffOnly |
| `git_rebase`, `git_rebase_control` | G4 | continue / abort / skip |
| `git_set_upstream`, `git_delete_remote_branch` | G4 | |
| ~~`git_remotes`~~, ~~`git_worktree_list`~~ | G4 | folded into `git_branches` — same read, no extra round trip |
| `git_apply_patch` | G5 | hunk stage/unstage/discard via `--cached` / `--reverse`, patch on stdin |
| `git_file_diff` | G5 | one file, **one side** (index→worktree or HEAD→index) — what makes a hunk applyable |
| `git_repo_state` | ~~G6~~ G4 | mid-merge / rebase / cherry-pick / revert; G4's abort needs it |
| `git_resolve` | G6 | reads `ls-files -u` first: `checkout --ours/--theirs` + `add`, or `rm -f` where that side has no stage |
| `git_status_entries` *(extend)* | G6 | `conflicted` flag — the seven unmerged `XY` pairs, incl. `AA`/`DD`, which carry no `U` |
| `git_log` *(extend)* | G7 | search, path filter, date range, ref, skip/pagination |
| `git_commit_detail` | G7 | full body, committer, parents |
| `git_file_history` | G7 | log for one path |
| `git_revert`, `git_cherry_pick`, `git_reset` | G7 | all behind confirms |
| `git_tags`, `git_tag_create`, `git_tag_delete` | G7 | tags absent today |
| `git_stash_apply`, `git_stash_show`, `git_stash_branch` | G3 | pop is currently the only option |
| `git_ignore_add` | G3 | appends/creates `.gitignore`; `fs::write_file` won't create files |
| `sys::reveal_path` | G3 | `reveal_item_in_dir` — selects the file, unlike `open_path` |

Every one: registered in `src-tauri/src/lib.rs`, typed in `src/ipc/git.ts` with a doc
comment matching the existing style, `-z` + `core.quotePath=false` on any path-carrying read.

---

## File-decomposition note

`src/panels/Git/index.tsx` is 1582 lines before any of this work. Each step that touches a
tab should **extract that tab** on its way through, converging on:

```
src/panels/Git/
  index.tsx          panel shell, tabs, shared confirm/dialog plumbing
  HistoryTab.tsx     G7
  BranchesTab.tsx    G4
  StatusTab.tsx      G5, G6
  CommitBox.tsx      G1
  Graph.tsx          G7
  useOrientation.ts  G2
  Splitter.tsx       G2   two-pane draggable split, collapsible second pane
  layout.ts          G2   persisted splitter positions + section open/closed
  menus.ts           G3   per-row-type context-menu contents (pure builders)
  draft.ts           G1   per-repo commit-message drafts
  rows.tsx           shared row primitives
  format.ts          shared glyph/colour maps + style objects (value half of rows.tsx)
```

Don't do the split as its own refactor step — do it incrementally, inside the step that
already has the file open, so no session spends its budget on pure motion.

---

## Sequencing

```
G1 commit ──┬── G2 layout ──┬── G5 selection + keyboard
            │               │
            └── G3 menus ───┼── G4 branch ops ── G6 conflicts
                            │
                            └── G7 history
                                              G8 freshness (last)
```

**G1 + G2 are entangled** — where the commit box lives depends on the orientation model — so
if a single session can carry both, do them together. Otherwise land G1's backend + a
provisional wide-layout commit box, then let G2 place it properly.

---

## Progress tracker

- [x] G1 — Commit composer + publish branch
- [x] G2 — Responsive layout (vertical/narrow)
- [x] G3 — Context menus
- [x] G4 — Branch operations (merge / rebase / upstream)
- [x] G5 — Selection flexibility + keyboard-first
- [x] G6 — Merge conflicts
- [ ] G7 — History parity (graph / search / rewrite ops)
- [ ] G8 — Freshness, targeted refresh, robustness

Suggested commit messages: `git: commit composer (G1)`, `git: responsive vertical layout
(G2)`, `git: context menus (G3)`, … matching the repo's existing `<area>: <what>` style.
