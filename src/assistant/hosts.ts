// Host-bound tools (step H1): a tool runs on the machine it acts on. Each tool has
// a host (`ToolDef.host`): `workbench` and `any` run here, in the engine; `pc` and
// `phone` run on a host that connects and says which of them it offers.
//
// - A host says `hello {host, tools, version}`. The engine sends `device.call {id,
//   tool, input}` and the host answers `device.result {id, ok, output}`; a stop or
//   a timeout sends `device.cancel {id}`.
// - The engine keeps every host tool's schema, tier and `trust`, so the gate runs
//   here on the engine's facts, and the tool list never changes with what's
//   connected. A host only runs what it's sent, and refuses a tool it didn't
//   announce. Of what a host announces, only the engine's tools for that host
//   count.
// - A call to a host that isn't connected, or that didn't announce the tool, fails
//   at once with a plain reason. A host that goes away fails its open calls.
// - The desktop's `pc` tools use the in-process transport (`connectLocal`); the
//   phone's come over R1's socket (`remoteBridge.ts`).
// - **Named hosts** (fleet plan F3.1): another Workbench machine connects its `pc`
//   over the fleet's link (`fleetHosts.ts`), as that machine (`connect`'s
//   `machine`). A call names the machine (`device`, by name or id); without one it
//   goes to this machine's own host. Each machine's `pc` is its own connection.

import { PROTOCOL_VERSION } from "./protocol";

export type Host = "workbench" | "pc" | "phone" | "any";

/** The hosts whose tools run elsewhere, over a connection. */
export type RemoteHost = "pc" | "phone";

export const isRemoteHost = (h: Host | undefined): h is RemoteHost => h === "pc" || h === "phone";

const NAMES: Record<RemoteHost, string> = { pc: "the PC", phone: "the phone" };

/** A host to the engine. */
export type HostUp =
  | { type: "hello"; host: RemoteHost; tools: string[]; version: number; name?: string }
  | { type: "device.result"; id: string; ok: boolean; output: unknown };

/** The engine to a host. */
export type HostDown =
  | { type: "device.call"; id: string; tool: string; input: unknown }
  | { type: "device.cancel"; id: string };

export const isHostUp = (m: unknown): m is HostUp => {
  const t = (m as { type?: unknown } | null)?.type;
  return t === "hello" || t === "device.result";
};

/** One host's connection, as its transport drives it. */
export interface HostConn {
  /** A `device.result` from the host. */
  receive(msg: HostUp): void;
  /** The host went away: its open calls fail. */
  close(): void;
}

/** What a tool's `run` gets to reach a host. */
export interface HostCaller {
  /** Run `tool` on `host`; resolves to its output, rejects with its error.
   *  `device`: the machine, by name or id (another Workbench machine's host);
   *  this machine's own when absent or when it names this machine. */
  call(host: RemoteHost, tool: string, input: unknown, signal: AbortSignal, device?: string): Promise<unknown>;
}

/** Another machine whose host is connected. */
export interface MachineRef {
  id: string;
  name: string;
}

export interface Hosts extends HostCaller {
  /** A host said hello over a transport that sends with `send`. Throws (the
   *  reason) on a hello the engine can't take. A host already connected is
   *  replaced: its open calls fail. `machine`: the other machine's id, when it
   *  came over the fleet's link (its hello's `name` names it). */
  connect(hello: HostUp, send: (msg: HostDown) => void, machine?: string): HostConn;
  /** The host is connected, with the tools it offers. */
  tools(host: RemoteHost, machine?: string): ReadonlySet<string> | null;
  /** The other machines whose `host` is connected. */
  machines(host: RemoteHost): MachineRef[];
}

