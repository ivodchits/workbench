// The fleet's store (fleet plan F1.1): the latest `FleetStatus`, reloaded on every
// `fleet-changed`. Read by the Remote Access menu. A tiny external store like the
// others; never torn down.

import { useSyncExternalStore } from "react";
import { fleetStatus, onFleetChanged, type FleetStatus } from "../ipc/fleet";

let status: FleetStatus | null = null;
const listeners = new Set<() => void>();

/** Put a status the backend just returned in place. */
export function setFleetStatus(next: FleetStatus): void {
  status = next;
  for (const l of listeners) l();
}

export async function refreshFleet(): Promise<void> {
  try {
    setFleetStatus(await fleetStatus());
  } catch {
    // non-Tauri host / backend not ready
  }
}

let started = false;

/** Load once and follow `fleet-changed` from then on. Idempotent. */
export function initFleet(): void {
  if (started) return;
  started = true;
  void refreshFleet();
  onFleetChanged(() => void refreshFleet()).catch(() => {});
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The fleet's status; null until the first load. */
export function useFleet(): FleetStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}
