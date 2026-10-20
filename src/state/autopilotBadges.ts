// Plan autopilot on the rail (step P1): the line under a session's card ("autopilot ·
// step 2 of 5 · next: T2 · reviewing") and what its buttons need. Duck fills this
// through its port as its autopilots change; ephemeral, like live status.
//
// A session on a running autopilot gets no done alerts (`notifications.ts`): each
// step's end is Duck's to judge, and Duck tells you when it stops.

import { useSyncExternalStore } from "react";

export interface AutopilotBadge {
  state: "running" | "paused" | "stopped";
  /** The card's line, without the "autopilot ·" prefix. */
  text: string;
  /** Why it paused or stopped, or what it asks; null while it runs. */
  why: string | null;
  /** Duck's thread that runs it: the step log. */
  threadId: string;
}

let badges: ReadonlyMap<string, AutopilotBadge> = new Map();
const listeners = new Set<() => void>();

/** Show (or with null, drop) a session's autopilot line. */
export function setAutopilotBadge(instanceId: string, badge: AutopilotBadge | null): void {
  const next = new Map(badges);
  if (badge === null) {
    if (!next.delete(instanceId)) return;
  } else next.set(instanceId, badge);
  badges = next;
  for (const l of listeners) l();
}

/** The session is on a running autopilot. */
export function autopilotRunning(instanceId: string): boolean {
  return badges.get(instanceId)?.state === "running";
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useAutopilotBadge(instanceId: string): AutopilotBadge | null {
  return useSyncExternalStore(subscribe, () => badges.get(instanceId) ?? null);
}
