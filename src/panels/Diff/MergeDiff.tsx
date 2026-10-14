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
import { MergeView, getChunks, getOriginalDoc, unifiedMergeView, updateOriginalDoc } from "@codemirror/merge";

import type { DiffLayout } from "../../ipc/prefs";
import { codeMirrorTheme, diffTheme } from "../../theme";
import { useThemeVersion } from "../../state/appearance";
import { forgetScroll, persistScroll } from "../Editor/scrollMemory";
import { stepChange, textPatch } from "./mergeNav";

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
}

interface MergeDiffProps {
  ref?: Ref<MergeDiffHandle>;
  /** Put the cursor on the first or last change once built — where navigation
   *  arriving from the previous or next file lands. */
  start?: "first" | "last";
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
  const themeCompartment = useRef(new Compartment());
  const themeVersion = useThemeVersion();

  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

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

    let scroller: HTMLElement;
    let destroy: () => void;
    if (layout === "split") {
      const merge = new MergeView({
        a: { doc: original, extensions: [...shared, ...readOnly, keymap.of([...defaultKeymap, ...searchKeymap])] },
        b: { doc, extensions: [...shared, ...editing] },
        parent: host,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE,
        diffConfig: DIFF_CONFIG,
      });
      // Unlike a lone editor, the merge view doesn't scroll itself: its box does.
      merge.dom.style.height = "100%";
      merge.dom.style.overflow = "auto";
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
            unifiedMergeView({
              original,
              mergeControls: false,
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
    if (start) forgetScroll(scrollKey);
    const stopScroll = persistScroll(scroller, scrollKey);
    if (start) {
      const view = working.current;
      if (view) {
        view.dispatch({ selection: { anchor: start === "first" ? 0 : view.state.doc.length } });
        step(start === "first" ? 1 : -1);
      }
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

  useImperativeHandle(ref, () => ({ step, update }));

  useEffect(() => {
    for (const v of views.current) {
      v.dispatch({ effects: themeCompartment.current.reconfigure([codeMirrorTheme(), diffTheme()]) });
    }
  }, [themeVersion]);

  return <div ref={hostRef} style={{ height: "100%", width: "100%", overflow: "hidden" }} />;
}

export default MergeDiff;
