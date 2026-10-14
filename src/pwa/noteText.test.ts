import { describe, expect, it } from "vitest";

import { nameFromText } from "./noteText";

describe("a quick note's name", () => {
  it("comes from the first line, without markdown marks", () => {
    expect(nameFromText("\n\n# Buy milk\nand eggs")).toBe("Buy milk");
    expect(nameFromText("- [ ] call the plumber")).toBe("call the plumber");
    expect(nameFromText("1. first thing")).toBe("first thing");
  });

  it("holds only what a note name can, and stays short", () => {
    expect(nameFromText("a/b: c?")).toBe("a b c");
    expect(nameFromText("..hidden.")).toBe("hidden");
    expect(nameFromText("x".repeat(100))).toHaveLength(60);
  });

  it("falls back when there is nothing to name it by", () => {
    expect(nameFromText("")).toBe("note");
    expect(nameFromText("  \n ### \n")).toBe("note");
  });
});
