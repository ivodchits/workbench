import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusPhase } from "../state/status";

const sent: [string, string][] = [];
const phases = new Map<string, StatusPhase>();
const listeners = new Set<(id: string, phase: StatusPhase, prev: StatusPhase | null) => void>();
const compacting = new Set<string>();
const compactionEnds = new Set<(id: string, live: { phase: StatusPhase; compacting: boolean }) => void>();

vi.mock("./terminalPool", () => ({
  submitPrompt: (id: string, text: string) => void sent.push([id, text]),
}));
vi.mock("../state/status", () => ({
  getLiveStatuses: () =>
    new Map([...phases].map(([id, phase]) => [id, { phase, compacting: compacting.has(id), subagents: 0 }])),
  onStatusTransition: (cb: (id: string, phase: StatusPhase, prev: StatusPhase | null) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  onCompactionEnd: (cb: (id: string, live: { phase: StatusPhase; compacting: boolean }) => void) => {
    compactionEnds.add(cb);
    return () => compactionEnds.delete(cb);
  },
}));

import { cancelQueued, getQueued } from "../state/queue";
import { initQueueDelivery, sendOrQueue } from "./promptDelivery";

function move(id: string, phase: StatusPhase): void {
  const prev = phases.get(id) ?? null;
  phases.set(id, phase);
  for (const l of listeners) l(id, phase, prev);
}

function endCompaction(id: string): void {
  compacting.delete(id);
  const live = { phase: phases.get(id) ?? "idle", compacting: false };
  for (const l of compactionEnds) l(id, live);
}

describe("prompt delivery", () => {
  beforeEach(() => {
    sent.length = 0;
    phases.clear();
    compacting.clear();
    cancelQueued("a");
  });

  it("sends at once to an agent between turns", () => {
    expect(sendOrQueue("a", "hello")).toBe("sent");
    expect(sent).toEqual([["a", "hello"]]);
    expect(getQueued("a")).toBeUndefined();
  });

  it("holds a prompt for a working agent until its turn ends, then sends it once", () => {
    const stop = initQueueDelivery();
    move("a", "working");
    expect(sendOrQueue("a", "next")).toBe("queued");
    expect(sent).toEqual([]);

    move("a", "needs_you"); // a permission prompt mid-turn: still held
    expect(sent).toEqual([]);
    move("a", "working");
    move("a", "done");
    expect(sent).toEqual([["a", "next"]]);
    expect(getQueued("a")).toBeUndefined();

    move("a", "working");
    move("a", "done");
    expect(sent).toHaveLength(1);
    stop();
  });

  it("holds a prompt through a /compact from rest, then sends it when compaction ends", () => {
    const stop = initQueueDelivery();
    move("a", "done");
    compacting.add("a");
    expect(sendOrQueue("a", "after compact")).toBe("queued");
    endCompaction("a"); // PostCompact: no phase change, still "done"
    expect(sent).toEqual([["a", "after compact"]]);
    expect(getQueued("a")).toBeUndefined();
    stop();
  });

  it("keeps holding when a mid-turn compaction lifts back into work", () => {
    const stop = initQueueDelivery();
    move("a", "working");
    compacting.add("a");
    expect(sendOrQueue("a", "later")).toBe("queued");
    endCompaction("a");
    expect(sent).toEqual([]);
    move("a", "done");
    expect(sent).toEqual([["a", "later"]]);
    stop();
  });

  it("never sends into a pending question", () => {
    move("a", "needs_you");
    expect(sendOrQueue("a", "later")).toBe("queued");
    expect(sent).toEqual([]);
  });

  it("is one subscription however many hold it", () => {
    const first = initQueueDelivery();
    const second = initQueueDelivery();
    expect(listeners.size).toBe(1);
    first();
    first(); // releasing twice does not drop the other holder's
    expect(listeners.size).toBe(1);
    second();
    expect(listeners.size).toBe(0);
    expect(compactionEnds.size).toBe(0);
  });
});
