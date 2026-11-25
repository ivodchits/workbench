// The fleet view's store (fleet plan F9.1): every other machine's latest dashboard
// snapshot, as `fleet::view` follows it (`fleet-view`), keyed by machine id. A
// machine with no socket has a null snapshot, and why when opening it failed.
// Started once from the main window; never torn down.

import { useSyncExternalStore } from "react";
import { fleetViewList, onFleetView, type FleetViewEntry } from "../ipc/fleet";
import type { RemoteSnapshot } from "../remote/protocol";

export interface MachineView {
  machine: string;
  snapshot: RemoteSnapshot | null;
  error: string | null;
  /** Its projects when its snapshot was last there. */
  lastProjects: RemoteSnapshot["projects"];
}

let views: ReadonlyMap<string, MachineView> = new Map();
const listeners = new Set<() => void>();

function parse(e: FleetViewEntry): MachineView {
  let snapshot: RemoteSnapshot | null = null;
  if (e.snapshot) {
    try {
      snapshot = JSON.parse(e.snapshot) as RemoteSnapshot;
    } catch {
      snapshot = null;
    }
  }
  const last = snapshot?.projects ?? views.get(e.machine)?.lastProjects ?? [];
  return { machine: e.machine, snapshot, error: e.error, lastProjects: last };
}

function put(e: FleetViewEntry): void {
  const next = new Map(views);
  next.set(e.machine, parse(e));
  views = next;
  for (const l of listeners) l();
}

let started = false;

export function initFleetView(): void {
  if (started) return;
  started = true;
  onFleetView(put).catch(() => {});
  fleetViewList()
    .then((list) => {
      for (const e of list) if (!views.has(e.machine)) put(e);
    })
    .catch(() => {});
}

export function getFleetViews(): ReadonlyMap<string, MachineView> {
  return views;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useFleetViews(): ReadonlyMap<string, MachineView> {
  return useSyncExternalStore(subscribe, () => views);
}

/** Tests: put a view in place. */
export function setFleetViewForTest(v: MachineView): void {
  const next = new Map(views);
  next.set(v.machine, v);
  views = next;
  for (const l of listeners) l();
}
