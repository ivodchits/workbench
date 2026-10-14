import { describe, expect, it } from "vitest";

import { rangeReference } from "./fileDrag";
import {
  addComment,
  buildCommentsPrompt,
  clearComments,
  editComment,
  getComments,
  moveComments,
  quoteLines,
  removeComment,
} from "./reviewComments";

describe("review comments", () => {
  it("are kept per instance, in file then line order", () => {
    addComment("i1", { path: "src/b.ts", fromLine: 4, toLine: 4, quote: "b", note: "two" });
    addComment("i1", { path: "src/a.ts", fromLine: 9, toLine: 10, quote: "a", note: "one" });
    addComment("i1", { path: "src/a.ts", fromLine: 2, toLine: 2, quote: "a", note: "zero" });
    expect(getComments("i1").map((c) => c.note)).toEqual(["zero", "one", "two"]);
    expect(getComments("i2")).toEqual([]);
    clearComments("i1");
    expect(getComments("i1")).toEqual([]);
  });

  it("can be edited, moved and removed; an emptied note removes it", () => {
    const a = addComment("i3", { path: "x.ts", fromLine: 1, toLine: 1, quote: "", note: "first" });
    const b = addComment("i3", { path: "x.ts", fromLine: 5, toLine: 6, quote: "", note: "second" });
    editComment("i3", a, "changed");
    expect(getComments("i3")[0].note).toBe("changed");
    // Lines inserted above `b` move it; the list re-sorts.
    moveComments("i3", new Map([[b, [0, 0] as [number, number]]]));
    expect(getComments("i3").map((c) => c.id)).toEqual([b, a]);
    const before = getComments("i3");
    moveComments("i3", new Map([[b, [0, 0] as [number, number]]]));
    expect(getComments("i3")).toBe(before); // nothing moved: no new list
    editComment("i3", a, "  ");
    removeComment("i3", b);
    expect(getComments("i3")).toEqual([]);
  });
});

describe("the comments prompt", () => {
  it("names each place, quotes the code and carries the note", () => {
    const prompt = buildCommentsPrompt([
      { id: "1", path: "src/a.ts", fromLine: 12, toLine: 12, quote: "    const x = foo();", note: "rename foo" },
      {
        id: "2",
        path: "src/a.ts",
        fromLine: 30,
        toLine: 34,
        quote: "  if (x) {\n    run();\n  }\n  done();\n  log();",
        note: "handle null\nand log it",
      },
      { id: "3", path: "src/b.rs", fromLine: 3, toLine: 4, quote: "fn main() {\n}", note: "why?" },
    ]);
    expect(prompt).toBe(
      [
        "Review comments on your changes (3). Line numbers are in the files as they are now. Please address each one:",
        "",
        "1. src/a.ts:12",
        "   > const x = foo();",
        "   rename foo",
        "",
        "2. src/a.ts:30-34",
        "   > if (x) {",
        "   >   run();",
        "   > }",
        "   > … (2 more)",
        "   handle null",
        "   and log it",
        "",
        "3. src/b.rs:3-4",
        "   > fn main() {",
        "   > }",
        "   why?",
      ].join("\n"),
    );
  });

  it("cuts long lines and survives blank quotes", () => {
    const long = "x".repeat(300);
    expect(quoteLines(long)[0].length).toBe(2 + 120);
    expect(quoteLines("")).toEqual([">"]);
    expect(quoteLines("\n\n")).toEqual([">"]);
  });
});

describe("range references", () => {
  it("add the lines to an @path reference", () => {
    expect(rangeReference("C:\\r\\src\\a.ts", "C:\\r", 12, 12)).toBe("@src/a.ts#L12");
    expect(rangeReference("C:\\r\\src\\a.ts", "C:\\r", 3, 9)).toBe("@src/a.ts#L3-9");
    expect(rangeReference("C:/r/my dir/a.ts", "C:/r", 1, 2)).toBe('@"my dir/a.ts"#L1-2');
  });
});
