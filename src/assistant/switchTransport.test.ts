// The drawer's Duck on another machine (fleet plan F3.1b): the switch, and the
// drawer channel through two machines' fleet links.

import { describe, expect, it } from "vitest";
import type { FleetStatus } from "../ipc/fleet";
import { createFleetHub, runFleetLink, serveFleet } from "./fleetHosts";
import { createHosts } from "./hosts";
import type { WorkbenchPort } from "./port";
import { createLocalTransport, type ClientMessage, type DuckEndpoint, type DuckEvent } from "./protocol";
import { createLinkTransport, createSwappableEndpoint, createSwitchTransport } from "./switchTransport";

/** An engine that answers `sync` with its own threads, and says "changed" to all. */
function fakeEndpoint(name: string): DuckEndpoint & { got: ClientMessage[]; broadcast(e: DuckEvent): void } {
  const subs = new Set<(e: DuckEvent) => void>();
  const got: ClientMessage[] = [];
  return {
    got,
    handle(msg, reply) {
      got.push(msg);
      if (msg.type === "sync") (reply ?? ((e) => subs.forEach((s) => s(e))))({ type: "threads", threads: [{ id: name } as never] });
    },
    onEvent(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    broadcast: (e) => subs.forEach((s) => s(e)),
  };
}

const threadsOf = (events: DuckEvent[]) =>
  events.filter((e): e is Extract<DuckEvent, { type: "threads" }> => e.type === "threads").map((e) => e.threads.map((t) => t.id).join());

describe("the drawer's transport", () => {
  it("moves its subscribers to another machine's Duck and back", () => {
    const local = fakeEndpoint("here");
    const sw = createSwitchTransport(createLocalTransport(local));
    const seen: DuckEvent[] = [];
    sw.subscribe((e) => seen.push(e));
    const sent: ClientMessage[] = [];
    const remote = createLinkTransport((m) => sent.push(m));
    const switched: (string | null)[] = [];
    sw.onSwitch((w) => switched.push(w));

    sw.use({ transport: remote, where: "desktop" });
    expect(sw.where()).toBe("desktop");
    sw.send({ type: "sync" });
    expect(sent).toEqual([{ type: "sync" }]);
    remote.deliver({ type: "threads", threads: [{ id: "there" } as never] });
    local.broadcast({ type: "threads", threads: [{ id: "ignored" } as never] });
    expect(threadsOf(seen)).toEqual(["there"]);

    // Files go too: the main fetches them from here by id (F5.2).
    sw.send({ type: "send", threadId: null, text: "look", source: "desktop" as never, attachments: [{ id: "a" } as never] });
    expect(sent).toHaveLength(2);

    sw.use(null);
    sw.send({ type: "sync" });
    expect(threadsOf(seen)).toEqual(["there", "here"]);
    expect(switched).toEqual(["desktop", null]);
  });

  it("talks to the main's Duck through both machines' fleet links", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const mainEp = fakeEndpoint("desktop's");
    const laptopEp = fakeEndpoint("laptop's");
    // The desktop (main) and the laptop, their messages carried across.
    const hub = createFleetHub({ hosts: createHosts(() => new Set()), send: (_to, t) => queueMicrotask(() => laptop.receive("D", t)), events: () => {} });
    hub.setEndpoint(mainEp);
    const laptopHub = createFleetHub({ hosts: createHosts(() => new Set()), send: () => {}, events: () => {} });
    const noop = () => () => {};
    const port = { listProjects: () => [], listSessions: () => [], promptPending: () => false, onPhase: noop, onCompactionEnd: noop, onSessionYouStarted: noop, onChoices: noop } as unknown as WorkbenchPort;
    const status = (duck: string | null, online: boolean): FleetStatus =>
      ({ me: { id: "L", name: "laptop" }, members: [{ id: "D", name: "desktop", online }], config: { duck } }) as unknown as FleetStatus;
    let now = status("D", true);
    const toDesktop = (_to: string, t: string) => queueMicrotask(() => hub.receive("L", t));
    const laptop = runFleetLink({
      status: async () => now,
      hub: laptopHub,
      serve: (main, name) => serveFleet({ main, name, pc: {}, port, send: toDesktop }),
      setSelf: () => {},
      send: toDesktop,
    });
    const drawer = createSwitchTransport(createLocalTransport(laptopEp));
    const seen: DuckEvent[] = [];
    drawer.subscribe((e) => seen.push(e));
    laptop.setDrawer(drawer);
    await laptop.look();
    expect(drawer.where()).toBe("desktop");
    drawer.send({ type: "sync" });
    await tick();
    await tick();
    expect(threadsOf(seen)).toEqual(["desktop's"]);
    expect(mainEp.got).toContainEqual({ type: "sync" });
    // A change at the main reaches the laptop's drawer too.
    mainEp.broadcast({ type: "threads", threads: [{ id: "changed" } as never] });
    await tick();
    await tick();
    expect(threadsOf(seen).slice(-1)[0]).toBe("changed");

    // The desktop goes: the drawer is the laptop's own again.
    now = status("D", false);
    await laptop.look();
    expect(drawer.where()).toBeNull();
    drawer.send({ type: "sync" });
    expect(threadsOf(seen).slice(-1)[0]).toBe("laptop's");
  });
});

describe("Duck restarting behind one endpoint (F6.3)", () => {
  it("moves every subscriber to the new engine, holds what's sent meanwhile, and syncs everyone", () => {
    const ep = createSwappableEndpoint();
    const old = fakeEndpoint("old");
    ep.swap(old);
    const seen: string[] = [];
    const off = ep.onEvent((e) => seen.push(e.type === "threads" ? `threads:${e.threads[0].id}` : e.type));
    old.broadcast({ type: "threadDeleted", threadId: "x" });
    ep.swap(null);
    old.broadcast({ type: "threadDeleted", threadId: "y" });
    const replies: DuckEvent[] = [];
    ep.handle({ type: "sync" }, (e) => replies.push(e));
    const next = fakeEndpoint("new");
    ep.swap(next);
    // Everyone's resynced from the new engine, and the held request is answered by it.
    expect(seen).toEqual(["threadDeleted", "threads:new"]);
    expect(replies).toMatchObject([{ type: "threads", threads: [{ id: "new" }] }]);
    expect(next.got.map((m) => m.type)).toEqual(["sync", "sync"]);
    next.broadcast({ type: "threadDeleted", threadId: "z" });
    off();
    next.broadcast({ type: "threadDeleted", threadId: "w" });
    expect(seen).toEqual(["threadDeleted", "threads:new", "threadDeleted"]);
  });

  it("tells the drawer to start over only while it talks to this machine's Duck", () => {
    const drawer = createSwitchTransport(createLocalTransport(fakeEndpoint("here")));
    const starts: (string | null)[] = [];
    drawer.onSwitch((w) => starts.push(w));
    drawer.restarted();
    drawer.use({ transport: createLinkTransport(() => {}), where: "laptop" });
    drawer.restarted();
    expect(starts).toEqual([null, "laptop"]);
  });
});
