import { describe, expect, it } from "vitest";
import { createRemotes, normalizeRemote, remoteMatches } from "./remotes";

describe("projects' git remotes", () => {
  it("reads every form of a remote the same", () => {
    for (const u of [
      "https://github.com/IvoDchits/Workbench.git",
      "git@github.com:ivodchits/workbench.git",
      "ssh://git@github.com/ivodchits/workbench",
      "ssh://git@github.com:22/ivodchits/workbench.git",
      "https://user@github.com/ivodchits/workbench/",
    ])
      expect(normalizeRemote(u), u).toBe("github.com/ivodchits/workbench");
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("origin")).toBeNull();
  });

  it("matches a repo by its whole name or owner/repo", () => {
    const r = "github.com/ivodchits/workbench";
    expect(remoteMatches(r, "ivodchits/workbench")).toBe(true);
    expect(remoteMatches(r, "https://github.com/ivodchits/workbench")).toBe(true);
    expect(remoteMatches(r, "someone/workbench")).toBe(false);
    expect(remoteMatches(r, "workbench")).toBe(false);
  });

  it("looks each folder up once, and attaches what it found", async () => {
    let asked = 0;
    const remotes = createRemotes(async (root) => {
      asked++;
      return root === "C:/w" ? "git@github.com:me/w.git" : null;
    });
    const p = (id: string, root: string) => ({ id, name: id, rootPath: root, group: null, remote: false });
    expect(remotes.attach([p("a", "C:/w"), p("b", "C:/x")]).map((x) => x.gitRemote)).toEqual([undefined, undefined]);
    await new Promise((r) => setTimeout(r, 0));
    expect(remotes.attach([p("a", "C:/w"), p("b", "C:/x")]).map((x) => x.gitRemote)).toEqual(["github.com/me/w", undefined]);
    expect(asked).toBe(2);
  });
});
