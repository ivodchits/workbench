// The review panel's diff (step V1): the file at the base against the working tree,
// in `@codemirror/merge`. One component for both layouts — unified (one editor, the
// removed lines drawn above the lines that replaced them) and side by side (the
// base, read-only, beside the working tree) — with syntax highlighting, the changed
// words marked inside changed lines, and long unchanged stretches collapsed.
//
// The working-tree side is a real editor: edit in place, Ctrl+S saves (the panel's
// `onSave`). That is what replaced the panel's separate edit mode.
//
// Built once per mount; the panel keys it by path and layout, and hands the current
// buffer back in as `doc`, so a layout switch keeps unsaved edits. Later versions of
// the file arrive through the handle's `update` (step V2), which patches the open
// view in place so a refresh keeps the cursor and the scroll position.
//
// Step V3 added review comments (a gutter on the working-tree side, see
// `commentMarks`) and a revert button on each change, which asks the panel first
// (`onRevert`) and then puts the base's lines back into the buffer — an ordinary
// edit, so Ctrl+Z still has it.

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import {
  ChangeSet,
  Compartment,
  EditorState,
  Prec,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  MergeView,
  getChunks,
  getOriginalDoc,
  rejectChunk,
  unifiedMergeView,
  updateOriginalDoc,
} from "@codemirror/merge";

import type { DiffLayout } from "../../ipc/prefs";
import { codeMirrorTheme, diffTheme } from "../../theme";
import { useThemeVersion } from "../../state/appearance";
import { forgetScroll, persistScroll } from "../Editor/scrollMemory";
import { stepChange, textPatch } from "./mergeNav";
import { commentLines, commentMarks, selectedLines, syncComments, type CommentSpan } from "./commentMarks";

/** Unchanged lines kept around a change, and the shortest run worth collapsing. */
const COLLAPSE = { margin: 3, minSize: 4 };
/** Give up refining a diff after this long (ms) and show a coarser one: a guard for
 *  pathological files, with `scanLimit` at the library's default for the merge view. */
const DIFF_CONFIG = { scanLimit: 500, timeout: 1500 };

/** Where each change starts in the working-tree editor, in document order. */
function changeStarts(view: EditorView): number[] {
  return getChunks(view.state)?.chunks.map((c) => c.fromB) ?? [];
}

/** Move `view`'s cursor to the next / previous change; false when there is none. */
function stepView(view: EditorView, dir: 1 | -1): boolean {
  const at = stepChange(changeStarts(view), view.state.selection.main.head, dir);
  if (at === null) return false;
  view.dispatch({
    selection: { anchor: at },
    userEvent: "select.byChunk",
    effects: EditorView.scrollIntoView(at, { y: "center" }),
  });
  view.focus();
  return true;
}

/** A refresh's edit: kept out of the undo history, so Ctrl+Z can't undo the agent. */
const NOT_UNDOABLE = Transaction.addToHistory.of(false);

/** What the panel can do to an open merge view (step V2). */
export interface MergeDiffHandle {
  /** Move the cursor to the next / previous change and scroll it into view. False
   *  when there is none that way, so the panel can move on to another file. */
  step: (dir: 1 | -1) => boolean;
  /** Show newer texts of both sides, changing only what differs. */
  update: (original: string, current: string) => void;
  /** The working-tree lines the selection covers (the cursor's line when nothing is
   *  selected), with their text. */
  selection: () => { fromLine: number; toLine: number; text: string } | null;
  /** Move the cursor to a working-tree line and scroll it into view. */
  goToLine: (line: number) => void;
  /** The working-tree text as it stands in the editor. */
  content: () => string | null;
}

/** A revert waiting for the panel's confirm: run it to revert; false when the file
 *  changed in between (nothing is reverted then). */
export type PendingRevert = () => boolean;

function revertButton(text: string, onDown: (el: HTMLElement) => void): HTMLElement {
  const el = document.createElement("button");
  el.className = "cm-wb-revert";
  el.textContent = text;
  el.title = "revert this change to the base version — asks first";
  el.setAttribute("aria-label", "revert this change");
  el.onmousedown = (e) => {
    e.preventDefault();
    onDown(el);
  };
  return el;
}

/** Where a freshly built view puts its cursor. */
export type StartAt = "first" | "last" | { line: number };

/** Put the cursor at the start of `line` (clamped) and scroll it to the middle. */
function goToLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
  view.focus();
}

