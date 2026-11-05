import { describe, expect, it } from "vitest";

import { clock, joinDictation } from "./dictation";

describe("joinDictation", () => {
  it("fills an empty draft", () => {
    expect(joinDictation("", "  привет, fix the test  ")).toBe("привет, fix the test");
  });
  it("goes after a space, or straight on after whitespace", () => {
    expect(joinDictation("look at", "el archivo")).toBe("look at el archivo");
    expect(joinDictation("first line\n", "second")).toBe("first line\nsecond");
    expect(joinDictation("a ", "b")).toBe("a b");
  });
  it("leaves the draft alone when nothing was heard", () => {
    expect(joinDictation("keep", "   ")).toBe("keep");
  });
});

describe("clock", () => {
  it("is m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7.9)).toBe("0:07");
    expect(clock(118)).toBe("1:58");
  });
});
