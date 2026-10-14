import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";

import { commentLines, commentMarks, selectedLines, syncComments } from "./commentMarks";

const doc = ["a", "b", "c", "d", "e"].join("\n");

function withComments(spans: { id: string; fromLine: number; toLine: number }[]) {
  const state = EditorState.create({ doc, extensions: commentMarks(() => {}) });
  const effect = syncComments(state, spans);
  return effect ? state.update({ effects: effect }).state : state;
}

describe("comment marks", () => {
  it("follow edits above and inside them", () => {
    let state = withComments([
      { id: "x", fromLine: 2, toLine: 3 },
      { id: "y", fromLine: 5, toLine: 5 },
    ]);
    expect(commentLines(state)).toEqual(
      new Map([
        ["x", [2, 3]],
        ["y", [5, 5]],
      ]),
    );
    // Two lines inserted at the top, one inside x.
    state = state.update({ changes: [{ from: 0, insert: "1\n2\n" }, { from: 3, insert: "\nb2" }] }).state;
    expect(commentLines(state)).toEqual(
      new Map([
        ["x", [4, 6]],
        ["y", [8, 8]],
      ]),
    );
  });

  it("survive their lines being deleted, and only re-sync when told something new", () => {
    let state = withComments([{ id: "x", fromLine: 2, toLine: 3 }]);
    state = state.update({ changes: { from: 1, to: 6 } }).state; // "\nb\nc\n" gone
    expect(commentLines(state).get("x")).toEqual([1, 1]);
    expect(syncComments(state, [{ id: "x", fromLine: 1, toLine: 1 }])).toBeNull();
    expect(syncComments(state, [{ id: "x", fromLine: 2, toLine: 2 }])).not.toBeNull();
  });

  it("take whole selected lines without the line the selection ends at", () => {
    const at = (anchor: number, head: number) =>
      selectedLines(EditorState.create({ doc, selection: EditorSelection.single(anchor, head) }));
    expect(at(2, 2)).toEqual([2, 2]); // a cursor: its line
    expect(at(2, 6)).toEqual([2, 3]); // "b\nc\n" up to the start of "d"
    expect(at(2, 7)).toEqual([2, 4]);
  });
});
