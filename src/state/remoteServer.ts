// Remote-server control store (step 4.3) — the single frontend view of the remote
// access server: its status, the paired devices and the recent auth failures (step
// R2). Shared by the Remote Access menu and the approval dialog (which mutate it) and
// the state mirror (which only reads `running`, to gate its snapshot pushes). The
// backend announces every change to devices, the code or the log as
// `remote-changed`; `initRemoteServer` reloads on it. A tiny external store like the
// others; never torn down.

import { useSyncExternalStore } from "react";
import {
  onRemoteChanged,
  remoteApproveDevice,
  remoteAuthLog,
  remoteDevicesList,
  remoteNewPairingCode,
  remoteRevokeDevice,
  remoteStart,
  remoteStatus,
  remoteStop,
  type AuthFailure,
  type RemoteDevice,
  type RemoteStatus,
} from "../ipc/remote";

export interface RemoteServerState {
  /** Null until the first load. */
  status: RemoteStatus | null;
  devices: RemoteDevice[];
  failures: AuthFailure[];
}

let state: RemoteServerState = { status: null, devices: [], failures: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<RemoteServerState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Read the latest status outside React (the mirror's running-gate). Null until the
 *  first `refreshRemoteStatus`. */
export function getRemoteStatus(): RemoteStatus | null {
  return state.status;
}

/** Load the status, devices and failures from the backend. Swallows a non-Tauri
 *  host so importing this never throws. */
export async function refreshRemoteStatus(): Promise<void> {
  try {
    const [status, devices, failures] = await Promise.all([
      remoteStatus(),
      remoteDevicesList(),
      remoteAuthLog(),
    ]);
    set({ status, devices, failures });
  } catch {
    // non-Tauri host / backend not ready — leave the state as it is.
  }
}

let started = false;

/** Load once and follow `remote-changed` from then on. Idempotent. */
export function initRemoteServer(): void {
  if (started) return;
  started = true;
  void refreshRemoteStatus();
  onRemoteChanged(() => void refreshRemoteStatus()).catch(() => {});
}

/** Enable serving; updates the store with the new (running) status. Re-throws so the
 *  panel can surface a bind/no-tailnet failure. */
export async function startRemote(): Promise<void> {
  set({ status: await remoteStart() });
}

/** Disable serving; updates the store. */
export async function stopRemote(): Promise<void> {
  set({ status: await remoteStop() });
}

/** Mint a fresh pairing code; updates the store so the panel shows it. */
export async function newPairingCode(): Promise<void> {
  set({ status: await remoteNewPairingCode() });
}

/** Let a waiting device in. */
export async function approveDevice(id: string): Promise<void> {
  set({ devices: await remoteApproveDevice(id) });
  void refreshRemoteStatus();
}

/** Revoke a device, or turn away a waiting one. */
export async function revokeDevice(id: string): Promise<void> {
  set({ devices: await remoteRevokeDevice(id) });
  void refreshRemoteStatus();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RemoteServerState {
  return state;
}

/** Subscribe a component to the remote server's status, devices and failures. */
export function useRemoteServer(): RemoteServerState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
