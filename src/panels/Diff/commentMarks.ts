// Review comments in the working-tree editor (step V3): a gutter that marks the
// commented lines and offers "+" on the others, a tint on commented lines, and the
// comment ranges kept as document ranges so they follow edits — the panel reads the
// moved line numbers back with `commentLines`.

import { RangeSet, RangeValue, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from "@codemirror/view";

/** A comment's lines, as the editor is told them. */
export interface CommentSpan {
  id: string;
  fromLine: number;
  toLine: number;
}

class CommentRange extends RangeValue {
  constructor(readonly id: string) {
    super();
  }
  eq(other: RangeValue): boolean {
    return other instanceof CommentRange && other.id === this.id;
  }
}

/** Replace the comment ranges with these. */
const setComments = StateEffect.define<RangeSet<CommentRange>>();

const commentField = StateField.define<RangeSet<CommentRange>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    // An edit that deletes a comment's lines whole drops its range; keep the comment
    // on the line that is left where they were.
    if (next.size < set.size) {
      const kept = new Set<string>();
      for (let it = next.iter(); it.value; it.next()) kept.add(it.value.id);
      const lost = [];
      for (let it = set.iter(); it.value; it.next()) {
        if (kept.has(it.value.id)) continue;
        const at = tr.changes.mapPos(it.from, -1);
        lost.push(new CommentRange(it.value.id).range(at, at));
      }
      next = next.update({ add: lost, sort: true });
    }
    for (const e of tr.effects) if (e.is(setComments)) next = e.value;
    return next;
  },
});

function rangesFor(doc: Text, spans: readonly CommentSpan[]): RangeSet<CommentRange> {
  const ranges = spans
    .filter((s) => s.fromLine >= 1 && s.fromLine <= doc.lines)
    .map((s) => {
      const to = Math.min(Math.max(s.toLine, s.fromLine), doc.lines);
      return new CommentRange(s.id).range(doc.line(s.fromLine).from, doc.line(to).to);
    });
  return RangeSet.of(ranges, true);
}

/** Where each comment is now, by id. */
export function commentLines(state: EditorState): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const doc = state.doc;
  for (let it = state.field(commentField, false)?.iter(); it?.value; it.next()) {
    out.set(it.value.id, [doc.lineAt(it.from).number, doc.lineAt(it.to).number]);
  }
  return out;
}

/** The effect that shows `spans`, or null when they are what is shown already. */
export function syncComments(state: EditorState, spans: readonly CommentSpan[]): StateEffect<unknown> | null {
  const now = commentLines(state);
  const same =
    now.size === spans.length &&
    spans.every((s) => {
      const at = now.get(s.id);
      return at && at[0] === s.fromLine && at[1] === Math.max(s.toLine, s.fromLine);
    });
  return same ? null : setComments.of(rangesFor(state.doc, spans));
}

/** The lines the main selection covers, 1-based. A selection ending at the very
 *  start of a line (whole lines picked with the mouse) doesn't take that line. */
export function selectedLines(state: EditorState): [number, number] {
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const first = doc.lineAt(from).number;
  const end = doc.lineAt(to);
  const last = to > from && to === end.from && end.number > first ? end.number - 1 : end.number;
  return [first, last];
}

function commented(state: EditorState, pos: number): boolean {
  let hit = false;
  state.field(commentField).between(pos, pos, () => {
    hit = true;
    return false;
  });
  return hit;
}

class Glyph extends GutterMarker {
  constructor(
    readonly text: string,
    readonly cls: string,
    readonly title: string,
  ) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof Glyph && other.cls === this.cls;
  }
  toDOM(): Node {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    span.title = this.title;
    return span;
  }
}

const MARKED = new Glyph("●", "cm-wb-comment-mark", "commented — see the comments below");
const ADD = new Glyph("+", "cm-wb-comment-add", "comment on this line (or on the selected lines)");

const lineTint = Decoration.line({ class: "cm-wb-commented" });

const tints = EditorView.decorations.compute([commentField, "doc"], (state): DecorationSet => {
  const ranges = [];
  const doc = state.doc;
  for (let it = state.field(commentField).iter(); it.value; it.next()) {
    const last = doc.lineAt(it.to).number;
    for (let n = doc.lineAt(it.from).number; n <= last; n++) ranges.push(lineTint.range(doc.line(n).from));
  }
  return Decoration.set(ranges, true);
});

const styles = EditorView.baseTheme({
  ".cm-wb-comment-gutter .cm-gutterElement": { cursor: "pointer", padding: "0 3px", textAlign: "center" },
  ".cm-wb-comment-add": { opacity: "0", color: "var(--wb-accent)" },
  ".cm-wb-comment-gutter .cm-gutterElement:hover .cm-wb-comment-add": { opacity: "1" },
  ".cm-wb-comment-mark": { color: "var(--wb-working)", fontSize: "9px" },
  ".cm-wb-commented": { boxShadow: "inset 2px 0 0 var(--wb-working)" },
});

/**
 * The comment layer for the working-tree editor. `onAdd` gets the lines a click on
 * the gutter asks to comment: the selection's lines when the click is inside them,
 * else the clicked line.
 */
export function commentMarks(onAdd: (fromLine: number, toLine: number) => void): Extension {
  return [
    commentField,
    tints,
    styles,
    gutter({
      class: "cm-wb-comment-gutter",
      lineMarker: (view, line) => (commented(view.state, line.from) ? MARKED : ADD),
      lineMarkerChange: (u) => u.docChanged || u.startState.field(commentField) !== u.state.field(commentField),
      initialSpacer: () => MARKED,
      domEventHandlers: {
        mousedown(view, line) {
          const doc = view.state.doc;
          const clicked = doc.lineAt(line.from).number;
          const [from, to] = selectedLines(view.state);
          if (!view.state.selection.main.empty && clicked >= from && clicked <= to) onAdd(from, to);
          else onAdd(clicked, clicked);
          return true;
        },
      },
    }),
  ];
}
