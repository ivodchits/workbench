// Which remote-session dialog is open (fleet plan F9.4): the kill confirmation or
// the resume picker for another machine's session (`panels/RemoteSessionDialogs`).

import { useSyncExternalStore } from "react";

import type { RemoteInstance } from "../remote/protocol";

export interface Target {
  kind: "kill" | "resume";
  machine: string;
  machineName: string;
  inst: RemoteInstance;
}

let target: Target | null = null;
const listeners = new Set<() => void>();

function set(next: Target | null): void {
  target = next;
  for (const l of listeners) l();
}

/** Ask to remove `inst` on `machine` (the rail's ✕). */
export function askKillRemote(machine: string, machineName: string, inst: RemoteInstance): void {
  if (!inst.remote) set({ kind: "kill", machine, machineName, inst });
}

/** Open the resume picker on `inst` on `machine`. */
export function askResumeRemote(machine: string, machineName: string, inst: RemoteInstance): void {
  if (!inst.remote) set({ kind: "resume", machine, machineName, inst });
}

export function closeRemoteDialog(): void {
  set(null);
}

export function useRemoteDialog(): Target | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => target,
  );
}
