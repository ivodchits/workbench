// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { promptChunks } from "../state/composer";
import { createStaging, promptWith, type SessionFile } from "./sessionFiles";

const image = (file: string): SessionFile => ({ kind: "image", name: "photo.jpg", size: 10, file });
const doc = (file: string): SessionFile => ({ kind: "file", name: "a.pdf", size: 10, file });

describe("a session's prompt with files", () => {
  it("puts the files' paths, then the pictures' tokens, after the text", () => {
    const text = promptWith(" look at these ", [image("1a2b3c4d.png"), doc("C:\\p\\.workbench-uploads\\a.pdf"), image("5e6f7a8b.jpg")]);
    expect(text).toBe("look at these\n\nAttached file: C:\\p\\.workbench-uploads\\a.pdf\n\n[image 1a2b3c4d.png] [image 5e6f7a8b.jpg]");
  });

  it("writes the tokens the desktop pastes as images", () => {
    const chunks = promptChunks(promptWith("", [image("1a2b3c4d.png"), image("5e6f7a8b.webp")]));
    expect(chunks.filter((c) => c.kind === "image")).toEqual([
      { kind: "image", name: "1a2b3c4d.png" },
      { kind: "image", name: "5e6f7a8b.webp" },
    ]);
  });

  it("is the text alone without files", () => {
    expect(promptWith("hi", [])).toBe("hi");
  });
});

/** An upload that waits until it's told how it went. */
function deferredUploads() {
  const calls: { name: string; ok(f: SessionFile): void; fail(e: Error): void }[] = [];
  const upload = (_id: string, _blob: Blob, name: string) =>
    new Promise<SessionFile>((ok, fail) => calls.push({ name, ok, fail }));
  return { calls, upload };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const blob = (n = 3) => new Blob(["x".repeat(n)]);

describe("staged files", () => {
  it("go up one at a time, and send only once they're up", async () => {
    const { calls, upload } = deferredUploads();
    const changed = vi.fn();
    const s = createStaging(upload, changed, () => {});
    s.add("i1", blob(), "a.txt");
    s.add("i1", blob(), "b.txt");
    await flush();
    expect(calls.map((c) => c.name)).toEqual(["a.txt"]);
    expect(s.busy("i1")).toBe(true);
    calls[0].ok(doc("/p/a.txt"));
    await flush();
    expect(calls.map((c) => c.name)).toEqual(["a.txt", "b.txt"]);
    calls[1].fail(new Error("no room"));
    await flush();
    expect(s.busy("i1")).toBe(false);
    expect(s.list("i1").map((x) => [x.state, x.error])).toEqual([
      ["ready", undefined],
      ["failed", "no room"],
    ]);
    expect(s.take("i1")).toEqual([doc("/p/a.txt")]);
    expect(s.list("i1")).toEqual([]);
    expect(changed).toHaveBeenCalledWith("i1");
  });

  it("refuses an empty or oversized file without sending it", async () => {
    const { calls, upload } = deferredUploads();
    const s = createStaging(upload, () => {}, () => {});
    s.add("i1", blob(0), "empty.txt");
    s.add("i1", { size: 26 * 1024 * 1024 } as Blob, "huge.mov");
    await flush();
    expect(calls).toEqual([]);
    expect(s.list("i1").map((x) => x.error)).toEqual(["the file is empty", "over 25 MB"]);
  });

  it("keeps each session's files apart, and drops a removed one before its turn", async () => {
    const { calls, upload } = deferredUploads();
    const released: string[] = [];
    const s = createStaging(upload, () => {}, (p) => released.push(p));
    s.add("i1", blob(), "a.png", "blob:a");
    s.add("i2", blob(), "b.png", "blob:b");
    s.remove("i2", s.list("i2")[0].key);
    expect(released).toEqual(["blob:b"]);
    await flush();
    calls[0].ok(image("1a2b3c4d.png"));
    await flush();
    expect(calls.map((c) => c.name)).toEqual(["a.png"]);
    expect(s.list("i2")).toEqual([]);
    expect(s.take("i1")).toEqual([image("1a2b3c4d.png")]);
    expect(released).toEqual(["blob:b", "blob:a"]);
  });
});
