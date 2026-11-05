import { describe, expect, it } from "vitest";

import type { Item } from "../transcript/model";
import { LISTEN_MAX_TEXT, listenAction, listenJob, listenRequest, listeningTo } from "./listen";
import type { ReaderView } from "./reader";

const base = { rev: 0, timestamp: null };
const reply = (id: string, text: string): Item => ({ ...base, kind: "assistant", id, text, isError: false }) as Item;
const prompt = (id: string, text: string): Item => ({ ...base, kind: "user", id, text, images: [] }) as unknown as Item;

const view = (key: string, state: ReaderView["state"]): ReaderView => ({
  threadId: "",
  key,
  title: "x",
  section: 0,
  sections: 2,
  state,
  where: "desktop",
});

describe("a message's listen request", () => {
  it("is keyed by session and item, titled by who wrote it and its first words", () => {
    expect(listenRequest("i1", reply("a1", "## Done\n\nThe tests pass."))).toEqual({
      key: "msg:i1:a1",
      title: "Claude: Done",
      text: "## Done\n\nThe tests pass.",
    });
    const long = listenRequest("i1", prompt("u1", "please make the build much faster than it is today, it takes ages"));
    expect(long?.title).toMatch(/^Your message: please make the build.{10,}…$/);
    expect(long!.title.length).toBeLessThan(70);
  });

  it("is none for empty messages and for other items", () => {
    expect(listenRequest("i1", reply("a1", "  \n"))).toBeNull();
    expect(listenRequest("i1", { ...base, kind: "turn-end", id: "e", durationMs: 1 } as Item)).toBeNull();
  });

  it("is cut to the longest read", () => {
    expect(listenRequest("i1", reply("a1", "a. ".repeat(LISTEN_MAX_TEXT)))!.text.length).toBe(LISTEN_MAX_TEXT);
  });
});

describe("a message's read", () => {
  it("is narrated, belongs to no thread, and can be read again as text", () => {
    const job = listenJob({ key: "msg:i1:a1", title: "Claude: Done", text: "One.\n\n```ts\nx()\n```\n\nTwo." });
    expect(job.narrate).toBe(true);
    expect(job.threadId).toBe("");
    expect(job.sections.join("\n\n")).toContain("x()");
    expect(job.source).toMatchObject({ source: "text", title: "Claude: Done", mode: "narrate" });
  });
});

describe("the button", () => {
  it("reads, stops what it's reading, and goes on with what's paused", () => {
    expect(listenAction(null, "msg:i:a")).toBe("read");
    expect(listenAction(view("msg:i:b", "reading"), "msg:i:a")).toBe("read");
    expect(listenAction(view("msg:i:a", "reading"), "msg:i:a")).toBe("stop");
    expect(listenAction(view("msg:i:a", "paused"), "msg:i:a")).toBe("resume");
  });

  it("knows the message of this session being read", () => {
    expect(listeningTo(view("msg:i1:a1", "paused"), "i1")).toEqual({ itemId: "a1", state: "paused" });
    expect(listeningTo(view("msg:i2:a1", "reading"), "i1")).toBeNull();
    expect(listeningTo(view("session:i1:last", "reading"), "i1")).toBeNull();
    expect(listeningTo(null, "i1")).toBeNull();
  });
});
