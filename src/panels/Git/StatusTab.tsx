// The working-tree tab (G5) — extracted from `index.tsx` on its way through, the
// way each step is meant to leave the panel smaller than it found it.
//
// What 3.11 shipped here was a flat list with Ctrl/Shift-click selection, hover
// glyphs, and no keyboard at all: you couldn't move between files, stage one, or
// open one without a mouse, which is the opposite of what §5 asks a keyboard-first
// panel to be. G5 fills that in and adds the flexibility the plan's "selection"
// ask names:
//
//   • **Keyboard.** The list is a focusable listbox: ↑/↓ move the lead, Shift+↑/↓
//     extend, Space stages (or unstages, when everything picked is staged), Enter
//     opens the lead in the Editor, Ctrl+A selects the lead's group, Esc clears.
//     The focused list draws a ring so it's obvious the keys will land here.
//   • **Checkboxes**, so "what I've selected to act on" is finally distinct from
//     "what diff I'm reading" — the old tint-vs-bar pair said both too quietly.
//   • **A filter** with *select all matching*, and a select-by-status menu
//     (modified / deleted / untracked / invert).
//   • **A tree view** beside the flat list, with a stage/unstage action on any
//     folder that acts on exactly the rows under it (not `git add <dir>`, which
//     would sweep in files the filter is hiding).
//   • **Hunk staging.** The diff pane now reads *one side* — index→worktree for an
//     unstaged row, HEAD→index for a staged one — because a hunk can only be
//     applied back to the side it was cut from. Each `@@` gets a checkbox and
//     inline actions; the patch is rebuilt from the picked hunks and handed to
//     `git apply` (`Diff/patch.ts`).
//
// Group headers act on the selection when there is one and on the whole group when
// there isn't, so "stage all" never quietly ignores what you just picked.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GLYPH } from "../../theme";
import { gitFileDiff, type HeadCommit, type Stash, type StatusEntry } from "../../ipc/git";
import ContextMenu, { type MenuEntry } from "../../components/ContextMenu";
import { useContextMenu } from "../../components/useContextMenu";
import UnifiedDiff, { type HunkControls } from "../Diff/UnifiedDiff";
import { buildPatch, parseDiff } from "../Diff/patch";
import CommitBox, { type CommitRequest } from "./CommitBox";
import { fileRowMenu, stashRowMenu, type FileActions } from "./menus";
import { inputStyle, miniActionStyle, statusCharColor } from "./format";
import { Empty, HeaderButton, RowAction, SectionHead } from "./rows";
import Splitter from "./Splitter";
import { readSection, writeSection } from "./layout";
import type { Orientation } from "./useOrientation";

/** The three buckets a status entry can appear in (a file can be in two). */
type Grp = "staged" | "unstaged" | "untracked";

const GROUP_ORDER: Grp[] = ["staged", "unstaged", "untracked"];

/** A displayed status row: its `rowId` is `<group>:<path>` so a file modified both
 *  staged and unstaged is two distinct selectable rows (and Shift-range stays in
 *  visual order). Selection is over these ids; actions resolve them back to paths. */
interface StatusRowItem {
  rowId: string;
  entry: StatusEntry;
  group: Grp;
}

/**
 * What this tab needs from the panel shell — the clipboard/OS shims and the stash
 * dialogs. `PanelActions` in `index.tsx` satisfies it structurally; it isn't
 * imported from there because that would be a cycle.
 */
export interface StatusPanelActions {
  busy: boolean;
  copy: (text: string, what: string) => void;
  abs: (rel: string) => string;
  openInEditor: (rel: string) => void;
  reveal: (rel: string) => void;
  ignore: (rel: string) => void;
  stashApply: (reference: string) => void;
  stashShow: (stash: Stash) => void;
  stashBranch: (stash: Stash) => void;
}

/** A one-shot instruction from the command palette (G5), carried as a nonce so the
 *  same command can fire twice. */
export interface StatusCommand {
  kind: "filter" | "commit" | "tree";
  /** Increments per dispatch — the effect's dependency. */
  n: number;
}

