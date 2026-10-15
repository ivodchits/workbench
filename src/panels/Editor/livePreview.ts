// Markdown that reads as formatted text while it is edited (step N2). Headings,
// emphasis, code, links, lists, quotes and fences are styled in place, and their
// markup (`#`, `**`, backticks, `[…](…)`, `>`) is hidden — except on the lines the
// cursor or selection touches, where the source shows so it can be edited. With
// the editor unfocused every line reads rendered.
//
// It works off the markdown syntax tree, so it needs the markdown language (GFM
// for strikethrough and task lists) in the same editor. Ctrl/Cmd+click on a
// rendered link opens it; clicking a task box ticks it.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { openUrl } from "../../ipc/os";

/** The line numbers whose markup shows: every line a selection range touches. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  return lines;
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    return el;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** Where the `[ ]` starts, to tick it. */
    readonly at: number,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = `cm-md-task${this.checked ? " cm-md-task-on" : ""}`;
    el.textContent = this.checked ? "▣" : "▢";
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" } });
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });
const LINK = mark("cm-md-link");
const CODE = mark("cm-md-code");
const STRIKE = mark("cm-md-strike");

/** The decorations for `state` over `from`–`to`. Lines in `active` keep their
 *  markup; pass null to keep it everywhere (styling only). Exported for tests. */
export function liveDecorations(
  state: EditorState,
  active: Set<number> | null,
  from = 0,
  to = state.doc.length,
): Range<Decoration>[] {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const isActive = (pos: number) => active === null || active.has(doc.lineAt(pos).number);
  /** Every line `from`–`to` spans, as line starts. */
  const linesOf = (a: number, b: number) => {
    const starts: number[] = [];
    for (let n = doc.lineAt(a).number, last = doc.lineAt(b).number; n <= last; n++) starts.push(doc.line(n).from);
    return starts;
  };
  /** Hide `a`–`b` plus the spaces after it, unless its line is active. */
  const hideMark = (a: number, b: number, withSpace = false) => {
    if (isActive(a)) return;
    let end = b;
    if (withSpace) while (end < doc.length && doc.sliceString(end, end + 1) === " ") end++;
    if (end > a) out.push(hide.range(a, end));
  };

  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      const name = node.name;
      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        out.push(line(`cm-md-h cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from));
        return;
      }
      switch (name) {
        case "HeaderMark": {
          // ATX `#`s before the text, a closing `###`, or a setext underline.
          const parent = node.node.parent?.name ?? "";
          if (parent.startsWith("Setext")) {
            if (!isActive(node.from)) out.push(hide.range(node.from, node.to));
          } else hideMark(node.from, node.to, true);
          return;
        }
        case "EmphasisMark":
        case "CodeMark":
        case "StrikethroughMark":
          // Fence backticks hide too, leaving the fence's language as a label.
          hideMark(node.from, node.to);
          return;
        case "InlineCode":
          out.push(CODE.range(node.from, node.to));
          return;
        case "Strikethrough":
          out.push(STRIKE.range(node.from, node.to));
          return;
        case "Link": {
          // `[text](url "title")`: the text styled, the rest hidden off the active line.
          const marks = node.node.getChildren("LinkMark");
          if (marks.length >= 2) {
            out.push(LINK.range(marks[0].to, marks[1].from));
            if (!isActive(node.from)) {
              out.push(hide.range(marks[0].from, marks[0].to));
              out.push(hide.range(marks[1].from, node.to));
            }
          }
          return;
        }
        case "Autolink":
          // `<https://…>`: the address styled, the brackets hidden.
          for (const m of node.node.getChildren("LinkMark")) hideMark(m.from, m.to);
          return;
        case "URL":
          if (node.node.parent?.name !== "Link") out.push(LINK.range(node.from, node.to));
          return;
        case "ListMark":
          if (node.node.parent?.parent?.name === "BulletList" && !isActive(node.from)) {
            // A task's `-` goes entirely; its box stands for it.
            const task = node.node.nextSibling?.name === "Task";
            out.push((task ? hide : bullet).range(node.from, task ? skipSpaces(doc.sliceString(node.to, node.to + 4), node.to) : node.to));
          }
          return;
        case "TaskMarker": {
          const checked = /x/i.test(doc.sliceString(node.from, node.to));
          if (checked) out.push(line("cm-md-done").range(doc.lineAt(node.from).from));
          if (!isActive(node.from)) {
            out.push(Decoration.replace({ widget: new TaskWidget(checked, node.from) }).range(node.from, node.to));
          }
          return;
        }
        case "Blockquote":
          for (const at of linesOf(node.from, node.to)) out.push(line("cm-md-quote").range(at));
          return;
        case "QuoteMark":
          hideMark(node.from, node.to, true);
          return;
        case "FencedCode":
        case "CodeBlock": {
          const starts = linesOf(node.from, node.to);
          starts.forEach((at, i) => {
            const edge = name === "FencedCode" && (i === 0 || i === starts.length - 1);
            out.push(line(edge ? "cm-md-fence cm-md-fence-edge" : "cm-md-fence").range(at));
          });
          return;
        }
        case "HorizontalRule":
          out.push(line("cm-md-hr").range(doc.lineAt(node.from).from));
          if (!isActive(node.from)) out.push(hide.range(node.from, node.to));
          return;
      }
    },
  });
  return out;
}

