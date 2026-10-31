// A selection you made in a chat survives the chat repainting under it. A reply
// streaming in replaces its HTML on every delta, a finished reply mounts in the
// streamed one's place, and the phone repaints its whole list on a new message: each
// takes the nodes a selection was in, and the selection with them. Hold it as
// character offsets into the chat's text just before the repaint, and put it back
// after, when the same text is still at those offsets.

/** A selection, by where it starts and ends in a root's text. */
export interface HeldSelection {
  start: number;
  end: number;
  text: string;
  /** Selected from the end back to the start (the focus is at `start`). */
  backward: boolean;
}

/** How many characters of `root`'s text come before (node, offset). */
function offsetOf(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The text node and offset `at` characters into `root`'s text. */
function pointAt(root: Node, at: number): { node: Node; offset: number } | null {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = (n as Text).data.length;
    if (at <= seen + len) return { node: n, offset: at - seen };
    seen += len;
  }
  return null;
}

/** The text selected inside `root`, held by offsets; null for none (or a caret). */
export function holdSelection(root: Node, sel: Selection | null = window.getSelection()): HeldSelection | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const text = range.toString();
  if (!text) return null;
  return {
    start: offsetOf(root, range.startContainer, range.startOffset),
    end: offsetOf(root, range.endContainer, range.endOffset),
    text,
    backward: sel.focusNode === range.startContainer && sel.focusOffset === range.startOffset,
  };
}

/** Put `held` back if a repaint took it and its text is still where it was. True
 *  when it was put back. */
export function restoreSelection(root: Node, held: HeldSelection | null, sel: Selection | null = window.getSelection()): boolean {
  if (!held || !sel) return false;
  const now = holdSelection(root, sel);
  if (now && now.start === held.start && now.end === held.end) return false;
  const a = pointAt(root, held.start);
  const b = pointAt(root, held.end);
  if (!a || !b) return false;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  if (range.toString() !== held.text) return false;
  if (held.backward) sel.setBaseAndExtent(b.node, b.offset, a.node, a.offset);
  else sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
  return true;
}

/** Run `paint`, keeping a selection in `root` through it. */
export function keepingSelection(root: Node | null, paint: () => void): void {
  const held = root ? holdSelection(root) : null;
  paint();
  if (root && held) restoreSelection(root, held);
}