export default function StatusTab({
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
  onStageHunks,
  onUnstageHunks,
  onDiscardHunks,
  command,
  onCommandDone,
}: {
  repoRoot: string;
  orientation: Orientation;
  actions: StatusPanelActions;
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
  /** Hunk patches, already built — the shell owns the confirm on the destructive one. */
  onStageHunks: (patch: string, count: number) => void;
  onUnstageHunks: (patch: string, count: number) => void;
  onDiscardHunks: (patch: string, count: number) => void;
  command: StatusCommand | null;
  /** Called once `command` has been carried out, so it isn't replayed on remount. */
  onCommandDone: () => void;
}) {
  // `menu` is the open context menu; `anchorId` below is the *selection* pivot, an
  // older and entirely separate thing.
  const { anchor: menu, openMenu, closeMenu } = useContextMenu();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [tree, setTree] = useState(() => readSection("status.tree", false));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [listFocused, setListFocused] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [pickedHunks, setPickedHunks] = useState<Set<number>>(new Set());
  // Bumped when the palette asks for the composer; `CommitBox` focuses on it.
  const [focusCommit, setFocusCommit] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // The three groups, before filtering. Same membership rules as 3.11 — a
  // conflicted file still satisfies two of them, which is G6's bug to fix.
  const groups = useMemo(
    () => ({
      staged: status.filter((e) => e.index !== " " && e.index !== "?"),
      unstaged: status.filter((e) => e.worktree !== " " && e.index !== "?"),
      untracked: status.filter((e) => e.untracked),
    }),
    [status],
  );

  const query = filter.trim().toLowerCase();

  // Rows per group after the filter. Everything downstream — selection, keyboard
  // order, group actions — reads these, so a hidden row can never be acted on by
  // something that only shows visible ones.
  const visible = useMemo(() => {
    const out = {} as Record<Grp, StatusRowItem[]>;
    for (const group of GROUP_ORDER) {
      out[group] = groups[group]
        .filter((e) => query === "" || e.path.toLowerCase().includes(query))
        .map((entry) => ({ rowId: `${group}:${entry.path}`, entry, group }));
    }
    return out;
  }, [groups, query]);

  // Folder trees, one per group. Built even in flat mode: it's cheap, and the
  // collapse state has to survive a toggle back and forth.
  const trees = useMemo(() => {
    const out = {} as Record<Grp, TreeNode[]>;
    for (const group of GROUP_ORDER) out[group] = buildTree(visible[group], group);
    return out;
  }, [visible]);

  /** Every row the filter kept, in group order — what selection and the diff pane
   *  resolve against. Collapsing a folder hides rows; it must not deselect them. */
  const allRows = useMemo(() => GROUP_ORDER.flatMap((g) => visible[g]), [visible]);

  // Navigation order = visual order. In tree mode that means leaves in tree order
  // with collapsed subtrees skipped, or ↓ would step onto a row you can't see.
  const navRows = useMemo(() => {
    if (!tree) return allRows;
    const out: StatusRowItem[] = [];
    for (const group of GROUP_ORDER) flattenTree(trees[group], collapsed, out);
    return out;
  }, [tree, trees, collapsed, allRows]);

  // As status refreshes (or the filter narrows), prune the selection/anchor/lead to
  // rows that still exist, and default the lead so the diff pane fills.
  useEffect(() => {
    const ids = new Set(allRows.map((r) => r.rowId));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
    setAnchorId((prev) => (prev && ids.has(prev) ? prev : null));
    setLead((prev) => (prev && ids.has(prev) ? prev : allRows[0]?.rowId ?? null));
  }, [allRows]);

  const leadRow = allRows.find((r) => r.rowId === lead) ?? null;
  const leadPath = leadRow?.entry.path ?? null;
  const leadStaged = leadRow?.group === "staged";
  const leadUntracked = leadRow?.entry.untracked ?? false;

  // The lead file's diff for *its own side*. Not `diff HEAD` any more (G5): a hunk
  // is only applyable against the side it came from, and a row in the staged group
  // is asking about the index, not the working tree.
  useEffect(() => {
    if (!leadPath) {
      setDiff(null);
      return;
    }
    let alive = true;
    setPickedHunks(new Set());
    void gitFileDiff(repoRoot, leadPath, leadStaged, leadUntracked)
      .then((d) => alive && setDiff(d.binary ? "" : d.text))
      .catch((err) => alive && setDiff(String(err)));
    return () => {
      alive = false;
    };
    // `status` is a dependency without appearing above: every write refreshes it,
    // and after staging half a file the diff on screen is the *old* side. Re-read
    // whenever the repo did.
  }, [repoRoot, leadPath, leadStaged, leadUntracked, status]);

  // Palette commands (G5): the panel shell switches to this tab and bumps a nonce,
  // so a command that arrives while History was showing runs as this mounts.
  useEffect(() => {
    if (!command) return;
    if (command.kind === "filter") filterRef.current?.focus();
    else if (command.kind === "commit") setFocusCommit((n) => n + 1);
    else if (command.kind === "tree")
      setTree((v) => {
        writeSection("status.tree", !v);
        return !v;
      });
    // Consumed — otherwise leaving the tab and coming back would replay it, and
    // "toggle the tree" would flip itself again on every remount.
    onCommandDone();
  }, [command, onCommandDone]);

  // Keep the lead row on screen when the keyboard moves it. Matching on the data
  // attribute rather than a ref map keeps the row components ignorant of this.
  useEffect(() => {
    if (!lead) return;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>("[data-rowid]") ?? []) {
      if (el.dataset.rowid === lead) {
        el.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [lead]);

  // --- selection ------------------------------------------------------------

  const selectOnly = useCallback((rowId: string) => {
    setSelected(new Set([rowId]));
    setAnchorId(rowId);
    setLead(rowId);
  }, []);

  const extendTo = useCallback(
    (rowId: string) => {
      const ids = navRows.map((r) => r.rowId);
      const from = anchorId && ids.includes(anchorId) ? anchorId : lead;
      const a = from ? ids.indexOf(from) : -1;
      const b = ids.indexOf(rowId);
      if (a === -1 || b === -1) {
        selectOnly(rowId);
        return;
      }
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(ids.slice(lo, hi + 1)));
      setAnchorId(from);
      setLead(rowId);
    },
    [navRows, anchorId, lead, selectOnly],
  );

  const toggleOne = useCallback((rowId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
    setAnchorId(rowId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAnchorId(null);
  }, []);

  const onRowClick = (rowId: string, e: React.MouseEvent) => {
    if (e.shiftKey) extendTo(rowId);
    else if (e.ctrlKey || e.metaKey) {
      toggleOne(rowId);
      setLead(rowId);
    } else selectOnly(rowId);
  };

  // The rows an action applies to: the selection when the lead is part of it,
  // otherwise just the lead. That's the rule the row menu already used for
  // right-clicks, applied to the keyboard too.
  const targetRows = useCallback((): StatusRowItem[] => {
    if (lead && selected.has(lead)) return allRows.filter((r) => selected.has(r.rowId));
    return leadRow ? [leadRow] : [];
  }, [lead, selected, allRows, leadRow]);

  // --- keyboard -------------------------------------------------------------

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (navRows.length === 0) return;
    const ids = navRows.map((r) => r.rowId);
    const at = lead ? ids.indexOf(lead) : -1;

    const step = (delta: number) => {
      const next = ids[Math.max(0, Math.min(ids.length - 1, at === -1 ? 0 : at + delta))];
      if (!next) return;
      if (e.shiftKey) extendTo(next);
      else selectOnly(next);
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Home":
        e.preventDefault();
        selectOnly(ids[0]);
        break;
      case "End":
        e.preventDefault();
        selectOnly(ids[ids.length - 1]);
        break;
      case " ": {
        e.preventDefault();
        if (busy) break;
        const target = targetRows();
        if (target.length === 0) break;
        // Everything picked is already staged → unstage it. Otherwise stage the
        // part that isn't, which is what a mixed selection means.
        if (target.every((r) => r.group === "staged")) {
          onUnstage(uniquePaths(target));
        } else {
          onStage(uniquePaths(target.filter((r) => r.group !== "staged")));
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        if (leadRow && !isDeleted(leadRow.entry)) actions.openInEditor(leadRow.entry.path);
        break;
      case "Escape":
        e.preventDefault();
        clearSelection();
        break;
      case "a":
      case "A":
        if (!(e.ctrlKey || e.metaKey)) break;
        e.preventDefault();
        // The *focused group* is the lead's — Ctrl+A in a panel of three lists
        // has to mean one of them.
        if (leadRow) setSelected(new Set(visible[leadRow.group].map((r) => r.rowId)));
        break;
    }
  };

  // --- resolved selection, for the bars and group headers --------------------

  const selRows = allRows.filter((r) => selected.has(r.rowId));
  const selPaths = uniquePaths(selRows);
  const selStaged = uniquePaths(selRows.filter((r) => r.group === "staged"));
  const selUntracked = uniquePaths(selRows.filter((r) => r.entry.untracked));
  const untrackedSet = new Set(selUntracked);
  const selTracked = selPaths.filter((p) => !untrackedSet.has(p));

  // The menu's file items go through this tab's own callbacks, which are the ones
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
    const row = allRows.find((r) => r.rowId === rowId);
    if (!row) return;
    const inSelection = selected.has(rowId);
    if (!inSelection) selectOnly(rowId);
    else setLead(rowId);

    const target = inSelection ? allRows.filter((r) => selected.has(r.rowId)) : [row];
    const paths = uniquePaths(target);
    const untracked = uniquePaths(target.filter((r) => r.entry.untracked));
    const untrackedInTarget = new Set(untracked);
    const { entry } = row;
    openMenu(
      e,
      fileRowMenu(
        {
          path: entry.path,
          paths,
          staged: uniquePaths(target.filter((r) => r.group === "staged")),
          tracked: paths.filter((p) => !untrackedInTarget.has(p)),
          untracked,
          deleted: isDeleted(entry),
          isUntracked: entry.untracked,
          conflicted: entry.index === "U" || entry.worktree === "U",
        },
        fileActions,
      ),
    );
  };

  /** The select-by-status menu — the "act on every deleted file" gesture that a
   *  filter box alone can't express. */
  const openSelectMenu = (e: React.MouseEvent) => {
    const pick = (label: string, test: (r: StatusRowItem) => boolean): MenuEntry => {
      const hits = allRows.filter(test);
      return {
        label,
        hint: hits.length ? String(hits.length) : undefined,
        disabled: hits.length === 0,
        title: hits.length === 0 ? "no row in view matches" : "replaces the current selection",
        onClick: () => setSelected(new Set(hits.map((r) => r.rowId))),
      };
    };
    openMenu(e, [
      pick("▣ all in view", () => true),
      // Either side: a file staged-modified and worktree-modified is "modified"
      // whichever row you're looking at.
      pick("▣ all modified", (r) => r.entry.index === "M" || r.entry.worktree === "M"),
      pick("▣ all deleted", (r) => r.entry.index === "D" || r.entry.worktree === "D"),
      pick("▣ all untracked", (r) => r.entry.untracked),
      pick("▣ all staged", (r) => r.group === "staged"),
      { kind: "separator" },
      {
        label: "⇄ invert selection",
        onClick: () =>
          setSelected(new Set(allRows.filter((r) => !selected.has(r.rowId)).map((r) => r.rowId))),
      },
      {
        label: "✗ clear selection",
        disabled: selected.size === 0,
        title: selected.size === 0 ? "nothing selected" : undefined,
        onClick: clearSelection,
      },
    ]);
  };

  // --- hunks ----------------------------------------------------------------

  const hunkCount = useMemo(() => (diff ? parseDiff(diff).hunks.length : 0), [diff]);

  const applyHunks = (picked: ReadonlySet<number>, what: "stage" | "unstage" | "discard") => {
    if (!diff) return;
    const patch = buildPatch(diff, picked);
    if (!patch) return;
    const n = picked.size;
    if (what === "stage") onStageHunks(patch, n);
    else if (what === "unstage") onUnstageHunks(patch, n);
    else onDiscardHunks(patch, n);
    setPickedHunks(new Set());
  };

  // An untracked file's "diff" is a synthesis with no blob for git to match, so it
  // has no hunk layer at all — staging it is a whole-file gesture.
  const hunks: HunkControls | undefined =
    leadRow && !leadUntracked && hunkCount > 0
      ? {
          selected: pickedHunks,
          busy,
          onToggle: (i) =>
            setPickedHunks((prev) => {
              const next = new Set(prev);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              return next;
            }),
          actions: leadStaged
            ? [
                {
                  key: "unstage",
                  glyph: "−",
                  label: "unstage this hunk",
                  onRun: (i) => applyHunks(new Set([i]), "unstage"),
                },
              ]
            : [
                {
                  key: "stage",
                  glyph: "+",
                  label: "stage this hunk",
                  onRun: (i) => applyHunks(new Set([i]), "stage"),
                },
                {
                  key: "discard",
                  glyph: "⨯",
                  label: "discard this hunk — asks first",
                  danger: true,
                  onRun: (i) => applyHunks(new Set([i]), "discard"),
                },
              ],
        }
      : undefined;

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
            <FilterBar
              filter={filter}
              onFilter={setFilter}
              inputRef={filterRef}
              matched={allRows.length}
              total={GROUP_ORDER.reduce((n, g) => n + groups[g].length, 0)}
              tree={tree}
              onTree={() =>
                setTree((v) => {
                  writeSection("status.tree", !v);
                  return !v;
                })
              }
              onSelectMenu={openSelectMenu}
              onSelectMatching={() =>
                setSelected(new Set(allRows.map((r) => r.rowId)))
              }
            />
            {selected.size > 0 && (
              <SelectionBar
                count={selected.size}
                busy={busy}
                canUnstage={selStaged.length > 0}
                onStage={() => onStage(selPaths)}
                onUnstage={() => onUnstage(selStaged)}
                onDiscard={() => onDiscard(selTracked, selUntracked)}
                onClear={clearSelection}
              />
            )}
            <div
              ref={listRef}
              tabIndex={0}
              role="listbox"
              aria-multiselectable
              onKeyDown={onListKeyDown}
              onFocus={() => setListFocused(true)}
              onBlur={() => setListFocused(false)}
              style={{
                flex: 1,
                overflow: "auto",
                minHeight: 0,
                background: "var(--wb-panel)",
                outline: "none",
                // The focus ring: the keys below only work while this box has
                // focus, so it has to be visible that it does.
                boxShadow: listFocused ? "inset 0 0 0 1px var(--wb-borderActive)" : "none",
              }}
            >
              {status.length === 0 ? (
                <div style={{ padding: "10px 12px", font: "11px var(--wb-mono)", color: "var(--wb-done)" }}>
                  {GLYPH.ok} working tree clean
                </div>
              ) : allRows.length === 0 ? (
                <div style={{ padding: "10px 12px", font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
                  no file matches “{filter.trim()}”
                </div>
              ) : (
                GROUP_ORDER.map((group) =>
                  visible[group].length === 0 ? null : (
                    <StatusGroup
                      key={group}
                      group={group}
                      rows={visible[group]}
                      nodes={trees[group]}
                      tree={tree}
                      collapsed={collapsed}
                      onCollapse={(key) =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      selected={selected}
                      lead={lead}
                      onRowClick={onRowClick}
                      onRowMenu={onRowMenu}
                      onCheck={toggleOne}
                      busy={busy}
                      onStage={onStage}
                      onUnstage={onUnstage}
                      onDiscard={onDiscard}
                    />
                  ),
                )
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
          <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
            {pickedHunks.size > 0 && (
              <HunkBar
                count={pickedHunks.size}
                staged={leadStaged}
                busy={busy}
                onStage={() => applyHunks(pickedHunks, "stage")}
                onUnstage={() => applyHunks(pickedHunks, "unstage")}
                onDiscard={() => applyHunks(pickedHunks, "discard")}
                onClear={() => setPickedHunks(new Set())}
              />
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              {!leadRow ? (
                <Empty>select a file</Empty>
              ) : diff === null ? (
                <Empty>reading diff…</Empty>
              ) : diff.trim() === "" ? (
                <Empty>{GLYPH.warn} no textual diff</Empty>
              ) : (
                <UnifiedDiff text={diff} hunks={hunks} />
              )}
            </div>
          </div>
        }
      />
      {/* Docked full-width under both panes at every width: even wide, the file
          column is too narrow to write a commit message in, and stacking it under
          the diff would put it below the fold in a narrow column. */}
      <CommitBox
        repoRoot={repoRoot}
        stagedCount={new Set(groups.staged.map((e) => e.path)).size}
        trackedDirtyCount={new Set(groups.unstaged.map((e) => e.path)).size}
        head={head}
        hasUpstream={hasUpstream}
        busy={busy}
        committedAt={committedAt}
        focusAt={focusCommit}
        onCommit={onCommit}
      />
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </div>
  );
}

// --- bars -------------------------------------------------------------------

/** Filter + view controls above the file list (G5). */
function FilterBar({
  filter,
  onFilter,
  inputRef,
  matched,
  total,
  tree,
  onTree,
  onSelectMenu,
  onSelectMatching,
}: {
  filter: string;
  onFilter: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  matched: number;
  total: number;
  tree: boolean;
  onTree: () => void;
  onSelectMenu: (e: React.MouseEvent) => void;
  onSelectMatching: () => void;
}) {
  const filtering = filter.trim() !== "";
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
      }}
    >
      <input
        ref={inputRef}
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && filtering) {
            e.stopPropagation();
            onFilter("");
          }
        }}
        placeholder="filter files…"
        spellCheck={false}
        style={{ ...inputStyle, flex: 1, minWidth: 0, padding: "2px 6px", fontSize: 11 }}
      />
      {filtering && (
        <HeaderButton
          onClick={onSelectMatching}
          disabled={matched === 0}
          title={`select the ${matched} matching ${matched === 1 ? "row" : "rows"}`}
        >
          ▣ {matched}/{total}
        </HeaderButton>
      )}
      <HeaderButton onClick={onSelectMenu} title="select by status">
        ▤
      </HeaderButton>
      <HeaderButton
        onClick={onTree}
        accent={tree}
        title={tree ? "flat list" : "folder tree"}
      >
        {tree ? "⌸" : "≡"}
      </HeaderButton>
    </div>
  );
}

/** The bulk-action bar shown above the file list once ≥1 file is selected. */
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

/** The picked-hunks bar over the diff (G5) — the multi-hunk counterpart to the
 *  inline actions on each `@@` row. */
function HunkBar({
  count,
  staged,
  busy,
  onStage,
  onUnstage,
  onDiscard,
  onClear,
}: {
  count: number;
  staged: boolean;
  busy: boolean;
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
        gap: 11,
        padding: "4px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10.5px var(--wb-mono)",
      }}
    >
      <span style={{ color: "var(--wb-text)" }}>
        {count} {count === 1 ? "hunk" : "hunks"} picked
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 11 }}>
        {staged ? (
          <HeaderButton onClick={onUnstage} disabled={busy} accent>
            − unstage
          </HeaderButton>
        ) : (
          <>
            <HeaderButton onClick={onStage} disabled={busy} accent>
              + stage
            </HeaderButton>
            <HeaderButton onClick={onDiscard} disabled={busy} danger>
              ⨯ discard
            </HeaderButton>
          </>
        )}
        <HeaderButton onClick={onClear} disabled={busy}>
          clear
        </HeaderButton>
      </span>
    </div>
  );
}

