// The review panel's diff (step V1): the file at the base against the working tree,
// in `@codemirror/merge`. One component for both layouts — unified (one editor, the
// removed lines drawn above the lines that replaced them) and side by side (the
// base, read-only, beside the working tree) — with syntax highlighting, the changed
// words marked inside changed lines, and long unchanged stretches collapsed.
//
// The working-tree side is a real editor: edit in place, Ctrl+S saves (the panel's
// `onSave`). That is what replaced the panel's separate edit mode.
//
// Built once per mount; the panel keys it by path, layout and reload, and hands the
// current buffer back in as `doc`, so a layout switch keeps unsaved edits.

import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { MergeView, unifiedMergeView } from "@codemirror/merge";

import type { DiffLayout } from "../../ipc/prefs";
import { codeMirrorTheme, diffTheme } from "../../theme";
import { useThemeVersion } from "../../state/appearance";
import { persistScroll } from "../Editor/scrollMemory";

/** Unchanged lines kept around a change, and the shortest run worth collapsing. */
const COLLAPSE = { margin: 3, minSize: 4 };
/** Give up refining a diff after this long (ms) and show a coarser one: a guard for
 *  pathological files, with `scanLimit` at the library's default for the merge view. */
const DIFF_CONFIG = { scanLimit: 500, timeout: 1500 };

interface MergeDiffProps {
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

function MergeDiff({ layout, original, doc, editable, language, scrollKey, onChange, onSave }: MergeDiffProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const views = useRef<EditorView[]>([]);
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
    const working: Extension[] = editable
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
        b: { doc, extensions: [...shared, ...working] },
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
      scroller = merge.dom;
      destroy = () => merge.destroy();
    } else {
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            ...shared,
            ...working,
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
      scroller = view.scrollDOM;
      destroy = () => view.destroy();
    }
    const stopScroll = persistScroll(scroller, scrollKey);

    return () => {
      stopScroll();
      views.current = [];
      destroy();
    };
    // Built once per mount: the panel keys this component on everything that
    // should rebuild it, and the texts are only the starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const v of views.current) {
      v.dispatch({ effects: themeCompartment.current.reconfigure([codeMirrorTheme(), diffTheme()]) });
    }
  }, [themeVersion]);

  return <div ref={hostRef} style={{ height: "100%", width: "100%", overflow: "hidden" }} />;
}

export default MergeDiff;
