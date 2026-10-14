// The plans each session has proposed (step P1), for the "open plan" buttons.
//
// Read straight from the session's transcript (`readPlans`), so they are known
// whichever view a console shows. Reading a whole session is not free, so it is
// done only when there may be a new plan: when a console shows up, and when the
// session asks to approve a plan (`ExitPlanMode` always asks).
//
// Nothing here opens anything: a plan is only ever opened by a click.

import { useSyncExternalStore } from "react";

import { readTranscriptBack } from "../ipc/transcript";
import { readPlans, type PlanRef } from "../transcript/feed";

const EMPTY: readonly PlanRef[] = [];
let plans: ReadonlyMap<string, readonly PlanRef[]> = new Map();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<readonly PlanRef[]>>();

function put(instanceId: string, list: readonly PlanRef[]): void {
  const prev = plans.get(instanceId) ?? EMPTY;
  if (prev.length === list.length && prev.every((p, i) => p.id === list[i].id)) return;
  const next = new Map(plans);
  next.set(instanceId, list);
  plans = next;
  for (const l of listeners) l();
}

export function getPlans(instanceId: string): readonly PlanRef[] {
  return plans.get(instanceId) ?? EMPTY;
}

/** Re-read the session's plans. One read per instance at a time. */
export function refreshPlans(instanceId: string): Promise<readonly PlanRef[]> {
  const running = inFlight.get(instanceId);
  if (running) return running;
  const read = readPlans((before) => readTranscriptBack(instanceId, before))
    .then((list) => {
      put(instanceId, list);
      return list;
    })
    .catch(() => getPlans(instanceId)) // no transcript (yet): keep what was known
    .finally(() => inFlight.delete(instanceId));
  inFlight.set(instanceId, read);
  return read;
}

/** Add the plans a view already folded (the transcript view has them in hand). It
 *  may hold only the newest part of the session, so this adds and never drops. */
export function notePlans(instanceId: string, list: readonly PlanRef[]): void {
  const known = getPlans(instanceId);
  const ids = new Set(known.map((p) => p.id));
  const added = list.filter((p) => !ids.has(p.id));
  if (added.length > 0) put(instanceId, [...known, ...added]);
}

export function usePlans(instanceId: string): readonly PlanRef[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => getPlans(instanceId),
  );
}