// --- groups + rows ----------------------------------------------------------

const GROUP_LABEL: Record<Grp, string> = {
  staged: "staged",
  unstaged: "unstaged",
  untracked: "untracked",
};

function StatusGroup({
  group,
  rows,
  nodes,
  tree,
  collapsed,
  onCollapse,
  selected,
  lead,
  onRowClick,
  onRowMenu,
  onCheck,
  busy,
  onStage,
  onUnstage,
  onDiscard,
}: {
  group: Grp;
  rows: StatusRowItem[];
  nodes: TreeNode[];
  tree: boolean;
  collapsed: ReadonlySet<string>;
  onCollapse: (key: string) => void;
  selected: Set<string>;
  lead: string | null;
  onRowClick: (rowId: string, e: React.MouseEvent) => void;
  onRowMenu: (rowId: string, e: React.MouseEvent) => void;
  onCheck: (rowId: string) => void;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (tracked: string[], untracked: string[]) => void;
}) {
  // A group header acts on the selection *within this group* when there is one,
  // and on the whole group when there isn't — so "stage all" beside a live
  // selection can't quietly mean something wider than what's highlighted.
  const picked = rows.filter((r) => selected.has(r.rowId));
  const target = picked.length > 0 ? picked : rows;
  const paths = uniquePaths(target);
  const untracked = uniquePaths(target.filter((r) => r.entry.untracked));
  const untrackedSet = new Set(untracked);
  const tracked = paths.filter((p) => !untrackedSet.has(p));
  const scope = picked.length > 0 ? String(picked.length) : "all";
  const primary = group === "staged" ? "unstage" : "stage";

  return (
    <div>
      <SectionHead>
        {GROUP_LABEL[group]} <span style={{ color: "var(--wb-textFaint)" }}>{rows.length}</span>
        <button
          onClick={() => (group === "staged" ? onUnstage(paths) : onStage(paths))}
          disabled={busy}
          style={miniActionStyle}
          title={`${primary} ${paths.length} ${paths.length === 1 ? "file" : "files"}`}
        >
          {primary} {scope}
        </button>
        <button
          onClick={() => onDiscard(tracked, untracked)}
          disabled={busy}
          style={{ ...miniActionStyle, marginLeft: 10, color: "var(--wb-needs)" }}
          title={
            tracked.length === 0
              ? "delete these untracked files — asks first"
              : "revert these files to HEAD (untracked ones are deleted) — asks first"
          }
        >
          {tracked.length === 0 ? "delete" : "discard"} {scope}
        </button>
      </SectionHead>
      {tree ? (
        <TreeLevel
          nodes={nodes}
          depth={0}
          group={group}
          collapsed={collapsed}
          onCollapse={onCollapse}
          selected={selected}
          lead={lead}
          onRowClick={onRowClick}
          onRowMenu={onRowMenu}
          onCheck={onCheck}
          busy={busy}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
        />
      ) : (
        rows.map((r) => (
          <StatusRow
            key={r.rowId}
            row={r}
            depth={0}
            picked={selected.has(r.rowId)}
            lead={r.rowId === lead}
            onClick={(ev) => onRowClick(r.rowId, ev)}
            onMenu={(ev) => onRowMenu(r.rowId, ev)}
            onCheck={() => onCheck(r.rowId)}
            busy={busy}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
          />
        ))
      )}
    </div>
  );
}