function skipSpaces(after: string, at: number): number {
  let n = 0;
  while (n < after.length && after[n] === " ") n++;
  return at + n;
}

function build(view: EditorView): DecorationSet {
  const active = view.hasFocus ? activeLines(view.state) : new Set<number>();
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) ranges.push(...liveDecorations(view.state, active, from, to));
  return Decoration.set(ranges, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.focusChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (p) => p.decorations },
);

/** Ctrl/Cmd+click on a link opens it. */
const openLinks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return false;
    const url = linkAt(view.state, pos);
    if (!url) return false;
    e.preventDefault();
    void openUrl(url).catch(() => {});
    return true;
  },
});

/** The web address of the link at `pos`, if there is one. Exported for tests. */
export function linkAt(state: EditorState, pos: number): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      const text = url ? state.doc.sliceString(url.from, url.to) : "";
      return /^https?:\/\//i.test(text) ? text : null;
    }
    if (node.name === "URL") {
      const text = state.doc.sliceString(node.from, node.to);
      return /^https?:\/\//i.test(text) ? text : null;
    }
  }
  return null;
}

const theme = EditorView.baseTheme({
  ".cm-md-h": { fontWeight: "600", color: "var(--wb-text)", lineHeight: "1.4" },
  ".cm-md-h1": { fontSize: "1.5em", paddingTop: "0.4em" },
  ".cm-md-h2": { fontSize: "1.28em", paddingTop: "0.3em" },
  ".cm-md-h3": { fontSize: "1.13em", paddingTop: "0.2em" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { color: "var(--wb-textDim2)" },
  // The highlight style colours heading text; in the live view headings read as text.
  ".cm-md-h *": { color: "inherit" },
  ".cm-md-code": {
    background: "var(--wb-panel)",
    border: "1px solid var(--wb-border)",
    padding: "0 3px",
  },
  ".cm-md-link, .cm-md-link *": { color: "var(--wb-accent)", textDecoration: "underline", cursor: "pointer" },
  ".cm-md-strike": { textDecoration: "line-through", color: "var(--wb-textDim2)" },
  ".cm-md-bullet": { color: "var(--wb-accent)", paddingRight: "0.2em" },
  ".cm-md-task": { cursor: "pointer", color: "var(--wb-textFaint)", paddingRight: "0.4em" },
  ".cm-md-task-on": { color: "var(--wb-done)" },
  ".cm-md-done": { color: "var(--wb-textDim2)", textDecoration: "line-through" },
  ".cm-md-quote": {
    borderLeft: "2px solid var(--wb-accent)",
    paddingLeft: "10px !important",
    color: "var(--wb-textDim2)",
  },
  ".cm-md-fence": { background: "var(--wb-panel)" },
  ".cm-md-fence-edge": { color: "var(--wb-textFaint)", fontSize: "0.9em" },
  ".cm-md-hr": {
    backgroundImage: "linear-gradient(var(--wb-border), var(--wb-border))",
    backgroundSize: "100% 1px",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  },
});

/** The live markdown view. Needs the markdown language alongside it. */
export function livePreview(): Extension {
  return [plugin, openLinks, theme];
}
