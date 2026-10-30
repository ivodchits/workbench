import { describe, expect, it } from "vitest";
import { createOutbox, type OutboxItem, type SendResult } from "./outbox";

const prompt = (instanceId: string, text: string) => ({ kind: "prompt" as const, instanceId, text });
const duck = (text: string, threadId: string | null = "t1") => ({ kind: "duck" as const, threadId, text });

describe("the outbox", () => {
  it("keeps every change, and sends in order once the link is back", async () => {
    let kept: OutboxItem[] = [];
    const box = createOutbox((items) => (kept = items));
    box.add(prompt("i1", "one"));
    box.add(prompt("i1", "two"));
    expect(kept.map((it) => it.state)).toEqual(["pending", "pending"]);

    const sent: string[] = [];
    let up = false;
    box.handle("prompt", async (it) => {
      if (!up) return "wait";
      sent.push(it.kind === "prompt" ? it.text : "");
      return "done";
    });
    await box.flush();
    // Down: the first waits, and the second stays behind it.
    expect(sent).toEqual([]);
    expect(box.list()).toHaveLength(2);
    up = true;
    await box.flush();
    expect(sent).toEqual(["one", "two"]);
    expect(kept).toEqual([]);
  });

  it("lets one kind wait without holding up another", async () => {
    const box = createOutbox(() => {});
    box.add(duck("hi"));
    box.add(prompt("i1", "go"));
    box.handle("duck", async () => "wait");
    box.handle("prompt", async () => "done");
    await box.flush();
    expect(box.list().map((it) => it.kind)).toEqual(["duck"]);
  });

  it("keeps a refused item, with why, until retried or discarded", async () => {
    const box = createOutbox(() => {});
    const it = box.add({ kind: "noteSave", projectId: "p", noteId: "n", content: "mine", base: "r1" });
    let answer: SendResult = { failed: "the note changed on the desktop" };
    box.handle("noteSave", async () => answer);
    await box.flush();
    expect(box.list()[0]).toMatchObject({ state: "failed", error: "the note changed on the desktop", content: "mine" });
    // A flush doesn't try it again by itself…
    answer = "done";
    await box.flush();
    expect(box.list()).toHaveLength(1);
    // …a retry does.
    box.retry(it.id);
    await box.flush();
    expect(box.list()).toHaveLength(0);
  });

  it("waits for a Duck message to come back, and offers it again if the link dropped", async () => {
    const box = createOutbox(() => {});
    const a = box.add(duck("first"));
    box.add(duck("second"));
    box.handle("duck", async () => "sent");
    await box.flush();
    expect(box.list().map((it) => it.state)).toEqual(["sent", "sent"]);
    box.confirm(a.id);
    box.unconfirmed("duck", "the link dropped");
    expect(box.list()).toEqual([expect.objectContaining({ text: "second", state: "failed", error: "the link dropped" })]);
  });

  it("restores what was kept: mid-way items are offered back, unless resending is safe", () => {
    const box = createOutbox(() => {});
    const early = box.add(prompt("i1", "typed before the load"));
    box.restore([
      { id: "a", kind: "prompt", instanceId: "i1", text: "x", at: 1, state: "sending" },
      { id: "b", kind: "duck", threadId: "t", text: "y", at: 2, state: "sent" },
      { id: "c", kind: "noteSave", projectId: "p", noteId: "n", content: "z", base: "r", at: 3, state: "sending" },
      { id: "d", kind: "prompt", instanceId: "i1", text: "w", at: 4, state: "pending" },
      { junk: true },
    ]);
    expect(box.list().map((it) => [it.id, it.state])).toEqual([
      ["a", "failed"],
      ["b", "failed"],
      ["c", "pending"],
      ["d", "pending"],
      [early.id, "pending"],
    ]);
  });

  it("drops an item discarded while it was being sent", async () => {
    const box = createOutbox(() => {});
    const it = box.add(prompt("i1", "oops"));
    box.handle("prompt", async () => {
      box.remove(it.id);
      return { failed: "late" };
    });
    await box.flush();
    expect(box.list()).toEqual([]);
  });
});