/** One level of the folder tree (G5). Folders carry the action for everything
 *  under them — the "stage this directory" gesture, restricted to the rows
 *  actually in view so it can't reach past the filter. */
function TreeLevel({
  nodes,
  depth,
  group,
  collapsed,
  onCollapse,
  selected,
  lead,
  onRowClick,
  onRowMenu,
  onCheck,
  busy,
  onStage,
  onUnstage,
  onDiscard,
}: {
  nodes: TreeNode[];
  depth: number;
  group: Grp;
  collapsed: ReadonlySet<string>;
  onCollapse: (key: string) => void;
  selected: Set<string>;
  lead: string | null;
  onRowClick: (rowId: string, e: React.MouseEvent) => void;
  onRowMenu: (rowId: string, e: React.MouseEvent) => void;
  onCheck: (rowId: string) => void;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (tracked: string[], untracked: string[]) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const row = node.row;
        return row ? (
          <StatusRow
            key={node.key}
            row={row}
            depth={depth}
            picked={selected.has(row.rowId)}
            lead={row.rowId === lead}
            onClick={(ev) => onRowClick(row.rowId, ev)}
            onMenu={(ev) => onRowMenu(row.rowId, ev)}
            onCheck={() => onCheck(row.rowId)}
            busy={busy}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            label={node.name}
          />
        ) : (
          <FolderRow
            key={node.key}
            node={node}
            depth={depth}
            group={group}
            open={!collapsed.has(node.key)}
            onToggle={() => onCollapse(node.key)}
            busy={busy}
            onStage={onStage}
            onUnstage={onUnstage}
          >
            <TreeLevel
              nodes={node.children}
              depth={depth + 1}
              group={group}
              collapsed={collapsed}
              onCollapse={onCollapse}
              selected={selected}
              lead={lead}
              onRowClick={onRowClick}
              onRowMenu={onRowMenu}
              onCheck={onCheck}
              busy={busy}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          </FolderRow>
        );
      })}
    </>
  );
}

