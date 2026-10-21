import { describe, expect, it } from "vitest";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { RemoteDuckFrame } from "../remote/protocol";
import { apply, emptyView, type DuckView } from "./duckStore";

const thread = (id: string, updated = 1): ThreadRow => ({ id, title: id, mode: "chat", created: 1, updated });
const msg = (threadId: string, seq: number, role: StoredMessage["role"], text: string): StoredMessage => ({
  threadId,
  seq,
  ts: 10 + seq,
  role,
  content: [{ type: "text", text }],
  source: "phone",
});

function run(frames: RemoteDuckFrame[], v: DuckView = emptyView(), adopting = false) {
  let adopted = false;
  const fx = [];
  for (const f of frames) {
    const r = apply(v, f, adopting && !adopted);
    v = r.view;
    adopted ||= r.adopted;
    fx.push(r.fx);
  }
  return { v, adopted, fx };
}

describe("duckStore", () => {
  it("streams a reply into the open thread and settles it", () => {
    const { v } = run([
      { type: "threads", threads: [thread("a")], v: 1 },
      { type: "history", threadId: "a", messages: [msg("a", 1, "user", "hi")], state: "thinking", v: 1 },
      { type: "delta", threadId: "a", text: "Hel", v: 1 },
      { type: "delta", threadId: "a", text: "lo.", v: 1 },
    ]);
    expect(v.synced).toBe(true);
    expect(v.streaming.a).toBe("Hello.");
    const done = run(
      [
        { type: "message", message: msg("a", 2, "assistant", "Hello."), v: 1 },
        { type: "message", message: msg("a", 2, "assistant", "Hello."), v: 1 },
        { type: "turnState", threadId: "a", state: "idle", queued: 0, v: 1 },
      ],
      v,
    ).v;
    expect(done.streaming.a).toBe("");
    expect(done.messages.a.map((m) => m.seq)).toEqual([1, 2]);
    expect(done.states.a).toBe("idle");
    expect(done.threads[0].updated).toBe(12);
  });

  it("opens the thread a first send made", () => {
    const { v, adopted } = run(
      [
        { type: "threads", threads: [thread("old")], v: 1 },
        { type: "thread", thread: thread("new", 5), v: 1 },
      ],
      emptyView(),
      true,
    );
    expect(adopted).toBe(true);
    expect(v.current).toBe("new");
    expect(v.threads.map((t) => t.id)).toEqual(["new", "old"]);
    // A thread Duck makes while you're on one isn't adopted.
    const on = { ...emptyView(), current: "old" };
    expect(run([{ type: "thread", thread: thread("x"), v: 1 }], on, true).v.current).toBe("old");
  });

  it("keeps the cards open until answered anywhere", () => {
    const request = { threadId: "a", batchId: "b", toolUseId: "u", name: "stop_session", input: {} };
    const { v } = run([
      { type: "confirm", request, v: 1 },
      { type: "confirm", request, v: 1 },
    ]);
    expect(v.asks).toHaveLength(1);
    expect(run([{ type: "confirmed", threadId: "a", toolUseId: "u", allow: true, v: 1 }], v).v.asks).toEqual([]);
  });

  it("drops the lost stream and asks for the thread again after a lag", () => {
    const v = { ...emptyView(), current: "a", streaming: { a: "half a sen" } };
    const r = apply(v, { type: "lagged" }, false);
    expect(r.view.streaming.a).toBe("");
    expect(r.fx.refetch).toBe(true);
  });

  it("moves to the next thread when the open one is deleted", () => {
    const v = { ...emptyView(), current: "a", threads: [thread("a", 2), thread("b")] };
    const r = apply(v, { type: "threadDeleted", threadId: "a", v: 1 }, false);
    expect(r.view.current).toBe("b");
    expect(r.fx.open).toBe("b");
  });

  it("keeps the autopilots for their cards", () => {
    const a = { instanceId: "w", session: "workbench", threadId: "t1", state: "running" as const, text: "step 2 of 5 (P2) · working" };
    const { v } = run([{ v: 1, type: "autopilots", autopilots: [a] }]);
    expect(v.autopilots).toEqual([a]);
  });

  it("pages the decisions, newest first", () => {
    const row = (id: number) => ({
      id,
      ts: id,
      threadId: "a",
      toolUseId: `u${id}`,
      projectId: null,
      tool: "assistant:x",
      summary: "",
      input: {},
      decision: "allow" as const,
      layer: "rule",
      reason: "",
      ruleId: null,
      shadow: false,
    });
    let { v } = run([{ type: "decisions", rows: [row(9), row(8)], before: null, more: true, v: 1 }]);
    v = run([{ type: "decisions", rows: [row(7)], before: 8, more: false, v: 1 }], v).v;
    v = run([{ type: "decision", row: row(10), v: 1 }], v).v;
    expect(v.decisions.map((d) => d.id)).toEqual([10, 9, 8, 7]);
    expect(v.decisionsMore).toBe(false);
  });
});
