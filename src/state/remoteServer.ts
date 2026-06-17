// Remote-server control store (step 4.3) — the single frontend view of the remote
// access server's status, shared by the settings panel (which mutates it) and the
// state mirror (which only reads `running`, to gate its snapshot pushes). A tiny
// external store like the others; never torn down.

import { useSyncExternalStore } from "react";
import {
  remoteNewPairingCode,
  remoteStart,
  remoteStatus,
  remoteStop,
  type RemoteStatus,
} from "../ipc/remote";

let status: RemoteStatus | null = null;
const listeners = new Set<() => void>();

function set(next: RemoteStatus): void {
  status = next;
  for (const l of listeners) l();
}

/** Read the latest status outside React (the mirror's running-gate). Null until the
 *  first `refreshRemoteStatus`. */
export function getRemoteStatus(): RemoteStatus | null {
  return status;
}

/** Load the current status from the backend (called on launch and when the panel
 *  opens). Swallows a non-Tauri host so importing this never throws. */
export async function refreshRemoteStatus(): Promise<void> {
  try {
    set(await remoteStatus());
  } catch {
    // non-Tauri host / backend not ready — leave status null.
  }
}

/** Enable serving; updates the store with the new (running) status. Re-throws so the
 *  panel can surface a bind/no-tailnet failure. */
export async function startRemote(): Promise<void> {
  set(await remoteStart());
}

/** Disable serving; updates the store. */
export async function stopRemote(): Promise<void> {
  set(await remoteStop());
}

/** Mint a fresh pairing code; updates the store so the panel shows it. */
export async function newPairingCode(): Promise<void> {
  set(await remoteNewPairingCode());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RemoteStatus | null {
  return status;
}

/** Subscribe a component to the remote-server status. */
export function useRemoteServer(): RemoteStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
