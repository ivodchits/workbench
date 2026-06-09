// CodeMirror 6 editor view (step 1.8). A thin React wrapper that owns one
// `EditorView` for the lifetime of one open file. The parent keys this component
// by file path, so switching tabs mounts a fresh view seeded from the store's
// buffer (preserving unsaved text) with its own clean undo history — no risk of
// an undo reaching across into another file's content.
//
// Edits flow out via `onChange` (into the editors store); `onSave` fires on
// Ctrl/Cmd+S with the view's current text; `onCursor` reports the caret position
// for the footer. Callbacks are read through refs so the long-lived view never
// holds a stale closure when the parent re-renders.

import { useEffect, useRef } from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";

import { codeMirrorTheme } from "../../theme";

interface CodeMirrorViewProps {
  /** Stable for the component's life — the parent keys on it. */
  path: string;
  /** Initial buffer text (from the store; may hold unsaved edits). */
  initialDoc: string;
  /** Language extension for `path`, or null for plain text. */
  language: Extension | null;
  /** Fired on every edit with the new document text. */
  onChange: (content: string) => void;
  /** Fired on Ctrl/Cmd+S with the current document text. */
  onSave: (content: string) => void;
  /** Fired on Ctrl/Cmd+Shift+S — save every dirty tab in this editor. */
  onSaveAll: () => void;
  /** Fired when the caret moves, with 1-based line/column. */
  onCursor?: (line: number, col: number) => void;
}

function CodeMirrorView({
  path,
  initialDoc,
  language,
  onChange,
  onSave,
  onSaveAll,
  onCursor,
}: CodeMirrorViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Latest callbacks, so the view (built once per `path`) never calls a stale one.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onSaveAllRef = useRef(onSaveAll);
  const onCursorRef = useRef(onCursor);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onSaveAllRef.current = onSaveAll;
  onCursorRef.current = onCursor;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      if ((update.docChanged || update.selectionSet) && onCursorRef.current) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorRef.current(line.number, head - line.from + 1);
      }
    });

    const saveKey = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: (view) => {
            onSaveRef.current(view.state.doc.toString());
            return true;
          },
        },
        {
          key: "Mod-Shift-s",
          preventDefault: true,
          run: () => {
            onSaveAllRef.current();
            return true;
          },
        },
      ]),
    );

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      saveKey,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      codeMirrorTheme(),
      ...(language ? [language] : []),
      updateListener,
    ];

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: initialDoc, extensions }),
    });
    view.focus();

    return () => view.destroy();
    // `path` keys the mount; doc/language are read at creation. Editing the same
    // file never changes these, so the view is built exactly once per open file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div ref={hostRef} style={{ height: "100%", width: "100%", overflow: "hidden" }} />;
}

export default CodeMirrorView;
