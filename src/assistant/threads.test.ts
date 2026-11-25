import { describe, expect, it } from "vitest";
import type { ThreadRow } from "../ipc/assistant";
import { createThreadStore, IMAGE_GONE, withoutImages, type ThreadBackend } from "./threads";

describe("withoutImages", () => {
  it("puts a line in place of every image, in tool results and parked batches", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const result = { type: "tool_result", tool_use_id: "u", content: [{ type: "text", text: "Captured" }, image] };
    expect(withoutImages([result])).toEqual([
      { ...result, content: [{ type: "text", text: "Captured" }, { type: "text", text: IMAGE_GONE }] },
    ]);
    const calls = [{ id: "u", name: "screenshot", input: {}, state: "done", result }];
    expect(JSON.stringify(withoutImages(calls))).not.toContain("AAAA");
    // Anything without images is left as it is.
    const plain = [{ type: "text", text: "hi" }];
    expect(withoutImages(plain)).toEqual(plain);
    expect(withoutImages("text")).toBe("text");
  });
});

describe("read marks", () => {
  it("keeps a thread's news and its read mark, which never goes back", async () => {
    const marks: [string, number][] = [];
    const backend: ThreadBackend = {
      threadCreate: async (id, mode): Promise<ThreadRow> => ({ id, title: "", mode, created: 1, updated: 1, seen: 0, news: 0 }),
      threadList: async () => [],
      threadMessages: async () => [],
      threadTitle: async () => {},
      threadDelete: async () => {},
      messageAppend: async () => {},
      pendingPut: async () => {},
      pendingList: async () => [],
      pendingClear: async () => {},
      threadSeen: async (id, at) => {
        marks.push([id, at]);
        return true;
      },
    };
    let clock = 10;
    const store = createThreadStore(backend, { now: () => clock++ });
    const t = await store.create("assistant", "a");
    await store.append(t.id, "user", [{ type: "text", text: "hi" }], "desktop");
    expect(store.thread("a")?.news).toBe(0);
    await store.append(t.id, "assistant", [{ type: "text", text: "hello" }], "duck");
    expect(store.thread("a")?.news).toBe(11);
    expect((await store.setSeen("a", 11))?.seen).toBe(11);
    expect(await store.setSeen("a", 5)).toBeUndefined();
    expect(await store.setSeen("nope", 50)).toBeUndefined();
    expect(marks).toEqual([["a", 11]]);
  });
});
