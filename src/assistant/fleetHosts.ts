// Duck's hosts across the fleet (fleet plan F3.1): another Workbench machine
// serves its `pc` tools and its Workbench to the main, over the fleet's link
// (`fleet_host_send` and the `fleet-host` event; the Rust side only carries it).
//
// Every message is an envelope, `{ch, msg}`: `pc` carries H1's host messages
// (`hello`, `device.call`, …), `workbench` the remote port's (`port.remote.ts`).
//
// - **The hub** (every machine; only the main's gets traffic): a machine's `pc`
//   hello connects it as that machine's named host (`hosts.ts`), its
//   `port.hello` makes its remote port for the fleet port. When the machine's link
//   goes, both close.
// - **Serving** (a machine that isn't the main): says hello on both channels to the
//   main and answers what it's sent. A new main gets a new hello; the old stops.
// - A main that hears from a machine it doesn't know (its Duck restarted) asks it to
//   say hello again (`port.resync`), and so does a main that just started.
// - **The drawer** (F3.1b): `duck` carries the Duck Protocol between the main's
//   endpoint and the drawer of a machine that isn't the main (`switchTransport.ts`),
//   as the phone's socket does: answers to the drawer that asked, changes to all.
// - `runFleetLink` follows the fleet's status to do all this.

import type { FleetStatus } from "../ipc/fleet";
import { serveHost, type HostConn, type HostDown, type HostHandler, type Hosts, type HostUp, type MachineRef } from "./hosts";
import type { WorkbenchPort } from "./port";
import type { ClientMessage, DuckEndpoint, DuckEvent } from "./protocol";
import type { Remotes } from "./remotes";
import { createLinkTransport, type SwitchTransport } from "./switchTransport";
import { createRemotePort, serveWorkbench, type PortDown, type PortEvent, type PortUp, type RemotePort } from "./port.remote";

type Envelope =
  | { ch: "pc"; msg: HostUp | HostDown }
  | { ch: "workbench"; msg: PortUp | PortDown }
  | { ch: "duck"; msg: ClientMessage | DuckEvent };

/** The main's messages to a machine it serves, as opposed to a host's to the main. */
const DOWN = new Set(["device.call", "device.cancel", "port.call", "port.resync"]);

/** Whether `text` is for what this machine serves (else for its hub). */
export function isDown(text: string): boolean {
  const t = parse(text)?.msg.type;
  return t !== undefined && DOWN.has(t);
}

function parse(text: string): Envelope | null {
  try {
    const e = JSON.parse(text) as Envelope;
    return (e.ch === "pc" || e.ch === "workbench" || e.ch === "duck") && e.msg && typeof e.msg === "object" ? e : null;
  } catch {
    return null;
  }
}

export interface FleetHub {
  /** A message from machine `from`. */
  receive(from: string, text: string): void;
  /** Machine `id`'s link went (or it left the fleet). */
  gone(id: string): void;
  /** The other machines' Workbenches connected now. */
  ports(): RemotePort[];
  /** Ask machine `id` to say hello again. */
  resync(id: string): void;
  /** The engine the other machines' drawers talk to (once it's started). */
  setEndpoint(ep: DuckEndpoint): void;
}

/** The main's side. `events` hands a machine's port events to the fleet port. */
export function createFleetHub(deps: {
  hosts: Hosts;
  send: (to: string, text: string) => void;
  events: (name: PortEvent, args: unknown[]) => void;
  /** A machine's host said hello: it's connected to this one (F3.2). */
  connected?: (id: string) => void;
}): FleetHub {
  const pc = new Map<string, HostConn>();
  const ports = new Map<string, RemotePort>();
  const drawers = new Map<string, () => void>();
  let endpoint: DuckEndpoint | null = null;
  const out = (to: string, e: Envelope) => deps.send(to, JSON.stringify(e));
  const resync = (id: string) => out(id, { ch: "workbench", msg: { type: "port.resync" } });
  return {
    resync,
    setEndpoint(ep) {
      endpoint = ep;
    },
    receive(from, text) {
      const e = parse(text);
      if (!e) return;
      if (e.ch === "duck") {
        if (!endpoint) return;
        const reply = (ev: DuckEvent) => out(from, { ch: "duck", msg: ev });
        if (!drawers.has(from)) drawers.set(from, endpoint.onEvent(reply));
        endpoint.handle(e.msg as ClientMessage, reply);
        return;
      }
      const known = e.ch === "pc" ? pc.has(from) : ports.has(from);
      const hello = e.msg.type === "hello" || e.msg.type === "port.hello";
      if (!known && !hello) return resync(from);
      if (e.ch === "pc") {
        const msg = e.msg as HostUp;
        if (msg.type === "hello") {
          pc.get(from)?.close();
          try {
            pc.set(from, deps.hosts.connect(msg, (down) => out(from, { ch: "pc", msg: down }), from));
            deps.connected?.(from);
          } catch (err) {
            console.warn(`duck: a machine's pc host was refused`, err);
          }
        } else if (msg.type === "device.result") pc.get(from)?.receive(msg);
        return;
      }
      const msg = e.msg as PortUp;
      if (msg.type === "port.hello") {
        ports.get(from)?.close();
        ports.set(from, createRemotePort(from, msg.name, (down) => out(from, { ch: "workbench", msg: down }), deps.events));
      }
      ports.get(from)?.receive(msg);
    },
    gone(id) {
      drawers.get(id)?.();
      drawers.delete(id);
      pc.get(id)?.close();
      pc.delete(id);
      ports.get(id)?.close();
      ports.delete(id);
    },
    ports: () => [...ports.values()],
  };
}

