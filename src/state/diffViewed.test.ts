import { describe, expect, it } from "vitest";

import type { DiffFile } from "../ipc/git";
import { getViewed, isViewed, setViewed, toggleViewed } from "./diffViewed";

const file = (stamp: string, path = "src/a.ts"): DiffFile => ({
  path,
  absPath: `C:/r/${path}`,
  status: "modified",
  insertions: 1,
  deletions: 0,
  binary: false,
  stamp,
});

describe("viewed marks", () => {
  it("hold until the file's stamp moves", () => {
    toggleViewed("d1", file("10@1:+1-0"));
    expect(isViewed(getViewed("d1"), file("10@1:+1-0"))).toBe(true);
    // The agent edited it again: no longer viewed, without anyone unmarking it.
    expect(isViewed(getViewed("d1"), file("12@2:+2-0"))).toBe(false);
    // Marking it again remembers the new stamp.
    toggleViewed("d1", file("12@2:+2-0"));
    expect(isViewed(getViewed("d1"), file("12@2:+2-0"))).toBe(true);
  });

  it("are per panel and per file, and can be cleared", () => {
    setViewed("d2", file("s", "b.ts"), true);
    expect(isViewed(getViewed("d3"), file("s", "b.ts"))).toBe(false);
    expect(isViewed(getViewed("d2"), file("s", "c.ts"))).toBe(false);
    toggleViewed("d2", file("s", "b.ts"));
    expect(isViewed(getViewed("d2"), file("s", "b.ts"))).toBe(false);
  });
});
