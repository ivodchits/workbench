import { describe, expect, it } from "vitest";

import { editBuffer, freshName, getBuffer, isDirty, moveBuffer, setBuffer } from "./notes";

describe("notes store", () => {
  it("names a new note after the ones taken, ignoring case", () => {
    expect(freshName([])).toBe("untitled");
    expect(freshName(["Untitled", "untitled 2"])).toBe("untitled 3");
  });

  it("keeps a buffer's edits apart from its baseline, and moves it on rename", () => {
    setBuffer("p", "a", { content: "x", baseline: "x", revision: "r1", path: "/n/a.md" });
    expect(isDirty(getBuffer("p", "a"))).toBe(false);
    editBuffer("p", "a", "xy");
    expect(isDirty(getBuffer("p", "a"))).toBe(true);
    moveBuffer("p", "a", "b");
    expect(getBuffer("p", "a")).toBeUndefined();
    expect(getBuffer("p", "b")?.content).toBe("xy");
    moveBuffer("p", "b", null);
    expect(getBuffer("p", "b")).toBeUndefined();
  });
});
