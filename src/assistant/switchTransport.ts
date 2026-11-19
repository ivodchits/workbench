// Where this machine's drawer talks to Duck (fleet plan F3.1b): its own engine, or
// the main's over the fleet's link when another machine is the main. The drawer
// holds one transport and never knows; a switch moves every subscriber across and
// tells the drawer (`onSwitch`), which starts over with a `sync`.
//
// Files a message carries are stored on this machine; the main fetches them from
// here by their id when it needs them (fleet plan F5.2).

import { PROTOCOL_VERSION, type ClientMessage, type DuckEvent, type Stamped, type Transport } from "./protocol";

export interface SwitchTransport extends Transport {
  /** Talk to `remote` (another machine's Duck, named `where`), or back to this
   *  machine's own with null. */
  use(remote: { transport: Transport; where: string } | null): void;
  /** The machine Duck is on when it isn't this one. */
  where(): string | null;
  onSwitch(cb: (where: string | null) => void): () => void;
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
