import { describe, expect, it } from "vitest";

import { pathFor, reference, referenceText, spliceReference } from "./fileDrag";

describe("pathFor", () => {
  it("is relative, with forward slashes, inside the working dir", () => {
    expect(pathFor("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("src/a.ts");
    expect(pathFor("/home/me/repo/src/a.ts", "/home/me/repo")).toBe("src/a.ts");
  });

  it("ignores case and separator style on Windows", () => {
    expect(pathFor("c:/Repo/src/a.ts", "C:\\repo\\")).toBe("src/a.ts");
  });

  it("does not ignore case elsewhere", () => {
    expect(pathFor("/home/me/Repo/a.ts", "/home/me/repo")).toBe("/home/me/Repo/a.ts");
  });

  it("is left alone outside the working dir", () => {
    expect(pathFor("C:\\other\\a.ts", "C:\\repo")).toBe("C:\\other\\a.ts");
    // A sibling whose name merely starts the same way is outside.
    expect(pathFor("C:\\repo-two\\a.ts", "C:\\repo")).toBe("C:\\repo-two\\a.ts");
  });

  it("is left alone for the working dir itself, or when there is none", () => {
    expect(pathFor("C:\\repo", "C:\\repo")).toBe("C:\\repo");
    expect(pathFor("C:\\repo\\a.ts", "")).toBe("C:\\repo\\a.ts");
  });
});

describe("reference", () => {
  it("quotes a path with white space", () => {
    expect(reference("C:\\repo\\my notes\\a b.md", "C:\\repo")).toBe('@"my notes/a b.md"');
    expect(reference("C:\\repo\\a.md", "C:\\repo")).toBe("@a.md");
  });
});

describe("referenceText", () => {
  it("writes one reference per file, each followed by a space", () => {
    expect(referenceText(["C:\\repo\\a.ts", "C:\\repo\\b c.ts"], "C:\\repo")).toBe(
      '@a.ts @"b c.ts" ',
    );
  });

  it("writes a file once", () => {
    expect(referenceText(["/r/a.ts", "/r/a.ts"], "/r")).toBe("@a.ts ");
  });
});

describe("spliceReference", () => {
  it("inserts at the caret", () => {
    expect(spliceReference("look at ", 8, 8, "@a.ts ")).toEqual({ text: "look at @a.ts ", caret: 14 });
  });

  it("keeps the reference apart from a word before it", () => {
    expect(spliceReference("look", 4, 4, "@a.ts ")).toEqual({ text: "look @a.ts ", caret: 11 });
  });

  it("replaces a selection, without doubling the space after it", () => {
    expect(spliceReference("see THIS now", 4, 8, "@a.ts ")).toEqual({
      text: "see @a.ts now",
      caret: 9,
    });
  });
});
