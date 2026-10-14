import { describe, expect, it } from "vitest";

import { stepChange, textPatch } from "./mergeNav";

const apply = (old: string, p: ReturnType<typeof textPatch>) =>
  p ? old.slice(0, p.from) + p.insert + old.slice(p.to) : old;

describe("textPatch", () => {
  it("replaces only what changed", () => {
    const old = "a\nb\nc\n";
    const next = "a\nB\nb2\nc\n";
    const p = textPatch(old, next);
    expect(p).toEqual({ from: 2, to: 3, insert: "B\nb2" });
    expect(apply(old, p)).toBe(next);
  });

  it("handles growth, shrinkage, repeats and equality", () => {
    for (const [old, next] of [
      ["", "x"],
      ["x", ""],
      ["aaa", "aaaa"],
      ["abcabc", "abc"],
      ["line\n", "line\nline\n"],
    ]) {
      expect(apply(old, textPatch(old, next))).toBe(next);
    }
    expect(textPatch("same", "same")).toBeNull();
  });
});

describe("stepChange", () => {
  const starts = [10, 40, 90];
  it("goes forward and back without wrapping", () => {
    expect(stepChange(starts, 0, 1)).toBe(10);
    expect(stepChange(starts, 10, 1)).toBe(40);
    expect(stepChange(starts, 90, 1)).toBeNull();
    expect(stepChange(starts, 90, -1)).toBe(40);
    expect(stepChange(starts, 10, -1)).toBeNull();
  });

  it("goes back to the start of the change the cursor is in", () => {
    expect(stepChange(starts, 55, -1)).toBe(40);
    expect(stepChange([], 0, 1)).toBeNull();
  });
});