function FolderRow({
  node,
  depth,
  group,
  open,
  onToggle,
  busy,
  onStage,
  onUnstage,
  children,
}: {
  node: TreeNode;
  depth: number;
  group: Grp;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const under = leavesUnder(node);
  const paths = uniquePaths(under);
  const label = group === "staged" ? "unstage" : "stage";
  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 12px",
          paddingLeft: 12 + depth * 12,
          cursor: "pointer",
          font: "11px var(--wb-mono)",
          color: "var(--wb-textDim2)",
          userSelect: "none",
        }}
      >
        <span aria-hidden style={{ width: 7, color: "var(--wb-textFaint)", font: "8px var(--wb-mono)" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={node.path}>
          {node.name}/
        </span>
        <span style={{ flex: "0 0 auto", color: "var(--wb-textFaint)", font: "10px var(--wb-mono)" }}>
          {paths.length}
        </span>
        <span style={{ flex: "0 0 auto", visibility: hover ? "visible" : "hidden" }}>
          <RowAction
            onClick={(ev) => {
              ev?.stopPropagation();
              if (group === "staged") onUnstage(paths);
              else onStage(paths);
            }}
            label={`${label} the ${paths.length} ${paths.length === 1 ? "file" : "files"} under ${node.path}`}
            disabled={busy}
          >
            {group === "staged" ? "−" : "+"}
          </RowAction>
        </span>
      </div>
      {open && children}
    </>
  );
}