interface Open {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface Live {
  /** The machine's id and name, for another machine's host. */
  machine: MachineRef | null;
  tools: Set<string>;
  send(msg: HostDown): void;
  calls: Map<string, Open>;
  closed: boolean;
}

/** Where a host lives in `live`: its kind, and the machine's id for another one. */
const keyOf = (host: RemoteHost, machine?: string | null) => (machine ? `${host}@${machine}` : host);

const nameOf = (host: RemoteHost, l: Live | undefined) => (l?.machine ? `${l.machine.name}'s ${host}` : NAMES[host]);

/** `declared(host)`: the engine's tools for that host. `self()`: this machine's
 *  name and id, so a `device` naming it means its own host. */
export function createHosts(
  declared: (host: RemoteHost) => ReadonlySet<string>,
  self: () => MachineRef | null = () => null,
): Hosts {
  const live = new Map<string, Live>();
  let next = 0;

  const norm = (s: string) => s.trim().toLowerCase();

  /** The key a call goes to; throws (the reason) for a machine that isn't here. */
  function target(host: RemoteHost, device: string | undefined): string {
    const d = device?.trim();
    const me = self();
    if (!d || (me && (norm(d) === norm(me.name) || d === me.id))) return keyOf(host);
    for (const l of live.values()) {
      if (l.machine && (l.machine.id === d || norm(l.machine.name) === norm(d)) && live.get(keyOf(host, l.machine.id)) === l)
        return keyOf(host, l.machine.id);
    }
    const others = [...live.values()].filter((l) => l.machine).map((l) => l.machine!.name);
    const known = [...new Set([...(me ? [me.name] : []), ...others])];
    throw new Error(`"${d}" isn't connected${known.length ? `; the machines here: ${known.join(", ")}` : ""}`);
  }

  function drop(l: Live, why: string): void {
    l.closed = true;
    for (const c of l.calls.values()) c.reject(new Error(why));
    l.calls.clear();
  }

  return {
    connect(hello, send, machine) {
      if (hello.type !== "hello") throw new Error("a host starts with hello");
      if (hello.version !== PROTOCOL_VERSION)
        throw new Error(`this host speaks version ${hello.version}, Duck ${PROTOCOL_VERSION}`);
      if (!isRemoteHost(hello.host)) throw new Error(`"${String(hello.host)}" isn't a host`);
      const host = hello.host;
      const mine = declared(host);
      const l: Live = {
        machine: machine ? { id: machine, name: (hello.name ?? "").trim().slice(0, 40) || machine } : null,
        tools: new Set(hello.tools.filter((t) => mine.has(t))),
        send,
        calls: new Map(),
        closed: false,
      };
      const key = keyOf(host, machine);
      const old = live.get(key);
      if (old) drop(old, `${nameOf(host, old)} reconnected`);
      live.set(key, l);
      return {
        receive(msg) {
          if (msg.type !== "device.result" || l.closed) return;
          const c = l.calls.get(msg.id);
          if (!c) return;
          l.calls.delete(msg.id);
          if (msg.ok) c.resolve(msg.output);
          else c.reject(new Error(typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output)));
        },
        close() {
          if (l.closed) return;
          drop(l, `${nameOf(host, l)} disconnected`);
          if (live.get(key) === l) live.delete(key);
        },
      };
    },
    tools: (host, machine) => live.get(keyOf(host, machine))?.tools ?? null,
    machines: (host) =>
      [...live.entries()].filter(([k, l]) => l.machine && k === keyOf(host, l.machine.id)).map(([, l]) => l.machine!),
    call(host, tool, input, signal, device) {
      let key: string;
      try {
        key = target(host, device);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const l = live.get(key);
      if (!l) return Promise.reject(new Error(`${NAMES[host]} isn't connected`));
      if (!l.tools.has(tool)) return Promise.reject(new Error(`${nameOf(host, l)} doesn't offer ${tool}`));
      if (signal.aborted) return Promise.reject(new Error("stopped"));
      const id = `c${++next}`;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!l.calls.delete(id)) return;
          l.send({ type: "device.cancel", id });
          reject(new Error("stopped"));
        };
        const settle = <T>(f: (v: T) => void) => (v: T) => {
          signal.removeEventListener("abort", onAbort);
          f(v);
        };
        l.calls.set(id, { resolve: settle(resolve), reject: settle(reject) });
        signal.addEventListener("abort", onAbort);
        l.send({ type: "device.call", id, tool, input });
      });
    },
  };
}

/** A tool as its host runs it. */
export type HostHandler = (input: unknown, signal: AbortSignal) => Promise<unknown> | unknown;

/** The host's side of a connection: says hello with `handlers`' names, runs each
 *  call it's sent, answers it, and aborts it on `device.cancel`. */
export function serveHost(
  host: RemoteHost,
  handlers: Record<string, HostHandler>,
  send: (msg: HostUp) => void,
  name?: string,
): { receive(msg: HostDown): void; hello: HostUp } {
  const running = new Map<string, AbortController>();
  const hello: HostUp = {
    type: "hello",
    host,
    tools: Object.keys(handlers).sort(),
    version: PROTOCOL_VERSION,
    ...(name !== undefined && { name }),
  };
  return {
    hello,
    receive(msg) {
      if (msg.type === "device.cancel") {
        running.get(msg.id)?.abort();
        running.delete(msg.id);
        return;
      }
      const h = Object.prototype.hasOwnProperty.call(handlers, msg.tool) ? handlers[msg.tool] : undefined;
      if (!h) return send({ type: "device.result", id: msg.id, ok: false, output: `this host has no tool ${msg.tool}` });
      const ctl = new AbortController();
      running.set(msg.id, ctl);
      void Promise.resolve()
        // Cancelled before it started: it doesn't start.
        .then(() => (ctl.signal.aborted ? null : h(msg.input, ctl.signal)))
        .then(
          (output) => ({ ok: true, output }),
          (e: unknown) => ({ ok: false, output: e instanceof Error ? e.message : String(e) }),
        )
        .then((r) => {
          // A cancelled call isn't answered: the engine has moved on.
          if (running.get(msg.id) !== ctl) return;
          running.delete(msg.id);
          send({ type: "device.result", id: msg.id, ...r });
        });
    },
  };
}

/** A host in this process (the desktop's `pc` tools): the same messages, handed
 *  over directly. */
export function connectLocal(hosts: Hosts, host: RemoteHost, handlers: Record<string, HostHandler>): HostConn {
  let conn: HostConn | null = null;
  const served = serveHost(host, handlers, (msg) => conn?.receive(msg));
  conn = hosts.connect(served.hello, (msg) => served.receive(msg));
  return conn;
}
