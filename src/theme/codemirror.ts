// CodeMirror theme derived from the same `ThemeTokens` that drive the chrome and
// the xterm theme, so the editor reads as part of the one continuous terminal
// surface (design §5.x: "CodeMirror gets a matching theme so the editor doesn't
// break the spell"). One token edit recolors chrome, terminals, and editor alike.
//
// Two halves: an `EditorView.theme` for the editor's own chrome (background,
// gutters, cursor, selection, active line) and a `HighlightStyle` mapping Lezer
// syntax tags to the shared `str`/`kw`/`fn`/`num`/`com` tokens. Both are returned
// as a single extension array ready to drop into an `EditorState`.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

import { activeTheme, mono, type ThemeTokens } from "./tokens";

/**
 * Build the editor-chrome theme. `dark: true` tells CodeMirror's own defaults
 * (e.g. the focus ring) to assume a dark base, matching our surfaces.
 */
function editorChrome(tokens: ThemeTokens): Extension {
  return EditorView.theme(
    {
      "&": {
        color: tokens.text,
        backgroundColor: tokens.bg,
        height: "100%",
        fontSize: "12.5px",
      },
      ".cm-content": {
        fontFamily: mono,
        caretColor: tokens.accent,
        padding: "6px 0",
      },
      ".cm-scroller": {
        fontFamily: mono,
        lineHeight: "1.6",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: tokens.accent,
        borderLeftWidth: "2px",
      },
      // Selection layer — target both focused and unfocused so a click-away keeps
      // the highlight visible (CM splits these across two rules).
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: tokens.sel,
        },
      ".cm-activeLine": {
        backgroundColor: tokens.titlebar,
      },
      ".cm-gutters": {
        backgroundColor: tokens.bg,
        color: tokens.textFaint,
        border: "none",
        fontFamily: mono,
      },
      ".cm-activeLineGutter": {
        backgroundColor: tokens.titlebar,
        color: tokens.textDim2,
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 8px 0 12px",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: tokens.sel,
        border: "none",
        color: tokens.textDim2,
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: tokens.accentSoft,
        outline: `1px solid ${tokens.border}`,
      },
      ".cm-selectionMatch": {
        backgroundColor: tokens.accentSoft,
      },
    },
    { dark: true },
  );
}

/** Map Lezer syntax tags to the shared syntax tokens (`str`/`kw`/`fn`/`num`/`com`). */
function highlightStyle(tokens: ThemeTokens): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: tokens.kw },
    { tag: [t.string, t.special(t.string), t.regexp], color: tokens.str },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
      color: tokens.fn,
    },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: tokens.fn },
    { tag: [t.number, t.bool, t.null, t.atom], color: tokens.num },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: tokens.com, fontStyle: "italic" },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: tokens.textDim2 },
    { tag: [t.propertyName, t.attributeName], color: tokens.text },
    { tag: [t.variableName, t.definition(t.variableName)], color: tokens.text },
    { tag: [t.invalid], color: tokens.needs },
    // Markdown structure — keep prose readable while marking the syntax.
    { tag: [t.heading], color: tokens.accent, fontWeight: "600" },
    { tag: [t.link, t.url], color: tokens.fn, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "600" },
    { tag: [t.quote], color: tokens.textDim2 },
    { tag: [t.monospace], color: tokens.str },
  ]);
}

/**
 * The full editor theme extension (chrome + syntax highlighting) for `tokens`,
 * defaulting to the active app theme. The Phase-3 theme switcher rebuilds the
 * editor with the new theme, exactly as it re-derives the xterm theme.
 */
export function codeMirrorTheme(tokens: ThemeTokens = activeTheme): Extension {
  return [editorChrome(tokens), syntaxHighlighting(highlightStyle(tokens))];
}