export interface FleetServing {
  /** Who it serves, as which name. */
  readonly main: string;
  readonly name: string;
  receive(text: string): void;
  stop(): void;
}

/** A machine that isn't the main: serve its `pc` tools and its Workbench to `main`. */
export function serveFleet(deps: {
  main: string;
  name: string;
  pc: Record<string, HostHandler>;
  port: WorkbenchPort;
  send: (to: string, text: string) => void;
  remotes?: Remotes;
}): FleetServing {
  const out = (e: Envelope) => deps.send(deps.main, JSON.stringify(e));
  const pc = serveHost("pc", deps.pc, (msg) => out({ ch: "pc", msg }), deps.name);
  out({ ch: "pc", msg: pc.hello });
  const wb = serveWorkbench(deps.port, deps.name, (msg) => out({ ch: "workbench", msg }), undefined, deps.remotes);
  return {
    main: deps.main,
    name: deps.name,
    receive(text) {
      const e = parse(text);
      if (!e) return;
      if (e.ch === "pc") pc.receive(e.msg as HostDown);
      else {
        if (e.msg.type === "port.resync") out({ ch: "pc", msg: pc.hello });
        wb.receive(e.msg as PortDown);
      }
    },
    stop: () => wb.stop(),
  };
}

/** Follow the fleet: serve the main when that's another machine that's up, take
 *  hosts when it's this one, and forget a machine whose link went. Returns a look,
 *  to run on every `fleet-changed`. */
export function runFleetLink(deps: {
  status: () => Promise<FleetStatus | null>;
  hub: FleetHub;
  serve: (main: string, name: string) => FleetServing;
  setSelf: (m: MachineRef) => void;
  /** Every fresh status (F3.2: the machines Duck knows of). */
  onStatus?: (s: FleetStatus) => void;
  send: (to: string, text: string) => void;
}): {
  look(): Promise<void>;
  receive(from: string, text: string): void;
  /** This machine's drawer: moved to the main while serving it (F3.1b). */
  setDrawer(d: SwitchTransport): void;
} {
  let serving: FleetServing | null = null;
  let online: Set<string> | null = null;
  let surface: ReturnType<typeof createLinkTransport> | null = null;
  let drawer: SwitchTransport | null = null;
  let mainName = "";
  const drawTo = (main: string | null, where: string) => {
    mainName = where;
    if (!drawer) return;
    if (!main) {
      surface = null;
      drawer.use(null);
      return;
    }
    surface = createLinkTransport((msg) => deps.send(main, JSON.stringify({ ch: "duck", msg })));
    drawer.use({ transport: surface, where });
  };
  return {
    setDrawer(d) {
      drawer = d;
      if (serving) drawTo(serving.main, mainName);
    },
    receive(from, text) {
      const e = parse(text);
      if (e?.ch === "duck" && serving?.main === from) {
        surface?.deliver(e.msg as DuckEvent);
        return;
      }
      if (isDown(text)) {
        if (serving?.main === from) serving.receive(text);
      } else deps.hub.receive(from, text);
    },
    async look() {
      const s = await deps.status().catch(() => null);
      if (!s) return;
      deps.setSelf({ id: s.me.id, name: s.me.name });
      deps.onStatus?.(s);
      const now = new Set(s.members.filter((m) => m.online).map((m) => m.id));
      const first = online === null;
      for (const id of online ?? []) if (!now.has(id)) deps.hub.gone(id);
      // A main that just started asks the others for their hosts.
      if (first) for (const id of now) deps.hub.resync(id);
      online = now;
      const main = s.config.duck;
      const want = main && main !== s.me.id && now.has(main) ? main : null;
      if (serving && (serving.main !== want || serving.name !== s.me.name)) {
        serving.stop();
        serving = null;
        if (!want) drawTo(null, "");
      }
      if (want && !serving) {
        serving = deps.serve(want, s.me.name);
        drawTo(want, s.members.find((m) => m.id === want)?.name ?? "another machine");
      }
    },
  };
}