interface MergeDiffProps {
  ref?: Ref<MergeDiffHandle>;
  /** Put the cursor on the first or last change once built — where navigation
   *  arriving from the previous or next file lands — or on a line (a comment's). */
  start?: StartAt;
  layout: DiffLayout;
  /** The file at the base ("" for a file that didn't exist there). */
  original: string;
  /** The working-tree text to start from (may hold unsaved edits). */
  doc: string;
  /** False for a deleted file: there is nothing on disk to edit. */
  editable: boolean;
  language: Extension | null;
  /** Remembers the scroll offset across tab switches (dockview detaches the DOM). */
  scrollKey: string;
  /** This file's review comments, kept marked in the gutter (step V3). */
  comments: readonly CommentSpan[];
  /** The gutter's "+" was clicked: comment these lines. */
  onAddComment: (fromLine: number, toLine: number, text: string) => void;
  /** Edits moved commented lines: where each comment is now. */
  onCommentsMoved: (lines: Map<string, [number, number]>) => void;
  /** A change's revert button: confirm, then run `revert`. */
  onRevert: (revert: PendingRevert) => void;
  onChange: (content: string) => void;
  onSave: (content: string) => void;
}

function MergeDiff({
  ref,
  start,
  layout,
  original,
  doc,
  editable,
  language,
  scrollKey,
  comments,
  onAddComment,
  onCommentsMoved,
  onRevert,
  onChange,
  onSave,
}: MergeDiffProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const views = useRef<EditorView[]>([]);
  /** The editor holding the working tree (the only one, unified), and the base's
   *  editor side by side. */
  const working = useRef<EditorView | null>(null);
  const baseView = useRef<EditorView | null>(null);

  function step(dir: 1 | -1): boolean {
    const view = working.current;
    return view ? stepView(view, dir) : false;
  }

  function update(original: string, current: string): void {
    const view = working.current;
    if (!view) return;
    const nextOriginal = original.replace(/\r\n/g, "\n");
    const base = baseView.current;
    if (base) {
      const p = textPatch(base.state.doc.toString(), nextOriginal);
      if (p) base.dispatch({ changes: p, annotations: NOT_UNDOABLE });
    } else {
      const old = getOriginalDoc(view.state);
      const p = textPatch(old.toString(), nextOriginal);
      if (p) {
        const changes = ChangeSet.of(p, old.length);
        view.dispatch({ effects: updateOriginalDoc.of({ doc: changes.apply(old), changes }) });
      }
    }
    const p = textPatch(view.state.doc.toString(), current.replace(/\r\n/g, "\n"));
    if (p) view.dispatch({ changes: p, annotations: NOT_UNDOABLE });
  }
  function selection(): { fromLine: number; toLine: number; text: string } | null {
    const view = working.current;
    if (!view) return null;
    const [fromLine, toLine] = selectedLines(view.state);
    const doc = view.state.doc;
    return { fromLine, toLine, text: doc.sliceString(doc.line(fromLine).from, doc.line(toLine).to) };
  }

  const themeCompartment = useRef(new Compartment());
  const themeVersion = useThemeVersion();

  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onAddRef = useRef(onAddComment);
  const onMovedRef = useRef(onCommentsMoved);
  const onRevertRef = useRef(onRevert);
  const commentsRef = useRef(comments);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onAddRef.current = onAddComment;
  onMovedRef.current = onCommentsMoved;
  onRevertRef.current = onRevert;
  commentsRef.current = comments;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shared: Extension[] = [
      lineNumbers(),
      drawSelection(),
      bracketMatching(),
      highlightSelectionMatches(),
      themeCompartment.current.of([codeMirrorTheme(), diffTheme()]),
      ...(language ? [language] : []),
    ];
    const readOnly: Extension[] = [EditorState.readOnly.of(true)];
    const editing: Extension[] = editable
      ? [
          history(),
          indentOnInput(),
          highlightActiveLine(),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: (view) => {
                  onSaveRef.current(view.state.doc.toString());
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ]
      : [...readOnly, keymap.of([...defaultKeymap, ...searchKeymap])];
    // Comments go on the working tree, the file the agent will read. Their lines
    // follow every edit — typing here, a refresh, a revert — and are reported back.
    const commenting: Extension[] = [
      commentMarks((fromLine, toLine) => {
        const view = working.current;
        if (!view) return;
        const doc = view.state.doc;
        onAddRef.current(fromLine, toLine, doc.sliceString(doc.line(fromLine).from, doc.line(toLine).to));
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const lines = commentLines(u.state);
        const moved = commentsRef.current.some((c) => {
          const at = lines.get(c.id);
          return at && (at[0] !== c.fromLine || at[1] !== c.toLine);
        });
        if (moved) onMovedRef.current(lines);
      }),
    ];

    let scroller: HTMLElement;
    let destroy: () => void;
    if (layout === "split") {
      const merge = new MergeView({
        a: { doc: original, extensions: [...shared, ...readOnly, keymap.of([...defaultKeymap, ...searchKeymap])] },
        b: { doc, extensions: [...shared, ...editing, ...commenting] },
        parent: host,
        ...(editable ? { revertControls: "a-to-b" as const, renderRevertControl: () => revertButton("↶", () => {}) } : {}),
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE,
        diffConfig: DIFF_CONFIG,
      });
      // Unlike a lone editor, the merge view doesn't scroll itself: its box does.
      merge.dom.style.height = "100%";
      merge.dom.style.overflow = "auto";
      // The library reverts on mousedown in its own listener; take the press first
      // and ask before doing the same revert.
      merge.dom.addEventListener(
        "mousedown",
        (e) => {
          const button = (e.target as HTMLElement | null)?.closest<HTMLElement>(".cm-merge-revert > [data-chunk]");
          if (!button) return;
          e.preventDefault();
          e.stopPropagation();
          const chunk = merge.chunks[Number(button.dataset.chunk)];
          if (!chunk) return;
          const docA = merge.a.state.doc;
          const docB = merge.b.state.doc;
          onRevertRef.current(() => {
            if (merge.a.state.doc !== docA || merge.b.state.doc !== docB) return false;
            let insert = docA.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
            if (chunk.fromA !== chunk.toA && chunk.toB <= docB.length) insert += merge.b.state.lineBreak;
            merge.b.dispatch({
              changes: { from: chunk.fromB, to: Math.min(docB.length, chunk.toB), insert },
              userEvent: "revert",
            });
            return true;
          });
        },
        true,
      );
      views.current = [merge.a, merge.b];
      working.current = merge.b;
      baseView.current = merge.a;
      scroller = merge.dom;
      destroy = () => merge.destroy();
    } else {
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            ...shared,
            ...editing,
            ...commenting,
            unifiedMergeView({
              original,
              // One button per change, revert. The library's other one, "accept"
              // (fold the change into the base), means nothing here.
              mergeControls: editable
                ? (type) =>
                    type === "accept"
                      ? document.createElement("span")
                      : revertButton("↶ revert", (el) => {
                          const view = working.current;
                          if (!view) return;
                          const pos = view.posAtDOM(el);
                          const doc = view.state.doc;
                          onRevertRef.current(() => view.state.doc === doc && rejectChunk(view, pos));
                        })
                : false,
              gutter: true,
              highlightChanges: true,
              syntaxHighlightDeletions: true,
              collapseUnchanged: COLLAPSE,
              diffConfig: DIFF_CONFIG,
            }),
          ],
        }),
      });
      views.current = [view];
      working.current = view;
      baseView.current = null;
      scroller = view.scrollDOM;
      destroy = () => view.destroy();
    }
    const initial = working.current && syncComments(working.current.state, commentsRef.current);
    if (initial) working.current?.dispatch({ effects: initial });
    if (start) forgetScroll(scrollKey);
    const stopScroll = persistScroll(scroller, scrollKey);
    const view = working.current;
    if (view && typeof start === "object") {
      goToLine(view, start.line);
    } else if (view && start) {
      view.dispatch({ selection: { anchor: start === "first" ? 0 : view.state.doc.length } });
      step(start === "first" ? 1 : -1);
    }

    return () => {
      stopScroll();
      views.current = [];
      working.current = null;
      baseView.current = null;
      destroy();
    };
    // Built once per mount: the panel keys this component on everything that
    // should rebuild it, and the texts are only the starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    step,
    update,
    selection,
    goToLine: (line) => working.current && goToLine(working.current, line),
    content: () => working.current?.state.doc.toString() ?? null,
  }));

  // Comments added, edited or removed in the panel: show them.
  useEffect(() => {
    const view = working.current;
    if (!view) return;
    const effect = syncComments(view.state, comments);
    if (effect) view.dispatch({ effects: effect });
  }, [comments]);

  useEffect(() => {
    for (const v of views.current) {
      v.dispatch({ effects: themeCompartment.current.reconfigure([codeMirrorTheme(), diffTheme()]) });
    }
  }, [themeVersion]);

  return <div ref={hostRef} style={{ height: "100%", width: "100%", overflow: "hidden" }} />;
}

export default MergeDiff;