function StatusRow({
  row,
  depth,
  picked,
  lead,
  onClick,
  onMenu,
  onCheck,
  busy,
  onStage,
  onUnstage,
  onDiscard,
  label,
}: {
  row: StatusRowItem;
  depth: number;
  /** In the multi-selection (checkbox ticked + highlighted background). */
  picked: boolean;
  /** The lead row driving the diff pane (highlighted left bar). */
  lead: boolean;
  onClick: (e: React.MouseEvent) => void;
  onMenu: (e: React.MouseEvent) => void;
  onCheck: () => void;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (tracked: string[], untracked: string[]) => void;
  /** Tree mode shows the basename; the flat list shows the whole path. */
  label?: string;
}) {
  const [hover, setHover] = useState(false);
  const { entry, group } = row;
  const ch = charOf(entry);
  const staged = group === "staged";
  return (
    <div
      data-rowid={row.rowId}
      role="option"
      aria-selected={picked}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      onContextMenu={onMenu}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 12px",
        paddingLeft: 12 + depth * 12,
        borderLeft: `2px solid ${lead ? "var(--wb-selBar)" : "transparent"}`,
        background: picked ? "var(--wb-sel)" : "transparent",
        cursor: "pointer",
        font: "11px var(--wb-mono)",
        // Stop Shift-click from text-selecting the file names as a range is picked.
        userSelect: "none",
      }}
    >
      <button
        onClick={(e) => {
          // The checkbox is *only* about membership: it must not move the lead, or
          // ticking a box would swap the diff you were reading.
          e.stopPropagation();
          onCheck();
        }}
        role="checkbox"
        aria-checked={picked}
        aria-label={`select ${entry.path}`}
        title="add to / remove from the selection"
        style={{
          flex: "0 0 auto",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          font: "11px var(--wb-mono)",
          color: picked ? "var(--wb-accent)" : "var(--wb-textFaint)",
        }}
      >
        {picked ? "▣" : "▢"}
      </button>
      <span style={{ flex: "0 0 auto", width: 9, color: statusCharColor(ch) }}>{ch}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: picked || lead ? "var(--wb-text)" : "var(--wb-textDim2)",
        }}
        title={entry.path}
      >
        {label ?? entry.path}
      </span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 8, visibility: hover ? "visible" : "hidden" }}>
        <RowAction
          onClick={(ev) => {
            ev?.stopPropagation();
            if (staged) onUnstage([entry.path]);
            else onStage([entry.path]);
          }}
          label={staged ? "unstage" : "stage"}
          disabled={busy}
        >
          {staged ? "−" : "+"}
        </RowAction>
        {!staged && (
          <RowAction
            onClick={(ev) => {
              ev?.stopPropagation();
              if (entry.untracked) onDiscard([], [entry.path]);
              else onDiscard([entry.path], []);
            }}
            label={entry.untracked ? "delete this untracked file" : "discard changes"}
            disabled={busy}
            danger
          >
            ⨯
          </RowAction>
        )}
      </span>
    </div>
  );
}

