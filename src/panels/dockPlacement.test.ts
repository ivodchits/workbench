import { describe, expect, it } from "vitest";
import { nextPanelPosition, type GridShape } from "./dockPlacement";

const leaf = (id: string) => ({ type: "leaf" as const, data: { id, views: [id] } });
const col = (...ids: string[]) =>
  ids.length === 1 ? leaf(ids[0]) : { type: "branch" as const, data: ids.map(leaf) };
const grid = (...cols: string[][]): GridShape => ({
  orientation: "HORIZONTAL",
  root: { type: "branch", data: cols.map((c) => col(...c)) },
});

describe("nextPanelPosition", () => {
  it("opens to the right for 1 and 2 columns", () => {
    expect(nextPanelPosition(grid(["a"]))).toEqual({ direction: "right" });
    expect(nextPanelPosition(grid(["a"], ["b"]))).toEqual({ direction: "right" });
  });
  it("falls back to right without a usable grid", () => {
    expect(nextPanelPosition(null)).toEqual({ direction: "right" });
    expect(nextPanelPosition({ orientation: "VERTICAL", root: grid(["a"], ["b"], ["c"]).root })).toEqual({
      direction: "right",
    });
  });
  it("stacks the 4th panel under the first column", () => {
    expect(nextPanelPosition(grid(["a"], ["b"], ["c"]))).toEqual({ referenceGroup: "a", direction: "below" });
  });
  it("fills the emptiest column, below its last group", () => {
    expect(nextPanelPosition(grid(["a", "d"], ["b"], ["c"]))).toEqual({ referenceGroup: "b", direction: "below" });
    expect(nextPanelPosition(grid(["a", "d"], ["b", "e"], ["c"]))).toEqual({ referenceGroup: "c", direction: "below" });
    expect(nextPanelPosition(grid(["a", "d"], ["b", "e"], ["c", "f"]))).toEqual({ referenceGroup: "d", direction: "below" });
  });
});
