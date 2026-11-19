import { describe, expect, it } from "vitest";
import type { FleetStatus } from "../ipc/fleet";
import { createFleetTools, type WaitingStore } from "./fleet";
import { dropWaiting, listMachines, wakeMachine, waitForMachine } from "./tools/fleet";
import type { ToolContext } from "./tools/registry";

const member = (id: string, name: string, kind: string, online: boolean) => ({ id, name, kind, online, os: "windows", caps: [] as string[], wakeable: true });

const status = (laptopOn: boolean): FleetStatus =>
  ({
    me: member("D", "desktop", "desktop", true),
    members: [member("L", "laptop", "laptop", laptopOn), member("S", "homeserver", "server", false)],
    config: { duck: "D", order: ["D", "S", "L"], wake: ["L"] },
  }) as unknown as FleetStatus;

function memStore(): WaitingStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    put: async (id, data) => void rows.set(id, data),
    list: async () => [...rows.values()],
    delete: async (id) => rows.delete(id),
  };
}

function setup() {
  const store = memStore();
  const told: [string | null, string][] = [];
  let n = 0;
  const woken: string[] = [];
  const fleet = createFleetTools({
    store,
    wakeSend: async (id) => (woken.push(id), "sent to it from here"),
    tell: async (threadId, text) => {
      if (threadId === "gone") throw new Error("no such thread");
      told.push([threadId, text]);
    },
    newId: () => `w${++n}`,
  });
  fleet.setStatus(status(false));
  return { fleet, store, told, woken };
}

const ctx = (fleet: ReturnType<typeof createFleetTools>) => ({ fleet, threadId: "t1" }) as unknown as ToolContext & { prepared: undefined };

describe("Duck's machines and the waiting queue (fleet plan F3.2)", () => {
  it("lists the machines in priority order, and tells the prompt what each is for", () => {
    const { fleet } = setup();
    expect(fleet.machines().map((m) => m.name)).toEqual(["desktop", "homeserver", "laptop"]);
    const block = fleet.promptBlock()!;
    expect(block).toContain("desktop (desktop), homeserver (server), laptop (laptop)");
    expect(block).toContain("You run on desktop");
    expect(block).toContain("homeserver takes only research or heavy-thinking sessions, never coding");
    // Who's on isn't in it: the cached prefix holds as machines come and go.
    fleet.setStatus(status(true));
    expect(fleet.promptBlock()).toBe(block);
  });

  it("queues a task for a machine that's off, and hands it back when it connects", async () => {
    const { fleet, store, told } = setup();
    const out = await waitForMachine.run({ machine: "Laptop", task: "fix the flaky test in workbench" }, ctx(fleet));
    expect(out).toContain("Queued for laptop");
    expect(store.rows.size).toBe(1);
    const listed = (await listMachines.run({}, ctx(fleet))) as { machines: { name: string; on: boolean; waiting?: unknown[] }[] };
    expect(listed.machines.find((m) => m.name === "laptop")?.waiting).toHaveLength(1);

    // Another machine connecting changes nothing.
    await fleet.connected("S");
    expect(told).toEqual([]);
    await fleet.connected("L");
    expect(told).toHaveLength(1);
    expect(told[0][0]).toBe("t1");
    expect(told[0][1]).toContain("laptop is connected now. You queued this for it: fix the flaky test in workbench");
    expect(store.rows.size).toBe(0);
    expect(fleet.waiting()).toEqual([]);
  });

  it("refuses a machine that's on or unknown, and starts a new thread when the old one's gone", async () => {
    const { fleet, told } = setup();
    fleet.setStatus(status(true));
    await expect(waitForMachine.run({ machine: "laptop", task: "x" }, ctx(fleet))).rejects.toThrow(/laptop is on now/);
    await expect(waitForMachine.run({ machine: "toaster", task: "x" }, ctx(fleet))).rejects.toThrow(/no computer "toaster"/);
    fleet.setStatus(status(false));
    const item = await fleet.queue(fleet.find("laptop")!, "later", "gone");
    await fleet.connected("L");
    expect(told).toEqual([[null, expect.stringContaining("later")]]);
    expect(fleet.waiting().some((w) => w.id === item.id)).toBe(false);
  });

  it("drops a task, and keeps the queue across a restart", async () => {
    const { fleet, store } = setup();
    const a = await fleet.queue(fleet.find("L")!, "one", "t1");
    await fleet.queue(fleet.find("L")!, "two", "t1");
    await expect(dropWaiting.run({ id: a.id }, ctx(fleet))).resolves.toBe("Dropped.");
    await expect(dropWaiting.run({ id: a.id }, ctx(fleet))).rejects.toThrow(/nothing waiting/);
    const again = createFleetTools({ store, tell: async () => {} });
    await again.load();
    expect(again.waiting().map((w) => w.task)).toEqual(["two"]);
  });
});

describe("waking a machine (fleet plan F4.1)", () => {
  it("sends the packet and waits for the machine to connect", async () => {
    const { fleet, woken } = setup();
    const signal = new AbortController().signal;
    const going = wakeMachine.run({ machine: "laptop" }, { ...ctx(fleet), signal } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(woken).toEqual(["L"]);
    await fleet.connected("L");
    await expect(going).resolves.toContain("laptop is awake and connected");
  });

  it("counts the machine's link coming up, and gives up after the wait", async () => {
    const { fleet } = setup();
    const signal = new AbortController().signal;
    const going = fleet.wake(fleet.find("laptop")!, signal, 5000);
    await new Promise((r) => setTimeout(r, 0));
    fleet.setStatus(status(true));
    await expect(going).resolves.toContain("awake");
    fleet.setStatus(status(false));
    await expect(fleet.wake(fleet.find("laptop")!, signal, 10)).resolves.toContain("didn't connect within 0 s");
  });

  it("refuses a machine that isn't set to be woken", async () => {
    const { fleet } = setup();
    await expect(wakeMachine.run({ machine: "homeserver" }, ctx(fleet))).rejects.toThrow(/isn't set to be woken/);
    const listed = (await listMachines.run({}, ctx(fleet))) as { machines: { name: string; canWake?: boolean }[] };
    expect(listed.machines.find((m) => m.name === "laptop")?.canWake).toBe(true);
  });
});