// --- stashes ----------------------------------------------------------------

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
        <button
          onClick={() => onStashPush(null, true)}
          disabled={busy || !hasChanges}
          style={miniActionStyle}
          title="stash all changes (incl. untracked)"
        >
          stash
        </button>
      </SectionHead>
      {open &&
        (stashes.length === 0 ? (
          <div style={{ padding: "3px 14px 8px", font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
            no stashes
          </div>
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
      <span
        style={{ flex: 1, minWidth: 0, color: "var(--wb-textDim2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={stash.message}
      >
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

// --- tree building ----------------------------------------------------------

/** A folder tree node. Leaves carry their `row`; folders carry `children`. */
interface TreeNode {
  /** Unique across groups (a path can appear in two of them). */
  key: string;
  /** What's drawn: a path segment for folders, the basename for files. */
  name: string;
  /** Repo-relative path of the folder or file. */
  path: string;
  row?: StatusRowItem;
  children: TreeNode[];
}

/** Group one group's rows into a folder tree, folders before files at each level. */
function buildTree(rows: StatusRowItem[], group: Grp): TreeNode[] {
  const root: TreeNode = { key: `${group}:/`, name: "", path: "", children: [] };
  for (const row of rows) {
    const parts = row.entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = node.children.find((c) => !c.row && c.path === path);
      if (!next) {
        next = { key: `${group}:${path}/`, name: parts[i], path, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.children.push({
      key: row.rowId,
      name: parts[parts.length - 1],
      path: row.entry.path,
      row,
      children: [],
    });
  }
  sortLevel(root);
  return root.children;
}

function sortLevel(node: TreeNode): void {
  node.children.sort((a, b) => {
    const dirA = a.row ? 1 : 0;
    const dirB = b.row ? 1 : 0;
    return dirA - dirB || a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (!c.row) sortLevel(c);
}

/** Leaf rows in display order, skipping collapsed subtrees — the keyboard's order. */
function flattenTree(nodes: TreeNode[], collapsed: ReadonlySet<string>, out: StatusRowItem[]): void {
  for (const n of nodes) {
    if (n.row) out.push(n.row);
    else if (!collapsed.has(n.key)) flattenTree(n.children, collapsed, out);
  }
}

/** Every row under a folder, collapsed or not — what its action applies to. */
function leavesUnder(node: TreeNode): StatusRowItem[] {
  const out: StatusRowItem[] = [];
  const walk = (n: TreeNode) => {
    if (n.row) out.push(n.row);
    else for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

// --- small helpers ----------------------------------------------------------

/** Distinct paths behind a set of rows (a file can be two rows). */
function uniquePaths(rows: StatusRowItem[]): string[] {
  return [...new Set(rows.map((r) => r.entry.path))];
}

/** The most telling status char for the glyph: staged side if present, else worktree. */
function charOf(entry: StatusEntry): string {
  return entry.untracked ? "?" : entry.index !== " " ? entry.index : entry.worktree;
}

/** There's no file on disk to open or reveal. */
function isDeleted(entry: StatusEntry): boolean {
  return !entry.untracked && (entry.index === "D" || entry.worktree === "D");
}
