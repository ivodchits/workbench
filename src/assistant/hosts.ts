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

import { PROTOCOL_VERSION } from "./protocol";

export type Host = "workbench" | "pc" | "phone" | "any";

/** The hosts whose tools run elsewhere, over a connection. */
export type RemoteHost = "pc" | "phone";

export const isRemoteHost = (h: Host | undefined): h is RemoteHost => h === "pc" || h === "phone";

const NAMES: Record<RemoteHost, string> = { pc: "the PC", phone: "the phone" };

/** A host to the engine. */
export type HostUp =
  | { type: "hello"; host: RemoteHost; tools: string[]; version: number }
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
  /** Run `tool` on `host`; resolves to its output, rejects with its error. */
  call(host: RemoteHost, tool: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface Hosts extends HostCaller {
  /** A host said hello over a transport that sends with `send`. Throws (the
   *  reason) on a hello the engine can't take. A host already connected is
   *  replaced: its open calls fail. */
  connect(hello: HostUp, send: (msg: HostDown) => void): HostConn;
  /** The host is connected, with the tools it offers. */
  tools(host: RemoteHost): ReadonlySet<string> | null;
}

interface Open {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface Live {
  tools: Set<string>;
  send(msg: HostDown): void;
  calls: Map<string, Open>;
  closed: boolean;
}

/** `declared(host)`: the engine's tools for that host. */
export function createHosts(declared: (host: RemoteHost) => ReadonlySet<string>): Hosts {
  const live = new Map<RemoteHost, Live>();
  let next = 0;

  function drop(l: Live, why: string): void {
    l.closed = true;
    for (const c of l.calls.values()) c.reject(new Error(why));
    l.calls.clear();
  }

  return {
    connect(hello, send) {
      if (hello.type !== "hello") throw new Error("a host starts with hello");
      if (hello.version !== PROTOCOL_VERSION)
        throw new Error(`this host speaks version ${hello.version}, Duck ${PROTOCOL_VERSION}`);
      if (!isRemoteHost(hello.host)) throw new Error(`"${String(hello.host)}" isn't a host`);
      const host = hello.host;
      const mine = declared(host);
      const l: Live = {
        tools: new Set(hello.tools.filter((t) => mine.has(t))),
        send,
        calls: new Map(),
        closed: false,
      };
      const old = live.get(host);
      if (old) drop(old, `${NAMES[host]} reconnected`);
      live.set(host, l);
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
          drop(l, `${NAMES[host]} disconnected`);
          if (live.get(host) === l) live.delete(host);
        },
      };
    },
    tools: (host) => live.get(host)?.tools ?? null,
    call(host, tool, input, signal) {
      const l = live.get(host);
      if (!l) return Promise.reject(new Error(`${NAMES[host]} isn't connected`));
      if (!l.tools.has(tool)) return Promise.reject(new Error(`${NAMES[host]} doesn't offer ${tool}`));
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
): { receive(msg: HostDown): void; hello: HostUp } {
  const running = new Map<string, AbortController>();
  const hello: HostUp = { type: "hello", host, tools: Object.keys(handlers).sort(), version: PROTOCOL_VERSION };
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
