// Where this machine's drawer talks to Duck (fleet plan F3.1b): its own engine, or
// the main's over the fleet's link when another machine is the main. The drawer
// holds one transport and never knows; a switch moves every subscriber across and
// tells the drawer (`onSwitch`), which starts over with a `sync`.
//
// Files a message carries are stored on this machine; the main fetches them from
// here by their id when it needs them (fleet plan F5.2).

import { PROTOCOL_VERSION, type ClientMessage, type DuckEndpoint, type DuckEvent, type Stamped, type Transport } from "./protocol";

export interface SwitchTransport extends Transport {
  /** Talk to `remote` (another machine's Duck, named `where`), or back to this
   *  machine's own with null. */
  use(remote: { transport: Transport; where: string } | null): void;
  /** The machine Duck is on when it isn't this one. */
  where(): string | null;
  onSwitch(cb: (where: string | null) => void): () => void;
  /** This machine's Duck started again (F6.3): the drawer starts over as on a
   *  switch, when it's talking to this machine's. */
  restarted(): void;
}

export function createSwitchTransport(local: Transport): SwitchTransport {
  let current: Transport = local;
  let where: string | null = null;
  const subs = new Map<(e: Stamped<DuckEvent>) => void, () => void>();
  const switched = new Set<(where: string | null) => void>();

  return {
    send(msg: ClientMessage) {
      current.send(msg);
    },
    subscribe(cb) {
      subs.set(cb, current.subscribe(cb));
      return () => {
        subs.get(cb)?.();
        subs.delete(cb);
      };
    },
    use(remote) {
      const next = remote?.transport ?? local;
      const nextWhere = remote?.where ?? null;
      if (next === current && nextWhere === where) return;
      for (const [cb, off] of subs) {
        off();
        subs.set(cb, next.subscribe(cb));
      }
      current = next;
      where = nextWhere;
      for (const cb of switched) cb(where);
    },
    where: () => where,
    restarted() {
      if (current === local) for (const cb of switched) cb(where);
    },
    onSwitch(cb) {
      switched.add(cb);
      return () => void switched.delete(cb);
    },
  };
}

/** Duck at another machine, as a transport: `send` carries a message there, and
 *  `deliver` hands out what comes back. */
export function createLinkTransport(send: (msg: ClientMessage) => void): Transport & { deliver(e: DuckEvent): void } {
  const subs = new Set<(e: Stamped<DuckEvent>) => void>();
  return {
    send,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    deliver(e) {
      const stamped = { ...e, v: PROTOCOL_VERSION } as Stamped<DuckEvent>;
      for (const cb of subs) cb(stamped);
    },
  };
}

/** This machine's Duck as one endpoint that outlives it (fleet plan F6.3): the
 *  drawer, the phones and the other machines hold this, and a restart swaps the
 *  engine's endpoint behind it. Every subscriber moves across; what's sent while
 *  there's none (mid-restart) waits for the next. */
export interface SwappableEndpoint extends DuckEndpoint {
  /** Put `ep` behind it, or none (`null`) while Duck restarts. Every surface then
   *  gets a fresh `sync` (the threads, the cards, the settings) from the new one. */
  swap(ep: DuckEndpoint | null): void;
}

/** The most messages kept while Duck restarts; older ones are dropped. */
const WAITING_MAX = 100;

export function createSwappableEndpoint(): SwappableEndpoint {
  let current: DuckEndpoint | null = null;
  const subs = new Map<(e: DuckEvent) => void, () => void>();
  const waiting: [ClientMessage, ((e: DuckEvent) => void) | undefined][] = [];
  const fanOut = (e: DuckEvent) => {
    for (const cb of subs.keys()) cb(e);
  };
  return {
    handle(msg, reply) {
      if (current) current.handle(msg, reply);
      else {
        waiting.push([msg, reply]);
        if (waiting.length > WAITING_MAX) waiting.shift();
      }
    },
    onEvent(cb) {
      subs.set(cb, current ? current.onEvent(cb) : () => {});
      return () => {
        subs.get(cb)?.();
        subs.delete(cb);
      };
    },
    swap(ep) {
      if (ep === current) return;
      for (const [cb, off] of subs) {
        off();
        subs.set(cb, ep ? ep.onEvent(cb) : () => {});
      }
      current = ep;
      if (!ep) return;
      ep.handle({ type: "sync" }, fanOut);
      for (const [msg, reply] of waiting.splice(0)) ep.handle(msg, reply);
    },
  };
}
